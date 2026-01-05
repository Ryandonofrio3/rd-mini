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
├── ts/                         # TypeScript SDK (includes browser)
│   ├── src/
│   │   ├── index.ts            # Main entry: rd-mini
│   │   ├── raindrop.ts
│   │   ├── transport.ts
│   │   ├── types.ts
│   │   ├── core/               # Shared code
│   │   │   ├── types.ts
│   │   │   ├── utils.ts
│   │   │   └── format.ts
│   │   ├── browser/            # Browser entry: rd-mini/browser
│   │   │   └── index.ts
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
└── PLAN.md
```

## SDK Summary

| SDK | Status | Package |
|-----|--------|---------|
| TypeScript | ✅ Complete | `rd-mini` |
| Browser | ✅ Complete | `rd-mini/browser` |
| Python | ✅ Complete | `raindrop-ai` |
| Vercel AI SDK | ✅ Built-in | (included in `rd-mini`) |

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

## Feature Completeness Analysis

Compared to the old `raindrop-ai` SDK:

| Feature | Old SDK | New SDK | Status |
|---------|---------|---------|--------|
| Track AI calls | `trackAi()` | `wrap()` auto-traces | ✅ Better |
| Streaming | Manual `trackAiPartial` | Auto on stream end | ✅ Better |
| Multi-step pipelines | `@interaction` decorator | `withInteraction()` | ✅ Same |
| Begin/finish pattern | `begin()`/`finish()` | `begin()`/`finish()` | ✅ Same |
| Resume interaction | `resume_interaction()` | `resumeInteraction()` | ✅ Same |
| Tool tracing | `@tool`, `withTool()` | `wrapTool()` | ✅ Same |
| User identification | `identify()` | `identify()` | ✅ Same |
| Feedback/signals | `track_signal()` | `feedback()` | ✅ Same |
| Attachments | ✅ | ✅ | ✅ Same |
| Conversation threading | `convo_id` | `conversationId` | ✅ Same |
| Debug mode | `debugLogs` | `debug` | ✅ Same |
| Disable tracking | `disabled` | `disabled` | ✅ Same |
| PII redaction | `redactPii` | ❌ | N/A (no source access) |

**Provider support:**
- Old SDK's `instrumentModules` (Cohere, Bedrock, Pinecone, etc.) was just OTEL pass-through, not real support
- New SDK has **better** OpenAI/Anthropic/Vercel AI SDK support with custom wrappers

---

## Next Steps

### Phase 1: Feature Complete (Core) ✅

All Phase 1 items completed:

- [x] **`withTool()` inline pattern** - `Interaction.withTool()` in `ts/src/raindrop.ts:143-182`
- [x] **`version` param to tool tracing** - Added to `WithToolOptions` and `WrapToolOptions`
- [x] **Queue configuration exposed** - `flushInterval`, `maxQueueSize`, `maxRetries` in `RaindropConfig`
- [x] **`flush()` method** - `raindrop.flush()` in `ts/src/raindrop.ts:417-425`

### Repo Consolidation ✅

Consolidated browser and integrations into single `rd-mini` package:

- [x] **Shared core module** - `ts/src/core/` with types, utils, formatters
- [x] **Browser SDK** - `ts/src/browser/index.ts` using shared core
- [x] **Package exports** - `rd-mini` and `rd-mini/browser` entry points
- [x] **CI/CD updated** - Removed separate browser jobs
- [x] **Cleanup** - Removed old `browser/` and `integrations/` folders

### Phase 1.5: Minor Gaps ✅

Closed small gaps identified in feature review:

- [x] **`trackSignal()` in TypeScript SDK** - `ts/src/raindrop.ts`
- [x] **`trackSignal()` in Python SDK** - `python/src/raindrop/client.py`
- [x] **Queue config in Python SDK** - `flush_interval`, `max_queue_size`, `max_retries`
- [x] **Deployment patterns doc** - `docs/guides/deployment.mdx`

### Phase 2: Documentation

- [x] **Deployment patterns** - `docs/guides/deployment.mdx`
- [ ] **Error handling docs** - retry behavior, fire-and-forget semantics
- [ ] **Migration guide from v1** - before/after for common patterns

### Phase 3: Publishing & Verification

1. ~~**Python SDK**~~ ✅ Complete
2. ~~**Repo restructure**~~ ✅ Complete
3. **Dashboard verification** - Make sure data looks right
4. **Documentation** - Mintlify core pages
5. **Publish** - npm + PyPI

### Phase 4: Provider Expansion Strategy

**Current coverage:**
- ✅ OpenAI (direct client)
- ✅ Anthropic (direct client)
- ✅ Vercel AI SDK (covers OpenAI, Anthropic, Google, Mistral, Cohere via AI SDK providers)

**How to add new providers:**

1. Create wrapper in `ts/src/wrappers/newprovider.ts`
2. Proxy the main generation method
3. Extract: model, input, output, tokens, errors
4. Attach `_traceId` to response
5. Add detection in `raindrop.ts:detectProvider()`
6. Add Python equivalent if needed

**Recommended additions (if users request):**

| Provider | Effort | Notes |
|----------|--------|-------|
| Google Gemini (direct) | ~300 lines | For users not using AI SDK |
| AWS Bedrock | ~400 lines | Enterprise, multiple model families |
| Azure OpenAI | ~100 lines | Mostly reuse OpenAI wrapper |
| Mistral (direct) | ~250 lines | For users not using AI SDK |
| Cohere (direct) | ~250 lines | For users not using AI SDK |

**Not recommended:**
- LangChain/LlamaIndex - Too many abstractions, high maintenance
- Self-hosted models - Too varied, users can use HTTP API directly

**Key insight:** The Vercel AI SDK already provides unified interface for many providers. Users on AI SDK get Google, Mistral, Cohere, etc. "for free" via our AI SDK wrapper. Direct provider wrappers only needed for users NOT using AI SDK.

---

## Summary

**Current Status:**
- ✅ Phase 1 (Code): Complete - all core features implemented
- ✅ Repo Consolidation: Complete - single `rd-mini` package with browser export
- ✅ Phase 1.5 (Minor Gaps): Complete - trackSignal, Python queue config, deployment doc
- ⏳ Phase 2 (Docs): Remaining - error handling, migration guide

**Remaining work:**
```
Phase 2 (Docs):    ~1 hour - error handling docs, migration guide
```

**Provider coverage:**
- Direct wrappers: OpenAI, Anthropic
- Via AI SDK: OpenAI, Anthropic, Google, Mistral, Cohere, and any AI SDK provider
- Future (if requested): Bedrock, Azure OpenAI, direct Gemini

The SDK is **feature complete** in terms of code. The `wrap()` pattern is simpler and more maintainable than the OTEL approach.
