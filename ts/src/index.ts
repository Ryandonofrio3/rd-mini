/**
 * Raindrop - Zero-config AI Observability SDK
 *
 * @example
 * ```typescript
 * import { Raindrop } from 'raindrop';
 * import OpenAI from 'openai';
 *
 * const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
 * const openai = raindrop.wrap(new OpenAI());
 *
 * // All calls are now automatically traced
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 *
 * console.log(response._traceId); // Access trace ID for feedback
 * ```
 */

export { Raindrop, Interaction } from './raindrop.js';
export type {
  RaindropConfig,
  UserTraits,
  FeedbackOptions,
  RaindropRequestOptions,
  WithTraceId,
  InteractionOptions,
  InteractionContext,
  WrapToolOptions,
  BeginOptions,
  FinishOptions,
  Attachment,
} from './types.js';
