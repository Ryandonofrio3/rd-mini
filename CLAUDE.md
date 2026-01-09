# Claude Context for raindrop-mini

## Project Overview

**raindrop-mini** (`rd-mini`) is a lightweight SDK for the Raindrop AI observability platform. It provides tracing and telemetry for AI/LLM applications.

The SDK is published as:
- **TypeScript/JavaScript**: `rd-mini` on npm
- **Python**: `rd-mini` on PyPI

This is a rewrite/simplification of the original `raindrop-ai` packages (reference copies saved in `/reference/`).

**Goal**: Simpler, more explicit API. Breaking changes from original are intentional - we favor clarity over backwards compatibility.

## Repository Structure

```
raindrop-mini/
├── ts/                     # TypeScript SDK
│   ├── src/
│   │   ├── core/           # Core types (types.ts)
│   │   ├── raindrop.ts     # Main Raindrop class
│   │   ├── transport.ts    # HTTP transport layer
│   │   ├── wrappers/       # Provider wrappers (openai, anthropic, ai-sdk, gemini, bedrock)
│   │   └── plugins/        # Plugin implementations (pii.ts, otel.ts)
│   └── package.json
├── python/                 # Python SDK
│   └── src/rd_mini/
│       ├── client.py       # Main Raindrop class + decorators
│       ├── transport.py    # HTTP transport layer
│       ├── types.py        # Type definitions
│       ├── wrappers/       # Provider wrappers
│       └── plugins/        # Plugin implementations
├── docs/                   # Documentation (Mintlify MDX)
└── reference/              # Original raindrop-ai packages (gitignored)
```

## Architecture

### Core Concepts

1. **Raindrop Client** - Main entry point, manages state and wraps providers
2. **Interactions** - Container for multi-step AI workflows (begin/finish pattern)
3. **Spans** - Individual units of work within an interaction (AI calls, tools)
4. **Traces** - Standalone AI calls not part of an interaction
5. **Plugins** - Hooks for processing data before it's sent (PII, OTEL)

### Wrapper Pattern

All AI provider wrappers follow the same pattern:

```
User calls wrapped client
    ↓
Wrapper intercepts call
    ↓
Check if inside interaction (via context)
    ↓
├─ YES: Create SpanData, notify plugins, add to interaction.spans
└─ NO:  Create TraceData, send via transport
```

**Key files:**
- `ts/src/wrappers/*.ts` - TypeScript wrappers
- `python/src/rd_mini/wrappers/*.py` - Python wrappers

### Plugin Notification Flow

Plugins receive notifications at key points:

```
onInteractionStart(ctx)     # Interaction begins
    ↓
onSpan(span)               # Each span completes (AI calls, tools)
    ↓
onInteractionEnd(ctx)      # Interaction ends, ctx.spans contains all spans
    ↓
onTrace(trace)             # Standalone traces (outside interactions)
```

**Important**: Wrappers must call `context.notifySpan(span)` before adding to `interaction.spans` so plugins see individual spans.

### Wrapper Context Interface

When `raindrop.wrap(client)` is called, wrappers receive a context object:

```typescript
interface WrapperContext {
  generateTraceId: () => string;
  sendTrace: (trace: TraceData) => void;
  getUserId: () => string | undefined;
  getInteractionContext: () => InteractionContext | undefined;
  notifySpan: (span: SpanData) => void;  // Added Jan 2025
  debug: boolean;
}
```

## Design Principles

1. **Feature parity** - TypeScript and Python SDKs should have identical features and behavior
2. **Sane defaults** - Opt-in for aggressive features, secure by default
3. **Explicit over magic** - `raindrop.wrap(client)` instead of auto-instrumentation
4. **Plugin architecture** - Extensible via plugins (PII, OTEL, etc.)

## Key Decisions Made

### PII Plugin Alignment (Jan 2025)

Both SDKs now have consistent behavior:

| Option | Default | Description |
|--------|---------|-------------|
| `redactNames` / `redact_names` | `false` | Opt-in name redaction (can have false positives) |
| `specificTokens` / `specific_tokens` | `false` | Use `<REDACTED_EMAIL>` vs generic `<REDACTED>` |
| `patterns` | all | Which PII patterns to apply |

Name redaction uses:
- Well-known names list (~11k common names in `well-known-names.json`)
- Greeting context ("Hi John")
- Closing context ("Thanks, Sarah")
- Signature line detection (with exclusions for "Thanks", "Best", etc.)

**PII Coverage** (what gets redacted):
- `input`, `output` - Always
- `toolCalls[].arguments`, `toolCalls[].result` - Always
- `error` - String fields that may contain sensitive data
- `properties` - Custom properties object
- `attachments[].value`, `attachments[].name` - Attachment content

### Wrapper Span Notifications (Jan 2025)

Fixed: Wrappers now call `context.notifySpan(span)` before adding spans to interactions. This ensures plugins (like OTEL) see individual AI call spans, not just the final interaction.

## Build Commands

**TypeScript (uses Bun):**
```bash
cd ts
bun install
bun run build    # Compile TypeScript
bun test tests/unit
bun run test:pii  # PII smoke test
```

**Python (uses uv):**
```bash
cd python
uv sync --dev
uv run pytest tests/ -v
```

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `ci.yml` - Runs on push/PR to main, tests both SDKs
- `release.yml` - Handles package releases

## Reference Materials

Original `raindrop-ai` packages are saved in `/reference/` for comparison:
- Downloaded from npm (`raindrop-ai@0.0.72`)
- Downloaded from PyPI (`raindrop-ai@0.0.35`)

Key differences from original:
- Original Python always used specific tokens and always redacted names
- Original TypeScript used external `@dawn-analytics/redact-pii` package
- Original had `instrumentModules` auto-magic, we use explicit `wrap()`
- Original had `tracer()` for batch jobs, we use interactions
- New implementation is custom, consistent across both SDKs

## Naming Conventions

| TypeScript | Python | Notes |
|------------|--------|-------|
| `camelCase` | `snake_case` | Standard for each language |
| `creditCard` | `credit_card` | Pattern names follow language convention |
| `createPiiPlugin()` | `create_pii_plugin()` | Factory functions |
| `redactNames` | `redact_names` | Options follow language convention |

## Plugin Interface

Both SDKs implement the same plugin lifecycle:

```
onInteractionStart(ctx)  # Called when interaction starts
onSpan(span)             # Called when span completes (AI calls, tools)
onInteractionEnd(ctx)    # Called when interaction ends
onTrace(trace)           # Called for standalone traces
flush()                  # Called during flush
shutdown()               # Called during shutdown
```

## Critical File Locations

### TypeScript
- `ts/src/raindrop.ts` - Main class, `wrap()` method (line ~440), `_notifySpan()` (line ~955)
- `ts/src/wrappers/openai.ts` - OpenAI wrapper, streaming handler
- `ts/src/plugins/pii.ts` - PII plugin, `SIGNATURE_EXCLUSIONS` constant

### Python
- `python/src/rd_mini/client.py` - Main class, decorators (`@task` ~722, `@workflow` ~822, `@tool` ~966) with async support
- `python/src/rd_mini/wrappers/openai.py` - OpenAI wrapper with async support
- `python/src/rd_mini/plugins/pii.py` - PII plugin

## Test Structure

**TypeScript:**
```
ts/tests/
├── unit/           # Unit tests (raindrop, transport, wrappers)
└── integration/    # Integration tests (interactions, openai)
```

**Python:**
```
python/tests/
├── test_raindrop.py
├── test_transport.py
└── test_wrappers.py
```

## Known Issues / TODO

### TypeScript JSON Import Syntax
The PII plugin uses `import ... with { type: 'json' }` for importing the well-known names. This requires:
- Node.js 20.10+ (or flag in older versions)
- Bun (works natively)

May need to change for broader compatibility.

### Missing Tests
- No PII plugin tests in either SDK
- No OTEL plugin tests

## Session History

### Jan 2025 - Bug Fixes
Fixed:
- [x] Signature detection false positives (added `SIGNATURE_EXCLUSIONS`)
- [x] PII coverage gaps (now redacts `error`, `properties`, `attachments`)
- [x] TypeScript wrapper `_notifySpan` calls (plugins now see AI spans)
- [x] Python async decorator support (uses `asyncio.iscoroutinefunction()`)

Remaining:
- [ ] Add comprehensive tests with real API calls

### External Review Findings (Gemini/GPT)
Two external reviews identified:
1. **Valid concerns**: Missing `_notifySpan` in wrappers (FIXED), sync-only decorators (FIXED), PII gaps (FIXED)
2. **Intentional simplifications**: No `tracer()`, no `instrumentModules`, explicit `wrap()` pattern
3. **Not critical**: Some API renames are breaking but intentional for clarity
