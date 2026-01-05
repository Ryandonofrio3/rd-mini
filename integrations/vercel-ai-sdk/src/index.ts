/**
 * Raindrop integration for Vercel AI SDK
 *
 * Provides automatic tracing for Vercel AI SDK models.
 *
 * Usage:
 *   import { openai } from "@ai-sdk/openai";
 *   import { wrapModel } from "@raindrop/vercel-ai";
 *
 *   const raindrop = new Raindrop({ apiKey: "..." });
 *   const model = wrapModel(raindrop, openai("gpt-4"));
 *
 *   const { text } = await generateText({ model, prompt: "Hello" });
 */

import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from "ai";

export interface RaindropContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  debug: boolean;
}

export interface TraceData {
  traceId: string;
  provider: string;
  model: string;
  input: unknown;
  output?: string;
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  userId?: string;
  conversationId?: string;
  error?: string;
  properties?: Record<string, unknown>;
}

export interface RaindropOptions {
  userId?: string;
  conversationId?: string;
  traceId?: string;
  properties?: Record<string, unknown>;
}

/**
 * Wrap a Vercel AI SDK model for automatic tracing.
 */
export function wrapModel(
  context: RaindropContext,
  model: LanguageModelV1,
): LanguageModelV1 {
  return {
    ...model,
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    defaultObjectGenerationMode: model.defaultObjectGenerationMode,

    async doGenerate(
      options: LanguageModelV1CallOptions,
    ): Promise<Awaited<ReturnType<LanguageModelV1["doGenerate"]>>> {
      const raindropOpts = (options as unknown as { raindrop?: RaindropOptions }).raindrop;
      const traceId = raindropOpts?.traceId || context.generateTraceId();
      const startTime = Date.now();

      if (context.debug) {
        console.log(`[raindrop] AI SDK generate started: ${traceId}`);
      }

      try {
        const result = await model.doGenerate(options);

        const endTime = Date.now();
        const output = result.text || "";

        context.sendTrace({
          traceId,
          provider: model.provider,
          model: model.modelId,
          input: options.prompt,
          output,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          tokens: result.usage
            ? {
                input: result.usage.promptTokens,
                output: result.usage.completionTokens,
                total: result.usage.promptTokens + result.usage.completionTokens,
              }
            : undefined,
          userId: raindropOpts?.userId || context.getUserId(),
          conversationId: raindropOpts?.conversationId,
          properties: raindropOpts?.properties,
        });

        // Attach trace ID to result
        (result as unknown as { _traceId: string })._traceId = traceId;

        return result;
      } catch (error) {
        const endTime = Date.now();

        context.sendTrace({
          traceId,
          provider: model.provider,
          model: model.modelId,
          input: options.prompt,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          userId: raindropOpts?.userId || context.getUserId(),
          conversationId: raindropOpts?.conversationId,
          properties: raindropOpts?.properties,
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    },

    async doStream(
      options: LanguageModelV1CallOptions,
    ): Promise<Awaited<ReturnType<LanguageModelV1["doStream"]>>> {
      const raindropOpts = (options as unknown as { raindrop?: RaindropOptions }).raindrop;
      const traceId = raindropOpts?.traceId || context.generateTraceId();
      const startTime = Date.now();

      if (context.debug) {
        console.log(`[raindrop] AI SDK stream started: ${traceId}`);
      }

      const result = await model.doStream(options);

      // Wrap the stream to capture output
      const originalStream = result.stream;
      const collectedContent: string[] = [];
      let promptTokens = 0;
      let completionTokens = 0;

      const wrappedStream = new ReadableStream<LanguageModelV1StreamPart>({
        async start(controller) {
          const reader = originalStream.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                // Stream complete - send trace
                const endTime = Date.now();
                context.sendTrace({
                  traceId,
                  provider: model.provider,
                  model: model.modelId,
                  input: options.prompt,
                  output: collectedContent.join(""),
                  startTime,
                  endTime,
                  latencyMs: endTime - startTime,
                  tokens:
                    promptTokens || completionTokens
                      ? {
                          input: promptTokens,
                          output: completionTokens,
                          total: promptTokens + completionTokens,
                        }
                      : undefined,
                  userId: raindropOpts?.userId || context.getUserId(),
                  conversationId: raindropOpts?.conversationId,
                  properties: raindropOpts?.properties,
                });

                controller.close();
                break;
              }

              // Collect content
              if (value.type === "text-delta") {
                collectedContent.push(value.textDelta);
              }

              // Collect usage
              if (value.type === "finish") {
                if (value.usage) {
                  promptTokens = value.usage.promptTokens;
                  completionTokens = value.usage.completionTokens;
                }
              }

              controller.enqueue(value);
            }
          } catch (error) {
            const endTime = Date.now();
            context.sendTrace({
              traceId,
              provider: model.provider,
              model: model.modelId,
              input: options.prompt,
              startTime,
              endTime,
              latencyMs: endTime - startTime,
              userId: raindropOpts?.userId || context.getUserId(),
              conversationId: raindropOpts?.conversationId,
              properties: raindropOpts?.properties,
              error: error instanceof Error ? error.message : String(error),
            });

            controller.error(error);
          }
        },
      });

      return {
        ...result,
        stream: wrappedStream,
      };
    },
  };
}

/**
 * Create a Raindrop context from configuration.
 * Use this if you're not using the main Raindrop SDK.
 */
export function createRaindropContext(config: {
  apiKey: string;
  baseUrl?: string;
  debug?: boolean;
}): RaindropContext {
  let currentUserId: string | undefined;

  return {
    generateTraceId: () => `trace_${crypto.randomUUID()}`,
    sendTrace: (trace) => {
      // Fire and forget
      fetch(`${config.baseUrl || "https://api.raindrop.ai"}/v1/events/track`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify([
          {
            event_id: trace.traceId,
            user_id: trace.userId,
            event: "ai_interaction",
            timestamp: new Date(trace.startTime).toISOString(),
            properties: {
              provider: trace.provider,
              latency_ms: trace.latencyMs,
              input_tokens: trace.tokens?.input,
              output_tokens: trace.tokens?.output,
              ...(trace.error ? { error: trace.error } : {}),
              ...trace.properties,
            },
            ai_data: {
              model: trace.model,
              input: JSON.stringify(trace.input),
              output: trace.output,
              convo_id: trace.conversationId,
            },
          },
        ]),
      }).catch(() => {
        if (config.debug) {
          console.error("[raindrop] Failed to send trace");
        }
      });
    },
    getUserId: () => currentUserId,
    debug: config.debug || false,
  };
}
