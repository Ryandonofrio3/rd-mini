/**
 * Raindrop Browser SDK
 *
 * Lightweight client-side SDK for AI observability.
 *
 * Usage:
 *   const raindrop = new Raindrop({ apiKey: "..." });
 *
 *   // Single-shot AI event
 *   const { eventIds } = await raindrop.trackAi({
 *     event: "chat",
 *     userId: "user_123",
 *     model: "gpt-4o",
 *     input: "hello",
 *     output: "hi there",
 *   });
 *
 *   // Partial AI event (streaming)
 *   const partial = await raindrop.trackAiPartial({
 *     eventId: "evt_123",
 *     event: "chat",
 *     userId: "user_123",
 *     model: "gpt-4o",
 *   });
 *   await partial.finish({ output: "final response" });
 */

export interface RaindropConfig {
  apiKey: string;
  baseUrl?: string;
  debug?: boolean;
}

export interface UserTraits {
  name?: string;
  email?: string;
  plan?: string;
  [key: string]: unknown;
}

export interface Attachment {
  type: "code" | "text" | "image" | "iframe";
  name?: string;
  value: string;
  role: "input" | "output";
  language?: string;
}

export interface TrackAiOptions {
  event: string;
  userId?: string;
  eventId?: string;
  model?: string;
  input?: string;
  output?: string;
  convoId?: string;
  properties?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface TrackAiPartialOptions {
  eventId: string;
  event?: string;
  userId?: string;
  model?: string;
  input?: string;
  output?: string;
  convoId?: string;
  properties?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface PartialEvent {
  eventId: string;
  finish: (options?: { output?: string; properties?: Record<string, unknown> }) => Promise<{ success: boolean }>;
}

export interface SignalOptions {
  eventId: string;
  name: string;
  type?: "default" | "feedback" | "edit";
  sentiment?: "POSITIVE" | "NEGATIVE";
  comment?: string;
  after?: string;
  attachmentId?: string;
  properties?: Record<string, unknown>;
}

export interface FeedbackOptions {
  type?: "thumbs_up" | "thumbs_down";
  score?: number;
  comment?: string;
  signalType?: "default" | "feedback" | "edit" | "standard";
  properties?: Record<string, unknown>;
}

export interface IdentifyOptions {
  userId: string;
  traits?: UserTraits;
}

export class Raindrop {
  private apiKey: string;
  private baseUrl: string;
  private debug: boolean;
  private currentUserId: string | null = null;
  private partialEvents: Map<string, TrackAiPartialOptions> = new Map();

  constructor(config: RaindropConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || "https://api.raindrop.ai";
    this.debug = config.debug || false;

    if (this.debug) {
      console.log("[raindrop] Browser SDK initialized");
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

    const payload = items.map((item) => ({
      user_id: item.userId,
      traits: item.traits || {},
    }));

    await this.send("/users/identify", payload);

    if (this.debug) {
      console.log(`[raindrop] Identified ${items.length} user(s)`);
    }

    return { success: true };
  }

  /**
   * Track a single-shot AI event.
   */
  async trackAi(options: TrackAiOptions): Promise<{ eventIds: string[] }> {
    const eventId = options.eventId || this.generateId();

    const event = {
      event_id: eventId,
      user_id: options.userId || this.currentUserId,
      event: options.event,
      timestamp: new Date().toISOString(),
      properties: options.properties || {},
      ai_data: {
        model: options.model,
        input: options.input,
        output: options.output,
        convo_id: options.convoId,
      },
      ...(options.attachments && { attachments: options.attachments }),
    };

    await this.send("/events/track", [event]);

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
        existing.output = (existing.output || "") + options.output;
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
    const event = {
      event_id: eventId,
      user_id: partial.userId || this.currentUserId,
      event: partial.event || "ai_interaction",
      timestamp: new Date().toISOString(),
      properties: partial.properties || {},
      ai_data: {
        model: partial.model,
        input: partial.input,
        output: partial.output,
        convo_id: partial.convoId,
      },
      ...(partial.attachments && { attachments: partial.attachments }),
    };

    await this.send("/events/track", [event]);

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
    const signal = {
      event_id: options.eventId,
      signal_name: options.name,
      signal_type: options.type || "default",
      sentiment: options.sentiment || "NEGATIVE",
      timestamp: new Date().toISOString(),
      ...(options.attachmentId && { attachment_id: options.attachmentId }),
      properties: {
        ...(options.comment && { comment: options.comment }),
        ...(options.after && { after: options.after }),
        ...options.properties,
      },
    };

    await this.send("/signals/track", [signal]);

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
          ? "thumbs_up"
          : "thumbs_down"
        : options.type || "thumbs_down";

    const sentiment =
      options.score !== undefined
        ? options.score >= 0.5
          ? "POSITIVE"
          : "NEGATIVE"
        : options.type === "thumbs_up"
        ? "POSITIVE"
        : "NEGATIVE";

    return this.trackSignal({
      eventId: traceId,
      name,
      type: options.signalType === "standard" ? "default" : options.signalType,
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
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

  /**
   * Generate a unique event ID.
   */
  private generateId(): string {
    // Use crypto.randomUUID if available (modern browsers)
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback
    return (
      "evt_" +
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }
}

export default Raindrop;
