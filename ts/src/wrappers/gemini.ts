/**
 * Google Gemini SDK Wrapper
 * Wraps @google/genai client to auto-capture all generateContent calls
 *
 * Supports:
 * - ai.models.generateContent() (non-streaming)
 * - ai.models.generateContentStream() (streaming)
 * - Thinking/reasoning features
 * - Multi-modal inputs
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

// Minimal type definitions for @google/genai
type GeminiClient = {
  models: {
    generateContent: (params: unknown) => Promise<unknown>;
    generateContentStream?: (params: unknown) => Promise<unknown>;
  };
};

type GenerateContentParams = {
  model: string;
  contents: unknown;
  config?: {
    thinkingConfig?: {
      thinkingLevel?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type GenerateContentResponse = {
  text: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
};

type StreamChunk = {
  text?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

export interface GeminiWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  notifySpan: (span: SpanData) => void;
  debug: boolean;
}

/**
 * Creates a wrapped Gemini client that auto-traces all calls
 */
export function wrapGemini<T extends GeminiClient>(
  client: T,
  context: GeminiWrapperContext
): T {
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);

  // Wrap models.generateContent
  if (client.models?.generateContent) {
    const originalGenerateContent = client.models.generateContent.bind(client.models);
    wrappedClient.models = Object.create(client.models);
    wrappedClient.models.generateContent = wrapGenerateContent(originalGenerateContent, context);

    // Also wrap generateContentStream if it exists
    if (client.models.generateContentStream) {
      const originalStream = client.models.generateContentStream.bind(client.models);
      wrappedClient.models.generateContentStream = wrapGenerateContentStream(originalStream, context);
    }
  }

  return wrappedClient as T;
}

/**
 * Wrap models.generateContent
 */
function wrapGenerateContent(
  originalFn: (params: unknown) => Promise<unknown>,
  context: GeminiWrapperContext
) {
  return async (
    params: GenerateContentParams,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<GenerateContentResponse>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    if (context.debug) {
      console.log('[raindrop] Gemini generateContent started:', traceId);
    }

    try {
      const response = await originalFn(params) as GenerateContentResponse;
      const endTime = Date.now();

      // Extract output text
      const output = response.text || extractTextFromCandidates(response.candidates);

      // Extract function calls
      const toolCalls = extractFunctionCalls(response.candidates);

      // Check if we're within an interaction
      const interaction = context.getInteractionContext();

      if (interaction) {
        // Add as span to the interaction
        const span: SpanData = {
          spanId: traceId,
          parentId: interaction.interactionId,
          name: `gemini:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.contents,
          output,
          properties: {
            ...options?.raindrop?.properties,
            input_tokens: response.usageMetadata?.promptTokenCount,
            output_tokens: response.usageMetadata?.candidatesTokenCount,
            thoughts_tokens: response.usageMetadata?.thoughtsTokenCount,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            thinking_level: params.config?.thinkingConfig?.thinkingLevel,
          },
        };
        context.notifySpan(span);
        interaction.spans.push(span);
      } else {
        // Standalone - send as trace
        context.sendTrace({
          traceId,
          provider: 'google',
          model: params.model,
          input: params.contents,
          output,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          tokens: response.usageMetadata ? {
            input: response.usageMetadata.promptTokenCount || 0,
            output: response.usageMetadata.candidatesTokenCount || 0,
            total: response.usageMetadata.totalTokenCount || 0,
          } : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          userId,
          conversationId: options?.raindrop?.conversationId,
          properties: {
            ...options?.raindrop?.properties,
            thoughts_tokens: response.usageMetadata?.thoughtsTokenCount,
            thinking_level: params.config?.thinkingConfig?.thinkingLevel,
          },
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
          name: `gemini:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.contents,
          error: error instanceof Error ? error.message : String(error),
        };
        context.notifySpan(span);
        interaction.spans.push(span);
      } else {
        context.sendTrace({
          traceId,
          provider: 'google',
          model: params.model,
          input: params.contents,
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

/**
 * Wrap models.generateContentStream
 */
function wrapGenerateContentStream(
  originalFn: (params: unknown) => Promise<unknown>,
  context: GeminiWrapperContext
) {
  return async (
    params: GenerateContentParams,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<AsyncIterable<StreamChunk>>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    if (context.debug) {
      console.log('[raindrop] Gemini generateContentStream started:', traceId);
    }

    const stream = await originalFn(params) as AsyncIterable<StreamChunk>;
    return wrapStream(stream, {
      traceId,
      startTime,
      userId,
      conversationId: options?.raindrop?.conversationId,
      properties: options?.raindrop?.properties,
      model: params.model,
      input: params.contents,
      thinkingLevel: params.config?.thinkingConfig?.thinkingLevel,
      context,
    });
  };
}

/**
 * Wrap a stream to capture events and send trace on completion
 */
function wrapStream(
  stream: AsyncIterable<StreamChunk>,
  options: {
    traceId: string;
    startTime: number;
    userId?: string;
    conversationId?: string;
    properties?: Record<string, unknown>;
    model: string;
    input: unknown;
    thinkingLevel?: string;
    context: GeminiWrapperContext;
  }
): WithTraceId<AsyncIterable<StreamChunk>> {
  const interaction = options.context.getInteractionContext();
  const collectedText: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  let usageMetadata: StreamChunk['usageMetadata'];

  const wrappedStream = {
    [Symbol.asyncIterator]: async function* () {
      try {
        for await (const chunk of stream) {
          // Collect text
          if (chunk.text) {
            collectedText.push(chunk.text);
          } else if (chunk.candidates) {
            const text = extractTextFromCandidates(chunk.candidates);
            if (text) collectedText.push(text);

            // Collect function calls
            const calls = extractFunctionCalls(chunk.candidates);
            toolCalls.push(...calls);
          }

          // Capture usage metadata (usually in final chunk)
          if (chunk.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }

          yield chunk;
        }

        // Stream complete - send trace
        const endTime = Date.now();
        const output = collectedText.join('');

        if (interaction) {
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `gemini:${options.model}`,
            type: 'ai',
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            input: options.input,
            output,
            properties: {
              ...options.properties,
              input_tokens: usageMetadata?.promptTokenCount,
              output_tokens: usageMetadata?.candidatesTokenCount,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              thinking_level: options.thinkingLevel,
            },
          };
          options.context.notifySpan(span);
          interaction.spans.push(span);
        } else {
          options.context.sendTrace({
            traceId: options.traceId,
            provider: 'google',
            model: options.model,
            input: options.input,
            output,
            startTime: options.startTime,
            endTime,
            latencyMs: endTime - options.startTime,
            tokens: usageMetadata ? {
              input: usageMetadata.promptTokenCount || 0,
              output: usageMetadata.candidatesTokenCount || 0,
              total: usageMetadata.totalTokenCount || 0,
            } : undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            userId: options.userId,
            conversationId: options.conversationId,
            properties: {
              ...options.properties,
              thinking_level: options.thinkingLevel,
            },
          });
        }
      } catch (error) {
        const endTime = Date.now();

        if (interaction) {
          const span: SpanData = {
            spanId: options.traceId,
            parentId: interaction.interactionId,
            name: `gemini:${options.model}`,
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
            provider: 'google',
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

  return wrappedStream as WithTraceId<AsyncIterable<StreamChunk>>;
}

/**
 * Extract text from candidates array
 */
function extractTextFromCandidates(
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
): string {
  if (!candidates) return '';
  return candidates
    .flatMap(c => c.content?.parts || [])
    .map(p => p.text || '')
    .join('');
}

/**
 * Extract function calls from candidates
 */
function extractFunctionCalls(
  candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name: string; args: Record<string, unknown> } }> } }>
): Array<{ id: string; name: string; arguments: unknown }> {
  if (!candidates) return [];

  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];

  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        calls.push({
          id: '', // Gemini doesn't use IDs for function calls
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
      }
    }
  }

  return calls;
}
