# Raindrop SDK - Developer Guide

## Project Overview

Zero-config AI observability SDK. The core insight: wrap your AI client once, all calls are traced automatically.

```typescript
// Old way: 30+ lines OTEL setup + experimental_telemetry on every call
// New way:
const raindrop = new Raindrop({ apiKey });
const openai = raindrop.wrap(new OpenAI());
// Done. Every call traced.
```

## Repository Structure

```
raindrop-mini/
├── ts/                         # TypeScript SDK (includes browser)
│   ├── src/
│   │   ├── index.ts            # Main exports
│   │   ├── raindrop.ts         # Core Raindrop class (~700 lines)
│   │   ├── transport.ts        # HTTP transport with batching/retry
│   │   ├── types.ts            # Re-exports from core
│   │   ├── core/               # Shared code (browser + server)
│   │   │   ├── types.ts        # All type definitions
│   │   │   ├── utils.ts        # generateId, DEFAULT_CONFIG, delay
│   │   │   └── format.ts       # API payload formatters
│   │   ├── browser/            # Browser entry point
│   │   │   └── index.ts        # Lightweight browser SDK
│   │   └── wrappers/           # Provider-specific wrappers
│   │       ├── openai.ts       # OpenAI wrapper (~400 lines)
│   │       ├── anthropic.ts    # Anthropic wrapper (~350 lines)
│   │       └── ai-sdk.ts       # Vercel AI SDK wrapper (~300 lines)
│   ├── tests/
│   │   ├── unit/               # Unit tests (bun test)
│   │   └── integration/        # Integration tests
│   └── package.json
│
├── python/                     # Python SDK
│   ├── src/raindrop/
│   │   ├── client.py           # Core Raindrop class
│   │   ├── transport.py        # HTTP transport
│   │   ├── types.py            # Type definitions
│   │   └── wrappers/
│   │       ├── openai.py
│   │       └── anthropic.py
│   ├── tests/
│   └── pyproject.toml
│
├── docs/                       # Mintlify documentation (separate git repo)
│
├── existing_docs/              # Old SDK docs (reference only)
│
├── PLAN.md                     # Project roadmap
└── CLAUDE.md                   # This file
```

## Key Design Decisions

### 1. Wrap Pattern (not decorators or OTEL)

```typescript
const openai = raindrop.wrap(new OpenAI());
```

Why:
- Works with any client instance
- Zero changes at call sites
- No OTEL complexity
- Trace ID available immediately on responses (`response._traceId`)

### 2. AsyncLocalStorage for Context (TypeScript)

```typescript
// In raindrop.ts
const interactionStorage = new AsyncLocalStorage<InteractionContext>();

// withInteraction sets context
await raindrop.withInteraction({ ... }, async () => {
  // All wrapped calls inside automatically link to this interaction
  await openai.chat.completions.create(...);
});
```

Python uses `contextvars` for the same purpose.

### 3. Fire-and-Forget Transport

```typescript
// transport.ts
sendTrace(trace: TraceData): void {  // Note: void, not Promise
  this.enqueue({ type: 'trace', data: formatTrace(trace), timestamp: Date.now() });
}
```

- Never blocks user code
- Batches events (flushInterval, maxQueueSize)
- Retries with exponential backoff
- Swallows errors (logs in debug mode)

### 4. Spans as Nested Data (not separate OTEL spans)

Interactions contain spans array:
```typescript
{
  interactionId: "trace_xxx",
  spans: [
    { spanId: "span_1", type: "tool", name: "search_docs", ... },
    { spanId: "span_2", type: "ai", name: "openai:gpt-4o", ... }
  ]
}
```

Sent as single event to `/events/track`, dashboard renders the tree.

### 5. Provider Detection

```typescript
// raindrop.ts:detectProvider()
private detectProvider(client: unknown): ProviderType {
  // OpenAI: has chat.completions
  if (c.chat?.completions) return 'openai';
  // Anthropic: has messages.create
  if (c.messages?.create) return 'anthropic';
  // AI SDK: has modelId and provider
  if (c.modelId && c.provider) return 'ai-sdk';
  return 'unknown';
}
```

## API Endpoints

All requests to `https://api.raindrop.ai/v1`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/events/track` | POST | Traces and interactions (array of events) |
| `/signals/track` | POST | Feedback signals (array of signals) |
| `/users/identify` | POST | User identification (single object) |

Authorization: `Bearer ${apiKey}`

## Package Exports

```json
// ts/package.json
"exports": {
  ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
  "./browser": { "import": "./dist/browser/index.js", "types": "./dist/browser/index.d.ts" }
}
```

Usage:
```typescript
import { Raindrop } from 'rd-mini';           // Server
import { Raindrop } from 'rd-mini/browser';   // Browser
```

## Key Files Deep Dive

### `ts/src/raindrop.ts`
- `Raindrop` class: main entry point
- `Interaction` class: handle for begin/finish pattern
- `wrap()`: detects provider, returns wrapped client
- `withInteraction()`: context manager with AsyncLocalStorage
- `wrapTool()`: wraps functions for tracing
- `feedback()`: sends feedback signals

### `ts/src/wrappers/openai.ts`
- Proxies `chat.completions.create()` and `responses.create()`
- Handles streaming (wraps async iterator)
- Extracts tokens, tool calls from response
- Attaches `_traceId` to response object

### `ts/src/transport.ts`
- Queue-based batching
- Groups by endpoint type before sending
- Exponential backoff retry (100ms, 200ms, 400ms...)
- `flush()` for manual flush, `close()` for shutdown

### `ts/src/core/format.ts`
- `formatTrace()`: converts TraceData to API format
- `formatInteraction()`: converts interaction + spans
- `formatFeedback()`: converts FeedbackOptions to signal
- `formatSignal()`: full signal options
- `formatIdentify()`: user identification

## Common Tasks

### Add a new provider wrapper

1. Create `ts/src/wrappers/newprovider.ts`
2. Export wrap function: `export function wrapNewProvider(client, context)`
3. Proxy the main method (e.g., `client.generate()`)
4. Extract: model, input, output, tokens, errors
5. Call `context.sendTrace()` on completion
6. Attach `_traceId` to response
7. Add detection in `raindrop.ts:detectProvider()`
8. Add to `wrap()` switch statement

### Add a new config option

1. Add to `RaindropConfig` in `ts/src/core/types.ts`
2. Add default in `DEFAULT_CONFIG` in `ts/src/core/utils.ts`
3. Handle in `Raindrop` constructor
4. Pass to Transport if needed

### Add a new API method

1. Add types to `ts/src/core/types.ts`
2. Add formatter to `ts/src/core/format.ts`
3. Add transport method to `ts/src/transport.ts`
4. Add public method to `ts/src/raindrop.ts`
5. Export types from `ts/src/index.ts`

## Testing

```bash
# TypeScript
cd ts
bun test tests/unit          # Unit tests
bun test tests/integration   # Integration tests (needs API key)
bun run build               # Type check + compile

# Python
cd python
uv sync --dev
uv run pytest tests/ -v
```

## CI/CD

- `.github/workflows/ci.yml`: Tests on push/PR
- `.github/workflows/release.yml`: Publishes on GitHub release

TypeScript → npm (`rd-mini`)
Python → PyPI (`raindrop-ai`)

## Debugging

```typescript
const raindrop = new Raindrop({ apiKey, debug: true });
// Logs: [raindrop] Initialized, Wrapping provider, Queued event, Sent N events...
```

## Migration from Old SDK

| Old | New |
|-----|-----|
| `raindrop-ai` | `rd-mini` |
| `writeKey` | `apiKey` |
| `debugLogs` | `debug` |
| `setUserDetails()` | `identify()` |
| `trackAi()` | Use `wrap()` - automatic |
| `convo_id` | `conversationId` |
| OTEL setup | Deleted - not needed |
| `experimental_telemetry` | Deleted - not needed |

## Known Limitations

- **PII Redaction**: Not implemented (no source access to old implementation)
- **Other providers**: Only OpenAI, Anthropic, Vercel AI SDK have wrappers
- **Python queue config**: Not exposed yet (uses defaults)

## Architecture Principles

1. **Never block user code** - All I/O is fire-and-forget
2. **Zero config for common cases** - `wrap()` just works
3. **Escape hatches for complex cases** - `begin()`/`finish()`, `wrapTool()`
4. **Share code where possible** - `core/` module for browser + server
5. **Type safety** - Full TypeScript, exported types for users
