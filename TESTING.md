# Raindrop SDK - Testing & Verification Plan

## What We Know

### API Endpoints (from `transport.ts` and `format.ts`)

| Endpoint | Method | Purpose | Payload Format |
|----------|--------|---------|----------------|
| `POST /v1/events/track` | Batch | Traces and interactions | `[{ event_id, user_id, event, timestamp, properties, ai_data, attachments }]` |
| `POST /v1/signals/track` | Batch | Feedback signals | `[{ event_id, signal_name, sentiment, signal_type, properties }]` |
| `POST /v1/users/identify` | Single | User identification | `{ user_id, traits }` |

### Event Format (from `format.ts`)

**Trace event:**
```json
{
  "event_id": "trace_xxx",
  "user_id": "user123",
  "event": "ai_interaction",
  "timestamp": "2024-01-05T12:00:00.000Z",
  "properties": {
    "$context": { "library": { "name": "rd-mini", "version": "0.1.0" } },
    "provider": "openai",
    "latency_ms": 1234,
    "input_tokens": 10,
    "output_tokens": 50
  },
  "ai_data": {
    "model": "gpt-4o-mini",
    "input": "User message",
    "output": "AI response",
    "convo_id": "conv_xxx"
  }
}
```

**Interaction event (with spans as attachments):**
```json
{
  "event_id": "trace_xxx",
  "event": "rag_query",
  "properties": {
    "span_count": 2
  },
  "attachments": [
    {
      "type": "code",
      "name": "tool:search_docs",
      "value": "{\"spanId\":\"span_xxx\",\"input\":{},\"output\":{},\"latencyMs\":100}",
      "role": "output",
      "language": "json"
    }
  ]
}
```

### What We DON'T Know (Need to Verify)

1. **Does the dashboard parse our event format correctly?**
2. **Are spans displayed as nested traces or just attachments?**
3. **Does conversation threading work?**
4. **Do signals link to the correct traces?**
5. **Is PII redaction happening before data leaves the client?**

---

## Test Environment

```bash
# Required env vars
export RAINDROP_API_KEY=xxx
export OPENAI_API_KEY=xxx
export ANTHROPIC_API_KEY=xxx  # Optional

# Optional - for comparing against old SDK
export AI_GATEWAY_API_KEY=xxx
```

---

## Test Plan

### Phase 1: Unit Tests (Already Done)

```bash
cd ts && bun test tests/unit
cd python && uv run pytest tests/ -v
```

### Phase 2: Integration Tests - SDK Works

```bash
cd ts && bun test tests/integration
```

Tests:
- [x] OpenAI non-streaming
- [x] OpenAI streaming
- [x] Tool calls
- [x] Error handling
- [x] Feedback
- [x] User identification
- [x] Conversation threading

### Phase 3: Smoke Test - Data Reaches Dashboard

Run the smoke test and manually verify in dashboard:

```bash
cd ts && bun run scripts/smoke-test.ts
```

Verify in dashboard:
- [ ] Traces appear within 30 seconds
- [ ] `ai_data.input` and `ai_data.output` are populated
- [ ] Token counts display
- [ ] User ID shows up
- [ ] Conversation threads are grouped
- [ ] Feedback appears on correct trace
- [ ] Attachments render

### Phase 4: Feature Parity Test

Compare old SDK vs new SDK output:

```bash
# Run both SDKs with same inputs
bun run scripts/compare-sdks.ts
```

Check:
- [ ] Same endpoints hit
- [ ] Event format compatible
- [ ] No fields missing that dashboard expects

### Phase 5: PII Redaction Test

```bash
bun run scripts/pii-test.ts
```

Verify:
- [ ] Emails redacted: `john@example.com` → `<REDACTED>`
- [ ] Phone numbers redacted
- [ ] Credit cards redacted
- [ ] Names redacted (if enabled)
- [ ] Custom patterns work

### Phase 6: Python SDK

```bash
cd python
uv run python scripts/smoke_test.py
```

---

## Manual Dashboard Verification Checklist

After running smoke test, verify in Raindrop dashboard:

### Traces View
- [x] New traces appear (28 events from smoke tests)
- [x] Model name in properties (provider: openai)
- [x] Input/output content visible (User/Assistant columns)
- [x] Latency displayed (latency_ms property)
- [x] Token counts displayed (total_tokens, input_tokens, output_tokens)
- [x] Custom event names work (py_smoke_test_rag, smoke_test_manual, etc.)
- [x] Errors captured with error property

### Conversation View
- [x] Traces with same `convo_id` grouped (smoke_convo_*, py_smoke_convo_*)
- [x] Chronological ordering correct

### User View
- [ ] User traits appear after `identify()` - **NEEDS VERIFICATION**
- [x] User's traces associated (user_id column shows correct IDs)

### Feedback View
- [ ] Thumbs up/down signals appear - **NEEDS VERIFICATION**
- [ ] Links to correct trace - **NEEDS VERIFICATION**
- [ ] Comments visible - **NEEDS VERIFICATION**

### Span/Attachment View
- [ ] Tool calls render as attachments - **NEEDS VERIFICATION** (click into event)
- [ ] Span data parseable (JSON in code block) - **NEEDS VERIFICATION**

### Known Limitations
- Streaming requests don't show token counts (OpenAI doesn't return usage for streams)
- TypeScript sends `undefined` for missing userId, Python sends `null` (cosmetic difference)

---

## Known Differences from Old SDK

| Feature | Old SDK | New SDK | Notes |
|---------|---------|---------|-------|
| Event ID field | `event_id` | `event_id` | Same |
| Trace endpoint | `/events/track` | `/events/track` | Same |
| Spans | OTEL spans via Traceloop | Attachments with JSON | Dashboard must parse |
| PII | `@dawn-analytics/redact-pii` | Custom plugin | Same patterns |
| OTEL export | Built-in | Plugin | Optional |

---

## Troubleshooting

### Events not appearing in dashboard

1. Check API key is valid
2. Check `debug: true` logs for send errors
3. Verify base URL: `https://api.raindrop.ai`
4. Check event format matches expected schema

### Token counts missing

- OpenAI only returns usage on non-streaming requests by default
- For streaming, we don't have usage data (OpenAI limitation)

### Spans not showing as nested

- Current implementation sends spans as attachments
- Dashboard may need to parse `tool:*` attachments specially
- This is a known limitation - spans as real nested traces would require API changes

---

## Success Criteria

Before shipping:

1. **All integration tests pass** with real API keys
2. **Smoke test traces visible** in dashboard within 30 seconds
3. **All checklist items verified** in dashboard
4. **Python SDK parity** - same features work
5. **PII redaction verified** - no PII in sent events

---

## Future Work (Post-Launch)

### Port Well-Known Names to TypeScript PII Plugin

**Current state:**
- Python: Has `well-known-names.json` (11,546 names), `redact_names=True` by default
- TypeScript: No names list, `redactNames=false` by default, basic greeting pattern has bug

**To do:**
1. Copy `python/src/rd_mini/plugins/well-known-names.json` to `ts/src/plugins/`
2. Update `ts/src/plugins/pii.ts` to load names list
3. Fix greeting pattern bug (inserts `<REDACTED>` but doesn't remove name)
4. Add closing pattern detection ("Thanks, John")
5. Add specific token option (`<REDACTED_EMAIL>` etc.)
6. Consider changing default to `redactNames: true` for parity

**Impact:** Low - core PII patterns (email, phone, SSN, CC, API keys, passwords, addresses) work in both SDKs. Name redaction is a nice-to-have.
