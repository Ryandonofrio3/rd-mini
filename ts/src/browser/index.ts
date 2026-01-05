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

export class Raindrop {
  private apiKey: string;
  private baseUrl: string;
  private debug: boolean;
  private currentUserId: string | null = null;
  private partialEvents: Map<string, TrackAiPartialOptions> = new Map();

  constructor(config: RaindropConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_CONFIG.baseUrl;
    this.debug = config.debug ?? DEFAULT_CONFIG.debug;

    if (this.debug) {
      console.log('[raindrop] Browser SDK initialized');
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

    const payload = items.map((item) => formatIdentify(item.userId, item.traits || {}));

    await this.send('/users/identify', payload);

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
   */
  async trackAiPartial(options: TrackAiPartialOptions): Promise<PartialEvent> {
    const existing = this.partialEvents.get(options.eventId);

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

    if (this.debug) {
      console.log(`[raindrop] Partial event updated: ${options.eventId}`);
    }

    return {
      eventId: options.eventId,
      finish: async (finishOptions) => {
        return this.finishPartial(options.eventId, finishOptions);
      },
    };
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

    // Send the complete event
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
   * Send data to the API.
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
