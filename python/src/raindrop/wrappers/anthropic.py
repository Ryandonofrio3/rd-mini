"""
Anthropic SDK Wrapper
Wraps Anthropic client to auto-capture all messages
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any, Callable, Iterator

from raindrop.types import InteractionContext, SpanData, TraceData

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


class WrappedMessages:
    """Wrapped messages that traces all calls."""

    def __init__(self, original: Any, context: WrapperContext):
        self._original = original
        self._context = context

    def create(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Create a message with automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        if self._context.debug:
            print(f"[raindrop] Anthropic messages started: {trace_id}")

        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        system = kwargs.get("system")
        is_streaming = kwargs.get("stream", False)

        # Build input representation
        input_data = messages
        if system:
            input_data = [{"role": "system", "content": system}, *messages]

        if is_streaming:
            return self._handle_stream(
                trace_id=trace_id,
                start_time=start_time,
                user_id=user_id,
                conversation_id=conversation_id,
                properties=properties,
                model=model,
                input_data=input_data,
                args=args,
                kwargs=kwargs,
            )

        # Non-streaming
        try:
            response = self._original.create(*args, **kwargs)
            end_time = time.time()

            # Extract output content
            output = ""
            if response.content:
                for block in response.content:
                    if hasattr(block, "text"):
                        output += block.text

            # Extract tool use
            tool_calls = None
            if response.content:
                tool_uses = [b for b in response.content if hasattr(b, "type") and b.type == "tool_use"]
                if tool_uses:
                    tool_calls = [
                        {
                            "id": tc.id,
                            "name": tc.name,
                            "arguments": tc.input,
                        }
                        for tc in tool_uses
                    ]

            tokens = None
            if response.usage:
                tokens = {
                    "input": response.usage.input_tokens,
                    "output": response.usage.output_tokens,
                    "total": response.usage.input_tokens + response.usage.output_tokens,
                }

            # Check for interaction context
            interaction = self._context.get_interaction_context()

            if interaction:
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"anthropic:{model}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=input_data,
                    output=output,
                    properties={
                        **properties,
                        "input_tokens": tokens["input"] if tokens else None,
                        "output_tokens": tokens["output"] if tokens else None,
                        "tool_calls": tool_calls,
                    },
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider="anthropic",
                        model=model,
                        input=input_data,
                        output=output,
                        start_time=start_time,
                        end_time=end_time,
                        latency_ms=int((end_time - start_time) * 1000),
                        tokens=tokens,
                        tool_calls=tool_calls,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        properties=properties,
                    )
                )

            # Attach trace_id to response
            response._trace_id = trace_id
            return response

        except Exception as e:
            end_time = time.time()
            interaction = self._context.get_interaction_context()

            if interaction:
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"anthropic:{model}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=input_data,
                    error=str(e),
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider="anthropic",
                        model=model,
                        input=input_data,
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

    def _handle_stream(
        self,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model: str,
        input_data: list[Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> "TracedAnthropicStream":
        """Handle streaming response."""
        stream = self._original.create(*args, **kwargs)
        return TracedAnthropicStream(
            stream=stream,
            trace_id=trace_id,
            start_time=start_time,
            user_id=user_id,
            conversation_id=conversation_id,
            properties=properties,
            model=model,
            input_data=input_data,
            context=self._context,
        )


class TracedAnthropicStream:
    """Wrapper around Anthropic stream that traces on completion."""

    def __init__(
        self,
        stream: Any,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model: str,
        input_data: list[Any],
        context: WrapperContext,
    ):
        self._stream = stream
        self.__trace_id = trace_id
        self._start_time = start_time
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._properties = properties
        self._model = model
        self._input_data = input_data
        self._context = context
        self._collected_content: list[str] = []
        self._collected_tool_calls: dict[str, dict[str, Any]] = {}
        self._input_tokens: int | None = None
        self._output_tokens: int | None = None
        self._interaction = context.get_interaction_context()

    @property
    def _trace_id(self) -> str:
        return self.__trace_id

    def __iter__(self) -> Iterator[Any]:
        try:
            for event in self._stream:
                # Handle different event types
                event_type = getattr(event, "type", None)

                if event_type == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta:
                        delta_type = getattr(delta, "type", None)
                        if delta_type == "text_delta":
                            self._collected_content.append(delta.text)
                        elif delta_type == "input_json_delta":
                            # Tool input streaming
                            idx = str(event.index)
                            if idx in self._collected_tool_calls:
                                self._collected_tool_calls[idx]["arguments"] += delta.partial_json

                elif event_type == "content_block_start":
                    content_block = getattr(event, "content_block", None)
                    if content_block and getattr(content_block, "type", None) == "tool_use":
                        idx = str(event.index)
                        self._collected_tool_calls[idx] = {
                            "id": content_block.id,
                            "name": content_block.name,
                            "arguments": "",
                        }

                elif event_type == "message_delta":
                    usage = getattr(event, "usage", None)
                    if usage:
                        self._output_tokens = getattr(usage, "output_tokens", None)

                elif event_type == "message_start":
                    message = getattr(event, "message", None)
                    if message:
                        usage = getattr(message, "usage", None)
                        if usage:
                            self._input_tokens = getattr(usage, "input_tokens", None)

                yield event

            # Stream complete - send trace
            self._finalize()

        except Exception as e:
            self._finalize(error=str(e))
            raise

    def _finalize(self, error: str | None = None) -> None:
        """Send trace on stream completion."""
        end_time = time.time()
        output = "".join(self._collected_content)

        tool_calls = None
        if self._collected_tool_calls:
            tool_calls = []
            for tc in self._collected_tool_calls.values():
                try:
                    args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                except json.JSONDecodeError:
                    args = tc["arguments"]
                tool_calls.append({
                    "id": tc["id"],
                    "name": tc["name"],
                    "arguments": args,
                })

        tokens = None
        if self._input_tokens is not None or self._output_tokens is not None:
            input_t = self._input_tokens or 0
            output_t = self._output_tokens or 0
            tokens = {
                "input": input_t,
                "output": output_t,
                "total": input_t + output_t,
            }

        if self._interaction:
            span = SpanData(
                span_id=self._trace_id,
                parent_id=self._interaction.interaction_id,
                name=f"anthropic:{self._model}",
                type="ai",
                start_time=self._start_time,
                end_time=end_time,
                latency_ms=int((end_time - self._start_time) * 1000),
                input=self._input_data,
                output=output if not error else None,
                error=error,
                properties={
                    **self._properties,
                    "input_tokens": tokens["input"] if tokens else None,
                    "output_tokens": tokens["output"] if tokens else None,
                    "tool_calls": tool_calls,
                },
            )
            self._interaction.spans.append(span)
        else:
            self._context.send_trace(
                TraceData(
                    trace_id=self._trace_id,
                    provider="anthropic",
                    model=self._model,
                    input=self._input_data,
                    output=output if not error else None,
                    start_time=self._start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - self._start_time) * 1000),
                    tokens=tokens,
                    tool_calls=tool_calls,
                    user_id=self._user_id,
                    conversation_id=self._conversation_id,
                    properties=self._properties,
                    error=error,
                )
            )


class WrappedAnthropic:
    """Wrapped Anthropic client that traces all calls."""

    def __init__(self, client: Any, context: WrapperContext):
        self._client = client
        self._context = context
        self.messages = WrappedMessages(client.messages, context)

    def __getattr__(self, name: str) -> Any:
        """Forward other attributes to original client."""
        return getattr(self._client, name)


def wrap_anthropic(client: Any, context: WrapperContext) -> WrappedAnthropic:
    """Wrap an Anthropic client for automatic tracing."""
    return WrappedAnthropic(client, context)
