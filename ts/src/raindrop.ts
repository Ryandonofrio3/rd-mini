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
  RaindropPlugin,
  UserTraits,
  FeedbackOptions,
  SignalOptions,
  TraceData,
  RaindropRequestOptions,
  ProviderType,
  InteractionOptions,
  InteractionContext,
  WrapToolOptions,
  WithToolOptions,
  SpanData,
  BeginOptions,
  FinishOptions,
  Attachment,
} from './core/types.js';
import { generateId, DEFAULT_CONFIG } from './core/utils.js';
import { Transport } from './transport.js';
import { wrapOpenAI } from './wrappers/openai.js';
import { wrapAnthropic } from './wrappers/anthropic.js';
import { wrapAISDKModel } from './wrappers/ai-sdk.js';
import { wrapGemini } from './wrappers/gemini.js';
import { wrapBedrock } from './wrappers/bedrock.js';
import { createPiiPlugin } from './plugins/pii.js';

// Global context storage for interaction tracking
const interactionStorage = new AsyncLocalStorage<InteractionContext>();

/**
 * Manual span for async workflows
 * Use when you need to start and end a span in different places
 */
export class ManualSpan {
  private span: SpanData;
  private raindrop: Raindrop;
  private context: InteractionContext | undefined;
  private ended = false;

  constructor(
    span: SpanData,
    raindrop: Raindrop,
    context: InteractionContext | undefined
  ) {
    this.span = span;
    this.raindrop = raindrop;
    this.context = context;
  }

  /** Get the span ID */
  get id(): string {
    return this.span.spanId;
  }

  /** Record input data for the span */
  recordInput(data: unknown): this {
    this.span.input = data;
    return this;
  }

  /** Record output data for the span */
  recordOutput(data: unknown): this {
    this.span.output = data;
    return this;
  }

  /** Set properties on the span */
  setProperties(props: Record<string, unknown>): this {
    this.span.properties = { ...this.span.properties, ...props };
    return this;
  }

  /**
   * End the span and record it
   * @param error Optional error message if the span failed
   */
  end(error?: string): void {
    if (this.ended) {
      console.warn('[raindrop] Span already ended:', this.id);
      return;
    }

    this.ended = true;
    const endTime = Date.now();

    this.span.endTime = endTime;
    this.span.latencyMs = endTime - this.span.startTime;
    if (error) {
      this.span.error = error;
    }

    // Notify plugins (can mutate span before storing)
    this.raindrop._notifySpan(this.span);

    // If within an interaction, add to its spans
    if (this.context) {
      this.context.spans.push(this.span);
    } else {
      // Standalone span - send as individual trace
      this.raindrop._sendToolTrace(this.span);
    }
  }
}

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
    if (options?.output !== undefined) {
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

  /**
   * Execute a tool inline and trace it
   *
   * @example
   * const result = await interaction.withTool(
   *   { name: 'search_docs' },
   *   async () => await vectorDb.search(query)
   * );
   */
  async withTool<T>(
    options: WithToolOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const spanId = generateId('span');
    const startTime = Date.now();

    const span: SpanData = {
      spanId,
      parentId: this.context.interactionId,
      name: options.name,
      type: 'tool',
      version: options.version,
      startTime,
      properties: options.properties,
    };

    try {
      const result = await fn();
      const endTime = Date.now();

      span.endTime = endTime;
      span.latencyMs = endTime - startTime;
      span.output = result;

      // Notify plugins (can mutate span before storing)
      this.raindrop._notifySpan(span);

      this.context.spans.push(span);

      return result;
    } catch (error) {
      const endTime = Date.now();

      span.endTime = endTime;
      span.latencyMs = endTime - startTime;
      span.error = error instanceof Error ? error.message : String(error);

      // Notify plugins (can mutate span before storing)
      this.raindrop._notifySpan(span);

      this.context.spans.push(span);

      throw error;
    }
  }
}

export class Raindrop {
  private config: Required<Omit<RaindropConfig, 'plugins' | 'writeKey'>> & { apiKey: string };
  private plugins: RaindropPlugin[];
  private transport: Transport;
  private currentUserId?: string;
  private _currentUserTraits?: UserTraits; // Stored for future use
  private lastTraceId?: string;
  private activeInteractions = new Map<string, Interaction>();

  constructor(config: RaindropConfig) {
    // Support both apiKey and writeKey for backwards compatibility
    const apiKey = config.apiKey || config.writeKey;
    if (!apiKey) {
      throw new Error('Raindrop: apiKey (or writeKey) is required');
    }

    this.config = {
      apiKey,
      baseUrl: config.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      debug: config.debug ?? DEFAULT_CONFIG.debug,
      disabled: config.disabled ?? DEFAULT_CONFIG.disabled,
      flushInterval: config.flushInterval ?? DEFAULT_CONFIG.flushInterval,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_CONFIG.maxQueueSize,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      redactPii: config.redactPii ?? DEFAULT_CONFIG.redactPii,
    };

    // Build plugins list, adding PII plugin if redactPii is enabled
    this.plugins = config.plugins ?? [];
    if (config.redactPii) {
      this.plugins = [createPiiPlugin(), ...this.plugins];
    }

    this.transport = new Transport({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      debug: this.config.debug,
      disabled: this.config.disabled,
      flushInterval: this.config.flushInterval,
      maxQueueSize: this.config.maxQueueSize,
      maxRetries: this.config.maxRetries,
    });

    if (this.config.debug) {
      const pluginNames = this.plugins.map(p => p.name);
      console.log('[raindrop] Initialized', {
        baseUrl: this.config.baseUrl,
        disabled: this.config.disabled,
        plugins: pluginNames.length > 0 ? pluginNames : undefined,
      });
    }
  }

  /**
   * Call onInteractionStart hook on all plugins
   * @internal
   */
  private callOnInteractionStart(ctx: InteractionContext): void {
    for (const plugin of this.plugins) {
      if (plugin.onInteractionStart) {
        try {
          plugin.onInteractionStart(ctx);
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.onInteractionStart threw:`, error);
          }
        }
      }
    }
  }

  /**
   * Call onInteractionEnd hook on all plugins
   * @internal
   */
  private callOnInteractionEnd(ctx: InteractionContext): void {
    for (const plugin of this.plugins) {
      if (plugin.onInteractionEnd) {
        try {
          plugin.onInteractionEnd(ctx);
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.onInteractionEnd threw:`, error);
          }
        }
      }
    }
  }

  /**
   * Call onSpan hook on all plugins
   * @internal
   */
  private callOnSpan(span: SpanData): void {
    for (const plugin of this.plugins) {
      if (plugin.onSpan) {
        try {
          plugin.onSpan(span);
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.onSpan threw:`, error);
          }
        }
      }
    }
  }

  /**
   * Call onTrace hook on all plugins
   * @internal
   */
  private callOnTrace(trace: TraceData): void {
    for (const plugin of this.plugins) {
      if (plugin.onTrace) {
        try {
          plugin.onTrace(trace);
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.onTrace threw:`, error);
          }
        }
      }
    }
  }

  /**
   * Call flush on all plugins
   * @internal
   */
  private async callPluginFlush(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.flush) {
        try {
          await plugin.flush();
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.flush threw:`, error);
          }
        }
      }
    }
  }

  /**
   * Call shutdown on all plugins
   * @internal
   */
  private async callPluginShutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.shutdown) {
        try {
          await plugin.shutdown();
        } catch (error) {
          if (this.config.debug) {
            console.warn(`[raindrop] Plugin ${plugin.name}.shutdown threw:`, error);
          }
        }
      }
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

      case 'gemini':
        return wrapGemini(client as Parameters<typeof wrapGemini>[0], context) as T;

      case 'bedrock':
        return wrapBedrock(client as Parameters<typeof wrapBedrock>[0], context) as T;

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
   * Track a signal with full options
   *
   * Use this for custom signal types beyond thumbs up/down.
   * For simple feedback, use feedback() instead.
   *
   * @example
   * // Edit signal - user corrected the response
   * await raindrop.trackSignal({
   *   eventId: traceId,
   *   name: 'edit',
   *   type: 'edit',
   *   after: 'The corrected response text',
   * });
   *
   * // Custom signal with sentiment
   * await raindrop.trackSignal({
   *   eventId: traceId,
   *   name: 'hallucination_detected',
   *   type: 'feedback',
   *   sentiment: 'NEGATIVE',
   *   comment: 'Model made up a fact',
   * });
   */
  async trackSignal(options: SignalOptions): Promise<void> {
    this.transport.sendSignal(options);

    if (this.config.debug) {
      console.log('[raindrop] Signal tracked:', options.eventId, options.name);
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

    // Notify plugins
    this.callOnInteractionStart(context);

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
      // Re-enter context so wrapped clients can find it
      interactionStorage.enterWith(existing.getContext());
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
    // Enter context so wrapped clients can find it
    interactionStorage.enterWith(context);
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

    // Clear context if it matches this interaction (prevent misattribution)
    const currentContext = interactionStorage.getStore();
    if (currentContext?.interactionId === context.interactionId) {
      // Note: enterWith(undefined) clears the context for this async chain
      interactionStorage.enterWith(undefined as unknown as InteractionContext);
    }

    // Notify plugins (can mutate context before sending)
    this.callOnInteractionEnd(context);

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
   * Flush all pending events (without closing)
   */
  async flush(): Promise<void> {
    // Flush plugins first (they may buffer data)
    await this.callPluginFlush();

    await this.transport.flush();

    if (this.config.debug) {
      console.log('[raindrop] Flushed');
    }
  }

  /**
   * Flush all pending events and close
   */
  async close(): Promise<void> {
    // Flush plugins first
    await this.callPluginFlush();

    // Then shutdown plugins
    await this.callPluginShutdown();

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

    // Notify plugins
    this.callOnInteractionStart(context);

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
      const spanId = generateId('span');
      const startTime = Date.now();

      if (self.config.debug) {
        console.log('[raindrop] Tool started:', name, spanId);
      }

      const span: SpanData = {
        spanId,
        parentId: context?.interactionId,
        name,
        type: 'tool',
        version: options?.version,
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

        // Notify plugins (can mutate span before storing)
        self._notifySpan(span);

        // If within an interaction, add to its spans
        if (context) {
          context.spans.push(span);
        } else {
          // Standalone tool call - send as individual trace
          self._sendToolTrace(span);
        }

        return result;
      } catch (error) {
        const endTime = Date.now();

        span.endTime = endTime;
        span.latencyMs = endTime - startTime;
        span.error = error instanceof Error ? error.message : String(error);

        // Notify plugins (can mutate span before storing)
        self._notifySpan(span);

        if (context) {
          context.spans.push(span);
        } else {
          self._sendToolTrace(span);
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
   * Start a manual span for async workflows
   *
   * Use this when you need to start and end a span in different places,
   * such as in async callbacks or distributed workflows.
   *
   * @example
   * const span = raindrop.startSpan('process_document', { type: 'tool' });
   * span.recordInput({ docId: '123' });
   *
   * try {
   *   const result = await processDocument(docId);
   *   span.recordOutput(result);
   *   span.end();
   * } catch (error) {
   *   span.end(error.message);
   * }
   */
  startSpan(
    name: string,
    options: {
      type?: 'tool' | 'ai';
      version?: number;
      properties?: Record<string, unknown>;
    } = {}
  ): ManualSpan {
    const context = this.getInteractionContext();
    const spanId = generateId('span');

    if (this.config.debug) {
      console.log('[raindrop] Manual span started:', name, spanId);
    }

    const span: SpanData = {
      spanId,
      parentId: context?.interactionId,
      name,
      type: options.type || 'tool',
      version: options.version,
      startTime: Date.now(),
      properties: options.properties,
    };

    return new ManualSpan(span, this, context);
  }

  /**
   * Internal: Send an interaction with all its spans
   */
  private sendInteraction(
    context: InteractionContext,
    result: { output?: string; endTime: number; latencyMs: number; error?: string }
  ): void {
    this.lastTraceId = context.interactionId;

    // Update context with final values for plugin access
    if (result.output !== undefined) {
      context.output = result.output;
    }

    // Notify plugins (can mutate context before sending)
    this.callOnInteractionEnd(context);

    this.transport.sendInteraction({
      interactionId: context.interactionId,
      userId: context.userId,
      event: context.event || 'interaction',
      input: context.input,
      output: context.output,
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
   * Internal: Notify plugins when a span completes
   * @internal
   */
  _notifySpan(span: SpanData): void {
    this.callOnSpan(span);
  }

  /**
   * Internal: Send a standalone tool trace
   * @internal
   */
  _sendToolTrace(span: SpanData): void {
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

    // Notify plugins (can mutate trace before sending)
    this.callOnTrace(trace);

    this.transport.sendTrace(trace);
  }

  /**
   * Internal: Generate a unique trace ID
   */
  private generateTraceId(): string {
    return generateId('trace');
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

    // Google Gemini: has models.generateContent
    if (c.models && typeof c.models === 'object') {
      const models = c.models as Record<string, unknown>;
      if (typeof models.generateContent === 'function') {
        return 'gemini';
      }
    }

    // AWS Bedrock: has send method and is BedrockRuntimeClient
    // Check for send method + constructor name pattern
    if (typeof c.send === 'function') {
      const constructorName = (client as { constructor?: { name?: string } }).constructor?.name;
      if (constructorName?.includes('Bedrock')) {
        return 'bedrock';
      }
      // Also check for bedrock-specific config
      if (c.config && typeof c.config === 'object') {
        const config = c.config as Record<string, unknown>;
        if (typeof config.serviceId === 'string' && (config.serviceId as string).toLowerCase().includes('bedrock')) {
          return 'bedrock';
        }
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
