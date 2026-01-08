/**
 * Raindrop Exporter for Vercel AI SDK
 *
 * Receives OTEL spans from Vercel AI SDK's experimental_telemetry and sends them to Raindrop.
 * This allows zero-code instrumentation for any Vercel AI SDK provider (OpenAI, Anthropic,
 * Google, Bedrock, etc.)
 *
 * @example Next.js instrumentation.ts
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
 * @example Node.js with NodeSDK
 * ```typescript
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 * import { RaindropExporter } from 'rd-mini/vercel';
 *
 * const sdk = new NodeSDK({
 *   traceExporter: new RaindropExporter({
 *     apiKey: process.env.RAINDROP_API_KEY!,
 *   }),
 * });
 * sdk.start();
 * ```
 *
 * @example Usage in AI SDK calls
 * ```typescript
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 *
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   prompt: 'Hello!',
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     functionId: 'chat',
 *     metadata: {
 *       userId: 'user_123',
 *       conversationId: 'conv_456',
 *     },
 *   },
 * });
 * ```
 */

// ============================================
// Types - OTEL interfaces (avoid hard dependency)
// ============================================

/** OTEL HrTime is [seconds, nanoseconds] */
type HrTime = [number, number];

/** Minimal ReadableSpan interface from @opentelemetry/sdk-trace-base */
interface ReadableSpan {
  name: string;
  kind: number;
  spanContext(): { traceId: string; spanId: string };
  parentSpanId?: string;
  startTime: HrTime;
  endTime: HrTime;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  instrumentationLibrary: { name: string; version?: string };
  events: Array<{ name: string; time: HrTime; attributes?: Record<string, unknown> }>;
  resource?: { attributes: Record<string, unknown> };
}

/** ExportResult from @opentelemetry/core */
interface ExportResult {
  code: number;
  error?: Error;
}

const ExportResultCode = {
  SUCCESS: 0,
  FAILED: 1,
} as const;

/** SpanExporter interface from @opentelemetry/sdk-trace-base */
export interface SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

// ============================================
// Configuration
// ============================================

export interface RaindropExporterConfig {
  /** Your Raindrop API key */
  apiKey: string;

  /** Base URL for Raindrop API (default: https://api.raindrop.ai) */
  baseUrl?: string;

  /** Enable debug logging (default: false) */
  debug?: boolean;

  /**
   * Filter function to select which spans to export.
   * By default, only AI SDK spans are exported.
   * Return true to export, false to skip.
   */
  spanFilter?: (span: ReadableSpan) => boolean;

  /**
   * Whether to include prompt/response content in traces (default: true)
   * Set to false for privacy if you don't want content sent to Raindrop
   */
  includeContent?: boolean;

  /**
   * Batch size for sending events (default: 100)
   */
  batchSize?: number;

  /**
   * Timeout in ms for API requests (default: 30000)
   */
  timeout?: number;
}

// ============================================
// Helpers
// ============================================

/** Convert OTEL HrTime to milliseconds */
function hrTimeToMs(hrTime: HrTime): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6;
}

/** Convert OTEL HrTime to ISO timestamp */
function hrTimeToIso(hrTime: HrTime): string {
  return new Date(hrTimeToMs(hrTime)).toISOString();
}

/** Default filter: only AI SDK spans */
function isAISDKSpan(span: ReadableSpan): boolean {
  // AI SDK spans have instrumentation library name 'ai'
  if (span.instrumentationLibrary.name === 'ai') return true;

  // Or span names that start with 'ai.'
  if (span.name.startsWith('ai.')) return true;

  // Or have AI-specific attributes
  const attrs = span.attributes;
  if (attrs['ai.model.id'] || attrs['gen_ai.request.model']) return true;

  return false;
}

/** Extract string attribute safely */
function getStringAttr(attrs: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = attrs[key];
    if (typeof val === 'string') return val;
  }
  return undefined;
}

/** Extract number attribute safely */
function getNumberAttr(attrs: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = attrs[key];
    if (typeof val === 'number') return val;
  }
  return undefined;
}

// ============================================
// Exporter Implementation
// ============================================

export class RaindropExporter implements SpanExporter {
  private apiKey: string;
  private baseUrl: string;
  private debug: boolean;
  private spanFilter: (span: ReadableSpan) => boolean;
  private includeContent: boolean;
  private batchSize: number;
  private timeout: number;
  private pendingExports: Promise<void>[] = [];
  private isShutdown = false;

  constructor(config: RaindropExporterConfig) {
    if (!config.apiKey) {
      throw new Error('RaindropExporter: apiKey is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.raindrop.ai';
    this.debug = config.debug || false;
    this.spanFilter = config.spanFilter || isAISDKSpan;
    this.includeContent = config.includeContent !== false;
    this.batchSize = config.batchSize || 100;
    this.timeout = config.timeout || 30000;

    if (this.debug) {
      console.log('[raindrop] Exporter initialized', { baseUrl: this.baseUrl });
    }
  }

  /**
   * Export spans to Raindrop
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('Exporter is shutdown') });
      return;
    }

    // Filter to AI SDK spans only
    const aiSpans = spans.filter(this.spanFilter);

    if (aiSpans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    if (this.debug) {
      console.log(`[raindrop] Exporting ${aiSpans.length} AI spans (filtered from ${spans.length})`);
    }

    // Transform spans to Raindrop events
    const events = aiSpans.map((span) => this.transformSpan(span));

    // Send in batches
    const exportPromise = this.sendEvents(events)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error) => {
        if (this.debug) {
          console.error('[raindrop] Export failed:', error);
        }
        resultCallback({ code: ExportResultCode.FAILED, error });
      });

    this.pendingExports.push(exportPromise);
  }

  /**
   * Transform an OTEL span to a Raindrop event
   */
  private transformSpan(span: ReadableSpan): Record<string, unknown> {
    const attrs = span.attributes;
    const ctx = span.spanContext();

    // Extract model info - AI SDK uses various attribute names
    const model =
      getStringAttr(attrs, 'ai.model.id', 'gen_ai.request.model', 'ai.model') ||
      getStringAttr(attrs, 'ai.settings.model') ||
      'unknown';

    const provider =
      getStringAttr(attrs, 'ai.model.provider', 'gen_ai.system', 'ai.provider') ||
      this.inferProvider(model);

    // Extract usage/tokens
    const inputTokens = getNumberAttr(
      attrs,
      'ai.usage.promptTokens',
      'gen_ai.usage.prompt_tokens',
      'ai.usage.input_tokens'
    );
    const outputTokens = getNumberAttr(
      attrs,
      'ai.usage.completionTokens',
      'gen_ai.usage.completion_tokens',
      'ai.usage.output_tokens'
    );

    // Extract input/output content
    let input: unknown = undefined;
    let output: unknown = undefined;

    if (this.includeContent) {
      // Input can be prompt or messages
      input =
        attrs['ai.prompt'] ||
        attrs['gen_ai.prompt'] ||
        attrs['ai.prompt.messages'] ||
        this.extractMessages(attrs);

      // Output is the response text
      output =
        attrs['ai.response.text'] ||
        attrs['gen_ai.completion'] ||
        attrs['ai.result.text'] ||
        attrs['ai.response'];
    }

    // Extract tool calls
    const toolCalls = this.extractToolCalls(span);

    // Extract custom metadata from experimental_telemetry
    const userId =
      getStringAttr(attrs, 'userId', 'user_id', 'ai.telemetry.metadata.userId') ||
      getStringAttr(attrs, 'ai.telemetry.metadata.user_id');
    const conversationId =
      getStringAttr(attrs, 'conversationId', 'conversation_id', 'ai.telemetry.metadata.conversationId') ||
      getStringAttr(attrs, 'convoId', 'convo_id', 'ai.telemetry.metadata.convoId');

    // Function ID becomes the event name
    const event =
      getStringAttr(attrs, 'ai.telemetry.functionId', 'functionId') ||
      span.name.replace(/^ai\./, '') ||
      'ai_call';

    // Calculate timing
    const startTime = hrTimeToMs(span.startTime);
    const endTime = hrTimeToMs(span.endTime);
    const latencyMs = endTime - startTime;

    // Extract error if present
    const error = span.status.code === 2 ? span.status.message : undefined;

    // Build properties from remaining metadata
    const properties: Record<string, unknown> = {};

    // Include any ai.telemetry.metadata.* attributes
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('ai.telemetry.metadata.') && !['userId', 'user_id', 'conversationId', 'convoId'].some(k => key.endsWith(k))) {
        const propKey = key.replace('ai.telemetry.metadata.', '');
        properties[propKey] = value;
      }
    }

    // Include resource attributes if available
    if (span.resource?.attributes) {
      const serviceName = span.resource.attributes['service.name'];
      if (serviceName) properties['service_name'] = serviceName;
    }

    return {
      event_id: ctx.spanId,
      trace_id: ctx.traceId,
      parent_id: span.parentSpanId,
      event,
      timestamp: hrTimeToIso(span.startTime),
      user_id: userId,
      convo_id: conversationId,
      ai_data: {
        model,
        provider,
        input,
        output,
        latency_ms: Math.round(latencyMs),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        error,
      },
      properties: Object.keys(properties).length > 0 ? properties : undefined,
    };
  }

  /**
   * Infer provider from model name
   */
  private inferProvider(model: string): string {
    const m = model.toLowerCase();
    if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'openai';
    if (m.includes('claude')) return 'anthropic';
    if (m.includes('gemini')) return 'google';
    if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
    if (m.includes('llama')) return 'meta';
    if (m.includes('command')) return 'cohere';
    return 'unknown';
  }

  /**
   * Extract messages from attributes
   */
  private extractMessages(attrs: Record<string, unknown>): unknown {
    // AI SDK may store messages as JSON string or array
    const messagesAttr = attrs['ai.prompt.messages'] || attrs['gen_ai.prompt.messages'];
    if (typeof messagesAttr === 'string') {
      try {
        return JSON.parse(messagesAttr);
      } catch {
        return messagesAttr;
      }
    }
    return messagesAttr;
  }

  /**
   * Extract tool calls from span events or attributes
   */
  private extractToolCalls(span: ReadableSpan): Array<{ id: string; name: string; arguments: unknown }> {
    const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];

    // Check span events for tool calls
    for (const event of span.events) {
      if (event.name === 'ai.toolCall' || event.name === 'gen_ai.tool_call') {
        const attrs = event.attributes || {};
        toolCalls.push({
          id: (attrs['ai.toolCall.id'] as string) || '',
          name: (attrs['ai.toolCall.name'] as string) || (attrs['name'] as string) || '',
          arguments: attrs['ai.toolCall.args'] || attrs['arguments'],
        });
      }
    }

    // Also check attributes for tool calls
    const toolCallsAttr = span.attributes['ai.response.toolCalls'];
    if (typeof toolCallsAttr === 'string') {
      try {
        const parsed = JSON.parse(toolCallsAttr);
        if (Array.isArray(parsed)) {
          for (const tc of parsed) {
            toolCalls.push({
              id: tc.id || tc.toolCallId || '',
              name: tc.name || tc.toolName || '',
              arguments: tc.args || tc.arguments,
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return toolCalls;
  }

  /**
   * Send events to Raindrop API
   */
  private async sendEvents(events: Record<string, unknown>[]): Promise<void> {
    // Send in batches
    for (let i = 0; i < events.length; i += this.batchSize) {
      const batch = events.slice(i, i + this.batchSize);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.baseUrl}/v1/events/track`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(batch),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        if (this.debug) {
          console.log(`[raindrop] Sent ${batch.length} events successfully`);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Force flush any pending exports
   */
  async forceFlush(): Promise<void> {
    await Promise.all(this.pendingExports);
    this.pendingExports = [];
  }

  /**
   * Shutdown the exporter
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.forceFlush();

    if (this.debug) {
      console.log('[raindrop] Exporter shutdown');
    }
  }
}
