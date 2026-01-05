/**
 * OpenAI SDK Wrapper
 * Wraps OpenAI client to auto-capture chat completions AND the new Responses API
 */

import type { TraceData, RaindropRequestOptions, WithTraceId, InteractionContext, SpanData } from '../types.js';

// Client types - flexible to handle both APIs
type OpenAIClient = {
  chat?: {
    completions: {
      create: (params: unknown, options?: unknown) => Promise<unknown>;
    };
  };
  responses?: {
    create: (params: unknown, options?: unknown) => Promise<unknown>;
  };
};

// === CHAT COMPLETIONS TYPES ===
type ChatCompletionParams = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  tools?: unknown[];
  [key: string]: unknown;
};

type ChatCompletionResponse = {
  id: string;
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type StreamChunk = {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

// === RESPONSES API TYPES (new OpenAI API) ===
type ResponsesParams = {
  model: string;
  input: string | Array<{ role: string; content: unknown }>;
  stream?: boolean;
  instructions?: string;
  tools?: unknown[];
  previous_response_id?: string;
  conversation?: string | { id: string };
  [key: string]: unknown;
};

type ResponsesResponse = {
  id: string;
  status: string;
  model: string;
  output: Array<{
    type: string;
    id?: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
};

export interface OpenAIWrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  debug: boolean;
}

/**
 * Creates a wrapped OpenAI client that auto-traces all calls
 * Supports both chat.completions.create AND responses.create (new API)
 */
export function wrapOpenAI<T extends OpenAIClient>(
  client: T,
  context: OpenAIWrapperContext
): T {
  // Create wrapped client, preserving prototype chain
  const wrappedClient = Object.create(Object.getPrototypeOf(client));
  Object.assign(wrappedClient, client);

  // Wrap chat.completions.create if it exists
  if (client.chat?.completions?.create) {
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);
    wrappedClient.chat = Object.create(client.chat);
    wrappedClient.chat.completions = Object.create(client.chat.completions);
    wrappedClient.chat.completions.create = wrapChatCompletions(originalCreate, context);
  }

  // Wrap responses.create if it exists (new API)
  if (client.responses?.create) {
    const originalCreate = client.responses.create.bind(client.responses);
    wrappedClient.responses = Object.create(client.responses);
    wrappedClient.responses.create = wrapResponses(originalCreate, context);
  }

  return wrappedClient as T;
}

/**
 * Wrap chat.completions.create
 */
function wrapChatCompletions(
  originalCreate: (params: unknown, options?: unknown) => Promise<unknown>,
  context: OpenAIWrapperContext
) {
  return async (
    params: ChatCompletionParams,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<ChatCompletionResponse> | WithTraceId<AsyncIterable<StreamChunk>>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    if (context.debug) {
      console.log('[raindrop] OpenAI chat.completions started:', traceId);
    }

    // Handle streaming
    if (params.stream) {
      const stream = await originalCreate(params, options) as AsyncIterable<StreamChunk>;
      return wrapChatStream(stream, {
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
      const response = await originalCreate(params, options) as ChatCompletionResponse;
      const endTime = Date.now();

      const output = response.choices[0]?.message?.content || '';
      const toolCalls = response.choices[0]?.message?.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      // Check if we're within an interaction
      const interaction = context.getInteractionContext();

      if (interaction) {
        // Add as span to the interaction
        const span: SpanData = {
          spanId: traceId,
          parentId: interaction.interactionId,
          name: `openai:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.messages,
          output,
          properties: {
            ...options?.raindrop?.properties,
            input_tokens: response.usage?.prompt_tokens,
            output_tokens: response.usage?.completion_tokens,
            tool_calls: toolCalls,
          },
        };
        interaction.spans.push(span);
      } else {
        // Standalone - send as trace
        context.sendTrace({
          traceId,
          provider: 'openai',
          model: params.model,
          input: params.messages,
          output,
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          tokens: response.usage ? {
            input: response.usage.prompt_tokens,
            output: response.usage.completion_tokens,
            total: response.usage.total_tokens,
          } : undefined,
          toolCalls,
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
          name: `openai:${params.model}`,
          type: 'ai',
          startTime,
          endTime,
          latencyMs: endTime - startTime,
          input: params.messages,
          error: error instanceof Error ? error.message : String(error),
        };
        interaction.spans.push(span);
      } else {
        context.sendTrace({
          traceId,
          provider: 'openai',
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
}

/**
 * Wrap responses.create (new Responses API)
 */
function wrapResponses(
  originalCreate: (params: unknown, options?: unknown) => Promise<unknown>,
  context: OpenAIWrapperContext
) {
  return async (
    params: ResponsesParams,
    options?: { raindrop?: RaindropRequestOptions }
  ): Promise<WithTraceId<ResponsesResponse>> => {
    const traceId = options?.raindrop?.traceId || context.generateTraceId();
    const startTime = Date.now();
    const userId = options?.raindrop?.userId || context.getUserId();

    // Use previous_response_id or conversation as conversationId if not provided
    const conversationId = options?.raindrop?.conversationId
      || params.previous_response_id
      || (typeof params.conversation === 'string' ? params.conversation : params.conversation?.id);

    if (context.debug) {
      console.log('[raindrop] OpenAI responses.create started:', traceId);
    }

    // TODO: Add streaming support for responses API when needed
    // For now, handle non-streaming only

    try {
      const response = await originalCreate(params, options) as ResponsesResponse;
      const endTime = Date.now();

      // Extract output text from the new response format
      const outputItems = response.output || [];
      const messageItems = outputItems.filter(item => item.type === 'message');
      const outputText = messageItems
        .flatMap(msg => msg.content || [])
        .filter(c => c.type === 'output_text')
        .map(c => c.text || '')
        .join('');

      context.sendTrace({
        traceId,
        provider: 'openai',
        model: params.model,
        input: params.input,
        output: outputText,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        tokens: response.usage ? {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.total_tokens,
        } : undefined,
        userId,
        conversationId,
        properties: {
          ...options?.raindrop?.properties,
          openai_response_id: response.id,
          openai_response_status: response.status,
        },
      });

      return Object.assign(response, { _traceId: traceId });
    } catch (error) {
      const endTime = Date.now();

      context.sendTrace({
        traceId,
        provider: 'openai',
        model: params.model,
        input: params.input,
        startTime,
        endTime,
        latencyMs: endTime - startTime,
        userId,
        conversationId,
        properties: options?.raindrop?.properties,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  };
}

/**
 * Wrap a chat completions stream
 */
function wrapChatStream(
  stream: AsyncIterable<StreamChunk>,
  options: {
    traceId: string;
    startTime: number;
    userId?: string;
    conversationId?: string;
    properties?: Record<string, unknown>;
    model: string;
    input: unknown;
    context: OpenAIWrapperContext;
  }
): WithTraceId<AsyncIterable<StreamChunk>> {
  const interaction = options.context.getInteractionContext();
  const collectedContent: string[] = [];
  const collectedToolCalls: Map<number, { id?: string; name: string; arguments: string }> = new Map();

  const wrappedStream = {
    [Symbol.asyncIterator]: async function* () {
      try {
        for await (const chunk of stream) {
          const deltaContent = chunk.choices[0]?.delta?.content;
          if (deltaContent) {
            collectedContent.push(deltaContent);
          }

          const deltaToolCalls = chunk.choices[0]?.delta?.tool_calls;
          if (deltaToolCalls) {
            for (const tc of deltaToolCalls) {
              const existing = collectedToolCalls.get(tc.index) || { name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              collectedToolCalls.set(tc.index, existing);
            }
          }

          yield chunk;
        }

        const endTime = Date.now();
        const output = collectedContent.join('');

        options.context.sendTrace({
          traceId: options.traceId,
          provider: 'openai',
          model: options.model,
          input: options.input,
          output,
          startTime: options.startTime,
          endTime,
          latencyMs: endTime - options.startTime,
          toolCalls: Array.from(collectedToolCalls.values()).map(tc => ({
            id: tc.id || '',
            name: tc.name,
            arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
          })),
          userId: options.userId,
          conversationId: options.conversationId,
          properties: options.properties,
        });
      } catch (error) {
        const endTime = Date.now();

        options.context.sendTrace({
          traceId: options.traceId,
          provider: 'openai',
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

        throw error;
      }
    },
    _traceId: options.traceId,
  };

  return wrappedStream as WithTraceId<AsyncIterable<StreamChunk>>;
}
