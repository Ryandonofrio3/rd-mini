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
 * Format an interaction for the /events/track API
 */
export function formatInteraction(interaction: InteractionPayload): Record<string, unknown> {
  // Convert spans to attachments for now (until we have proper nested trace support)
  const spanAttachments = interaction.spans.map(span => ({
    type: 'code',
    name: `${span.type}:${span.name}`,
    value: JSON.stringify({
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

  // Combine user attachments with span attachments
  const allAttachments = [
    ...(interaction.attachments || []),
    ...spanAttachments,
  ];

  return {
    event_id: interaction.interactionId,
    user_id: interaction.userId,
    event: interaction.event,
    timestamp: new Date(interaction.startTime).toISOString(),
    properties: {
      latency_ms: interaction.latencyMs,
      span_count: interaction.spans.length,
      ...(interaction.error && { error: interaction.error }),
      ...interaction.properties,
    },
    ai_data: {
      input: interaction.input,
      output: interaction.output,
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
    properties: options.properties || {},
    ai_data: {
      model: options.model,
      input: options.input,
      output: options.output,
      convo_id: options.convoId,
    },
    ...(options.attachments && { attachments: options.attachments }),
  };
}
