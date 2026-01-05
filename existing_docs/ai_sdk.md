Skip to main content
Raindrop home pagelight logo

Search...
⌘K

Ask AI
Support
Raindrop

Getting Started
Introduction
SDK
TypeScript
Python
HTTP API
Browser (JavaScript)
Vercel AI SDK (Beta)
Segment (Beta)
Platform
Signals
Experiments
Alerts
Search
Security
Privacy and PII Redaction
Data Security and Privacy
Privacy Policy
Terms of Use

On this page
Setting up OpenTelemetry in Next.js
Setting up OpenTelemetry in Node.js
Setting up OpenTelemetry in Cloudflare Workers
Using with Sentry (Next.js)
Instrumenting AI SDK Calls
Troubleshooting
Enable OpenTelemetry Debug Logging
Ensure Telemetry is Enabled at All Call Sites
Cloudflare Workers: Spans Incomplete or Missing
SDK
Vercel AI SDK (Beta)
If you’re using the Vercel AI SDK, Raindrop can automatically track AI events and traces using the AI SDK’s OpenTelemetry integration.

To integrate Raindrop with the Vercel AI SDK you’ll complete two steps:
Configure an OpenTelemetry (OTEL) trace exporter (instructions differ for Next.js, Node.js, and Cloudflare Workers).
Instrument your Vercel AI SDK calls and attach Raindrop metadata (common to all).
​
Setting up OpenTelemetry in Next.js
First, install the required OpenTelemetry packages.

npm

pnpm

bun
bun add raindrop-ai @opentelemetry/api @opentelemetry/sdk-trace-base @vercel/otel
Then, register the OpenTelemetry tracing exporter in your instrumentation.ts file.
// instrumentation.ts
import { registerOTel, OTLPHttpProtoTraceExporter } from '@vercel/otel';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

export function register() {
  registerOTel({
    serviceName: 'ai-chatbot',
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPHttpProtoTraceExporter({
          url: 'https://api.raindrop.ai/v1/traces',
          headers: {
            'Authorization': `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
          },
        }),
      ),
    ],
  });
}
​
Setting up OpenTelemetry in Node.js
For Node.js applications, first install the required OpenTelemetry packages.

npm

pnpm

bun
bun add raindrop-ai @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/resources @opentelemetry/semantic-conventions @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-proto @opentelemetry/sdk-trace-node
Then, configure the OpenTelemetry SDK:
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'ai-chatbot',
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: 'https://api.raindrop.ai/v1/traces',
        headers: {
          'Authorization': `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
        },
      })
    ),
  ],
});

sdk.start();
​
Setting up OpenTelemetry in Cloudflare Workers
Cloudflare’s native tracing doesn’t support custom spans, so we use @microlabs/otel-cf-workers.

npm

pnpm

bun
bun add raindrop-ai @opentelemetry/axpi @microlabs/otel-cf-workers
Add nodejs_compat to your wrangler.toml:
compatibility_flags = ["nodejs_compat"]
Create the OTEL config:
// src/otel.ts
import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';

export interface Env {
  RAINDROP_WRITE_KEY: string;
  [key: string]: unknown;
}

export const otelConfig: ResolveConfigFn<Env> = (env, _trigger) => ({
  exporter: {
    url: 'https://api.raindrop.ai/v1/traces',
    headers: { 'Authorization': `Bearer ${env.RAINDROP_WRITE_KEY}` },
  },
  service: { name: 'my-worker' },
});

export { instrument };
Wrap your handler:
// src/index.ts
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import raindrop from 'raindrop-ai/otel';
import { instrument, otelConfig, Env } from './otel';

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    const { prompt } = await request.json();

    const result = streamText({
      model: openai('gpt-4o'),
      prompt,
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'chat',
        metadata: {
          ...raindrop.metadata({ userId: 'user_123' }),
        },
      },
    });

    // Required for streaming: waitUntil keeps the worker alive to flush spans
    ctx.waitUntil(result.text);

    return result.toTextStreamResponse();
  },
};

export default instrument(handler, otelConfig);
​
Using with Sentry (Next.js)
If you’re already using Sentry for error tracking and tracing in your Next.js app, you can add Raindrop’s trace exporter directly to Sentry’s OpenTelemetry configuration instead of setting up a separate instrumentation file.
First, install the required OpenTelemetry packages alongside your existing Sentry setup:

npm

pnpm

bun
bun add @opentelemetry/exporter-trace-otlp-proto @opentelemetry/sdk-trace-base
Then, add the Raindrop exporter to Sentry’s openTelemetrySpanProcessors option in your sentry.server.config.ts:
// sentry.server.config.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1,
  openTelemetrySpanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: "https://api.raindrop.ai/v1/traces",
        headers: {
          Authorization: `Bearer ${process.env.RAINDROP_WRITE_KEY}`,
        },
      })
    ),
  ],
});
This approach helps avoid issues with OTEL duplicate registration issues eg. Error: @opentelemetry/api: Attempted duplicate registration of API: trace.
​
Instrumenting AI SDK Calls
To instrument your AI SDK calls:
Enable experimental_telemetry: { isEnabled: true } at all AI SDK call sites
Add Raindrop metadata at the top-level call that handles user input and produces the final output using raindrop.metadata()
import { generateText, openai, tool } from 'ai';
import { z } from 'zod';
import raindrop from 'raindrop-ai/otel';

const enhanceStory = tool({
  description: 'Enhance a story with additional details',
  parameters: z.object({
    story: z.string().describe('The story to enhance'),
  }),
  execute: async ({ story }) => {
    // This nested call only needs isEnabled: true, no metadata
    const enhanced = await generateText({
      model: openai('gpt-4o'),
      prompt: `Enhance this story with more vivid details: ${story}`,
      experimental_telemetry: {
        isEnabled: true, // Required at all call sites
        functionId: 'enhance-story',
      },
    });
    return { enhancedStory: enhanced.text };
  },
});

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Write a short story about a cat.',
  tools: {
    enhanceStory,
  },
  experimental_telemetry: {
    isEnabled: true, // Required
    functionId: 'generate-text',
    metadata: {
      ...raindrop.metadata({
        userId: 'user_123', // Required
        eventName: 'story_generation',
        convoId: 'convo_123',
      }),
    },
  },
});
​
Troubleshooting
​
Enable OpenTelemetry Debug Logging
If traces aren’t appearing in the Raindrop dashboard, enable debug logging to see what’s happening under the hood:
OTEL_LOG_LEVEL=debug npm run dev
This will output detailed logs about span creation, export attempts, and any errors during trace transmission.
​
Ensure Telemetry is Enabled at All Call Sites
A common issue is forgetting to add experimental_telemetry: { isEnabled: true } to nested AI SDK calls. Every generateText, streamText, generateObject, etc. call must have telemetry enabled for traces to be captured:
// ❌ Won't be traced - missing experimental_telemetry
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello world',
});

// ✅ Will be traced
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello world',
  experimental_telemetry: { isEnabled: true },
});
​
Cloudflare Workers: Spans Incomplete or Missing
Streaming responses require waitUntil
The instrument() wrapper flushes spans when the handler returns. With streaming, the handler returns immediately while the LLM is still generating. Without waitUntil, spans get flushed before they complete:
// ❌ Spans will be incomplete
const result = streamText({ ... });
return result.toTextStreamResponse();

// ✅ Spans will be complete
const result = streamText({ ... });
ctx.waitUntil(result.text);  // Delays flush until stream completes
return result.toTextStreamResponse();
If your spans show 1ms durations or are missing child spans, this is likely the cause.
That’s it! You’re ready to explore your events in the Raindrop dashboard. Ping us on Slack or email us if you get stuck!
Was this page helpful?


Yes

No
Browser (JavaScript)
Segment (Beta)
Ask a question...

x
Powered by
Vercel AI SDK (Beta) - Raindrop