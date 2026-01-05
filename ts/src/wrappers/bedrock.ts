/**
 * AWS Bedrock SDK Wrapper
 * Wraps @aws-sdk/client-bedrock-runtime to auto-capture InvokeModel calls
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

// Bedrock client type (from @aws-sdk/client-bedrock-runtime)
type BedrockClient = {
  send: (command: unknown) => Promise<unknown>;
};

// InvokeModelCommand input/output types
type InvokeModelCommandInput = {
  modelId: string;
  body: Uint8Array | string;
  contentType?: string;
  accept?: string;
};

type InvokeModelCommandOutput = {
  body: Uint8Array;
  contentType?: string;
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
  };
};

// Converse API types (newer Bedrock API)
type ConverseCommandInput = {
  modelId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: Array<{ text?: string }>;
  }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
};

type ConverseCommandOutput = {
  output: {
    message?: {
      role: string;
      content: Array<{ text?: string }>;
    };
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  stopReason?: string;
};

export interface BedrockWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  debug: boolean;
}

/**
 * Creates a wrapped Bedrock client that auto-traces all calls
 */
export function wrapBedrock<T extends BedrockClient>(
  client: T,
  context: BedrockWrapperContext
): T {
  const originalSend = client.send.bind(client);

  const wrappedSend = async (
    command: unknown,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<unknown> => {
    // Check if this is an InvokeModelCommand or ConverseCommand
    const commandName = (command as { constructor?: { name?: string } })?.constructor?.name;

    if (commandName === 'InvokeModelCommand') {
      return handleInvokeModel(originalSend, command, context, options);
    }

    if (commandName === 'ConverseCommand') {
      return handleConverse(originalSend, command, context, options);
    }

    if (commandName === 'ConverseStreamCommand') {
      return handleConverseStream(originalSend, command, context, options);
    }

    // For other commands, pass through
    return originalSend(command);
  };

  // Create wrapped client
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);
  wrappedClient.send = wrappedSend;

  return wrappedClient as T;
}

/**
 * Handle InvokeModelCommand
 */
async function handleInvokeModel(
  send: (command: unknown) => Promise<unknown>,
  command: unknown,
  context: BedrockWrapperContext,
  options?: { raindrop?: RaindropRequestOptions }
): Promise<WithTraceId<InvokeModelCommandOutput>> {
  const input = (command as { input?: InvokeModelCommandInput }).input;
  const modelId = input?.modelId || 'unknown';
  const traceId = options?.raindrop?.traceId || context.generateTraceId();
  const startTime = Date.now();
  const userId = options?.raindrop?.userId || context.getUserId();

  if (context.debug) {
    console.log('[raindrop] Bedrock InvokeModel started:', traceId, modelId);
  }

  // Parse input body
  let inputData: unknown;
  try {
    const bodyStr = input?.body instanceof Uint8Array
      ? new TextDecoder().decode(input.body)
      : input?.body;
    inputData = bodyStr ? JSON.parse(bodyStr) : undefined;
  } catch {
    inputData = input?.body;
  }

  try {
    const result = await send(command) as InvokeModelCommandOutput;
    const endTime = Date.now();

    // Parse output body
    let outputData: unknown;
    let outputText: string | undefined;
    try {
      const bodyStr = new TextDecoder().decode(result.body);
      outputData = JSON.parse(bodyStr);
      // Extract text based on model format
      outputText = extractOutputText(outputData, modelId);
    } catch {
      outputData = result.body;
    }

    const interaction = context.getInteractionContext();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: inputData,
        output: outputText || outputData,
        properties: options?.raindrop?.properties,
      };
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider: 'bedrock' as TraceData['provider'],
        model: modelId,
        input: inputData,
        output: outputText || outputData,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
      });
    }

    return Object.assign(result, { _traceId: traceId });
  } catch (error) {
    const endTime = Date.now();
    const interaction = context.getInteractionContext();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: inputData,
        error: error instanceof Error ? error.message : String(error),
      };
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider: 'bedrock' as TraceData['provider'],
        model: modelId,
        input: inputData,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  }
}

/**
 * Handle ConverseCommand (newer API)
 */
async function handleConverse(
  send: (command: unknown) => Promise<unknown>,
  command: unknown,
  context: BedrockWrapperContext,
  options?: { raindrop?: RaindropRequestOptions }
): Promise<WithTraceId<ConverseCommandOutput>> {
  const input = (command as { input?: ConverseCommandInput }).input;
  const modelId = input?.modelId || 'unknown';
  const traceId = options?.raindrop?.traceId || context.generateTraceId();
  const startTime = Date.now();
  const userId = options?.raindrop?.userId || context.getUserId();

  if (context.debug) {
    console.log('[raindrop] Bedrock Converse started:', traceId, modelId);
  }

  try {
    const result = await send(command) as ConverseCommandOutput;
    const endTime = Date.now();

    const outputText = result.output?.message?.content
      ?.map(c => c.text)
      .filter(Boolean)
      .join('');

    const interaction = context.getInteractionContext();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: input?.messages,
        output: outputText,
        properties: {
          ...options?.raindrop?.properties,
          input_tokens: result.usage?.inputTokens,
          output_tokens: result.usage?.outputTokens,
        },
      };
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider: 'bedrock' as TraceData['provider'],
        model: modelId,
        input: input?.messages,
        output: outputText,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        tokens: result.usage ? {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          total: result.usage.totalTokens,
        } : undefined,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
      });
    }

    return Object.assign(result, { _traceId: traceId });
  } catch (error) {
    const endTime = Date.now();
    const interaction = context.getInteractionContext();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: input?.messages,
        error: error instanceof Error ? error.message : String(error),
      };
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider: 'bedrock' as TraceData['provider'],
        model: modelId,
        input: input?.messages,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  }
}

/**
 * Handle ConverseStreamCommand
 */
async function handleConverseStream(
  send: (command: unknown) => Promise<unknown>,
  command: unknown,
  context: BedrockWrapperContext,
  options?: { raindrop?: RaindropRequestOptions }
): Promise<WithTraceId<unknown>> {
  const input = (command as { input?: ConverseCommandInput }).input;
  const modelId = input?.modelId || 'unknown';
  const traceId = options?.raindrop?.traceId || context.generateTraceId();
  const startTime = Date.now();
  const userId = options?.raindrop?.userId || context.getUserId();
  const interaction = context.getInteractionContext();

  if (context.debug) {
    console.log('[raindrop] Bedrock ConverseStream started:', traceId, modelId);
  }

  try {
    const result = await send(command) as { stream: AsyncIterable<unknown> };
    const collectedText: string[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    const wrappedStream = {
      [Symbol.asyncIterator]: async function* () {
        try {
          for await (const event of result.stream) {
            const e = event as Record<string, unknown>;

            // Collect text from contentBlockDelta events
            if (e.contentBlockDelta) {
              const delta = e.contentBlockDelta as { delta?: { text?: string } };
              if (delta.delta?.text) {
                collectedText.push(delta.delta.text);
              }
            }

            // Collect usage from metadata event
            if (e.metadata) {
              const metadata = e.metadata as { usage?: typeof usage };
              if (metadata.usage) {
                usage = metadata.usage;
              }
            }

            yield event;
          }

          // Stream complete
          const endTime = Date.now();
          const output = collectedText.join('');

          if (interaction) {
            const span: SpanData = {
              spanId: traceId,
              parentId: interaction.interactionId,
              name: `bedrock:${modelId}`,
              type: 'ai',
              startTime,
              endTime,
              latencyMs: endTime - startTime,
              input: input?.messages,
              output,
              properties: {
                ...options?.raindrop?.properties,
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
              },
            };
            interaction.spans.push(span);
          } else {
            context.sendTrace({
              traceId,
              provider: 'bedrock' as TraceData['provider'],
              model: modelId,
              input: input?.messages,
              output,
              startTime,
              endTime,
              latencyMs: endTime - startTime,
              tokens: {
                input: usage.inputTokens,
                output: usage.outputTokens,
                total: usage.totalTokens,
              },
              userId,
              conversationId: options?.raindrop?.conversationId,
              properties: options?.raindrop?.properties,
            });
          }
        } catch (error) {
          const endTime = Date.now();

          if (interaction) {
            const span: SpanData = {
              spanId: traceId,
              parentId: interaction.interactionId,
              name: `bedrock:${modelId}`,
              type: 'ai',
              startTime,
              endTime,
              latencyMs: endTime - startTime,
              input: input?.messages,
              error: error instanceof Error ? error.message : String(error),
            };
            interaction.spans.push(span);
          } else {
            context.sendTrace({
              traceId,
              provider: 'bedrock' as TraceData['provider'],
              model: modelId,
              input: input?.messages,
              startTime,
              endTime,
              latencyMs: endTime - startTime,
              userId,
              conversationId: options?.raindrop?.conversationId,
              properties: options?.raindrop?.properties,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          throw error;
        }
      },
    };

    return Object.assign({ stream: wrappedStream }, { _traceId: traceId });
  } catch (error) {
    const endTime = Date.now();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: input?.messages,
        error: error instanceof Error ? error.message : String(error),
      };
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider: 'bedrock' as TraceData['provider'],
        model: modelId,
        input: input?.messages,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  }
}

/**
 * Extract output text from various Bedrock model response formats
 */
function extractOutputText(data: unknown, modelId: string): string | undefined {
  const d = data as Record<string, unknown>;

  // Claude models
  if (modelId.includes('claude') || modelId.includes('anthropic')) {
    if (d.completion) return d.completion as string;
    if (d.content && Array.isArray(d.content)) {
      return (d.content as Array<{ text?: string }>)
        .map(c => c.text)
        .filter(Boolean)
        .join('');
    }
  }

  // Titan models
  if (modelId.includes('titan')) {
    if (d.results && Array.isArray(d.results)) {
      return (d.results as Array<{ outputText?: string }>)
        .map(r => r.outputText)
        .filter(Boolean)
        .join('');
    }
  }

  // Llama models
  if (modelId.includes('llama') || modelId.includes('meta')) {
    if (d.generation) return d.generation as string;
  }

  // Mistral models
  if (modelId.includes('mistral')) {
    if (d.outputs && Array.isArray(d.outputs)) {
      return (d.outputs as Array<{ text?: string }>)
        .map(o => o.text)
        .filter(Boolean)
        .join('');
    }
  }

  // Cohere models
  if (modelId.includes('cohere')) {
    if (d.generations && Array.isArray(d.generations)) {
      return (d.generations as Array<{ text?: string }>)
        .map(g => g.text)
        .filter(Boolean)
        .join('');
    }
  }

  // AI21 models
  if (modelId.includes('ai21')) {
    if (d.completions && Array.isArray(d.completions)) {
      return (d.completions as Array<{ data?: { text?: string } }>)
        .map(c => c.data?.text)
        .filter(Boolean)
        .join('');
    }
  }

  return undefined;
}
