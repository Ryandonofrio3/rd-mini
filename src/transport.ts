/**
 * HTTP Transport for Raindrop
 * Fire-and-forget with buffering and retry
 */

import type { TraceData, FeedbackOptions, UserTraits } from './types.js';

interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  debug: boolean;
  disabled: boolean;
}

interface QueuedEvent {
  type: 'trace' | 'feedback' | 'identify';
  data: unknown;
  timestamp: number;
}

export class Transport {
  private config: TransportConfig;
  private queue: QueuedEvent[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 1000; // 1 second
  private readonly MAX_QUEUE_SIZE = 100;
  private readonly MAX_RETRIES = 3;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  /**
   * Send a trace event (fire-and-forget)
   */
  sendTrace(trace: TraceData): void {
    if (this.config.disabled) return;

    this.enqueue({
      type: 'trace',
      data: this.formatTrace(trace),
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
      data: {
        event_id: traceId,
        signal_name: feedback.type || (feedback.score !== undefined && feedback.score >= 0.5 ? 'positive' : 'negative'),
        sentiment: feedback.score !== undefined
          ? (feedback.score >= 0.5 ? 'POSITIVE' : 'NEGATIVE')
          : (feedback.type === 'thumbs_up' ? 'POSITIVE' : 'NEGATIVE'),
        signal_type: feedback.signalType || 'default',
        timestamp: feedback.timestamp || new Date().toISOString(),
        ...(feedback.attachmentId && { attachment_id: feedback.attachmentId }),
        properties: {
          score: feedback.score,
          comment: feedback.comment,
          ...feedback.properties,
        },
      },
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
      data: {
        user_id: userId,
        traits,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Format trace data for API
   */
  private formatTrace(trace: TraceData): Record<string, unknown> {
    return {
      event_id: trace.traceId,
      user_id: trace.userId,
      event: 'ai_interaction',
      timestamp: new Date(trace.startTime).toISOString(),
      properties: {
        provider: trace.provider,
        conversation_id: trace.conversationId,
        latency_ms: trace.latencyMs,
        // Token usage
        ...(trace.tokens && {
          input_tokens: trace.tokens.input,
          output_tokens: trace.tokens.output,
          total_tokens: trace.tokens.total,
        }),
        // Error info
        ...(trace.error && { error: trace.error }),
        ...trace.properties,
      },
      ai_data: {
        model: trace.model,
        input: typeof trace.input === 'string' ? trace.input : JSON.stringify(trace.input),
        output: trace.output ? (typeof trace.output === 'string' ? trace.output : JSON.stringify(trace.output)) : undefined,
        convo_id: trace.conversationId,
      },
      // Include tool calls if present
      ...(trace.toolCalls && trace.toolCalls.length > 0 && {
        attachments: trace.toolCalls.map(tc => ({
          type: 'code',
          name: `tool:${tc.name}`,
          value: JSON.stringify({ arguments: tc.arguments, result: tc.result }),
          role: 'output',
          language: 'json',
        })),
      }),
    };
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
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.flush();
      return;
    }

    // Schedule flush
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
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
    const feedbacks = events.filter(e => e.type === 'feedback').map(e => e.data);
    const identifies = events.filter(e => e.type === 'identify').map(e => e.data);

    // Send in parallel, fire-and-forget
    const promises: Promise<void>[] = [];

    if (traces.length > 0) {
      promises.push(this.sendBatch('/events/track', traces));
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

      if (!response.ok && retries < this.MAX_RETRIES) {
        if (this.config.debug) {
          console.warn(`[raindrop] Request failed (${response.status}), retrying...`);
        }
        await this.delay(Math.pow(2, retries) * 100);
        return this.sendBatch(endpoint, data, retries + 1);
      }

      if (this.config.debug && response.ok) {
        console.log(`[raindrop] Sent ${data.length} events to ${endpoint}`);
      }
    } catch (error) {
      if (retries < this.MAX_RETRIES) {
        await this.delay(Math.pow(2, retries) * 100);
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

      if (!response.ok && retries < this.MAX_RETRIES) {
        await this.delay(Math.pow(2, retries) * 100);
        return this.sendSingle(endpoint, data, retries + 1);
      }
    } catch (error) {
      if (retries < this.MAX_RETRIES) {
        await this.delay(Math.pow(2, retries) * 100);
        return this.sendSingle(endpoint, data, retries + 1);
      }
      if (this.config.debug) {
        console.warn('[raindrop] Failed to send event:', error);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Close transport and flush remaining events
   */
  async close(): Promise<void> {
    await this.flush();
  }
}
