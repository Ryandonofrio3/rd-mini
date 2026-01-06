/**
 * Raindrop SDK - Shared Utilities
 */

/**
 * SDK metadata - keep in sync with package.json
 */
export const SDK_NAME = 'rd-mini';
export const SDK_VERSION = '0.1.0';

/**
 * Maximum event size in bytes (1MB)
 */
export const MAX_EVENT_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Generate a unique trace/event ID
 */
export function generateId(prefix: string = 'trace'): string {
  // Use crypto.randomUUID if available
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  // Fallback for environments without crypto.randomUUID
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Default base URL for Raindrop API
 */
export const DEFAULT_BASE_URL = 'https://api.raindrop.ai';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  debug: false,
  disabled: false,
  flushInterval: 1000,
  maxQueueSize: 100,
  maxRetries: 3,
  redactPii: false,
} as const;

/**
 * Delay utility for retries
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safely stringify a value for logging/transmission
 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
