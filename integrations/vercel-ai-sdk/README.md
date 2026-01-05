# Raindrop Vercel AI SDK Integration

Automatic tracing for Vercel AI SDK models.

## Installation

```bash
npm install @raindrop/vercel-ai ai
```

## Usage

### With Raindrop SDK

```typescript
import { Raindrop } from "raindrop";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });

// Wrap the model
const model = raindrop.wrapModel(openai("gpt-4"));

// Use as normal
const { text } = await generateText({
  model,
  prompt: "Hello, world!",
});

console.log(text);
```

### Standalone (without main SDK)

```typescript
import { wrapModel, createRaindropContext } from "@raindrop/vercel-ai";
import { openai } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

// Create context
const context = createRaindropContext({
  apiKey: process.env.RAINDROP_API_KEY!,
  debug: true,
});

// Wrap model
const model = wrapModel(context, openai("gpt-4"));

// Non-streaming
const { text } = await generateText({
  model,
  prompt: "Explain quantum computing",
});

// Streaming
const { textStream } = await streamText({
  model,
  prompt: "Write a haiku",
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### With Options

```typescript
const { text } = await generateText({
  model,
  prompt: "Hello",
  // Raindrop-specific options
  raindrop: {
    userId: "user-123",
    conversationId: "conv-456",
    properties: {
      experiment: "v2",
    },
  },
});
```

## Features

- Automatic tracing of all `generateText` and `streamText` calls
- Token counting
- Latency measurement
- Error tracking
- User and conversation threading
- Custom properties

## Supported Models

Works with any Vercel AI SDK compatible model:

- `@ai-sdk/openai`
- `@ai-sdk/anthropic`
- `@ai-sdk/google`
- `@ai-sdk/mistral`
- And more...
