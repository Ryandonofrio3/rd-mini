/**
 * Vercel AI SDK Wrapper
 * Wraps AI SDK model providers to auto-capture all calls
 */

import type { TraceData, RaindropRequestOptions, InteractionContext, SpanData } from '../types.js';

// Vercel AI SDK model type (simplified)
type LanguageModel = {
  modelId: string;
  provider: string;
  doGenerate?: (options: unknown) => Promise<unknown>;
  doStream?: (options: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

export interface AISDKWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  notifySpan: (span: SpanData) => void;
  debug: boolean;
}

/**
 * Wrap a Vercel AI SDK model to auto-trace calls
 *
 * Usage:
 *   const model = raindrop.wrap(openai('gpt-4o'));
 *   const result = await generateText({ model, prompt: '...' });
 */
export function wrapAISDKModel<T extends LanguageModel>(
  model: T,
  context: AISDKWrapperContext,
  defaultOptions?: RaindropRequestOptions
): T & { _raindropContext: AISDKWrapperContext; _raindropOptions?: RaindropRequestOptions } {
  // Create a proxy that intercepts method calls
  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Intercept doGenerate (non-streaming)
      if (prop === 'doGenerate' && typeof value === 'function') {
        return async function(this: T, options: Record<string, unknown>) {
          const traceId = (defaultOptions?.traceId) || context.generateTraceId();
          const startTime = Date.now();
          const userId = defaultOptions?.userId || context.getUserId();

          if (context.debug) {
            console.log('[raindrop] AI SDK generate started:', traceId);
          }

          try {
            const result = await value.call(target, options) as Record<string, unknown>;
            const endTime = Date.now();

            // Extract data from result
            const text = result.text as string || '';
            const usage = result.usage as { promptTokens?: number; completionTokens?: number } | undefined;
            const toolCalls = result.toolCalls as Array<{ toolName: string; args: unknown }> | undefined;

            // Check if we're within an interaction
            const interaction = context.getInteractionContext();

            if (interaction) {
              // Add as span to the interaction
              const span: SpanData = {
                spanId: traceId,
                parentId: interaction.interactionId,
                name: `ai-sdk:${target.modelId}`,
                type: 'ai',
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                input: options.prompt || options.messages,
                output: text,
                properties: {
                  ...defaultOptions?.properties,
                  input_tokens: usage?.promptTokens,
                  output_tokens: usage?.completionTokens,
                  tool_calls: toolCalls?.map(tc => ({ name: tc.toolName, arguments: tc.args })),
                },
              };
              context.notifySpan(span);
              interaction.spans.push(span);
            } else {
              context.sendTrace({
                traceId,
                provider: 'ai-sdk',
                model: target.modelId,
                input: options.prompt || options.messages,
                output: text,
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                tokens: usage ? {
                  input: usage.promptTokens,
                  output: usage.completionTokens,
                  total: (usage.promptTokens || 0) + (usage.completionTokens || 0),
                } : undefined,
                toolCalls: toolCalls?.map(tc => ({
                  id: '',
                  name: tc.toolName,
                  arguments: tc.args,
                })),
                userId,
                conversationId: defaultOptions?.conversationId,
                properties: defaultOptions?.properties,
              });
            }

            // Attach traceId to result
            return Object.assign(result, { _traceId: traceId });
          } catch (error) {
            const endTime = Date.now();
            const interaction = context.getInteractionContext();

            if (interaction) {
              const span: SpanData = {
                spanId: traceId,
                parentId: interaction.interactionId,
                name: `ai-sdk:${target.modelId}`,
                type: 'ai',
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                input: options.prompt || options.messages,
                error: error instanceof Error ? error.message : String(error),
              };
              context.notifySpan(span);
              interaction.spans.push(span);
            } else {
              context.sendTrace({
                traceId,
                provider: 'ai-sdk',
                model: target.modelId,
                input: options.prompt || options.messages,
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                userId,
                conversationId: defaultOptions?.conversationId,
                properties: defaultOptions?.properties,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            throw error;
          }
        };
      }

      // Intercept doStream (streaming)
      if (prop === 'doStream' && typeof value === 'function') {
        return async function(this: T, options: Record<string, unknown>) {
          const traceId = (defaultOptions?.traceId) || context.generateTraceId();
          const startTime = Date.now();
          const userId = defaultOptions?.userId || context.getUserId();
          const interaction = context.getInteractionContext();

          if (context.debug) {
            console.log('[raindrop] AI SDK stream started:', traceId);
          }

          try {
            const result = await value.call(target, options) as {
              stream: AsyncIterable<unknown>;
              [key: string]: unknown;
            };

            // Wrap the stream to capture data
            const originalStream = result.stream;
            const collectedText: string[] = [];
            const collectedToolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
            let usage = { promptTokens: 0, completionTokens: 0 };

            const wrappedStream = {
              [Symbol.asyncIterator]: async function* () {
                try {
                  for await (const chunk of originalStream) {
                    const c = chunk as Record<string, unknown>;

                    // Collect text
                    if (c.type === 'text-delta' && typeof c.textDelta === 'string') {
                      collectedText.push(c.textDelta);
                    }

                    // Collect tool calls
                    if (c.type === 'tool-call' && c.toolName) {
                      collectedToolCalls.push({
                        id: (c.toolCallId as string) || '',
                        name: c.toolName as string,
                        arguments: c.args,
                      });
                    }

                    // Collect usage
                    if (c.type === 'finish' && c.usage) {
                      const u = c.usage as { promptTokens?: number; completionTokens?: number };
                      usage = {
                        promptTokens: u.promptTokens || 0,
                        completionTokens: u.completionTokens || 0,
                      };
                    }

                    yield chunk;
                  }

                  // Stream complete - send trace
                  const endTime = Date.now();
                  const output = collectedText.join('');

                  if (interaction) {
                    // Add as span to the interaction
                    const span: SpanData = {
                      spanId: traceId,
                      parentId: interaction.interactionId,
                      name: `ai-sdk:${target.modelId}`,
                      type: 'ai',
                      startTime,
                      endTime,
                      latencyMs: endTime - startTime,
                      input: options.prompt || options.messages,
                      output,
                      properties: {
                        ...defaultOptions?.properties,
                        input_tokens: usage.promptTokens,
                        output_tokens: usage.completionTokens,
                        tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                      },
                    };
                    context.notifySpan(span);
              interaction.spans.push(span);
                  } else {
                    context.sendTrace({
                      traceId,
                      provider: 'ai-sdk',
                      model: target.modelId,
                      input: options.prompt || options.messages,
                      output,
                      startTime,
                      endTime,
                      latencyMs: endTime - startTime,
                      tokens: {
                        input: usage.promptTokens,
                        output: usage.completionTokens,
                        total: usage.promptTokens + usage.completionTokens,
                      },
                      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                      userId,
                      conversationId: defaultOptions?.conversationId,
                      properties: defaultOptions?.properties,
                    });
                  }
                } catch (error) {
                  const endTime = Date.now();

                  if (interaction) {
                    const span: SpanData = {
                      spanId: traceId,
                      parentId: interaction.interactionId,
                      name: `ai-sdk:${target.modelId}`,
                      type: 'ai',
                      startTime,
                      endTime,
                      latencyMs: endTime - startTime,
                      input: options.prompt || options.messages,
                      error: error instanceof Error ? error.message : String(error),
                    };
                    context.notifySpan(span);
              interaction.spans.push(span);
                  } else {
                    context.sendTrace({
                      traceId,
                      provider: 'ai-sdk',
                      model: target.modelId,
                      input: options.prompt || options.messages,
                      startTime,
                      endTime,
                      latencyMs: endTime - startTime,
                      userId,
                      conversationId: defaultOptions?.conversationId,
                      properties: defaultOptions?.properties,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }

                  throw error;
                }
              },
            };

            return Object.assign(result, {
              stream: wrappedStream,
              _traceId: traceId,
            });
          } catch (error) {
            const endTime = Date.now();

            if (interaction) {
              const span: SpanData = {
                spanId: traceId,
                parentId: interaction.interactionId,
                name: `ai-sdk:${target.modelId}`,
                type: 'ai',
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                input: options.prompt || options.messages,
                error: error instanceof Error ? error.message : String(error),
              };
              context.notifySpan(span);
              interaction.spans.push(span);
            } else {
              context.sendTrace({
                traceId,
                provider: 'ai-sdk',
                model: target.modelId,
                input: options.prompt || options.messages,
                startTime,
                endTime,
                latencyMs: endTime - startTime,
                userId,
                conversationId: defaultOptions?.conversationId,
                properties: defaultOptions?.properties,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            throw error;
          }
        };
      }

      return value;
    },
  };

  const proxied = new Proxy(model, handler);

  // Attach context for potential later use
  return Object.assign(proxied, {
    _raindropContext: context,
    _raindropOptions: defaultOptions,
  });
}
