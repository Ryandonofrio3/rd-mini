/**
 * Raindrop - Zero-config AI Observability SDK
 *
 * Usage:
 *   const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
 *   const openai = raindrop.wrap(new OpenAI());
 *   // All calls are now automatically traced
 *
 * Multi-step pipelines:
 *   await raindrop.withInteraction({ userId, event: 'rag_query' }, async () => {
 *     const docs = await searchDocs(query);  // Auto-linked
 *     const response = await openai.chat.completions.create(...);  // Auto-linked
 *   });
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  RaindropConfig,
  UserTraits,
  FeedbackOptions,
  TraceData,
  RaindropRequestOptions,
  ProviderType,
  InteractionOptions,
  InteractionContext,
  WrapToolOptions,
  SpanData,
} from './types.js';
import { Transport } from './transport.js';
import { wrapOpenAI } from './wrappers/openai.js';
import { wrapAnthropic } from './wrappers/anthropic.js';
import { wrapAISDKModel } from './wrappers/ai-sdk.js';

const DEFAULT_BASE_URL = 'https://api.raindrop.ai';

// Global context storage for interaction tracking
const interactionStorage = new AsyncLocalStorage<InteractionContext>();

export class Raindrop {
  private config: Required<RaindropConfig>;
  private transport: Transport;
  private currentUserId?: string;
  private _currentUserTraits?: UserTraits; // Stored for future use
  private lastTraceId?: string;

  constructor(config: RaindropConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
      debug: config.debug || false,
      disabled: config.disabled || false,
    };

    this.transport = new Transport({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      debug: this.config.debug,
      disabled: this.config.disabled,
    });

    if (this.config.debug) {
      console.log('[raindrop] Initialized', {
        baseUrl: this.config.baseUrl,
        disabled: this.config.disabled,
      });
    }
  }

  /**
   * Wrap an AI client or model to auto-trace all calls
   *
   * Supports:
   * - OpenAI client: raindrop.wrap(new OpenAI())
   * - Anthropic client: raindrop.wrap(new Anthropic())
   * - Vercel AI SDK model: raindrop.wrap(openai('gpt-4o'))
   */
  wrap<T>(client: T, options?: RaindropRequestOptions): T {
    const providerType = this.detectProvider(client);

    if (this.config.debug) {
      console.log('[raindrop] Wrapping provider:', providerType);
    }

    const context = {
      generateTraceId: () => this.generateTraceId(),
      sendTrace: (trace: TraceData) => this.sendTrace(trace),
      getUserId: () => this.currentUserId,
      debug: this.config.debug,
    };

    switch (providerType) {
      case 'openai':
        return wrapOpenAI(client as Parameters<typeof wrapOpenAI>[0], context) as T;

      case 'anthropic':
        return wrapAnthropic(client as Parameters<typeof wrapAnthropic>[0], context) as T;

      case 'ai-sdk':
        return wrapAISDKModel(
          client as Parameters<typeof wrapAISDKModel>[0],
          context,
          options
        ) as T;

      default:
        if (this.config.debug) {
          console.warn('[raindrop] Unknown provider type, returning unwrapped');
        }
        return client;
    }
  }

  /**
   * Identify a user for all subsequent calls
   */
  identify(userId: string, traits?: UserTraits): void {
    this.currentUserId = userId;
    this._currentUserTraits = traits;

    if (traits) {
      this.transport.sendIdentify(userId, traits);
    }

    if (this.config.debug) {
      console.log('[raindrop] User identified:', userId);
    }
  }

  /**
   * Send feedback for a specific trace
   */
  async feedback(traceId: string, options: FeedbackOptions): Promise<void> {
    this.transport.sendFeedback(traceId, options);

    if (this.config.debug) {
      console.log('[raindrop] Feedback sent:', traceId, options);
    }
  }

  /**
   * Get the last trace ID (useful if you can't access _traceId on response)
   */
  getLastTraceId(): string | undefined {
    return this.lastTraceId;
  }

  /**
   * Get the current user's traits (set via identify)
   */
  getUserTraits(): UserTraits | undefined {
    return this._currentUserTraits;
  }

  /**
   * Flush all pending events and close
   */
  async close(): Promise<void> {
    await this.transport.close();

    if (this.config.debug) {
      console.log('[raindrop] Closed');
    }
  }

  /**
   * Run code within an interaction context
   * All wrapped clients and tools called within will be auto-linked
   *
   * @example
   * await raindrop.withInteraction(
   *   { userId: 'user123', event: 'rag_query', input: 'What is X?' },
   *   async () => {
   *     const docs = await searchDocs(query);  // Auto-linked
   *     const response = await openai.chat.completions.create(...);  // Auto-linked
   *     return response.choices[0].message.content;
   *   }
   * );
   */
  async withInteraction<T>(
    options: InteractionOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const interactionId = this.generateTraceId();
    const startTime = Date.now();
    const userId = options.userId || this.currentUserId;

    const context: InteractionContext = {
      interactionId,
      userId,
      conversationId: options.conversationId,
      startTime,
      input: options.input,
      event: options.event || 'interaction',
      properties: options.properties,
      spans: [],
    };

    if (this.config.debug) {
      console.log('[raindrop] Interaction started:', interactionId);
    }

    try {
      // Run the function within the context
      const result = await interactionStorage.run(context, fn);
      const endTime = Date.now();

      // Send the interaction trace with all spans
      this.sendInteraction(context, {
        output: typeof result === 'string' ? result : JSON.stringify(result),
        endTime,
        latencyMs: endTime - startTime,
      });

      return result;
    } catch (error) {
      const endTime = Date.now();

      // Send the interaction trace with error
      this.sendInteraction(context, {
        endTime,
        latencyMs: endTime - startTime,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Wrap a tool function for automatic tracing
   * When called within withInteraction(), the tool will be auto-linked
   *
   * @example
   * const searchDocs = raindrop.wrapTool('search_docs', async (query: string) => {
   *   return await vectorDb.search(query);
   * });
   *
   * // Use normally
   * const docs = await searchDocs('how to use raindrop');
   */
  wrapTool<TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult>,
    options?: WrapToolOptions
  ): (...args: TArgs) => Promise<TResult> {
    const self = this;

    return async function(...args: TArgs): Promise<TResult> {
      const context = interactionStorage.getStore();
      const spanId = self.generateTraceId();
      const startTime = Date.now();

      if (self.config.debug) {
        console.log('[raindrop] Tool started:', name, spanId);
      }

      const span: SpanData = {
        spanId,
        parentId: context?.interactionId,
        name,
        type: 'tool',
        startTime,
        input: args.length === 1 ? args[0] : args,
        properties: options?.properties,
      };

      try {
        const result = await fn(...args);
        const endTime = Date.now();

        span.endTime = endTime;
        span.latencyMs = endTime - startTime;
        span.output = result;

        // If within an interaction, add to its spans
        if (context) {
          context.spans.push(span);
        } else {
          // Standalone tool call - send as individual trace
          self.sendToolTrace(span);
        }

        return result;
      } catch (error) {
        const endTime = Date.now();

        span.endTime = endTime;
        span.latencyMs = endTime - startTime;
        span.error = error instanceof Error ? error.message : String(error);

        if (context) {
          context.spans.push(span);
        } else {
          self.sendToolTrace(span);
        }

        throw error;
      }
    };
  }

  /**
   * Get the current interaction context (if any)
   * Useful for wrappers to check if they're within an interaction
   */
  getInteractionContext(): InteractionContext | undefined {
    return interactionStorage.getStore();
  }

  /**
   * Internal: Send an interaction with all its spans
   */
  private sendInteraction(
    context: InteractionContext,
    result: { output?: string; endTime: number; latencyMs: number; error?: string }
  ): void {
    this.lastTraceId = context.interactionId;

    this.transport.sendInteraction({
      interactionId: context.interactionId,
      userId: context.userId,
      event: context.event || 'interaction',
      input: context.input,
      output: result.output,
      startTime: context.startTime,
      endTime: result.endTime,
      latencyMs: result.latencyMs,
      conversationId: context.conversationId,
      properties: context.properties,
      error: result.error,
      spans: context.spans,
    });
  }

  /**
   * Internal: Send a standalone tool trace
   */
  private sendToolTrace(span: SpanData): void {
    this.lastTraceId = span.spanId;

    this.transport.sendTrace({
      traceId: span.spanId,
      provider: 'unknown',
      model: `tool:${span.name}`,
      input: span.input,
      output: span.output,
      startTime: span.startTime,
      endTime: span.endTime,
      latencyMs: span.latencyMs,
      error: span.error,
      properties: span.properties,
    });
  }

  /**
   * Internal: Send a trace
   */
  private sendTrace(trace: TraceData): void {
    this.lastTraceId = trace.traceId;
    this.transport.sendTrace(trace);
  }

  /**
   * Internal: Generate a unique trace ID
   */
  private generateTraceId(): string {
    // Use crypto.randomUUID if available, otherwise fallback
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `trace_${crypto.randomUUID()}`;
    }
    // Fallback for environments without crypto.randomUUID
    return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Internal: Detect the provider type from a client/model
   */
  private detectProvider(client: unknown): ProviderType {
    if (!client || typeof client !== 'object') {
      return 'unknown';
    }

    const c = client as Record<string, unknown>;

    // OpenAI: has chat.completions
    if (c.chat && typeof c.chat === 'object') {
      const chat = c.chat as Record<string, unknown>;
      if (chat.completions && typeof chat.completions === 'object') {
        return 'openai';
      }
    }

    // Anthropic: has messages.create
    if (c.messages && typeof c.messages === 'object') {
      const messages = c.messages as Record<string, unknown>;
      if (typeof messages.create === 'function') {
        return 'anthropic';
      }
    }

    // Vercel AI SDK: has modelId and provider
    if (typeof c.modelId === 'string' && typeof c.provider === 'string') {
      return 'ai-sdk';
    }

    // Vercel AI SDK: has specificationVersion (newer versions)
    if (c.specificationVersion !== undefined) {
      return 'ai-sdk';
    }

    return 'unknown';
  }
}
