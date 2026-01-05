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
