# rd-mini vs raindrop-ai: Feature Differences

Last updated: 2026-01-05

## Implementation Status

| Feature | Status |
|---------|--------|
| Signal Types (feedback, edit, default) | ✅ Done |
| Attachments | ✅ Done |
| Resume Interactions | ✅ Done |
| Browser localStorage Persistence | ✅ Done |
| Partial Events API (/events/track_partial) | ✅ Done |
| Python @task, @workflow decorators | ✅ Done |
| Manual Span Control (start_span) | ✅ Done |
| PII Redaction | ⏸️ Skipped (revisit later) |
| SDK Version in Events | ✅ Done |
| Event Size Limits | ✅ Done |
| Python atexit Handler | ✅ Done (was already there) |
| Buffer Overflow Handling | ✅ Done |
| Browser visibilitychange | ✅ Done |
| Identify Endpoint Format | ✅ Fixed |
| Partial Events (Server TS) | ⏸️ Skipped (browser-only for now) |
| disabled Config Option | ✅ Done (was already there) |
| Context Propagation (begin/resume) | ✅ Fixed |
| Empty String Output Bug | ✅ Fixed |
| Safe Serialization | ✅ Done |
| Attachment ID Support | ✅ Done |

## Architecture Difference

**rd-mini**: Direct wrap pattern with AsyncLocalStorage context. Zero dependencies beyond core SDK.

**raindrop-ai**: Built on Traceloop + OpenTelemetry. 70+ instrumentation packages. No auto-wrapping (manual tracking only).

---

## What rd-mini Does Better

- **Auto-instrumentation via wrap()** - they require manual `trackAi()` calls
- **Zero config** - 2 lines to start vs Traceloop init + env vars
- **Minimal dependencies** - 1 dep vs 70+ OTEL packages
- **Provider wrappers** - OpenAI, Anthropic, AI SDK built-in (they have none)

---

## Missing Features in rd-mini

### P1 - High Priority

#### Signal Types (feedback, edit, default) ✅ DONE
- `trackSignal()` with full options: type, sentiment, comment, after
- SignalOptions type with all fields
- Endpoint: `/signals/track`

#### Attachments ✅ DONE
- Types: "code", "text", "image", "iframe"
- Fields: `type`, `value`, `name`, `role` ("input", "output"), `language`
- `addAttachments()` on Interaction class

### P2 - Medium Priority

#### PII Redaction
- **SKIPPED** - Will revisit later
- Not implemented (noted in CLAUDE.md as known limitation)
- Python SDK: 199 LOC, 20+ regex patterns, 2,200+ well-known names list
- TS SDK: Uses `@dawn-analytics/redact-pii` package
- Patterns: emails, SSNs, credit cards, phone numbers, passwords, addresses, names
- Config: `redactPii: boolean` in options

#### Browser localStorage Persistence ✅ DONE
- Persist queue to localStorage on `beforeunload`
- Restore and flush on next page load
- Queue failed requests for retry

### P3 - Lower Priority

#### Partial Events API ✅ DONE
- `trackAiPartial()` sends to `/events/track_partial` endpoint
- Supports `is_pending: true/false` for streaming updates
- Final event also sent to `/events/track` for complete record

#### Resume Interactions ✅ DONE (was already implemented)
- `resumeInteraction(eventId)` in both TS and Python
- Continue building on existing interaction

#### Decorators (Python only) ✅ DONE
- `@raindrop.workflow(name="chat")` - wrap entire function as interaction
- `@raindrop.task(name="process")` - wrap as task span
- `@raindrop.tool(name="search")` - wrap as tool span

#### Manual Span Control ✅ DONE
- `startSpan(name, { type })` in TypeScript
- `start_span(name, kind)` in Python
- Returns `ManualSpan` with `record_input()`, `record_output()`, `set_properties()`, `end()`
- Use case: Complex async flows where context managers don't work

---

## API Endpoints Comparison

| Endpoint | rd-mini | raindrop-ai |
|----------|---------|-------------|
| `/events/track` | ✅ | ✅ |
| `/events/track_partial` | ✅ | ✅ |
| `/signals/track` | ✅ (full) | ✅ (full) |
| `/users/identify` | ✅ | ✅ |

---

## Config Options Comparison

| Option | rd-mini | raindrop-ai |
|--------|---------|-------------|
| `apiKey` / `writeKey` | ✅ | ✅ |
| `debug` / `debugLogs` | ✅ | ✅ |
| `endpoint` | ✅ | ✅ |
| `flushInterval` | ✅ | ✅ (`bufferTimeout`) |
| `maxQueueSize` | ✅ | ✅ (`bufferSize`) |
| `redactPii` | ❌ | ✅ |
| `disabled` | ❌ | ✅ |
| `disableTracing` | ❌ | ✅ |
| `instrumentModules` | ❌ | ✅ (12+ providers) |

---

## Production Gaps (P0) - ALL FIXED

### SDK Version in Events ✅
- Now sends `$context.library` with SDK name/version on every event
- TypeScript: Added to `format.ts` (formatTrace, formatInteraction, formatAiEvent)
- Python: Added to `transport.py` (_format_trace, send_interaction)

### Event Size Limits ✅
- Events > 1MB are now rejected with warning in debug mode
- TypeScript: `MAX_EVENT_SIZE_BYTES` in utils.ts, checked in transport.ts
- Python: `MAX_EVENT_SIZE_BYTES` in transport.py, checked in _enqueue

### Python atexit Handler ✅
- Was already implemented: `atexit.register(self.close)` in transport.py:56

### Buffer Overflow Handling ✅
- Warns at 80% capacity, discards oldest event at 100%
- TypeScript: Updated enqueue() in transport.ts
- Python: Updated _enqueue() in transport.py

### Browser visibilitychange ✅
- Added `visibilitychange` listener for mobile browser support
- Persists to localStorage when tab becomes hidden

### Identify Endpoint Format ✅
- Browser now sends single object (not array) to `/users/identify`
- Added `sendSingle()` method to browser SDK

### Partial Events (Server TS) ⏸️
- Skipped for now - browser-only feature is sufficient
- Server SDK uses streaming wrappers instead

### disabled Config Option ✅
- Was already implemented correctly
- Types in types.ts, passed to transport, checked on all send methods

---

## Bug Fixes (Round 2)

### Context Propagation for Manual Interactions ✅
- **Python**: `begin()` now sets `_interaction_context` so wrapped clients auto-link
- **Python**: `resume_interaction()` re-enters context
- **Python/TS**: `_finish_interaction()` clears context to prevent misattribution
- **TS**: `resumeInteraction()` now calls `interactionStorage.enterWith()`

### Empty String Output Bug ✅
- **TS**: `Interaction.finish()` now uses `!== undefined` check instead of truthy
- Empty string `""` is now correctly set as output

### Safe Serialization ✅
- **TS**: Added `safeStringify()` in format.ts - handles BigInt, circular refs
- **Python**: Added `safe_json_dumps()` in transport.py - handles datetime, bytes, sets
- Prevents crashes from non-serializable inputs/outputs

### Attachment ID Support ✅
- Added `attachmentId?: string` to TypeScript Attachment type
- Added `attachment_id: Optional[str]` to Python Attachment dataclass
- **Fixed**: TS now maps `attachmentId` → `attachment_id` in formatInteraction/formatAiEvent
- **Fixed**: Python now includes `attachment_id` in attachment dicts
- Enables targeting specific attachments with signals

### Interaction Input/Output Safe Serialization ✅
- TS: `formatInteraction()` now runs input/output through `toApiString()`
- Python: `send_interaction()` now runs input/output through `to_api_string()`
- Prevents crashes from non-serializable interaction data

---

## Architectural Limitations (Documented, Not Fixing)

### No Nested Interactions
- `begin()` / `resume_interaction()` overwrite current context (no stack)
- `finish()` clears context to None (no restore)
- **Decision**: By design. Use spans (`withTool`, `wrapTool`) for sub-grouping, not nested interactions
- Simpler mental model: Interactions are top-level containers, spans nest inside them

### No Distributed Tracing
- rd-mini uses AsyncLocalStorage (single-process only)
- Old SDK propagates W3C trace context across services
- **Decision**: Document as limitation, target simple use cases

### No Span Processor Export
- Old SDK: `createSpanProcessor()` for OTEL collector integration
- rd-mini: Different architecture, not supporting this
- **Decision**: Out of scope for "zero-config" goal

---

## Notes

- Their OTEL integration is overkill for most users but enables distributed tracing
- Their Python SDK has no auto-instrumentation (manual `trackAi()` only)
- Our wrap pattern is unique and better for DX
- PII redaction is a compliance gap (skipped for now)
- Production gaps above are quick fixes, not architectural changes
