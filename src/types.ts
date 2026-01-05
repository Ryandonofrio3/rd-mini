/**
 * Raindrop SDK Types
 */

export interface RaindropConfig {
  /** Your Raindrop API key */
  apiKey: string;
  /** Base URL for API (default: https://api.raindrop.ai) */
  baseUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Disable all tracking (useful for tests) */
  disabled?: boolean;
}

export interface UserTraits {
  name?: string;
  email?: string;
  plan?: string;
  [key: string]: unknown;
}

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

/**
 * Interaction options for withInteraction()
 */
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

/**
 * Tool wrapper options
 */
export interface WrapToolOptions {
  /** Version number for the tool */
  version?: number;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * Internal context for tracking interaction state
 */
export interface InteractionContext {
  interactionId: string;
  userId?: string;
  conversationId?: string;
  startTime: number;
  input?: string;
  event?: string;
  properties?: Record<string, unknown>;
  spans: SpanData[];
}

/**
 * Span data for tools and tasks
 */
export interface SpanData {
  spanId: string;
  parentId?: string;
  name: string;
  type: 'tool' | 'ai';
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  properties?: Record<string, unknown>;
}
