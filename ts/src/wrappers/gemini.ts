/**
 * Google Gemini SDK Wrapper
 * Wraps @google/generative-ai client to auto-capture all generateContent calls
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

// Gemini client type (from @google/generative-ai)
type GeminiClient = {
  getGenerativeModel: (config: { model: string }) => GenerativeModel;
};

type GenerativeModel = {
  generateContent: (request: GenerateContentRequest) => Promise<GenerateContentResult>;
  generateContentStream: (request: GenerateContentRequest) => Promise<GenerateContentStreamResult>;
  model: string;
};

type GenerateContentRequest = string | {
  contents: Array<{
    role: string;
    parts: Array<{ text?: string; inlineData?: unknown }>;
  }>;
  [key: string]: unknown;
};

type GenerateContentResult = {
  response: {
    text: () => string;
    candidates?: Array<{
      content: {
        parts: Array<{ text?: string }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount: number;
      candidatesTokenCount: number;
      totalTokenCount: number;
    };
  };
};

type GenerateContentStreamResult = {
  stream: AsyncIterable<{
    text: () => string;
    candidates?: Array<{
      content: {
        parts: Array<{ text?: string }>;
      };
    }>;
  }>;
  response: Promise<GenerateContentResult['response']>;
};

export interface GeminiWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  debug: boolean;
}

/**
 * Creates a wrapped Gemini client that auto-traces all calls
 */
export function wrapGemini<T extends GeminiClient>(
  client: T,
  context: GeminiWrapperContext
): T {
  const originalGetModel = client.getGenerativeModel.bind(client);

  const wrappedGetModel = (config: { model: string }): GenerativeModel => {
    const model = originalGetModel(config);
    return wrapGenerativeModel(model, context);
  };

  // Create wrapped client
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);
  wrappedClient.getGenerativeModel = wrappedGetModel;

  return wrappedClient as T;
}

/**
 * Wrap a GenerativeModel instance
 */
function wrapGenerativeModel(
  model: GenerativeModel,
  context: GeminiWrapperContext
): GenerativeModel {
  const originalGenerate = model.generateContent.bind(model);
  const originalStream = model.generateContentStream?.bind(model);

  const wrappedModel = Object.create(Object.getPrototypeOf(model));
  Object.assign(wrappedModel, model);

  wrappedModel.generateContent = async (
    request: GenerateContentRequest,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<GenerateContentResult>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    if (context.debug) {
      console.log('[raindrop] Gemini generateContent started:', traceId);
    }

    try {
      const result = await originalGenerate(request);
      const endTime = Date.now();

      const output = result.response.text();
      const usage = result.response.usageMetadata;

      const interaction = context.getInteractionContext();

      if (interaction) {
        const span: SpanData = {
          spanId: traceId,
          parentId: interaction.interactionId,
          name: `gemini:${model.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: request,
          output,
          properties: {
            ...options?.raindrop?.properties,
            input_tokens: usage?.promptTokenCount,
            output_tokens: usage?.candidatesTokenCount,
          },
        };
        interaction.spans.push(span);
      } else {
        context.sendTrace({
          traceId,
          provider: 'gemini' as TraceData['provider'],
          model: model.model,
          input: request,
          output,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          tokens: usage ? {
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
            total: usage.totalTokenCount,
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
          name: `gemini:${model.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: request,
          error: error instanceof Error ? error.message : String(error),
        };
        interaction.spans.push(span);
      } else {
        context.sendTrace({
          traceId,
          provider: 'gemini' as TraceData['provider'],
          model: model.model,
          input: request,
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

  // Wrap streaming if available
  if (originalStream) {
    wrappedModel.generateContentStream = async (
      request: GenerateContentRequest,
      options?: { raindrop?: RaindropRequestOptions }
    ): Promise<WithTraceId<GenerateContentStreamResult>> => {
      const traceId = options?.raindrop?.traceId || context.generateTraceId();
      const startTime = Date.now();
      const userId = options?.raindrop?.userId || context.getUserId();
      const interaction = context.getInteractionContext();

      if (context.debug) {
        console.log('[raindrop] Gemini generateContentStream started:', traceId);
      }

      try {
        const result = await originalStream(request);
        const collectedText: string[] = [];

        const wrappedStream = {
          [Symbol.asyncIterator]: async function* () {
            try {
              for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) {
                  collectedText.push(text);
                }
                yield chunk;
              }

              // Stream complete - get final response for usage
              const finalResponse = await result.response;
              const endTime = Date.now();
              const output = collectedText.join('');
              const usage = finalResponse.usageMetadata;

              if (interaction) {
                const span: SpanData = {
                  spanId: traceId,
                  parentId: interaction.interactionId,
                  name: `gemini:${model.model}`,
                  type: 'ai',
                  startTime,
                  endTime,
                  latencyMs: endTime - startTime,
                  input: request,
                  output,
                  properties: {
                    ...options?.raindrop?.properties,
                    input_tokens: usage?.promptTokenCount,
                    output_tokens: usage?.candidatesTokenCount,
                  },
                };
                interaction.spans.push(span);
              } else {
                context.sendTrace({
                  traceId,
                  provider: 'gemini' as TraceData['provider'],
                  model: model.model,
                  input: request,
                  output,
                  startTime,
                  endTime,
                  latencyMs: endTime - startTime,
                  tokens: usage ? {
                    input: usage.promptTokenCount,
                    output: usage.candidatesTokenCount,
                    total: usage.totalTokenCount,
                  } : undefined,
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
                  name: `gemini:${model.model}`,
                  type: 'ai',
                  startTime,
                  endTime,
                  latencyMs: endTime - startTime,
                  input: request,
                  error: error instanceof Error ? error.message : String(error),
                };
                interaction.spans.push(span);
              } else {
                context.sendTrace({
                  traceId,
                  provider: 'gemini' as TraceData['provider'],
                  model: model.model,
                  input: request,
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

        return Object.assign(
          { stream: wrappedStream, response: result.response },
          { _traceId: traceId }
        );
      } catch (error) {
        const endTime = Date.now();

        if (interaction) {
          const span: SpanData = {
            spanId: traceId,
            parentId: interaction.interactionId,
            name: `gemini:${model.model}`,
            type: 'ai',
            startTime,
            endTime,
            latencyMs: endTime - startTime,
            input: request,
            error: error instanceof Error ? error.message : String(error),
          };
          interaction.spans.push(span);
        } else {
          context.sendTrace({
            traceId,
            provider: 'gemini' as TraceData['provider'],
            model: model.model,
            input: request,
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
  }

  return wrappedModel;
}
