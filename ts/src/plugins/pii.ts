/**
 * PII Redaction Plugin
 *
 * Redacts personally identifiable information from trace data before it's sent.
 * Uses regex patterns to identify and replace sensitive data.
 *
 * @example
 * ```typescript
 * import { Raindrop } from 'rd-mini';
 * import { createPiiPlugin } from 'rd-mini/plugins/pii';
 *
 * const raindrop = new Raindrop({
 *   apiKey,
 *   plugins: [createPiiPlugin()],
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

export type PiiPattern =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'creditCard'
  | 'credentials'
  | 'address'
  | 'password';

export interface PiiPluginOptions {
  /** Which built-in patterns to use (default: all) */
  patterns?: PiiPattern[];
  /** Custom regex patterns to add */
  customPatterns?: RegExp[];
  /** Strings to never redact */
  allowList?: string[];
  /** Replacement string (default: <REDACTED>) */
  replacement?: string;
  /** Whether to redact names using greeting/closing context (default: false) */
  redactNames?: boolean;
}

// ============================================
// Built-in Patterns
// ============================================

const PATTERNS: Record<PiiPattern, RegExp> = {
  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,

  // Phone numbers (US-style, flexible)
  phone: /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,

  // SSN (xxx-xx-xxxx or variations)
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,

  // Credit card numbers (13-19 digits with optional spaces/dashes)
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,

  // API keys, tokens, secrets in key=value format
  credentials:
    /\b(api[_-]?key|token|bearer|authorization|auth[_-]?token|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[\w-]+["']?/gi,

  // Street addresses (simplified)
  address:
    /\b\d+\s+[A-Za-z\s]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|plaza|pl|terrace|ter|way|parkway|pkwy)\b/gi,

  // Password/secret patterns
  password: /\b(pass(word|phrase)?|secret|pwd|passwd)\s*[:=]\s*\S+/gi,
};

// Greeting patterns for name detection
const GREETING_PATTERN = /(^|\.\s+)(dear|hi|hello|greetings|hey|hey there)[\s,:-]*/gi;

// ============================================
// Redactor Class
// ============================================

class PiiRedactor {
  private patterns: RegExp[];
  private allowList: Set<string>;
  private replacement: string;
  private redactNames: boolean;

  constructor(options: PiiPluginOptions = {}) {
    const enabledPatterns = options.patterns ?? (Object.keys(PATTERNS) as PiiPattern[]);
    this.patterns = enabledPatterns.map((p) => PATTERNS[p]);
    if (options.customPatterns) {
      this.patterns.push(...options.customPatterns);
    }
    this.allowList = new Set(options.allowList ?? []);
    this.replacement = options.replacement ?? '<REDACTED>';
    this.redactNames = options.redactNames ?? false;
  }

  redact(text: string): string {
    if (typeof text !== 'string') return text;

    let result = text;

    // Apply all patterns
    for (const pattern of this.patterns) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      result = result.replace(pattern, (match) => {
        if (this.allowList.has(match)) return match;
        return this.replacement;
      });
    }

    // Optionally redact names after greetings/before closings
    if (this.redactNames) {
      result = this.redactNamesInContext(result);
    }

    return result;
  }

  private redactNamesInContext(text: string): string {
    let result = text;

    // Redact names after greetings (e.g., "Hello John" -> "Hello <REDACTED>")
    result = result.replace(GREETING_PATTERN, (match) => {
      const afterMatch = result.slice(result.indexOf(match) + match.length);
      const nameMatch = afterMatch.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
      if (nameMatch) {
        return match + this.replacement;
      }
      return match;
    });

    // Redact standalone signature-like lines (short lines with just capitalized words)
    const lines = result.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (
        stripped.length < 50 &&
        stripped.length > 0 &&
        /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[,.]?$/.test(stripped)
      ) {
        lines[i] = lines[i].replace(stripped, this.replacement);
      }
    }

    return lines.join('\n');
  }

  redactObject(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      return this.redact(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.redactObject(value);
      }
      return result;
    }

    return obj;
  }
}

// ============================================
// Plugin Factory
// ============================================

/**
 * Creates a PII redaction plugin.
 *
 * @example
 * ```typescript
 * // Use all default patterns
 * createPiiPlugin()
 *
 * // Only redact emails and phone numbers
 * createPiiPlugin({ patterns: ['email', 'phone'] })
 *
 * // Add custom patterns
 * createPiiPlugin({
 *   customPatterns: [/INTERNAL-\d+/g],
 *   allowList: ['support@company.com'],
 * })
 * ```
 */
export function createPiiPlugin(options: PiiPluginOptions = {}): RaindropPlugin {
  const redactor = new PiiRedactor(options);

  return {
    name: 'pii-redaction',

    onTrace(trace: TraceData): void {
      // Redact input/output
      if (trace.input) {
        trace.input = redactor.redactObject(trace.input);
      }
      if (trace.output) {
        trace.output = redactor.redactObject(trace.output);
      }
      // Redact tool call arguments/results
      if (trace.toolCalls) {
        for (const call of trace.toolCalls) {
          if (call.arguments) {
            call.arguments = redactor.redactObject(call.arguments);
          }
          if (call.result) {
            call.result = redactor.redactObject(call.result);
          }
        }
      }
    },

    onSpan(span: SpanData): void {
      if (span.input) {
        span.input = redactor.redactObject(span.input);
      }
      if (span.output) {
        span.output = redactor.redactObject(span.output);
      }
    },

    onInteractionEnd(ctx: InteractionContext): void {
      if (ctx.input) {
        ctx.input = redactor.redact(ctx.input);
      }
      if (ctx.output) {
        ctx.output = redactor.redact(ctx.output);
      }
      // Redact spans within interaction
      for (const span of ctx.spans) {
        if (span.input) {
          span.input = redactor.redactObject(span.input);
        }
        if (span.output) {
          span.output = redactor.redactObject(span.output);
        }
      }
    },
  };
}

export default createPiiPlugin;
