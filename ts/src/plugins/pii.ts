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

// Well-known names for name detection
import wellKnownNames from './well-known-names.json' with { type: 'json' };

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
  /** Whether to redact names using greeting/closing context and well-known names (default: false) */
  redactNames?: boolean;
  /** Use specific tokens like <REDACTED_EMAIL> instead of generic <REDACTED> (default: false) */
  specificTokens?: boolean;
}

// Mapping from pattern type to specific replacement token
const SPECIFIC_REPLACEMENTS: Record<string, string> = {
  email: '<REDACTED_EMAIL>',
  phone: '<REDACTED_PHONE>',
  ssn: '<REDACTED_SSN>',
  creditCard: '<REDACTED_CREDIT_CARD>',
  credentials: '<REDACTED_CREDENTIALS>',
  address: '<REDACTED_ADDRESS>',
  password: '<REDACTED_SECRET>',
  name: '<REDACTED_NAME>',
};

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

// Closing patterns for name detection (e.g., "Thanks, John" or "Best regards,\nSarah")
const CLOSING_PATTERN =
  /(thx|thanks|thank you|regards|best|[a-z]+ly|[a-z]+ regards|all the best|happy [a-z]+ing|take care|have a [a-z]+ (weekend|night|day))\s*[,.!]*/gi;

// Common words that look like names but aren't (for signature detection)
const SIGNATURE_EXCLUSIONS = new Set([
  'thanks',
  'thank',
  'best',
  'regards',
  'sincerely',
  'cheers',
  'hello',
  'hi',
  'hey',
  'dear',
  'greetings',
  'respectfully',
  'cordially',
  'warmly',
  'truly',
  'faithfully',
  'kindly',
  'yours',
]);

// ============================================
// Redactor Class
// ============================================

class PiiRedactor {
  private patternMap: Map<PiiPattern, RegExp>;
  private customPatterns: RegExp[];
  private allowList: Set<string>;
  private replacement: string;
  private redactNames: boolean;
  private specificTokens: boolean;
  private wellKnownNamesSet: Set<string>;
  private wellKnownPattern: RegExp | null;

  constructor(options: PiiPluginOptions = {}) {
    const enabledPatterns = options.patterns ?? (Object.keys(PATTERNS) as PiiPattern[]);
    this.patternMap = new Map(enabledPatterns.map((p) => [p, PATTERNS[p]]));
    this.customPatterns = options.customPatterns ?? [];
    this.allowList = new Set(options.allowList ?? []);
    this.replacement = options.replacement ?? '<REDACTED>';
    this.redactNames = options.redactNames ?? false;
    this.specificTokens = options.specificTokens ?? false;

    // Build well-known names set and pattern
    this.wellKnownNamesSet = new Set(wellKnownNames.map((n: string) => n.toLowerCase()));
    if (this.redactNames && this.wellKnownNamesSet.size > 0) {
      const namesPatternStr =
        '\\b(' + wellKnownNames.map((n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b';
      this.wellKnownPattern = new RegExp(namesPatternStr, 'gi');
    } else {
      this.wellKnownPattern = null;
    }
  }

  private getReplacement(patternType: string): string {
    if (this.specificTokens) {
      return SPECIFIC_REPLACEMENTS[patternType] ?? this.replacement;
    }
    return this.replacement;
  }

  redact(text: string): string {
    if (typeof text !== 'string') return text;

    let result = text;

    // Apply built-in patterns with their specific replacements
    for (const [patternType, pattern] of this.patternMap) {
      pattern.lastIndex = 0;
      const replacement = this.getReplacement(patternType);
      result = result.replace(pattern, (match) => {
        if (this.allowList.has(match)) return match;
        return replacement;
      });
    }

    // Apply custom patterns (use generic replacement)
    for (const pattern of this.customPatterns) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, (match) => {
        if (this.allowList.has(match)) return match;
        return this.replacement;
      });
    }

    // Optionally redact names
    if (this.redactNames) {
      result = this.redactNamesInContext(result);
    }

    return result;
  }

  private redactNamesInContext(text: string): string {
    let result = text;
    const nameReplacement = this.getReplacement('name');

    // First, redact well-known names
    if (this.wellKnownPattern) {
      this.wellKnownPattern.lastIndex = 0;
      result = result.replace(this.wellKnownPattern, nameReplacement);
    }

    // Redact names after greetings (e.g., "Hello John" -> "Hello <REDACTED>")
    GREETING_PATTERN.lastIndex = 0;
    const greetingMatches = [...result.matchAll(new RegExp(GREETING_PATTERN.source, 'gi'))];
    for (const match of greetingMatches.reverse()) {
      const startPos = (match.index ?? 0) + match[0].length;
      const nameMatch = result.slice(startPos).match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
      if (nameMatch) {
        const nameStart = startPos;
        const nameEnd = startPos + nameMatch[1].length;
        result = result.slice(0, nameStart) + nameReplacement + result.slice(nameEnd);
      }
    }

    // Redact names before closings (e.g., "Thanks, John" or "Best regards,\nSarah")
    let lines = result.split('\n');
    for (let i = 0; i < lines.length; i++) {
      CLOSING_PATTERN.lastIndex = 0;
      const closingMatch = CLOSING_PATTERN.exec(lines[i]);
      if (closingMatch) {
        const beforeClosing = lines[i].slice(0, closingMatch.index);
        const nameBefore = beforeClosing.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*$/);
        if (nameBefore) {
          lines[i] =
            beforeClosing.slice(0, nameBefore.index) +
            nameReplacement +
            beforeClosing.slice((nameBefore.index ?? 0) + nameBefore[1].length) +
            lines[i].slice(closingMatch.index);
        }
      }
    }
    result = lines.join('\n');

    // Redact standalone signature-like lines (short lines with just capitalized words)
    lines = result.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      const strippedLower = stripped.toLowerCase().replace(/[,.]$/, '');
      if (
        stripped.length < 50 &&
        stripped.length > 0 &&
        /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[,.]?$/.test(stripped) &&
        !lines[i].includes(nameReplacement) &&
        !SIGNATURE_EXCLUSIONS.has(strippedLower)
      ) {
        lines[i] = lines[i].replace(stripped, nameReplacement);
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
      // Redact error messages (may contain sensitive data)
      if (trace.error) {
        trace.error = redactor.redact(trace.error);
      }
      // Redact custom properties
      if (trace.properties) {
        trace.properties = redactor.redactObject(trace.properties) as Record<string, unknown>;
      }
    },

    onSpan(span: SpanData): void {
      if (span.input) {
        span.input = redactor.redactObject(span.input);
      }
      if (span.output) {
        span.output = redactor.redactObject(span.output);
      }
      if (span.error) {
        span.error = redactor.redact(span.error);
      }
      if (span.properties) {
        span.properties = redactor.redactObject(span.properties) as Record<string, unknown>;
      }
    },

    onInteractionEnd(ctx: InteractionContext): void {
      if (ctx.input) {
        ctx.input = redactor.redact(ctx.input);
      }
      if (ctx.output) {
        ctx.output = redactor.redact(ctx.output);
      }
      // Redact interaction properties
      if (ctx.properties) {
        ctx.properties = redactor.redactObject(ctx.properties) as Record<string, unknown>;
      }
      // Redact attachments
      if (ctx.attachments) {
        for (const attachment of ctx.attachments) {
          attachment.value = redactor.redact(attachment.value);
          if (attachment.name) {
            attachment.name = redactor.redact(attachment.name);
          }
        }
      }
      // Redact spans within interaction
      for (const span of ctx.spans) {
        if (span.input) {
          span.input = redactor.redactObject(span.input);
        }
        if (span.output) {
          span.output = redactor.redactObject(span.output);
        }
        if (span.error) {
          span.error = redactor.redact(span.error);
        }
        if (span.properties) {
          span.properties = redactor.redactObject(span.properties) as Record<string, unknown>;
        }
      }
    },
  };
}

export default createPiiPlugin;
