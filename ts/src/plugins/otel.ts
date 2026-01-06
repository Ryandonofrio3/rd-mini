/**
 * OpenTelemetry Export Plugin
 *
 * Exports traces to OpenTelemetry-compatible backends (Datadog, Honeycomb, Jaeger, etc.)
 * Uses the OTEL API as a peer dependency - bring your own TracerProvider.
 *
 * @example
 * ```typescript
 * import { Raindrop } from 'rd-mini';
 * import { createOtelPlugin } from 'rd-mini/plugins/otel';
 * import { trace } from '@opentelemetry/api';
 *
 * // Use existing tracer provider (e.g., from Datadog SDK)
 * const raindrop = new Raindrop({
 *   apiKey,
 *   plugins: [createOtelPlugin({ serviceName: 'my-ai-service' })],
 * });
 * ```
 */

import type {
  RaindropPlugin,
  TraceData,
  SpanData,
  InteractionContext,
} from '../core/types.js';

// ============================================
// Types
// ============================================

export interface OtelPluginOptions {
  /** Service name for OTEL spans */
  serviceName?: string;
  /** Custom tracer name (default: 'raindrop') */
  tracerName?: string;
  /** Whether to include input/output as span attributes (default: true) */
  includeContent?: boolean;
  /** Custom attribute prefix (default: 'raindrop') */
  attributePrefix?: string;
}

// OTEL API types (minimal interface to avoid hard dependency)
interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(endTime?: number): void;
  spanContext(): { traceId: string; spanId: string };
}

interface OtelTracer {
  startSpan(name: string, options?: { startTime?: number }): OtelSpan;
}

interface OtelApi {
  trace: {
    getTracer(name: string): OtelTracer;
  };
  SpanStatusCode: {
    OK: number;
    ERROR: number;
  };
}

// ============================================
// Plugin Implementation
// ============================================

/**
 * Creates an OpenTelemetry export plugin.
 *
 * This plugin creates OTEL spans for all traced AI interactions and tool calls.
 * It uses the global OTEL API, so you need to configure your TracerProvider
 * separately (via Datadog SDK, Honeycomb SDK, or manual OTEL setup).
 *
 * @example
 * ```typescript
 * // With Datadog (assumes dd-trace is initialized)
 * createOtelPlugin({ serviceName: 'my-ai-service' })
 *
 * // With Honeycomb
 * import { HoneycombSDK } from '@honeycombio/opentelemetry-node';
 * new HoneycombSDK().start();
 * createOtelPlugin({ serviceName: 'my-ai-service' })
 * ```
 */
export function createOtelPlugin(options: OtelPluginOptions = {}): RaindropPlugin {
  const {
    serviceName = 'raindrop',
    tracerName = 'raindrop',
    includeContent = true,
    attributePrefix = 'raindrop',
  } = options;

  // Lazy-load OTEL API to allow graceful degradation
  let otel: OtelApi | null = null;
  let tracer: OtelTracer | null = null;

  const getTracer = (): OtelTracer | null => {
    if (tracer) return tracer;

    try {
      // Dynamic import to avoid bundling OTEL if not used
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      otel = require('@opentelemetry/api') as OtelApi;
      tracer = otel.trace.getTracer(tracerName);
      return tracer;
    } catch {
      // OTEL not available - plugin becomes no-op
      console.warn(
        '[raindrop] @opentelemetry/api not found. Install it to enable OTEL export.'
      );
      return null;
    }
  };

  // Track active spans for proper nesting
  const activeSpans = new Map<string, OtelSpan>();

  const setCommonAttributes = (
    span: OtelSpan,
    data: {
      userId?: string;
      conversationId?: string;
      model?: string;
      provider?: string;
      latencyMs?: number;
      error?: string;
    }
  ): void => {
    span.setAttribute(`${attributePrefix}.service`, serviceName);
    if (data.userId) span.setAttribute(`${attributePrefix}.user_id`, data.userId);
    if (data.conversationId)
      span.setAttribute(`${attributePrefix}.conversation_id`, data.conversationId);
    if (data.model) span.setAttribute(`${attributePrefix}.model`, data.model);
    if (data.provider) span.setAttribute(`${attributePrefix}.provider`, data.provider);
    if (data.latencyMs) span.setAttribute(`${attributePrefix}.latency_ms`, data.latencyMs);
    if (data.error) {
      span.setAttribute(`${attributePrefix}.error`, data.error);
      span.setStatus({ code: otel?.SpanStatusCode.ERROR ?? 2, message: data.error });
    }
  };

  return {
    name: 'otel-export',

    onInteractionStart(ctx: InteractionContext): void {
      const t = getTracer();
      if (!t) return;

      const span = t.startSpan(`interaction:${ctx.event ?? 'default'}`, {
        startTime: ctx.startTime,
      });

      span.setAttribute(`${attributePrefix}.interaction_id`, ctx.interactionId);
      span.setAttribute(`${attributePrefix}.type`, 'interaction');

      if (includeContent && ctx.input) {
        span.setAttribute(`${attributePrefix}.input`, ctx.input);
      }

      setCommonAttributes(span, {
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        model: ctx.model,
      });

      activeSpans.set(ctx.interactionId, span);
    },

    onInteractionEnd(ctx: InteractionContext): void {
      const span = activeSpans.get(ctx.interactionId);
      if (!span) return;

      if (includeContent && ctx.output) {
        span.setAttribute(`${attributePrefix}.output`, ctx.output);
      }

      // Calculate end time
      const endTime = Date.now();
      const latencyMs = endTime - ctx.startTime;
      span.setAttribute(`${attributePrefix}.latency_ms`, latencyMs);

      span.setStatus({ code: otel?.SpanStatusCode.OK ?? 1 });
      span.end(endTime);
      activeSpans.delete(ctx.interactionId);
    },

    onSpan(spanData: SpanData): void {
      const t = getTracer();
      if (!t) return;

      const span = t.startSpan(`${spanData.type}:${spanData.name}`, {
        startTime: spanData.startTime,
      });

      span.setAttribute(`${attributePrefix}.span_id`, spanData.spanId);
      span.setAttribute(`${attributePrefix}.type`, spanData.type);
      span.setAttribute(`${attributePrefix}.name`, spanData.name);

      if (spanData.parentId) {
        span.setAttribute(`${attributePrefix}.parent_id`, spanData.parentId);
      }

      if (includeContent) {
        if (spanData.input) {
          span.setAttribute(
            `${attributePrefix}.input`,
            typeof spanData.input === 'string'
              ? spanData.input
              : JSON.stringify(spanData.input)
          );
        }
        if (spanData.output) {
          span.setAttribute(
            `${attributePrefix}.output`,
            typeof spanData.output === 'string'
              ? spanData.output
              : JSON.stringify(spanData.output)
          );
        }
      }

      setCommonAttributes(span, {
        latencyMs: spanData.latencyMs,
        error: spanData.error,
      });

      span.setStatus({
        code: spanData.error ? (otel?.SpanStatusCode.ERROR ?? 2) : (otel?.SpanStatusCode.OK ?? 1),
      });
      span.end(spanData.endTime);
    },

    onTrace(trace: TraceData): void {
      const t = getTracer();
      if (!t) return;

      const span = t.startSpan(`ai:${trace.provider}:${trace.model}`, {
        startTime: trace.startTime,
      });

      span.setAttribute(`${attributePrefix}.trace_id`, trace.traceId);
      span.setAttribute(`${attributePrefix}.type`, 'ai');

      if (includeContent) {
        if (trace.input) {
          span.setAttribute(
            `${attributePrefix}.input`,
            typeof trace.input === 'string' ? trace.input : JSON.stringify(trace.input)
          );
        }
        if (trace.output) {
          span.setAttribute(
            `${attributePrefix}.output`,
            typeof trace.output === 'string' ? trace.output : JSON.stringify(trace.output)
          );
        }
      }

      // Token counts
      if (trace.tokens) {
        if (trace.tokens.input) {
          span.setAttribute(`${attributePrefix}.tokens.input`, trace.tokens.input);
        }
        if (trace.tokens.output) {
          span.setAttribute(`${attributePrefix}.tokens.output`, trace.tokens.output);
        }
        if (trace.tokens.total) {
          span.setAttribute(`${attributePrefix}.tokens.total`, trace.tokens.total);
        }
      }

      // Tool calls
      if (trace.toolCalls && trace.toolCalls.length > 0) {
        span.setAttribute(`${attributePrefix}.tool_calls_count`, trace.toolCalls.length);
        span.setAttribute(
          `${attributePrefix}.tool_calls`,
          JSON.stringify(trace.toolCalls.map((tc) => tc.name))
        );
      }

      setCommonAttributes(span, {
        userId: trace.userId,
        conversationId: trace.conversationId,
        model: trace.model,
        provider: trace.provider,
        latencyMs: trace.latencyMs,
        error: trace.error,
      });

      span.setStatus({
        code: trace.error ? (otel?.SpanStatusCode.ERROR ?? 2) : (otel?.SpanStatusCode.OK ?? 1),
      });
      span.end(trace.endTime);
    },

    async flush(): Promise<void> {
      // OTEL providers typically handle their own flushing
      // This is a no-op but could be extended if needed
    },

    async shutdown(): Promise<void> {
      activeSpans.clear();
    },
  };
}

export default createOtelPlugin;
