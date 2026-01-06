/**
 * Raindrop SDK - API Payload Formatting
 * Shared between server and browser SDKs
 */

import type {
  TraceData,
  FeedbackOptions,
  UserTraits,
  SpanData,
  Attachment,
  SignalOptions,
} from './types.js';
import { SDK_NAME, SDK_VERSION } from './utils.js';

/**
 * Get SDK context metadata to include in events
 */
function getContext(): Record<string, unknown> {
  return {
    library: {
      name: SDK_NAME,
      version: SDK_VERSION,
    },
  };
}

/**
 * Safely stringify a value, handling circular refs, BigInt, and errors
 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      // Handle BigInt
      if (typeof val === 'bigint') {
        return val.toString();
      }
      // Handle circular references
      if (val !== null && typeof val === 'object') {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/**
 * Safely convert input/output to string format for API
 */
function toApiString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return safeStringify(value);
}

/**
 * Convert attachment to API format (attachmentId → attachment_id)
 */
export function toApiAttachment(att: Attachment): Record<string, unknown> {
  return {
    type: att.type,
    name: att.name,
    value: att.value,
    role: att.role,
    language: att.language,
    ...(att.attachmentId && { attachment_id: att.attachmentId }),
  };
}

// ============================================
// Interaction Data (for transport)
// ============================================

export interface InteractionPayload {
  interactionId: string;
  userId?: string;
  event: string;
  input?: string;
  output?: string;
  startTime: number;
  endTime: number;
  latencyMs: number;
  conversationId?: string;
  properties?: Record<string, unknown>;
  attachments?: Attachment[];
  error?: string;
  spans: SpanData[];
}

// ============================================
// Format functions
// ============================================

/**
 * Format a trace for the /events/track API
 */
export function formatTrace(trace: TraceData): Record<string, unknown> {
  return {
    event_id: trace.traceId,
    user_id: trace.userId,
    event: 'ai_interaction',
    timestamp: new Date(trace.startTime).toISOString(),
    properties: {
      $context: getContext(),
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
      input: toApiString(trace.input),
      output: toApiString(trace.output),
      convo_id: trace.conversationId,
    },
    // Include tool calls if present
    ...(trace.toolCalls && trace.toolCalls.length > 0 && {
      attachments: trace.toolCalls.map(tc => ({
        type: 'code',
        name: `tool:${tc.name}`,
        value: safeStringify({ arguments: tc.arguments, result: tc.result }),
        role: 'output',
        language: 'json',
      })),
    }),
  };
}

/**
 * Format an interaction for the /events/track API
 */
export function formatInteraction(interaction: InteractionPayload): Record<string, unknown> {
  // Convert spans to attachments for now (until we have proper nested trace support)
  const spanAttachments = interaction.spans.map(span => ({
    type: 'code',
    name: `${span.type}:${span.name}`,
    value: safeStringify({
      spanId: span.spanId,
      input: span.input,
      output: span.output,
      latencyMs: span.latencyMs,
      error: span.error,
      properties: span.properties,
    }),
    role: 'output',
    language: 'json',
  }));

  // Combine user attachments (mapped to API format) with span attachments
  const allAttachments = [
    ...(interaction.attachments || []).map(toApiAttachment),
    ...spanAttachments,
  ];

  return {
    event_id: interaction.interactionId,
    user_id: interaction.userId,
    event: interaction.event,
    timestamp: new Date(interaction.startTime).toISOString(),
    properties: {
      $context: getContext(),
      latency_ms: interaction.latencyMs,
      span_count: interaction.spans.length,
      ...(interaction.error && { error: interaction.error }),
      ...interaction.properties,
    },
    ai_data: {
      input: toApiString(interaction.input),
      output: toApiString(interaction.output),
      convo_id: interaction.conversationId,
    },
    ...(allAttachments.length > 0 && { attachments: allAttachments }),
  };
}

/**
 * Format feedback for the /signals/track API
 */
export function formatFeedback(traceId: string, feedback: FeedbackOptions): Record<string, unknown> {
  return {
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
  };
}

/**
 * Format a signal for the /signals/track API
 */
export function formatSignal(options: SignalOptions): Record<string, unknown> {
  return {
    event_id: options.eventId,
    signal_name: options.name,
    signal_type: options.type || 'default',
    sentiment: options.sentiment || 'NEGATIVE',
    timestamp: new Date().toISOString(),
    ...(options.attachmentId && { attachment_id: options.attachmentId }),
    properties: {
      ...(options.comment && { comment: options.comment }),
      ...(options.after && { after: options.after }),
      ...options.properties,
    },
  };
}

/**
 * Format user identification for the /users/identify API
 */
export function formatIdentify(userId: string, traits: UserTraits): Record<string, unknown> {
  return {
    user_id: userId,
    traits,
  };
}

/**
 * Format an AI event for the /events/track API (browser SDK style)
 */
export function formatAiEvent(options: {
  eventId: string;
  event: string;
  userId?: string;
  model?: string;
  input?: string;
  output?: string;
  convoId?: string;
  properties?: Record<string, unknown>;
  attachments?: Attachment[];
}): Record<string, unknown> {
  return {
    event_id: options.eventId,
    user_id: options.userId,
    event: options.event,
    timestamp: new Date().toISOString(),
    properties: {
      $context: getContext(),
      ...options.properties,
    },
    ai_data: {
      model: options.model,
      input: options.input,
      output: options.output,
      convo_id: options.convoId,
    },
    ...(options.attachments && { attachments: options.attachments.map(toApiAttachment) }),
  };
}
