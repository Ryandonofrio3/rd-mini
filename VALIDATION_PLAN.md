# Raindrop SDK v2 - Validation Plan

## Goal
Prove the new SDK has feature parity with the old SDK, demonstrate simpler DX, and validate the tracing pattern works for multi-step pipelines.

---

## Phase 1: Basic Scenarios (Unit-level validation)

### 1.1 Non-Streaming Completions
| Test | Provider | Expected Dashboard Output |
|------|----------|---------------------------|
| Basic completion | OpenAI, Anthropic, AI SDK | input, output, model, latency, tokens |
| With tool calls | OpenAI, Anthropic | tool_calls captured in attachments |
| Error (invalid key) | All | error field populated, no output |
| Error (rate limit) | All | error field populated |

**Test file**: `examples/test-basic.ts`

### 1.2 Streaming Completions
| Test | Provider | Expected |
|------|----------|----------|
| Basic stream | OpenAI, Anthropic, AI SDK | Full output captured when stream ends |
| Stream with tool calls | OpenAI, Anthropic | Tool calls accumulated and captured |
| Stream error mid-way | All | Partial content + error captured |

**Test file**: `examples/test-streaming.ts`

### 1.3 User & Conversation Context
| Test | Expected |
|------|----------|
| `identify()` then completion | `user_id` appears on event |
| Override userId per-request | Override takes precedence |
| `conversationId` option | `convo_id` appears on event |
| Multiple turns same convo | All share same `convo_id` |

**Test file**: `examples/test-context.ts`

### 1.4 Feedback/Signals
| Test | Expected |
|------|----------|
| `feedback(traceId, { type: 'thumbs_up' })` | Signal linked to event |
| `feedback(traceId, { score: 0.8 })` | Numeric score captured |
| `feedback()` with comment | Comment in properties |

**Test file**: `examples/test-feedback.ts`

---

## Phase 2: Real-World App Scenarios

### 2.1 Chatbot (multi-turn conversation)
```
User: "What's the weather?"
AI: "I'll check..." [tool call: get_weather]
AI: "It's 72°F in SF"
User: "Thanks!"
AI: "You're welcome!"
```

**Validation**:
- All 3 AI responses traced
- Tool call captured on turn 1
- Same `conversationId` links all turns
- User feedback on final response links correctly

**File**: `examples/app-chatbot.ts`

### 2.2 RAG Pipeline (multi-step)
```
1. User query
2. Embed query (AI call)
3. Search vector DB (tool)
4. Rerank results (AI call)
5. Generate answer (AI call)
```

**Validation**:
- Each step has its own trace/span
- Steps are linked as children of main interaction
- Total latency = sum of steps
- Tool (vector search) has its own span

**File**: `examples/app-rag.ts`

**Requires**: `wrapTool()` implementation

### 2.3 Agent with Tools
```
1. User: "Book me a flight to NYC next Friday"
2. AI decides: call search_flights tool
3. AI decides: call book_flight tool
4. AI: "Done! Confirmation #ABC123"
```

**Validation**:
- Both tool calls captured
- Each tool has timing and result
- Final output includes tool results

**File**: `examples/app-agent.ts`

---

## Phase 3: Dashboard Comparison

### 3.1 Setup
Run identical scenarios through both SDKs:
- Old SDK: `raindrop-ai` (existing package)
- New SDK: local `./src`

### 3.2 Comparison Script
```bash
# Run with old SDK
RAINDROP_SDK=old bun run examples/compare-sdks.ts

# Run with new SDK
RAINDROP_SDK=new bun run examples/compare-sdks.ts
```

### 3.3 Dashboard Checklist
For each scenario, verify in dashboard:

| Field | Old SDK | New SDK | Match? |
|-------|---------|---------|--------|
| event name | | | |
| user_id | | | |
| model | | | |
| input (full text) | | | |
| output (full text) | | | |
| input_tokens | | | |
| output_tokens | | | |
| latency_ms | | | |
| conversation_id | | | |
| tool_calls | | | |
| error (if any) | | | |
| signal (feedback) linked | | | |

---

## Phase 4: Tracing Implementation

### 4.1 API Design
```typescript
// Wrap a tool function (like wrap(client))
const searchDocs = raindrop.wrapTool('search_docs', async (query: string) => {
  const results = await vectorDb.search(query);
  return results;
});

// Use normally - auto-traced
const docs = await searchDocs("how to use raindrop");

// With options
const searchDocs = raindrop.wrapTool('search_docs', fn, {
  version: 2,
  properties: { source: 'pinecone' },
});
```

### 4.2 Span Nesting
When tools are called within an AI request:
```
[Interaction: chat_message]
  └── [AI: gpt-4o completion]
  └── [Tool: search_docs]
  └── [AI: gpt-4o with context]
```

### 4.3 Implementation Tasks
1. Add `wrapTool<T>(name, fn, options?) → T` to Raindrop class
2. Create span context (track current parent)
3. Link child spans to parent interaction
4. Capture: name, timing, input args, output/result, error
5. Send as nested traces in same event batch

---

## Success Criteria

### Must Have (for demo)
- [ ] All Phase 1 tests pass
- [ ] Chatbot scenario works end-to-end
- [ ] Dashboard shows equivalent data to old SDK
- [ ] `wrapTool()` captures tool executions

### Nice to Have
- [ ] RAG pipeline with nested spans
- [ ] Comparison script automated
- [ ] Unit tests with mocked API

---

## Execution Order

1. **Day 1**: Run `real-test.ts`, verify dashboard manually
2. **Day 2**: Build Phase 1 test files, run all providers
3. **Day 3**: Implement `wrapTool()` basic version
4. **Day 4**: Build chatbot scenario
5. **Day 5**: Dashboard comparison with old SDK
6. **Day 6**: Polish, document, prepare demo

---

## Questions to Resolve

1. **Event structure**: Should wrapped tools be separate events or nested within parent?
2. **Trace ID propagation**: How to link tool spans to parent AI call?
3. **Token tracking for tools**: Tools don't have tokens - how to handle?
4. **Properties passthrough**: How to add custom properties at call time?

---

## Notes

- Run all tests with `debug: true` to see payloads
- Use `RAINDROP_API_KEY` from dashboard
- Each test should print trace IDs for dashboard lookup
