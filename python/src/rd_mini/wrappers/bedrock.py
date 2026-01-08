"""
AWS Bedrock Runtime Wrapper
Wraps boto3 bedrock-runtime client to auto-capture all Converse calls

Supports:
- client.converse() (non-streaming)
- client.converse_stream() (streaming)
- All Bedrock foundation models (Claude, Llama, Titan, Mistral, etc.)
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Iterator

from rd_mini.types import InteractionContext, SpanData, TraceData

if TYPE_CHECKING:
    pass


class WrapperContext:
    """Context passed to wrappers."""

    def __init__(
        self,
        generate_trace_id: Callable[[], str],
        send_trace: Callable[[TraceData], None],
        get_user_id: Callable[[], str | None],
        get_interaction_context: Callable[[], InteractionContext | None],
        debug: bool,
    ):
        self.generate_trace_id = generate_trace_id
        self.send_trace = send_trace
        self.get_user_id = get_user_id
        self.get_interaction_context = get_interaction_context
        self.debug = debug


def safe_json_loads(s: str) -> Any:
    """Safely parse JSON, returning the raw string if parsing fails."""
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return s


def _infer_provider(model_id: str) -> str:
    """Infer provider from Bedrock model ID."""
    id_lower = model_id.lower()

    if "anthropic" in id_lower or "claude" in id_lower:
        return "anthropic"
    if "amazon" in id_lower or "titan" in id_lower or "nova" in id_lower:
        return "amazon"
    if "meta" in id_lower or "llama" in id_lower:
        return "meta"
    if "mistral" in id_lower or "mixtral" in id_lower:
        return "mistral"
    if "cohere" in id_lower or "command" in id_lower:
        return "cohere"
    if "ai21" in id_lower or "jamba" in id_lower or "jurassic" in id_lower:
        return "ai21"
    if "stability" in id_lower or "stable" in id_lower:
        return "stability"

    return "bedrock"


class WrappedBedrockClient:
    """Wrapped Bedrock client that traces converse calls."""

    def __init__(self, client: Any, context: WrapperContext):
        self._client = client
        self._context = context

    def converse(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Converse with automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        model_id = kwargs.get("modelId", "unknown")
        messages = kwargs.get("messages", [])

        if self._context.debug:
            print(f"[raindrop] Bedrock converse started: {trace_id}")

        try:
            response = self._client.converse(*args, **kwargs)
            end_time = time.time()

            # Extract output
            output_message = response.get("output", {}).get("message", {})
            output_content = output_message.get("content", [])

            output_text = ""
            tool_calls = []

            for block in output_content:
                if "text" in block:
                    output_text += block["text"]
                if "toolUse" in block:
                    tool_use = block["toolUse"]
                    tool_calls.append({
                        "id": tool_use.get("toolUseId", ""),
                        "name": tool_use.get("name", ""),
                        "arguments": tool_use.get("input", {}),
                    })

            # Extract usage
            usage = response.get("usage", {})
            tokens = None
            if usage:
                tokens = {
                    "input": usage.get("inputTokens", 0),
                    "output": usage.get("outputTokens", 0),
                    "total": usage.get("totalTokens", 0),
                }

            stop_reason = response.get("stopReason")
            provider = _infer_provider(model_id)

            # Check for interaction context
            interaction = self._context.get_interaction_context()

            if interaction:
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"bedrock:{model_id}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=messages,
                    output=output_text,
                    properties={
                        **properties,
                        "input_tokens": tokens["input"] if tokens else None,
                        "output_tokens": tokens["output"] if tokens else None,
                        "stop_reason": stop_reason,
                        "tool_calls": tool_calls if tool_calls else None,
                    },
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider=provider,
                        model=model_id,
                        input=messages,
                        output=output_text,
                        start_time=start_time,
                        end_time=end_time,
                        latency_ms=int((end_time - start_time) * 1000),
                        tokens=tokens,
                        tool_calls=tool_calls if tool_calls else None,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        properties={
                            **properties,
                            "stop_reason": stop_reason,
                        },
                    )
                )

            # Attach trace_id to response
            response["_trace_id"] = trace_id
            return response

        except Exception as e:
            end_time = time.time()
            interaction = self._context.get_interaction_context()
            provider = _infer_provider(model_id)

            if interaction:
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"bedrock:{model_id}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=messages,
                    error=str(e),
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider=provider,
                        model=model_id,
                        input=messages,
                        start_time=start_time,
                        end_time=end_time,
                        latency_ms=int((end_time - start_time) * 1000),
                        user_id=user_id,
                        conversation_id=conversation_id,
                        properties=properties,
                        error=str(e),
                    )
                )
            raise

    def converse_stream(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Converse with streaming and automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        model_id = kwargs.get("modelId", "unknown")
        messages = kwargs.get("messages", [])

        if self._context.debug:
            print(f"[raindrop] Bedrock converse_stream started: {trace_id}")

        response = self._client.converse_stream(*args, **kwargs)

        # The response contains a 'stream' key with the event stream
        stream = response.get("stream")
        if not stream:
            response["_trace_id"] = trace_id
            return response

        # Wrap the stream
        wrapped_stream = TracedBedrockStream(
            stream=stream,
            trace_id=trace_id,
            start_time=start_time,
            user_id=user_id,
            conversation_id=conversation_id,
            properties=properties,
            model_id=model_id,
            messages=messages,
            context=self._context,
        )

        # Return response with wrapped stream
        result = dict(response)
        result["stream"] = wrapped_stream
        result["_trace_id"] = trace_id
        return result

    def __getattr__(self, name: str) -> Any:
        """Forward other attributes to original client."""
        return getattr(self._client, name)


class TracedBedrockStream:
    """Wrapper around Bedrock stream that traces on completion."""

    def __init__(
        self,
        stream: Any,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model_id: str,
        messages: list[Any],
        context: WrapperContext,
    ):
        self._stream = stream
        self.__trace_id = trace_id
        self._start_time = start_time
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._properties = properties
        self._model_id = model_id
        self._messages = messages
        self._context = context
        self._collected_text: list[str] = []
        self._tool_calls: dict[int, dict[str, Any]] = {}
        self._usage: dict[str, int] | None = None
        self._stop_reason: str | None = None
        self._interaction = context.get_interaction_context()

    @property
    def _trace_id(self) -> str:
        return self.__trace_id

    def __iter__(self) -> Iterator[Any]:
        try:
            for event in self._stream:
                self._process_event(event)
                yield event

            # Stream complete - send trace
            self._finalize()

        except Exception as e:
            self._finalize(error=str(e))
            raise

    async def __aiter__(self) -> AsyncIterator[Any]:
        try:
            async for event in self._stream:
                self._process_event(event)
                yield event

            # Stream complete - send trace
            self._finalize()

        except Exception as e:
            self._finalize(error=str(e))
            raise

    def _process_event(self, event: dict[str, Any]) -> None:
        """Process a stream event and collect data."""
        # Content block delta - text
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            if "text" in delta:
                self._collected_text.append(delta["text"])
            # Tool use input delta
            if "toolUse" in delta and "input" in delta["toolUse"]:
                idx = event["contentBlockDelta"].get("contentBlockIndex", 0)
                if idx in self._tool_calls:
                    self._tool_calls[idx]["arguments"] += delta["toolUse"]["input"]

        # Content block start - tool use
        if "contentBlockStart" in event:
            start = event["contentBlockStart"].get("start", {})
            if "toolUse" in start:
                idx = event["contentBlockStart"].get("contentBlockIndex", 0)
                self._tool_calls[idx] = {
                    "id": start["toolUse"].get("toolUseId", ""),
                    "name": start["toolUse"].get("name", ""),
                    "arguments": "",
                }

        # Message stop
        if "messageStop" in event:
            self._stop_reason = event["messageStop"].get("stopReason")

        # Metadata with usage
        if "metadata" in event:
            usage = event["metadata"].get("usage", {})
            if usage:
                self._usage = {
                    "input": usage.get("inputTokens", 0),
                    "output": usage.get("outputTokens", 0),
                    "total": usage.get("totalTokens", 0),
                }

    def _finalize(self, error: str | None = None) -> None:
        """Send trace on stream completion."""
        end_time = time.time()
        output = "".join(self._collected_text)
        provider = _infer_provider(self._model_id)

        # Parse tool call arguments
        parsed_tool_calls = []
        for tc in self._tool_calls.values():
            parsed_tool_calls.append({
                "id": tc["id"],
                "name": tc["name"],
                "arguments": safe_json_loads(tc["arguments"]) if tc["arguments"] else {},
            })

        if self._interaction:
            span = SpanData(
                span_id=self._trace_id,
                parent_id=self._interaction.interaction_id,
                name=f"bedrock:{self._model_id}",
                type="ai",
                start_time=self._start_time,
                end_time=end_time,
                latency_ms=int((end_time - self._start_time) * 1000),
                input=self._messages,
                output=output if not error else None,
                error=error,
                properties={
                    **self._properties,
                    "input_tokens": self._usage["input"] if self._usage else None,
                    "output_tokens": self._usage["output"] if self._usage else None,
                    "stop_reason": self._stop_reason,
                    "tool_calls": parsed_tool_calls if parsed_tool_calls else None,
                },
            )
            self._interaction.spans.append(span)
        else:
            self._context.send_trace(
                TraceData(
                    trace_id=self._trace_id,
                    provider=provider,
                    model=self._model_id,
                    input=self._messages,
                    output=output if not error else None,
                    start_time=self._start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - self._start_time) * 1000),
                    tokens=self._usage,
                    tool_calls=parsed_tool_calls if parsed_tool_calls else None,
                    user_id=self._user_id,
                    conversation_id=self._conversation_id,
                    properties={
                        **self._properties,
                        "stop_reason": self._stop_reason,
                    },
                    error=error,
                )
            )


def wrap_bedrock(client: Any, context: WrapperContext) -> WrappedBedrockClient:
    """Wrap a Bedrock client for automatic tracing."""
    return WrappedBedrockClient(client, context)
