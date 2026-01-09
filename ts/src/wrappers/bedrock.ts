/**
 * AWS Bedrock Runtime Wrapper
 * Wraps @aws-sdk/client-bedrock-runtime client to auto-capture all Converse calls
 *
 * Supports:
 * - client.send(new ConverseCommand()) (non-streaming)
 * - client.send(new ConverseStreamCommand()) (streaming)
 * - All Bedrock foundation models (Claude, Llama, Titan, Mistral, etc.)
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

/**
 * Safely parse JSON, returning the raw string if parsing fails.
 */
function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// Minimal type definitions for @aws-sdk/client-bedrock-runtime
// We use loose typing to avoid hard dependency on the AWS SDK

type BedrockClient = {
  send: (command: unknown) => Promise<unknown>;
};

type ConverseInput = {
  modelId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: Array<{
      text?: string;
      image?: unknown;
      document?: unknown;
      toolUse?: { toolUseId: string; name: string; input: unknown };
      toolResult?: { toolUseId: string; content: unknown };
    }>;
  }>;
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools?: Array<{
      toolSpec?: {
        name: string;
        description?: string;
        inputSchema?: unknown;
      };
    }>;
  };
  [key: string]: unknown;
};

type ConverseOutput = {
  output?: {
    message?: {
      role: string;
      content: Array<{
        text?: string;
        toolUse?: { toolUseId: string; name: string; input: unknown };
      }>;
    };
  };
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  metrics?: {
    latencyMs: number;
  };
};

type ConverseStreamOutput = {
  stream?: AsyncIterable<StreamEvent>;
};

type StreamEvent = {
  messageStart?: { role: string };
  contentBlockStart?: { contentBlockIndex: number; start?: { toolUse?: { toolUseId: string; name: string } } };
  contentBlockDelta?: { contentBlockIndex: number; delta?: { text?: string; toolUse?: { input?: string } } };
  contentBlockStop?: { contentBlockIndex: number };
  messageStop?: { stopReason: string };
  metadata?: { usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; metrics?: { latencyMs: number } };
};

// Command type detection
interface CommandLike {
  input?: ConverseInput;
  constructor?: { name?: string };
}

export interface BedrockWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  notifySpan: (span: SpanData) => void;
  debug: boolean;
}

/**
 * Creates a wrapped Bedrock client that auto-traces all Converse calls
 */
export function wrapBedrock<T extends BedrockClient>(
  client: T,
  context: BedrockWrapperContext
): T {
  const originalSend = client.send.bind(client);

  const wrappedSend = async (
    command: CommandLike,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<unknown> => {
    const commandName = command.constructor?.name || '';

    // Only trace Converse commands
    if (commandName === 'ConverseCommand') {
      return handleConverse(originalSend, command, options, context);
    }

    if (commandName === 'ConverseStreamCommand') {
      return handleConverseStream(originalSend, command, options, context);
    }

    // Pass through other commands unchanged
    return originalSend(command);
  };

  // Create wrapped client
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);
  wrappedClient.send = wrappedSend;

  return wrappedClient as T;
}

/**
 * Handle ConverseCommand (non-streaming)
 */
async function handleConverse(
  originalSend: (command: unknown) => Promise<unknown>,
  command: CommandLike,
  options: { raindrop?: RaindropRequestOptions } | undefined,
  context: BedrockWrapperContext
): Promise<WithTraceId<ConverseOutput>> {
  const input = command.input as ConverseInput;
  const traceId = options?.raindrop?.traceId || context.generateTraceId();
  const startTime = Date.now();
  const userId = options?.raindrop?.userId || context.getUserId();

  if (context.debug) {
    console.log('[raindrop] Bedrock Converse started:', traceId);
  }

  try {
    const response = await originalSend(command) as ConverseOutput;
    const endTime = Date.now();

    // Extract output
    const outputMessage = response.output?.message;
    const outputText = outputMessage?.content
      ?.filter(c => c.text)
      .map(c => c.text)
      .join('') || '';

    // Extract tool calls
    const toolCalls = outputMessage?.content
      ?.filter(c => c.toolUse)
      .map(c => ({
        id: c.toolUse!.toolUseId,
        name: c.toolUse!.name,
        arguments: c.toolUse!.input,
      })) || [];

    // Infer provider from model ID
    const provider = inferProvider(input.modelId);

    // Check if we're within an interaction
    const interaction = context.getInteractionContext();

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${input.modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: input.messages,
        output: outputText,
        properties: {
          ...options?.raindrop?.properties,
          input_tokens: response.usage?.inputTokens,
          output_tokens: response.usage?.outputTokens,
          stop_reason: response.stopReason,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      };
      context.notifySpan(span);
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider,
        model: input.modelId,
        input: input.messages,
        output: outputText,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        tokens: response.usage ? {
          input: response.usage.inputTokens,
          output: response.usage.outputTokens,
          total: response.usage.totalTokens,
        } : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: {
          ...options?.raindrop?.properties,
          stop_reason: response.stopReason,
        },
      });
    }

    return Object.assign(response, { _traceId: traceId });
  } catch (error) {
    const endTime = Date.now();
    const interaction = context.getInteractionContext();
    const provider = inferProvider(input.modelId);

    if (interaction) {
      const span: SpanData = {
        spanId: traceId,
        parentId: interaction.interactionId,
        name: `bedrock:${input.modelId}`,
        type: 'ai',
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        input: input.messages,
        error: error instanceof Error ? error.message : String(error),
      };
      context.notifySpan(span);
      interaction.spans.push(span);
    } else {
      context.sendTrace({
        traceId,
        provider,
        model: input.modelId,
        input: input.messages,
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
 * Handle ConverseStreamCommand (streaming)
 */
async function handleConverseStream(
  originalSend: (command: unknown) => Promise<unknown>,
  command: CommandLike,
  options: { raindrop?: RaindropRequestOptions } | undefined,
  context: BedrockWrapperContext
): Promise<WithTraceId<ConverseStreamOutput>> {
  const input = command.input as ConverseInput;
  const traceId = options?.raindrop?.traceId || context.generateTraceId();
  const startTime = Date.now();
  const userId = options?.raindrop?.userId || context.getUserId();

  if (context.debug) {
    console.log('[raindrop] Bedrock ConverseStream started:', traceId);
  }

  const response = await originalSend(command) as ConverseStreamOutput;

  if (!response.stream) {
    return Object.assign(response, { _traceId: traceId });
  }

  // Wrap the stream
  const wrappedStream = wrapStream(response.stream, {
    traceId,
    startTime,
    userId,
    conversationId: options?.raindrop?.conversationId,
    properties: options?.raindrop?.properties,
    modelId: input.modelId,
    input: input.messages,
    context,
  });

  return Object.assign({ stream: wrappedStream }, { _traceId: traceId });
}

/**
 * Wrap a stream to capture events and send trace on completion
 */
function wrapStream(
  stream: AsyncIterable<StreamEvent>,
  options: {
    traceId: string;
    startTime: number;
    userId?: string;
    conversationId?: string;
    properties?: Record<string, unknown>;
    modelId: string;
    input: unknown;
    context: BedrockWrapperContext;
  }
): AsyncIterable<StreamEvent> {
  const interaction = options.context.getInteractionContext();
  const collectedText: string[] = [];
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  let stopReason: string | undefined;

  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        for await (const event of stream) {
          // Collect text deltas
          if (event.contentBlockDelta?.delta?.text) {
            collectedText.push(event.contentBlockDelta.delta.text);
          }

          // Collect tool use start
          if (event.contentBlockStart?.start?.toolUse) {
            const idx = event.contentBlockStart.contentBlockIndex;
            toolCalls.set(idx, {
              id: event.contentBlockStart.start.toolUse.toolUseId,
              name: event.contentBlockStart.start.toolUse.name,
              arguments: '',
            });
          }

          // Collect tool use input deltas
          if (event.contentBlockDelta?.delta?.toolUse?.input) {
            const idx = event.contentBlockDelta.contentBlockIndex;
            const existing = toolCalls.get(idx);
            if (existing) {
              existing.arguments += event.contentBlockDelta.delta.toolUse.input;
            }
          }

          // Collect stop reason
          if (event.messageStop?.stopReason) {
            stopReason = event.messageStop.stopReason;
          }

          // Collect usage from metadata
          if (event.metadata?.usage) {
            usage = event.metadata.usage;
          }

          yield event;
        }

        // Stream complete - send trace
        const endTime = Date.now();
        const output = collectedText.join('');
        const provider = inferProvider(options.modelId);

        const parsedToolCalls = Array.from(toolCalls.values()).map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? safeJsonParse(tc.arguments) : {},
        }));

        if (interaction) {
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `bedrock:${options.modelId}`,
            type: 'ai',
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            input: options.input,
            output,
            properties: {
              ...options.properties,
              input_tokens: usage?.inputTokens,
              output_tokens: usage?.outputTokens,
              stop_reason: stopReason,
              tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
            },
          };
          options.context.notifySpan(span);
          interaction.spans.push(span);
        } else {
          options.context.sendTrace({
            traceId: options.traceId,
            provider,
            model: options.modelId,
            input: options.input,
            output,
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            tokens: usage ? {
              input: usage.inputTokens,
              output: usage.outputTokens,
              total: usage.totalTokens,
            } : undefined,
            toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
            userId: options.userId,
            conversationId: options.conversationId,
            properties: {
              ...options.properties,
              stop_reason: stopReason,
            },
          });
        }
      } catch (error) {
        const endTime = Date.now();
        const provider = inferProvider(options.modelId);

        if (interaction) {
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `bedrock:${options.modelId}`,
            type: 'ai',
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            input: options.input,
            error: error instanceof Error ? error.message : String(error),
          };
          options.context.notifySpan(span);
          interaction.spans.push(span);
        } else {
          options.context.sendTrace({
            traceId: options.traceId,
            provider,
            model: options.modelId,
            input: options.input,
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            userId: options.userId,
            conversationId: options.conversationId,
            properties: options.properties,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        throw error;
      }
    },
  };
}

/**
 * Infer provider from Bedrock model ID
 */
function inferProvider(modelId: string): string {
  const id = modelId.toLowerCase();

  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic';
  if (id.includes('amazon') || id.includes('titan') || id.includes('nova')) return 'amazon';
  if (id.includes('meta') || id.includes('llama')) return 'meta';
  if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
  if (id.includes('cohere') || id.includes('command')) return 'cohere';
  if (id.includes('ai21') || id.includes('jamba') || id.includes('jurassic')) return 'ai21';
  if (id.includes('stability') || id.includes('stable')) return 'stability';

  return 'bedrock';
}
