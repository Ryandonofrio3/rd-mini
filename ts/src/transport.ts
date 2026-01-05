/**
 * HTTP Transport for Raindrop
 * Fire-and-forget with buffering and retry
 */

import type { TraceData, FeedbackOptions, UserTraits } from './core/types.js';
import {
  formatTrace,
  formatInteraction,
  formatFeedback,
  formatIdentify,
  type InteractionPayload,
} from './core/format.js';
import { delay, DEFAULT_CONFIG } from './core/utils.js';

export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  debug: boolean;
  disabled: boolean;
  flushInterval?: number;
  maxQueueSize?: number;
  maxRetries?: number;
}

interface QueuedEvent {
  type: 'trace' | 'feedback' | 'identify' | 'interaction';
  data: unknown;
  timestamp: number;
}

export class Transport {
  private config: TransportConfig;
  private queue: QueuedEvent[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly flushInterval: number;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;

  constructor(config: TransportConfig) {
    this.config = config;
    this.flushInterval = config.flushInterval ?? DEFAULT_CONFIG.flushInterval;
    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_CONFIG.maxQueueSize;
    this.maxRetries = config.maxRetries ?? DEFAULT_CONFIG.maxRetries;
  }

  /**
   * Send a trace event (fire-and-forget)
   */
  sendTrace(trace: TraceData): void {
    if (this.config.disabled) return;

    this.enqueue({
      type: 'trace',
      data: formatTrace(trace),
      timestamp: Date.now(),
    });
  }

  /**
   * Send feedback/signal event
   */
  sendFeedback(traceId: string, feedback: FeedbackOptions): void {
    if (this.config.disabled) return;

    this.enqueue({
      type: 'feedback',
      data: formatFeedback(traceId, feedback),
      timestamp: Date.now(),
    });
  }

  /**
   * Send user identification
   */
  sendIdentify(userId: string, traits: UserTraits): void {
    if (this.config.disabled) return;

    this.enqueue({
      type: 'identify',
      data: formatIdentify(userId, traits),
      timestamp: Date.now(),
    });
  }

  /**
   * Send an interaction with nested spans
   */
  sendInteraction(interaction: InteractionPayload): void {
    if (this.config.disabled) return;

    this.enqueue({
      type: 'interaction',
      data: formatInteraction(interaction),
      timestamp: Date.now(),
    });
  }

  /**
   * Enqueue an event for sending
   */
  private enqueue(event: QueuedEvent): void {
    this.queue.push(event);

    if (this.config.debug) {
      console.log('[raindrop] Queued event:', event.type, event.data);
    }

    // Flush if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      this.flush();
      return;
    }

    // Schedule flush
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  /**
   * Flush all queued events
   */
  async flush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.queue.length === 0) return;

    const events = [...this.queue];
    this.queue = [];

    // Group by type for batch sending
    const traces = events.filter(e => e.type === 'trace').map(e => e.data);
    const interactions = events.filter(e => e.type === 'interaction').map(e => e.data);
    const feedbacks = events.filter(e => e.type === 'feedback').map(e => e.data);
    const identifies = events.filter(e => e.type === 'identify').map(e => e.data);

    // Send in parallel, fire-and-forget
    const promises: Promise<void>[] = [];

    // Combine traces and interactions - both go to /events/track
    const allTraces = [...traces, ...interactions];
    if (allTraces.length > 0) {
      promises.push(this.sendBatch('/events/track', allTraces));
    }
    if (feedbacks.length > 0) {
      promises.push(this.sendBatch('/signals/track', feedbacks));
    }
    for (const identify of identifies) {
      promises.push(this.sendSingle('/users/identify', identify));
    }

    // Wait but don't throw
    await Promise.allSettled(promises);
  }

  /**
   * Send a batch of events
   */
  private async sendBatch(endpoint: string, data: unknown[], retries = 0): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok && retries < this.maxRetries) {
        if (this.config.debug) {
          console.warn(`[raindrop] Request failed (${response.status}), retrying...`);
        }
        await delay(Math.pow(2, retries) * 100);
        return this.sendBatch(endpoint, data, retries + 1);
      }

      if (this.config.debug && response.ok) {
        console.log(`[raindrop] Sent ${data.length} events to ${endpoint}`);
      }
    } catch (error) {
      if (retries < this.maxRetries) {
        await delay(Math.pow(2, retries) * 100);
        return this.sendBatch(endpoint, data, retries + 1);
      }
      if (this.config.debug) {
        console.warn('[raindrop] Failed to send events:', error);
      }
      // Fire-and-forget: swallow the error
    }
  }

  /**
   * Send a single event
   */
  private async sendSingle(endpoint: string, data: unknown, retries = 0): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok && retries < this.maxRetries) {
        await delay(Math.pow(2, retries) * 100);
        return this.sendSingle(endpoint, data, retries + 1);
      }
    } catch (error) {
      if (retries < this.maxRetries) {
        await delay(Math.pow(2, retries) * 100);
        return this.sendSingle(endpoint, data, retries + 1);
      }
      if (this.config.debug) {
        console.warn('[raindrop] Failed to send event:', error);
      }
    }
  }

  /**
   * Close transport and flush remaining events
   */
  async close(): Promise<void> {
    await this.flush();
  }
}
