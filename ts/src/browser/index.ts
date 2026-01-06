/**
 * Raindrop Browser SDK
 *
 * Lightweight client-side SDK for AI observability.
 * Uses shared types and formatting from core.
 *
 * @example
 * ```typescript
 * import { Raindrop } from 'rd-mini/browser';
 *
 * const raindrop = new Raindrop({ apiKey: 'your-key' });
 *
 * // Track AI events
 * const { eventIds } = await raindrop.trackAi({
 *   event: 'chat',
 *   userId: 'user_123',
 *   model: 'gpt-4o',
 *   input: 'hello',
 *   output: 'hi there',
 * });
 * ```
 */

import type {
  RaindropConfig,
  UserTraits,
  Attachment,
  TrackAiOptions,
  TrackAiPartialOptions,
  PartialEvent,
  SignalOptions,
  FeedbackOptions,
  IdentifyOptions,
} from '../core/types.js';
import {
  formatAiEvent,
  formatSignal,
  formatIdentify,
  toApiAttachment,
} from '../core/format.js';
import { generateId, DEFAULT_CONFIG } from '../core/utils.js';

// Re-export types for convenience
export type {
  RaindropConfig,
  UserTraits,
  Attachment,
  TrackAiOptions,
  TrackAiPartialOptions,
  PartialEvent,
  SignalOptions,
  FeedbackOptions,
  IdentifyOptions,
};

// Browser globals - these are available when running in browser context
// Using any to avoid DOM type dependency issues
declare const window: any;
declare const document: any;
declare const localStorage: any;

const STORAGE_KEY = 'raindrop_pending_events';
const PARTIAL_STORAGE_KEY = 'raindrop_partial_events';

export class Raindrop {
  private apiKey: string;
  private baseUrl: string;
  private debug: boolean;
  private currentUserId: string | null = null;
  private partialEvents: Map<string, TrackAiPartialOptions> = new Map();
  private pendingEvents: Array<{ endpoint: string; data: unknown[] }> = [];

  constructor(config: RaindropConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_CONFIG.baseUrl;
    this.debug = config.debug ?? DEFAULT_CONFIG.debug;

    // Restore any pending events from localStorage
    this.restoreFromStorage();

    // Set up handlers to persist pending events
    if (typeof window !== 'undefined') {
      // beforeunload for desktop browsers
      window.addEventListener('beforeunload', () => this.persistToStorage());

      // visibilitychange for mobile browsers (beforeunload often doesn't fire)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            this.persistToStorage();
          }
        });
      }
    }

    // Flush any restored events
    this.flushPendingEvents();

    if (this.debug) {
      console.log('[raindrop] Browser SDK initialized');
    }
  }

  /**
   * Restore pending events from localStorage
   */
  private restoreFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      // Restore pending events
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.pendingEvents = JSON.parse(stored);
        localStorage.removeItem(STORAGE_KEY);
        if (this.debug) {
          console.log(`[raindrop] Restored ${this.pendingEvents.length} pending event batches`);
        }
      }

      // Restore partial events
      const storedPartials = localStorage.getItem(PARTIAL_STORAGE_KEY);
      if (storedPartials) {
        const partials = JSON.parse(storedPartials) as Array<[string, TrackAiPartialOptions]>;
        this.partialEvents = new Map(partials);
        localStorage.removeItem(PARTIAL_STORAGE_KEY);
        if (this.debug) {
          console.log(`[raindrop] Restored ${this.partialEvents.size} partial events`);
        }
      }
    } catch (e) {
      if (this.debug) {
        console.warn('[raindrop] Failed to restore from localStorage:', e);
      }
    }
  }

  /**
   * Persist pending events to localStorage before page unload
   */
  private persistToStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      // Persist pending events
      if (this.pendingEvents.length > 0) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pendingEvents));
      }

      // Persist partial events
      if (this.partialEvents.size > 0) {
        const partials = Array.from(this.partialEvents.entries());
        localStorage.setItem(PARTIAL_STORAGE_KEY, JSON.stringify(partials));
      }
    } catch (e) {
      if (this.debug) {
        console.warn('[raindrop] Failed to persist to localStorage:', e);
      }
    }
  }

  /**
   * Flush any pending events that were restored from storage
   */
  private async flushPendingEvents(): Promise<void> {
    if (this.pendingEvents.length === 0) return;

    const events = [...this.pendingEvents];
    this.pendingEvents = [];

    for (const { endpoint, data } of events) {
      try {
        await this.send(endpoint, data as unknown[]);
      } catch (e) {
        if (this.debug) {
          console.warn('[raindrop] Failed to flush pending event:', e);
        }
      }
    }
  }

  /**
   * Identify a user for all subsequent calls.
   */
  async identify(
    options: IdentifyOptions | IdentifyOptions[]
  ): Promise<{ success: boolean }> {
    const items = Array.isArray(options) ? options : [options];

    for (const item of items) {
      if (!this.currentUserId) {
        this.currentUserId = item.userId;
      }
    }

    // Send each identify as a single object (API expects single, not array)
    for (const item of items) {
      const payload = formatIdentify(item.userId, item.traits || {});
      await this.sendSingle('/users/identify', payload);
    }

    if (this.debug) {
      console.log(`[raindrop] Identified ${items.length} user(s)`);
    }

    return { success: true };
  }

  /**
   * Track a single-shot AI event.
   */
  async trackAi(options: TrackAiOptions): Promise<{ eventIds: string[] }> {
    const eventId = options.eventId || generateId('evt');

    const event = formatAiEvent({
      eventId,
      event: options.event,
      userId: options.userId || this.currentUserId || undefined,
      model: options.model,
      input: options.input,
      output: options.output,
      convoId: options.convoId,
      properties: options.properties,
      attachments: options.attachments,
    });

    await this.send('/events/track', [event]);

    if (this.debug) {
      console.log(`[raindrop] AI event tracked: ${eventId}`);
    }

    return { eventIds: [eventId] };
  }

  /**
   * Start a partial AI event (for streaming or multi-turn).
   * Returns an object with finish() to complete the event.
   *
   * Partial updates are sent to /events/track_partial for real-time streaming.
   */
  async trackAiPartial(options: TrackAiPartialOptions): Promise<PartialEvent> {
    const existing = this.partialEvents.get(options.eventId);
    const isNew = !existing;

    if (existing) {
      // Merge with existing partial
      if (options.output) {
        existing.output = (existing.output || '') + options.output;
      }
      if (options.properties) {
        existing.properties = { ...existing.properties, ...options.properties };
      }
      if (options.attachments) {
        existing.attachments = [
          ...(existing.attachments || []),
          ...options.attachments,
        ];
      }
    } else {
      // Store new partial
      this.partialEvents.set(options.eventId, { ...options });
    }

    // Send partial update to track_partial endpoint
    const partialPayload = {
      event_id: options.eventId,
      is_pending: true,
      ...(options.event && { event: options.event }),
      ...(options.userId && { user_id: options.userId }),
      ...(options.model && { model: options.model }),
      ...(options.input && { input: options.input }),
      ...(options.output && { output: options.output }),
      ...(options.convoId && { convo_id: options.convoId }),
      ...(options.properties && { properties: options.properties }),
      ...(options.attachments && { attachments: options.attachments.map(toApiAttachment) }),
    };

    // Fire and forget - don't await
    this.sendPartial(partialPayload).catch(() => {});

    if (this.debug) {
      console.log(`[raindrop] Partial event ${isNew ? 'started' : 'updated'}: ${options.eventId}`);
    }

    return {
      eventId: options.eventId,
      finish: async (finishOptions) => {
        return this.finishPartial(options.eventId, finishOptions);
      },
    };
  }

  /**
   * Send a partial event update (fire-and-forget)
   */
  private async sendPartial(data: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}/v1/events/track_partial`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(data),
        keepalive: true,
      });
    } catch (error) {
      if (this.debug) {
        console.warn('[raindrop] Failed to send partial:', error);
      }
    }
  }

  /**
   * Finish a partial AI event.
   */
  private async finishPartial(
    eventId: string,
    options?: { output?: string; properties?: Record<string, unknown> }
  ): Promise<{ success: boolean }> {
    const partial = this.partialEvents.get(eventId);
    if (!partial) {
      if (this.debug) {
        console.warn(`[raindrop] No partial event found: ${eventId}`);
      }
      return { success: false };
    }

    // Merge final options
    if (options?.output) {
      partial.output = options.output;
    }
    if (options?.properties) {
      partial.properties = { ...partial.properties, ...options.properties };
    }

    // Send final partial update with is_pending: false
    const finalPartial = {
      event_id: eventId,
      is_pending: false,
      event: partial.event || 'ai_interaction',
      user_id: partial.userId || this.currentUserId || undefined,
      model: partial.model,
      input: partial.input,
      output: partial.output,
      convo_id: partial.convoId,
      properties: partial.properties,
      attachments: partial.attachments?.map(toApiAttachment),
    };

    await this.sendPartial(finalPartial);

    // Also send to /events/track for the complete record
    const event = formatAiEvent({
      eventId,
      event: partial.event || 'ai_interaction',
      userId: partial.userId || this.currentUserId || undefined,
      model: partial.model,
      input: partial.input,
      output: partial.output,
      convoId: partial.convoId,
      properties: partial.properties,
      attachments: partial.attachments,
    });

    await this.send('/events/track', [event]);

    // Clean up
    this.partialEvents.delete(eventId);

    if (this.debug) {
      console.log(`[raindrop] Partial event finished: ${eventId}`);
    }

    return { success: true };
  }

  /**
   * Track a signal (feedback, edit, etc.) on an AI event.
   */
  async trackSignal(options: SignalOptions): Promise<{ success: boolean }> {
    const signal = formatSignal(options);

    await this.send('/signals/track', [signal]);

    if (this.debug) {
      console.log(`[raindrop] Signal tracked: ${options.name} on ${options.eventId}`);
    }

    return { success: true };
  }

  /**
   * Send feedback for a specific trace (convenience wrapper for trackSignal).
   */
  async feedback(
    traceId: string,
    options: FeedbackOptions
  ): Promise<{ success: boolean }> {
    const name =
      options.score !== undefined
        ? options.score >= 0.5
          ? 'thumbs_up'
          : 'thumbs_down'
        : options.type || 'thumbs_down';

    const sentiment =
      options.score !== undefined
        ? options.score >= 0.5
          ? 'POSITIVE'
          : 'NEGATIVE'
        : options.type === 'thumbs_up'
        ? 'POSITIVE'
        : 'NEGATIVE';

    return this.trackSignal({
      eventId: traceId,
      name,
      type: options.signalType === 'standard' ? 'default' : options.signalType,
      sentiment,
      comment: options.comment,
      properties: options.properties,
    });
  }

  /**
   * Send batch data to the API.
   */
  private async send(endpoint: string, data: unknown[]): Promise<void> {
    const url = `${this.baseUrl}/v1${endpoint}`;
    const body = JSON.stringify(data);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        keepalive: true, // Helps with page unload
      });

      if (!response.ok) {
        if (this.debug) {
          console.warn(`[raindrop] API error: ${response.status}`);
        }
        // Queue for retry on next page load
        this.pendingEvents.push({ endpoint, data });
      }
    } catch (error) {
      if (this.debug) {
        console.error(`[raindrop] Failed to send:`, error);
      }
      // Queue for retry on next page load
      this.pendingEvents.push({ endpoint, data });
    }
  }

  /**
   * Send a single object to the API (for identify).
   */
  private async sendSingle(endpoint: string, data: unknown): Promise<void> {
    const url = `${this.baseUrl}/v1${endpoint}`;
    const body = JSON.stringify(data);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        keepalive: true,
      });

      if (!response.ok && this.debug) {
        console.warn(`[raindrop] API error: ${response.status}`);
      }
    } catch (error) {
      if (this.debug) {
        console.error(`[raindrop] Failed to send:`, error);
      }
    }
  }
}

export default Raindrop;
