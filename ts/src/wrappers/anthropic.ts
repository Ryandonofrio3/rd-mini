/**
 * Anthropic SDK Wrapper
 * Wraps Anthropic client to auto-capture all message creations
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

type AnthropicClient = {
  messages: {
    create: (params: unknown, options?: unknown) => Promise<unknown>;
  };
};

type MessageParams = {
  model: string;
  messages: Array<{ role: string; content: string | unknown[] }>;
  max_tokens: number;
  stream?: boolean;
  tools?: unknown[];
  [key: string]: unknown;
};

type MessageResponse = {
  id: string;
  content: Array<{
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};

type StreamEvent = {
  type: string;
  delta?: {
    type?: string;
    text?: string;
  };
  content_block?: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  message?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
};

export interface AnthropicWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  notifySpan: (span: SpanData) => void;
  debug: boolean;
}

/**
 * Creates a wrapped Anthropic client that auto-traces all calls
 */
export function wrapAnthropic<T extends AnthropicClient>(
  client: T,
  context: AnthropicWrapperContext
): T {
  const originalCreate = client.messages.create.bind(client.messages);

  const wrappedCreate = async (
    params: MessageParams,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<MessageResponse> | WithTraceId<AsyncIterable<StreamEvent>>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    if (context.debug) {
      console.log('[raindrop] Anthropic request started:', traceId);
    }

    // Handle streaming
    if (params.stream) {
      const stream = await originalCreate(params, options) as AsyncIterable<StreamEvent>;
      return wrapStream(stream, {
        traceId,
        startTime,
        userId,
        conversationId: options?.raindrop?.conversationId,
        properties: options?.raindrop?.properties,
        model: params.model,
        input: params.messages,
        context,
      });
    }

    // Handle non-streaming
    try {
      const response = await originalCreate(params, options) as MessageResponse;
      const endTime = Date.now();

      // Extract text output
      const textBlocks = response.content.filter(c => c.type === 'text');
      const output = textBlocks.map(c => c.text).join('');

      // Extract tool calls
      const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
      const toolCalls = toolUseBlocks.map(c => ({
        id: c.id || '',
        name: c.name || '',
        arguments: c.input,
      }));

      // Check if we're within an interaction
      const interaction = context.getInteractionContext();

      if (interaction) {
        // Add as span to the interaction
        const span: SpanData = {
          spanId: traceId,
          parentId: interaction.interactionId,
          name: `anthropic:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.messages,
          output,
          properties: {
            ...options?.raindrop?.properties,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
        };
        context.notifySpan(span);
          interaction.spans.push(span);
      } else {
        // Send trace
        context.sendTrace({
          traceId,
          provider: 'anthropic',
          model: params.model,
          input: params.messages,
          output,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          tokens: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
            total: response.usage.input_tokens + response.usage.output_tokens,
          },
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          userId,
          conversationId: options?.raindrop?.conversationId,
          properties: options?.raindrop?.properties,
        });
      }

      return Object.assign(response, { _traceId: traceId });
    } catch (error) {
      const endTime = Date.now();
      const interaction = context.getInteractionContext();

      if (interaction) {
        const span: SpanData = {
          spanId: traceId,
          parentId: interaction.interactionId,
          name: `anthropic:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.messages,
          error: error instanceof Error ? error.message : String(error),
        };
        context.notifySpan(span);
          interaction.spans.push(span);
      } else {
        context.sendTrace({
          traceId,
          provider: 'anthropic',
          model: params.model,
          input: params.messages,
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
  };

  // Create wrapped client
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);

  wrappedClient.messages = Object.create(client.messages);
  wrappedClient.messages.create = wrappedCreate;

  return wrappedClient as T;
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
    model: string;
    input: unknown;
    context: AnthropicWrapperContext;
  }
): WithTraceId<AsyncIterable<StreamEvent>> {
  const interaction = options.context.getInteractionContext();
  const collectedText: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  let usage = { input_tokens: 0, output_tokens: 0 };

  const wrappedStream = {
    [Symbol.asyncIterator]: async function* () {
      try {
        for await (const event of stream) {
          // Collect text deltas
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            collectedText.push(event.delta.text || '');
          }

          // Collect tool use blocks
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            toolCalls.push({
              id: event.content_block.id || '',
              name: event.content_block.name || '',
              arguments: event.content_block.input,
            });
          }

          // Collect usage from message_delta
          if (event.type === 'message_delta' && event.message?.usage) {
            usage = {
              input_tokens: event.message.usage.input_tokens || usage.input_tokens,
              output_tokens: event.message.usage.output_tokens || usage.output_tokens,
            };
          }

          yield event;
        }

        // Stream complete - send trace
        const endTime = Date.now();
        const output = collectedText.join('');

        if (interaction) {
          // Add as span to the interaction
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `anthropic:${options.model}`,
            type: 'ai',
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            input: options.input,
            output,
            properties: {
              ...options.properties,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            },
          };
          options.context.notifySpan(span);
          interaction.spans.push(span);
        } else {
          options.context.sendTrace({
            traceId: options.traceId,
            provider: 'anthropic',
            model: options.model,
            input: options.input,
            output,
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            tokens: {
              input: usage.input_tokens,
              output: usage.output_tokens,
              total: usage.input_tokens + usage.output_tokens,
            },
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            userId: options.userId,
            conversationId: options.conversationId,
            properties: options.properties,
          });
        }
      } catch (error) {
        const endTime = Date.now();

        if (interaction) {
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `anthropic:${options.model}`,
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
            provider: 'anthropic',
            model: options.model,
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
    _traceId: options.traceId,
  };

  return wrappedStream as WithTraceId<AsyncIterable<StreamEvent>>;
}
