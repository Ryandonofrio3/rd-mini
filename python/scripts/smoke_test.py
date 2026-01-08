#!/usr/bin/env python3
"""
Smoke Test - Verify Python SDK works end-to-end with real APIs

Run: uv run python scripts/smoke_test.py

This script tests all major features and outputs results.
After running, manually verify traces appear in the Raindrop dashboard.
"""

import os
import sys
import time
from dataclasses import dataclass

# Check env vars before importing SDK
RAINDROP_API_KEY = os.environ.get("RAINDROP_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

if not RAINDROP_API_KEY or not OPENAI_API_KEY:
    print("Missing required environment variables:")
    print(f"  RAINDROP_API_KEY: {'✓' if RAINDROP_API_KEY else '✗'}")
    print(f"  OPENAI_API_KEY: {'✓' if OPENAI_API_KEY else '✗'}")
    sys.exit(1)

from openai import OpenAI

from rd_mini import Raindrop


# ============================================
# Helpers
# ============================================


@dataclass
class TestResult:
    test: str
    status: str  # PASS or FAIL
    trace_id: str | None = None
    error: str | None = None


results: list[TestResult] = []


def log(message: str) -> None:
    print(f"\n{'=' * 60}\n{message}\n{'=' * 60}")


def passed(test: str, trace_id: str | None = None) -> None:
    results.append(TestResult(test, "PASS", trace_id))
    print(f"  ✓ {test}" + (f" ({trace_id})" if trace_id else ""))


def failed(test: str, error: str) -> None:
    results.append(TestResult(test, "FAIL", error=error))
    print(f"  ✗ {test}: {error}")


# ============================================
# Tests
# ============================================


def main() -> None:
    print("\n🧪 RAINDROP PYTHON SDK SMOKE TEST\n")
    print(f"API Key: {RAINDROP_API_KEY[:8]}...")
    print(f"Timestamp: {time.strftime('%Y-%m-%dT%H:%M:%S')}")
    print("")

    # Initialize
    raindrop = Raindrop(
        api_key=RAINDROP_API_KEY,
        debug=True,
    )

    openai_client = raindrop.wrap(OpenAI(api_key=OPENAI_API_KEY))

    # ------------------------------------------
    log("TEST 1: Basic Chat Completion")
    # ------------------------------------------
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": 'Say "Python smoke test" in exactly 3 words.'}],
        )

        if hasattr(response, "_trace_id") and response.choices[0].message.content:
            passed("Non-streaming chat completion", response._trace_id)
            print(f'    Response: "{response.choices[0].message.content}"')
            print(f"    Tokens: {response.usage.total_tokens if response.usage else 'N/A'}")
        else:
            failed("Non-streaming chat completion", "Missing _trace_id or content")
    except Exception as e:
        failed("Non-streaming chat completion", str(e))

    # ------------------------------------------
    log("TEST 2: Streaming Chat Completion")
    # ------------------------------------------
    try:
        stream = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Count from 1 to 5, one number per line."}],
            stream=True,
        )

        if hasattr(stream, "_trace_id"):
            passed("Stream has _trace_id immediately", stream._trace_id)
        else:
            failed("Stream has _trace_id immediately", "Missing _trace_id on stream")

        content = ""
        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                content += delta.content

        if "1" in content and "5" in content:
            passed("Stream content received")
            print(f'    Content: "{content[:50]}..."')
        else:
            failed("Stream content received", "Missing expected numbers")
    except Exception as e:
        failed("Streaming chat completion", str(e))

    # ------------------------------------------
    log("TEST 3: Tool Calls")
    # ------------------------------------------
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "What is the weather in San Francisco?"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get weather for a location",
                        "parameters": {
                            "type": "object",
                            "properties": {"location": {"type": "string"}},
                            "required": ["location"],
                        },
                    },
                }
            ],
            tool_choice="auto",
        )

        tool_calls = response.choices[0].message.tool_calls
        if tool_calls and tool_calls[0].function.name == "get_weather":
            passed("Tool call extracted", response._trace_id)
            print(f"    Tool: {tool_calls[0].function.name}")
            print(f"    Args: {tool_calls[0].function.arguments}")
        else:
            failed("Tool call extracted", "No tool call in response")
    except Exception as e:
        failed("Tool calls", str(e))

    # ------------------------------------------
    log("TEST 4: User Identification")
    # ------------------------------------------
    try:
        test_user_id = f"py_smoke_test_{int(time.time())}"
        raindrop.identify(
            test_user_id,
            {
                "name": "Python Smoke Test User",
                "email": "pysmoke@test.com",
                "plan": "enterprise",
            },
        )
        passed("User identified")
        print(f"    User ID: {test_user_id}")
    except Exception as e:
        failed("User identification", str(e))

    # ------------------------------------------
    log("TEST 5: Conversation Threading")
    # ------------------------------------------
    try:
        conversation_id = f"py_smoke_convo_{int(time.time())}"

        # Note: Python SDK uses raindrop= kwarg, not extra_body
        msg1 = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": 'Remember the word "giraffe".'}],
            raindrop={"conversation_id": conversation_id},
        )

        msg2 = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "user", "content": 'Remember the word "giraffe".'},
                {"role": "assistant", "content": msg1.choices[0].message.content or ""},
                {"role": "user", "content": "What word did I ask you to remember?"},
            ],
            raindrop={"conversation_id": conversation_id},
        )

        passed("Conversation threading")
        print(f"    Conversation ID: {conversation_id}")
        print(f"    Message 1: {msg1._trace_id}")
        print(f"    Message 2: {msg2._trace_id}")
    except Exception as e:
        failed("Conversation threading", str(e))

    # ------------------------------------------
    log("TEST 6: Feedback / Signals")
    # ------------------------------------------
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Tell me a one-liner joke."}],
        )

        raindrop.feedback(
            response._trace_id,
            {
                "type": "thumbs_up",
                "comment": "Python smoke test - feedback works!",
            },
        )

        passed("Feedback sent", response._trace_id)
        print("    Type: thumbs_up")
        print(f"    Linked to: {response._trace_id}")
    except Exception as e:
        failed("Feedback", str(e))

    # ------------------------------------------
    log("TEST 7: Interaction Context Manager")
    # ------------------------------------------
    try:
        with raindrop.interaction(
            event="py_smoke_test_rag",
            input="Python test query",
        ) as ctx:
            # Simulate a tool call
            @raindrop.tool("search_docs")
            def search_docs(query: str) -> list[dict]:
                return [{"title": "Doc 1", "content": "Python content"}]

            search_results = search_docs("test query")

            # AI call within interaction
            response = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": f"Summarize: {search_results}"}],
            )

            ctx.output = response.choices[0].message.content or ""
            interaction_id = ctx.interaction_id

        passed("Interaction with spans")
        print(f"    Interaction ID: {interaction_id}")
        print("    Event: py_smoke_test_rag")
    except Exception as e:
        failed("Interaction with spans", str(e))

    # ------------------------------------------
    log("TEST 8: Begin/Finish Pattern")
    # ------------------------------------------
    try:
        interaction = raindrop.begin(
            event="py_smoke_test_manual",
            input="Python manual interaction test",
        )

        # Simulate some work
        time.sleep(0.1)

        interaction.output = "Python manual interaction completed"
        interaction.finish()

        passed("Begin/finish pattern")
        print(f"    Interaction ID: {interaction.id}")
    except Exception as e:
        failed("Begin/finish pattern", str(e))

    # ------------------------------------------
    log("TEST 9: @workflow Decorator")
    # ------------------------------------------
    try:

        @raindrop.workflow("py_smoke_workflow")
        def my_workflow(message: str) -> str:
            response = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": message}],
            )
            return response.choices[0].message.content or ""

        result = my_workflow("What is 2+2?")
        passed("Workflow decorator")
        print(f"    Result: {result[:50]}...")
    except Exception as e:
        failed("Workflow decorator", str(e))

    # ------------------------------------------
    log("TEST 10: Error Handling")
    # ------------------------------------------
    try:
        openai_client.chat.completions.create(
            model="not-a-real-model",
            messages=[{"role": "user", "content": "test"}],
        )
        failed("Error handling", "Expected error to be thrown")
    except Exception as e:
        last_trace_id = raindrop.get_last_trace_id()
        if last_trace_id:
            passed("Error traced", last_trace_id)
            print(f"    Error: {str(e)[:60]}...")
        else:
            failed("Error handling", "Error not traced")

    # ------------------------------------------
    log("TEST 11: Flush & Close")
    # ------------------------------------------
    try:
        raindrop.flush()
        passed("Flush completed")

        raindrop.close()
        passed("Close completed")
    except Exception as e:
        failed("Flush/close", str(e))

    # ------------------------------------------
    # Summary
    # ------------------------------------------
    log("SUMMARY")

    passed_count = sum(1 for r in results if r.status == "PASS")
    failed_count = sum(1 for r in results if r.status == "FAIL")

    print(f"\n  Passed: {passed_count}")
    print(f"  Failed: {failed_count}")
    print(f"  Total:  {len(results)}")

    if failed_count > 0:
        print("\n  Failed tests:")
        for r in results:
            if r.status == "FAIL":
                print(f"    - {r.test}: {r.error}")

    print("\n" + "=" * 60)
    print("NEXT STEPS:")
    print("=" * 60)
    print("\n1. Open Raindrop dashboard")
    print("2. Verify these traces appear within 30 seconds:")
    for r in results:
        if r.trace_id:
            print(f"   - {r.trace_id} ({r.test})")
    print("\n3. Check:")
    print("   - [ ] Input/output content visible")
    print("   - [ ] Token counts displayed")
    print("   - [ ] User identified correctly")
    print("   - [ ] Conversation traces grouped")
    print("   - [ ] Feedback appears on trace")
    print("   - [ ] Spans visible in interaction")
    print("")

    sys.exit(1 if failed_count > 0 else 0)


if __name__ == "__main__":
    main()
