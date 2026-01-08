/**
 * Raindrop Vercel AI SDK Integration
 *
 * This module provides integration with Vercel AI SDK's experimental_telemetry feature.
 * It allows you to automatically trace all AI SDK calls without wrapping models.
 *
 * @example Next.js Setup (instrumentation.ts)
 * ```typescript
 * import { registerOTel } from '@vercel/otel';
 * import { RaindropExporter } from 'rd-mini/vercel';
 *
 * export function register() {
 *   registerOTel({
 *     serviceName: 'my-app',
 *     traceExporter: new RaindropExporter({
 *       apiKey: process.env.RAINDROP_API_KEY!,
 *     }),
 *   });
 * }
 * ```
 *
 * @example Using with AI SDK
 * ```typescript
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { raindropTelemetry } from 'rd-mini/vercel';
 *
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   prompt: 'Hello!',
 *   experimental_telemetry: raindropTelemetry({
 *     functionId: 'chat',
 *     userId: 'user_123',
 *     conversationId: 'conv_456',
 *   }),
 * });
 * ```
 *
 * @module rd-mini/vercel
 */

export { RaindropExporter } from './exporter.js';
export type { RaindropExporterConfig, SpanExporter } from './exporter.js';

// ============================================
// Telemetry Helper
// ============================================

export interface RaindropTelemetryOptions {
  /**
   * Function/event name for this call (e.g., 'chat', 'rag_query', 'summarize')
   */
  functionId?: string;

  /**
   * User ID to associate with this trace
   */
  userId?: string;

  /**
   * Conversation/thread ID to group related traces
   */
  conversationId?: string;

  /**
   * Custom event name (alias for functionId)
   */
  event?: string;

  /**
   * Additional custom properties to include in the trace
   */
  properties?: Record<string, string | number | boolean>;

  /**
   * Whether to record input/output content (default: true)
   * Maps to AI SDK's recordInputs/recordOutputs
   */
  recordContent?: boolean;
}

export interface TelemetryConfig {
  isEnabled: true;
  functionId?: string;
  metadata?: Record<string, string | number | boolean>;
  recordInputs?: boolean;
  recordOutputs?: boolean;
}

/**
 * Helper to create experimental_telemetry config with Raindrop metadata.
 *
 * This makes it easy to pass user IDs, conversation IDs, and custom properties
 * to Raindrop via the AI SDK's telemetry system.
 *
 * @example Basic usage
 * ```typescript
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   prompt: 'Hello!',
 *   experimental_telemetry: raindropTelemetry({
 *     userId: 'user_123',
 *   }),
 * });
 * ```
 *
 * @example With all options
 * ```typescript
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   prompt: 'Hello!',
 *   experimental_telemetry: raindropTelemetry({
 *     functionId: 'customer_support',
 *     userId: 'user_123',
 *     conversationId: 'conv_456',
 *     properties: {
 *       experiment: 'v2',
 *       priority: 'high',
 *     },
 *   }),
 * });
 * ```
 *
 * @example Disable content recording for privacy
 * ```typescript
 * experimental_telemetry: raindropTelemetry({
 *   userId: 'user_123',
 *   recordContent: false, // Don't send prompts/responses to Raindrop
 * }),
 * ```
 */
export function raindropTelemetry(options: RaindropTelemetryOptions = {}): TelemetryConfig {
  const metadata: Record<string, string | number | boolean> = {};

  // Add standard Raindrop fields
  if (options.userId) {
    metadata.userId = options.userId;
  }

  if (options.conversationId) {
    metadata.conversationId = options.conversationId;
  }

  // Add custom properties
  if (options.properties) {
    for (const [key, value] of Object.entries(options.properties)) {
      metadata[key] = value;
    }
  }

  const config: TelemetryConfig = {
    isEnabled: true,
    functionId: options.functionId || options.event,
    recordInputs: options.recordContent !== false,
    recordOutputs: options.recordContent !== false,
  };

  // Only add metadata if we have any
  if (Object.keys(metadata).length > 0) {
    config.metadata = metadata;
  }

  return config;
}

/**
 * Filter function to identify AI SDK spans.
 * Use this with spanFilter option if you need custom filtering.
 *
 * @example
 * ```typescript
 * new RaindropExporter({
 *   apiKey: '...',
 *   spanFilter: (span) => isAISDKSpan(span) && span.name !== 'ai.embed',
 * });
 * ```
 */
export function isAISDKSpan(span: {
  name: string;
  instrumentationLibrary: { name: string };
  attributes: Record<string, unknown>;
}): boolean {
  // AI SDK spans have instrumentation library name 'ai'
  if (span.instrumentationLibrary.name === 'ai') return true;

  // Or span names that start with 'ai.'
  if (span.name.startsWith('ai.')) return true;

  // Or have AI-specific attributes
  const attrs = span.attributes;
  if (attrs['ai.model.id'] || attrs['gen_ai.request.model']) return true;

  return false;
}
