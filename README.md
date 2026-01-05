# Raindrop SDK

Zero-config AI observability. Two lines to get started.

```typescript
const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
const openai = raindrop.wrap(new OpenAI());
// That's it. Every call is now traced.
```

## Why?

The old way required 30+ lines of OpenTelemetry setup and adding `experimental_telemetry: { isEnabled: true }` to every single AI call. Miss one? No trace.

The new way: wrap your client once, done.

## Installation

```bash
npm install raindrop
# or
bun add raindrop
```

## Quick Start

### OpenAI

```typescript
import { Raindrop } from 'raindrop';
import OpenAI from 'openai';

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
const openai = raindrop.wrap(new OpenAI());

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
console.log(response._traceId); // Use this for feedback
```

### Anthropic

```typescript
import { Raindrop } from 'raindrop';
import Anthropic from '@anthropic-ai/sdk';

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
const anthropic = raindrop.wrap(new Anthropic());

const response = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.content[0].text);
console.log(response._traceId);
```

### Vercel AI SDK

```typescript
import { Raindrop } from 'raindrop';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });

const result = await generateText({
  model: raindrop.wrap(openai('gpt-4o')),
  prompt: 'Hello!',
});

console.log(result.text);
```

## Streaming

Streaming just works. The trace captures the full output when the stream completes.

```typescript
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Count to 10' }],
  stream: true,
});

// Trace ID available immediately
console.log('Trace:', stream._traceId);

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
// Trace automatically completes with full output
```

## User Feedback

Connect thumbs up/down to specific AI responses:

```typescript
// After getting a response
const response = await openai.chat.completions.create({ ... });

// User clicks thumbs up
await raindrop.feedback(response._traceId, {
  type: 'thumbs_up',
  comment: 'Great answer!',
});

// Or use a score (0-1)
await raindrop.feedback(response._traceId, {
  score: 0.8,
  comment: 'Mostly correct',
});
```

### Feedback Options

```typescript
await raindrop.feedback(traceId, {
  // Pick one:
  type: 'thumbs_up',           // or 'thumbs_down'
  score: 0.8,                  // 0-1, overrides type

  // Optional:
  comment: 'User feedback',
  signalType: 'feedback',      // 'default' | 'feedback' | 'edit' | 'standard'
  attachmentId: 'att_123',     // Link to specific attachment
  properties: { ... },         // Custom data
});
```

## User Identification

Track which users are making which requests:

```typescript
// Identify once, applies to all subsequent calls
raindrop.identify('user_123', {
  name: 'Jane Doe',
  email: 'jane@example.com',
  plan: 'pro',
});

// All calls now include user_123
const response = await openai.chat.completions.create({ ... });
```

Or override per-request:

```typescript
const response = await openai.chat.completions.create(
  { model: 'gpt-4o', messages: [...] },
  { raindrop: { userId: 'different_user' } }
);
```

## Conversation Threading

Group multi-turn conversations:

```typescript
const conversationId = 'conv_' + Date.now();

// Turn 1
const response1 = await openai.chat.completions.create(
  { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi!' }] },
  { raindrop: { conversationId } }
);

// Turn 2 - same conversation
const response2 = await openai.chat.completions.create(
  { model: 'gpt-4o', messages: [...] },
  { raindrop: { conversationId } }
);
```

## Multi-Step Interactions

For complex pipelines (RAG, agents, etc.), group multiple AI calls into a single interaction:

### Context Manager (Simple)

```typescript
const result = await raindrop.withInteraction(
  {
    userId: 'user_123',
    event: 'rag_query',
    input: 'What is the capital of France?',
    conversationId: 'conv_123',
  },
  async (ctx) => {
    // All wrapped clients auto-link to this interaction
    const docs = await searchDocs(query);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: `Docs: ${docs}\n\nQ: ${query}` }],
    });

    // Set the final output
    ctx.output = response.choices[0].message.content;
    return response;
  }
);
```

### Begin/Finish (Flexible)

When you need more control (webhooks, streaming, cross-function):

```typescript
// Start the interaction
const interaction = raindrop.begin({
  eventId: 'evt_123',           // Optional custom ID
  event: 'chat_message',
  userId: 'user_123',
  input: 'What is love?',
  model: 'gpt-4o',
  conversationId: 'conv_123',
});

console.log(interaction.id);  // Access the event ID

// Do your work...
const response = await openai.chat.completions.create({ ... });

// Update properties as you go
interaction.setProperty('stage', 'completed');
interaction.setProperties({ tokens: 150, cached: true });
interaction.addAttachments([
  { type: 'text', name: 'context', value: 'retrieved docs...', role: 'input' }
]);

// Finish when done
interaction.output = response.choices[0].message.content;
interaction.finish();
```

### Resume an Interaction

If you need to finish an interaction elsewhere (e.g., in a webhook handler):

```typescript
// In your initial handler
const interaction = raindrop.begin({ event: 'async_job', userId: 'user_123' });
await saveToDatabase({ eventId: interaction.id, ... });

// Later, in a webhook or different function
const interaction = raindrop.resumeInteraction('evt_123');
interaction.output = 'Final result from webhook';
interaction.finish();
```

## Tool Tracing

Trace custom tool/function calls within interactions:

### Decorator Style

```typescript
// Define a traced tool
const searchDocs = raindrop.wrapTool(
  'search_docs',
  async (query: string) => {
    return await vectorDB.search(query);
  }
);

// Use within an interaction - auto-linked as a span
await raindrop.withInteraction({ event: 'rag' }, async () => {
  const docs = await searchDocs('capital of France');
  // docs call appears as a span in the interaction
});
```

### Python Style

```python
@raindrop.tool("search_docs")
def search_docs(query: str) -> list:
    return vector_db.search(query)

# Use normally - auto-traced
with raindrop.interaction(event="rag_query") as ctx:
    docs = search_docs("capital of France")
    response = openai.chat.completions.create(...)
    ctx.output = response.choices[0].message.content
```

## Attachments

Include additional context with your events:

```typescript
interaction.addAttachments([
  { type: 'code', name: 'example.ts', value: 'console.log("hi")', role: 'input', language: 'typescript' },
  { type: 'text', name: 'context', value: 'Retrieved document...', role: 'input' },
  { type: 'image', value: 'https://example.com/img.png', role: 'output' },
  { type: 'iframe', name: 'Generated UI', value: 'https://app.example.com', role: 'output' },
]);
```

## What Gets Captured

Every traced call automatically captures:

| Field | Description |
|-------|-------------|
| `input` | The prompt or messages |
| `output` | The response text |
| `model` | Model name (gpt-4o, claude-3-5-sonnet, etc.) |
| `latency_ms` | Response time |
| `input_tokens` | Prompt tokens |
| `output_tokens` | Completion tokens |
| `tool_calls` | Function calls with arguments |
| `error` | Error message if failed |
| `user_id` | Associated user |
| `conversation_id` | Conversation thread |

## Configuration

```typescript
const raindrop = new Raindrop({
  // Required
  apiKey: process.env.RAINDROP_API_KEY,

  // Optional
  baseUrl: 'https://api.raindrop.ai',  // Custom endpoint
  debug: true,                          // Log all events to console
  disabled: process.env.NODE_ENV === 'test',  // Disable in tests
});
```

## Cleanup

Flush pending events before your process exits:

```typescript
await raindrop.close();
```

## OpenAI Responses API

The new OpenAI Responses API is also supported:

```typescript
const response = await openai.responses.create({
  model: 'gpt-4.1',
  input: 'Tell me a story',
});

console.log(response._traceId);
```

## API Reference

### `new Raindrop(config)`

Create a new Raindrop instance.

### `raindrop.wrap(client)`

Wrap an AI client or model. Returns the same type with tracing enabled.

### `raindrop.identify(userId, traits?)`

Set the current user for all subsequent calls.

### `raindrop.feedback(traceId, options)`

Send feedback for a specific trace.

### `raindrop.withInteraction(options, fn)`

Execute a function within an interaction context. All traced calls inside are auto-linked.

### `raindrop.begin(options): Interaction`

Start a new interaction with manual control. Returns an `Interaction` handle.

### `raindrop.resumeInteraction(eventId): Interaction`

Resume an existing interaction by ID.

### `raindrop.wrapTool(name, fn, options?)`

Wrap a function as a traced tool.

### `raindrop.getLastTraceId()`

Get the most recent trace ID (backup if you can't access `_traceId`).

### `raindrop.close()`

Flush all pending events and close the transport.

### `Interaction` Object

```typescript
interaction.id                // Get the event ID
interaction.output            // Get/set the output
interaction.setProperty(k, v) // Set a single property
interaction.setProperties({}) // Set multiple properties
interaction.addAttachments([])// Add attachments
interaction.setInput(text)    // Set the input
interaction.finish(options?)  // Finish and send the interaction
```

---

## Before & After

### Before (Old SDK)

```typescript
// instrumentation.ts (15+ lines)
import { registerOTel } from '@vercel/otel';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPHttpProtoTraceExporter } from '@vercel/otel';

export function register() {
  registerOTel({
    serviceName: 'my-app',
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPHttpProtoTraceExporter({
          url: 'https://api.raindrop.ai/v1/traces',
          headers: { Authorization: `Bearer ${process.env.RAINDROP_API_KEY}` },
        }),
      ),
    ],
  });
}

// Then at EVERY call site:
const result = await generateText({
  model: openai('gpt-4o'),
  prompt: message,
  experimental_telemetry: {
    isEnabled: true,  // Easy to forget!
    functionId: 'chat',
    metadata: {
      ...raindrop.metadata({ userId: 'user_123' }),
    },
  },
});
```

### After (New SDK)

```typescript
import { Raindrop } from 'raindrop';
import OpenAI from 'openai';

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
const openai = raindrop.wrap(new OpenAI());

// Use normally - that's it!
const result = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: message }],
});

console.log(result._traceId); // Trace ID included automatically
```

---

Built with frustration at OTEL complexity. Made simple.
