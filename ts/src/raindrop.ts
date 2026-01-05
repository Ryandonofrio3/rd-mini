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
  BeginOptions,
  FinishOptions,
  Attachment,
} from './types.js';
import { Transport } from './transport.js';
import { wrapOpenAI } from './wrappers/openai.js';
import { wrapAnthropic } from './wrappers/anthropic.js';
import { wrapAISDKModel } from './wrappers/ai-sdk.js';

const DEFAULT_BASE_URL = 'https://api.raindrop.ai';

// Global context storage for interaction tracking
const interactionStorage = new AsyncLocalStorage<InteractionContext>();

/**
 * Interaction object returned by begin()
 * Allows manual control over interaction lifecycle
 */
export class Interaction {
  private context: InteractionContext;
  private raindrop: Raindrop;
  private finished = false;

  constructor(context: InteractionContext, raindrop: Raindrop) {
    this.context = context;
    this.raindrop = raindrop;
  }

  /** Get the interaction/event ID */
  get id(): string {
    return this.context.interactionId;
  }

  /** Get or set the output */
  get output(): string | undefined {
    return this.context.output;
  }

  set output(value: string | undefined) {
    this.context.output = value;
  }

  /** Set a single property */
  setProperty(key: string, value: unknown): this {
    if (!this.context.properties) {
      this.context.properties = {};
    }
    this.context.properties[key] = value;
    return this;
  }

  /** Merge multiple properties */
  setProperties(props: Record<string, unknown>): this {
    this.context.properties = {
      ...this.context.properties,
      ...props,
    };
    return this;
  }

  /** Add attachments */
  addAttachments(attachments: Attachment[]): this {
    if (!this.context.attachments) {
      this.context.attachments = [];
    }
    this.context.attachments.push(...attachments);
    return this;
  }

  /** Set the input */
  setInput(input: string): this {
    this.context.input = input;
    return this;
  }

  /** Get the underlying context (for internal use) */
  getContext(): InteractionContext {
    return this.context;
  }

  /**
   * Finish the interaction and send to Raindrop
   */
  finish(options?: FinishOptions): void {
    if (this.finished) {
      console.warn('[raindrop] Interaction already finished:', this.id);
      return;
    }

    this.finished = true;

    // Merge any final options
    if (options?.output) {
      this.context.output = options.output;
    }
    if (options?.properties) {
      this.setProperties(options.properties);
    }
    if (options?.attachments) {
      this.addAttachments(options.attachments);
    }

    // Send the interaction
    this.raindrop._finishInteraction(this.context);
  }
}

export class Raindrop {
  private config: Required<RaindropConfig>;
  private transport: Transport;
  private currentUserId?: string;
  private _currentUserTraits?: UserTraits; // Stored for future use
  private lastTraceId?: string;
  private activeInteractions = new Map<string, Interaction>();

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
      getInteractionContext: () => this.getInteractionContext(),
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
   * Start an interaction manually (escape hatch for complex flows)
   *
   * For simple cases, use withInteraction() instead.
   * Use begin() when you need to start and finish in different places.
   *
   * @example
   * const interaction = raindrop.begin({
   *   userId: 'user123',
   *   event: 'chat_message',
   *   input: 'What is X?',
   * });
   *
   * // ... later, maybe in a different function
   * interaction.finish({ output: 'X is...' });
   */
  begin(options: BeginOptions = {}): Interaction {
    const interactionId = options.eventId || this.generateTraceId();
    const userId = options.userId || this.currentUserId;

    const context: InteractionContext = {
      interactionId,
      userId,
      conversationId: options.conversationId,
      startTime: Date.now(),
      input: options.input,
      model: options.model,
      event: options.event || 'interaction',
      properties: options.properties,
      attachments: options.attachments,
      spans: [],
    };

    const interaction = new Interaction(context, this);
    this.activeInteractions.set(interactionId, interaction);

    // Also set it in AsyncLocalStorage so wrapped clients can find it
    interactionStorage.enterWith(context);

    if (this.config.debug) {
      console.log('[raindrop] Interaction started:', interactionId);
    }

    return interaction;
  }

  /**
   * Resume an existing interaction by ID
   *
   * @example
   * const interaction = raindrop.resumeInteraction(eventId);
   * interaction.finish({ output: 'Done!' });
   */
  resumeInteraction(eventId: string): Interaction {
    const existing = this.activeInteractions.get(eventId);
    if (existing) {
      return existing;
    }

    // Create a new interaction with the given ID (for cases where
    // the interaction was started elsewhere or we lost the reference)
    if (this.config.debug) {
      console.log('[raindrop] Creating new interaction for resume:', eventId);
    }

    const context: InteractionContext = {
      interactionId: eventId,
      userId: this.currentUserId,
      startTime: Date.now(),
      spans: [],
    };

    const interaction = new Interaction(context, this);
    this.activeInteractions.set(eventId, interaction);
    return interaction;
  }

  /**
   * Internal: Called by Interaction.finish()
   * @internal
   */
  _finishInteraction(context: InteractionContext): void {
    const endTime = Date.now();
    this.lastTraceId = context.interactionId;

    // Remove from active interactions
    this.activeInteractions.delete(context.interactionId);

    this.transport.sendInteraction({
      interactionId: context.interactionId,
      userId: context.userId,
      event: context.event || 'interaction',
      input: context.input,
      output: context.output,
      startTime: context.startTime,
      endTime,
      latencyMs: endTime - context.startTime,
      conversationId: context.conversationId,
      properties: context.properties,
      attachments: context.attachments,
      spans: context.spans,
    });

    if (this.config.debug) {
      console.log('[raindrop] Interaction finished:', context.interactionId);
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
   *   async (ctx) => {
   *     const docs = await searchDocs(query);  // Auto-linked
   *     const response = await openai.chat.completions.create(...);  // Auto-linked
   *     ctx.output = response.choices[0].message.content;  // Set output
   *   }
   * );
   */
  async withInteraction<T>(
    options: InteractionOptions,
    fn: (ctx: InteractionContext) => Promise<T>
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
      // Run the function within the context, passing ctx for output/properties
      const result = await interactionStorage.run(context, () => fn(context));
      const endTime = Date.now();

      // Use context.output if set, otherwise use return value
      const output = context.output !== undefined
        ? context.output
        : (typeof result === 'string' ? result : undefined);

      // Send the interaction trace with all spans
      this.sendInteraction(context, {
        output,
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
