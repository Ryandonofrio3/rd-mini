/**
 * Raindrop SDK - Shared Types
 * Used by both server and browser SDKs
 */

// ============================================
// Configuration
// ============================================

export interface RaindropConfig {
  /** Your Raindrop API key */
  apiKey: string;
  /** Base URL for API (default: https://api.raindrop.ai) */
  baseUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Disable all tracking (useful for tests) */
  disabled?: boolean;
  /** Flush interval in ms (default: 1000) */
  flushInterval?: number;
  /** Max events in queue before auto-flush (default: 100) */
  maxQueueSize?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Plugins for extending SDK behavior (PII redaction, OTEL export, etc.) */
  plugins?: RaindropPlugin[];
  /** Enable PII redaction (convenience option, equivalent to adding PII plugin) */
  redactPii?: boolean;
}

// ============================================
// Plugins
// ============================================

/**
 * Plugin interface for extending Raindrop SDK behavior.
 * Plugins receive lifecycle hooks and can mutate data before it's sent.
 *
 * @example
 * ```typescript
 * const myPlugin: RaindropPlugin = {
 *   name: 'my-plugin',
 *   onTrace(trace) {
 *     // Mutate trace data before sending
 *     trace.properties = { ...trace.properties, customField: 'value' };
 *   }
 * };
 * ```
 */
export interface RaindropPlugin {
  /** Unique plugin name for debugging */
  name: string;

  /** Called when an interaction starts (begin/withInteraction) */
  onInteractionStart?(ctx: InteractionContext): void;

  /** Called when an interaction ends (before sending to transport) */
  onInteractionEnd?(ctx: InteractionContext): void;

  /** Called when a span completes (tool/AI call within interaction) */
  onSpan?(span: SpanData): void;

  /** Called when a trace is created (standalone wrapped AI call) */
  onTrace?(trace: TraceData): void;

  /** Called during flush - plugins should send any buffered data */
  flush?(): Promise<void>;

  /** Called during shutdown - plugins should cleanup resources */
  shutdown?(): Promise<void>;
}

export interface UserTraits {
  name?: string;
  email?: string;
  plan?: string;
  [key: string]: unknown;
}

// ============================================
// Attachments
// ============================================

export interface Attachment {
  type: 'code' | 'text' | 'image' | 'iframe';
  /** Optional unique ID for targeting this attachment with signals */
  attachmentId?: string;
  name?: string;
  value: string;
  role: 'input' | 'output';
  language?: string;
}

// ============================================
// Traces
// ============================================

export interface TraceData {
  traceId: string;
  provider: 'openai' | 'anthropic' | 'ai-sdk' | 'unknown';
  model: string;
  input: unknown;
  output?: unknown;
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
  toolCalls?: ToolCall[];
  userId?: string;
  conversationId?: string;
  error?: string;
  properties?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
}

// ============================================
// Feedback / Signals
// ============================================

export interface FeedbackOptions {
  /** Score from 0 to 1, or use type for categorical */
  score?: number;
  /** Categorical feedback type */
  type?: 'thumbs_up' | 'thumbs_down';
  /** Optional comment */
  comment?: string;
  /** Signal type: default, feedback, edit, or standard */
  signalType?: 'default' | 'feedback' | 'edit' | 'standard';
  /** Reference to a specific attachment */
  attachmentId?: string;
  /** ISO timestamp (auto-generated if not provided) */
  timestamp?: string;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

export interface SignalOptions {
  eventId: string;
  name: string;
  type?: 'default' | 'feedback' | 'edit';
  sentiment?: 'POSITIVE' | 'NEGATIVE';
  comment?: string;
  after?: string;
  attachmentId?: string;
  properties?: Record<string, unknown>;
}

// ============================================
// Request Options
// ============================================

export interface RaindropRequestOptions {
  /** Override user ID for this request */
  userId?: string;
  /** Conversation ID for threading */
  conversationId?: string;
  /** Custom trace ID (generated if not provided) */
  traceId?: string;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * Extended response type that includes _traceId
 */
export type WithTraceId<T> = T & { _traceId: string };

/**
 * Provider detection result
 */
export type ProviderType = 'openai' | 'anthropic' | 'ai-sdk' | 'unknown';

// ============================================
// Interactions (Server SDK)
// ============================================

export interface InteractionOptions {
  /** User ID for this interaction */
  userId?: string;
  /** Event name (e.g., "rag_query", "chat_message") */
  event?: string;
  /** Input to the interaction (user's query) */
  input?: string;
  /** Conversation ID for threading */
  conversationId?: string;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

export interface BeginOptions {
  /** Custom event ID (generated if not provided) */
  eventId?: string;
  /** User ID for this interaction */
  userId?: string;
  /** Event name (e.g., "rag_query", "chat_message") */
  event?: string;
  /** Input to the interaction (user's query) */
  input?: string;
  /** AI model being used */
  model?: string;
  /** Conversation ID for threading */
  conversationId?: string;
  /** Additional properties */
  properties?: Record<string, unknown>;
  /** Initial attachments */
  attachments?: Attachment[];
}

export interface FinishOptions {
  /** The final output of the interaction */
  output?: string;
  /** Additional properties to merge */
  properties?: Record<string, unknown>;
  /** Additional attachments to add */
  attachments?: Attachment[];
}

export interface InteractionContext {
  interactionId: string;
  userId?: string;
  conversationId?: string;
  startTime: number;
  input?: string;
  output?: string;
  model?: string;
  event?: string;
  properties?: Record<string, unknown>;
  attachments?: Attachment[];
  spans: SpanData[];
}

// ============================================
// Tools / Spans
// ============================================

export interface WrapToolOptions {
  /** Version number for the tool */
  version?: number;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

export interface WithToolOptions {
  /** Name of the tool */
  name: string;
  /** Version number for the tool */
  version?: number;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

export interface SpanData {
  spanId: string;
  parentId?: string;
  name: string;
  type: 'tool' | 'ai';
  version?: number;
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  properties?: Record<string, unknown>;
}

// ============================================
// Browser SDK specific
// ============================================

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

export interface IdentifyOptions {
  userId: string;
  traits?: UserTraits;
}
