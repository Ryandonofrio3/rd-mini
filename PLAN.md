# Raindrop SDK v2 - Project Plan

## Vision

Replace the complex OTEL-based SDK with a simple "wrap once, trace everything" pattern.

**Before (30+ lines):**
```typescript
// instrumentation.ts setup...
// OTEL exporters...
// At every call site:
experimental_telemetry: { isEnabled: true, ... }
```

**After (2 lines):**
```typescript
const raindrop = new Raindrop({ apiKey });
const openai = raindrop.wrap(new OpenAI());
```

---

## Completed ✅

### TypeScript SDK Core

| Feature | Status | Notes |
|---------|--------|-------|
| `wrap()` for OpenAI | ✅ | Non-streaming, streaming, tool calls |
| `wrap()` for Anthropic | ✅ | Non-streaming, streaming, tool calls |
| `wrap()` for AI SDK | ✅ | Vercel AI SDK models |
| `identify()` | ✅ | User traits sent to /users/identify |
| `feedback()` | ✅ | Signals sent to /signals/track |
| `_traceId` on responses | ✅ | Available immediately, even on streams |
| Token counting | ✅ | Captured from provider responses |
| Latency measurement | ✅ | Automatic start/end timing |
| Error handling | ✅ | Errors traced with error field |
| Conversation threading | ✅ | Via `conversationId` option |
| Custom properties | ✅ | Via `properties` option |

### Multi-Step Pipelines

| Feature | Status | Notes |
|---------|--------|-------|
| `withInteraction()` | ✅ | Automatic context via AsyncLocalStorage |
| `wrapTool()` | ✅ | Wrap functions for auto-tracing |
| Nested spans | ✅ | AI calls + tools within interaction |
| Span linking | ✅ | All spans include parentId |

### Transport Layer

| Feature | Status | Notes |
|---------|--------|-------|
| Batched sending | ✅ | Queue + flush on interval/size |
| Retry with backoff | ✅ | 3 retries, exponential backoff |
| Fire-and-forget | ✅ | Non-blocking, swallows errors |
| `/events/track` | ✅ | Traces and interactions |
| `/signals/track` | ✅ | Feedback signals |
| `/users/identify` | ✅ | User identification |

### Test Suite

| Test File | Tests | Status |
|-----------|-------|--------|
| `test-basic.ts` | 7 | ✅ All passing |
| `test-context.ts` | 8 | ✅ All passing |
| `test-interaction.ts` | 3 | ✅ All passing |
| `run-all-tests.ts` | Runner | ✅ Working |

---

### Python SDK

| Feature | Status | Notes |
|---------|--------|-------|
| `wrap()` for OpenAI | ✅ | Non-streaming, streaming, tool calls |
| `wrap()` for Anthropic | ✅ | Non-streaming, streaming, tool calls |
| `identify()` | ✅ | User traits sent to /users/identify |
| `feedback()` | ✅ | Signals sent to /signals/track |
| `_trace_id` on responses | ✅ | Available immediately |
| `with interaction()` | ✅ | Context manager with contextvars |
| `@tool` decorator | ✅ | Decorator and wrap_tool() function |
| Transport layer | ✅ | Batching, retry, fire-and-forget |
| Tests | ✅ | 18 tests passing |

**Usage:**
```python
from raindrop import Raindrop
from openai import OpenAI

raindrop = Raindrop(api_key=os.environ["RAINDROP_API_KEY"])
client = raindrop.wrap(OpenAI())

response = client.chat.completions.create(...)
print(response._trace_id)
```

---

## Planned 📋

### Documentation (Mintlify)

Separate repo for docs using Mintlify.

**Structure:**
```
docs/
├── introduction.mdx
├── quickstart.mdx
├── typescript/
│   ├── installation.mdx
│   ├── wrap.mdx
│   ├── interactions.mdx
│   ├── feedback.mdx
│   └── api-reference.mdx
├── python/
│   ├── installation.mdx
│   ├── wrap.mdx
│   ├── interactions.mdx
│   └── api-reference.mdx
└── migration/
    └── from-v1.mdx
```

### Publishing

- [ ] Publish TypeScript SDK to npm as `raindrop`
- [ ] Publish Python SDK to PyPI as `raindrop-ai`
- [ ] Set up CI/CD for releases

### Dashboard Verification

- [ ] Verify events appear correctly in Raindrop dashboard
- [ ] Check span nesting displays properly
- [ ] Confirm feedback links to correct traces
- [ ] Test conversation threading view

---

## Project Structure

```
raindrop-mini/
├── ts/                         # TypeScript SDK
│   ├── src/
│   │   ├── index.ts
│   │   ├── raindrop.ts
│   │   ├── transport.ts
│   │   ├── types.ts
│   │   └── wrappers/
│   │       ├── openai.ts
│   │       ├── anthropic.ts
│   │       └── ai-sdk.ts
│   ├── examples/
│   └── package.json
│
├── python/                     # Python SDK
│   ├── src/raindrop/
│   │   ├── client.py
│   │   ├── transport.py
│   │   ├── types.py
│   │   └── wrappers/
│   │       ├── openai.py
│   │       └── anthropic.py
│   ├── tests/
│   └── pyproject.toml
│
├── browser/                    # Browser SDK (lightweight)
│   ├── src/index.ts
│   └── package.json
│
├── http/                       # HTTP API docs & examples
│   └── README.md
│
├── integrations/
│   ├── vercel-ai-sdk/          # Vercel AI SDK integration
│   │   ├── src/index.ts
│   │   └── package.json
│   └── segment/                # Segment integration docs
│       └── README.md
│
└── PLAN.md
```

## SDK Summary

| SDK | Status | Package |
|-----|--------|---------|
| TypeScript | ✅ Complete | `raindrop` |
| Python | ✅ Complete | `raindrop-ai` |
| Browser | ✅ Structure | `@raindrop/browser` |
| HTTP API | ✅ Documented | N/A |
| Vercel AI SDK | ✅ Structure | `@raindrop/vercel-ai` |
| Segment | ✅ Documented | N/A |

---

## Key Design Decisions

### 1. Wrap pattern vs decorators

We use `wrap()` because:
- Works with any client instance
- No code changes at call sites
- Familiar pattern (like middleware)

### 2. AsyncLocalStorage for context

TypeScript uses `AsyncLocalStorage` to propagate interaction context:
- No manual context passing
- Works across async boundaries
- Python will use `contextvars`

### 3. Spans as attachments

Currently, nested spans are sent as JSON attachments on the interaction event:
- Simple, works with existing API
- Dashboard can parse and display
- Future: native span support in API

### 4. Fire-and-forget transport

All sends are non-blocking:
- Never slows down user's code
- Retry in background
- Lose events on crash (acceptable tradeoff)

---

## Commands

### TypeScript SDK

```bash
cd ts

# Build
bun run build

# Run tests
bun run test:all

# Dev mode (watch)
bun run dev
```

### Python SDK

```bash
cd python

# Initialize (first time)
uv sync --dev

# Run tests
uv run python -m pytest tests/ -v

# Build package
uv build
```

### Browser SDK

```bash
cd browser

# Install deps
bun install

# Build
bun run build
```

### Vercel AI SDK Integration

```bash
cd integrations/vercel-ai-sdk

# Install deps
bun install

# Build
bun run build
```

---

## Next Steps

Priority order:

1. ~~**Python SDK**~~ ✅ Complete
2. ~~**Repo restructure**~~ ✅ Complete (ts/, python/, browser/, integrations/)
3. **Dashboard verification** - Make sure data looks right
4. **Documentation** - Mintlify setup + core pages
5. **Publish** - npm + PyPI
6. **Additional providers** - Cohere, Bedrock, etc.
