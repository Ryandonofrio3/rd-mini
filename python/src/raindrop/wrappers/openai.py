"""
OpenAI SDK Wrapper
Wraps OpenAI client to auto-capture all chat completions
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any, Callable, Iterator

from raindrop.types import InteractionContext, SpanData, TraceData

if TYPE_CHECKING:
    from raindrop.transport import Transport


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


class WrappedChatCompletions:
    """Wrapped chat.completions that traces all calls."""

    def __init__(self, original: Any, context: WrapperContext):
        self._original = original
        self._context = context

    def create(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Create a chat completion with automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        if self._context.debug:
            print(f"[raindrop] OpenAI chat.completions started: {trace_id}")

        model = kwargs.get("model", "unknown")
        messages = kwargs.get("messages", [])
        is_streaming = kwargs.get("stream", False)

        if is_streaming:
            return self._handle_stream(
                trace_id=trace_id,
                start_time=start_time,
                user_id=user_id,
                conversation_id=conversation_id,
                properties=properties,
                model=model,
                messages=messages,
                args=args,
                kwargs=kwargs,
            )

        # Non-streaming
        try:
            response = self._original.create(*args, **kwargs)
            end_time = time.time()

            output = response.choices[0].message.content if response.choices else ""
            tool_calls = None

            if response.choices and response.choices[0].message.tool_calls:
                tool_calls = [
                    {
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": json.loads(tc.function.arguments),
                    }
                    for tc in response.choices[0].message.tool_calls
                ]

            tokens = None
            if response.usage:
                tokens = {
                    "input": response.usage.prompt_tokens,
                    "output": response.usage.completion_tokens,
                    "total": response.usage.total_tokens,
                }

            # Check for interaction context
            interaction = self._context.get_interaction_context()

            if interaction:
                # Add as span
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"openai:{model}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=messages,
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
                # Send as standalone trace
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider="openai",
                        model=model,
                        input=messages,
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
                    name=f"openai:{model}",
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
                        provider="openai",
                        model=model,
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

    def _handle_stream(
        self,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model: str,
        messages: list[Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> "TracedStream":
        """Handle streaming response."""
        stream = self._original.create(*args, **kwargs)
        return TracedStream(
            stream=stream,
            trace_id=trace_id,
            start_time=start_time,
            user_id=user_id,
            conversation_id=conversation_id,
            properties=properties,
            model=model,
            messages=messages,
            context=self._context,
        )


class TracedStream:
    """Wrapper around OpenAI stream that traces on completion."""

    def __init__(
        self,
        stream: Any,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model: str,
        messages: list[Any],
        context: WrapperContext,
    ):
        self._stream = stream
        self._trace_id = trace_id
        self._start_time = start_time
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._properties = properties
        self._model = model
        self._messages = messages
        self._context = context
        self._collected_content: list[str] = []
        self._collected_tool_calls: dict[int, dict[str, Any]] = {}
        self._interaction = context.get_interaction_context()

    @property
    def _trace_id(self) -> str:
        return self.__trace_id

    @_trace_id.setter
    def _trace_id(self, value: str) -> None:
        self.__trace_id = value

    def __iter__(self) -> Iterator[Any]:
        try:
            for chunk in self._stream:
                # Collect content
                if chunk.choices and chunk.choices[0].delta.content:
                    self._collected_content.append(chunk.choices[0].delta.content)

                # Collect tool calls
                if chunk.choices and chunk.choices[0].delta.tool_calls:
                    for tc in chunk.choices[0].delta.tool_calls:
                        idx = tc.index
                        if idx not in self._collected_tool_calls:
                            self._collected_tool_calls[idx] = {"id": "", "name": "", "arguments": ""}
                        if tc.id:
                            self._collected_tool_calls[idx]["id"] = tc.id
                        if tc.function and tc.function.name:
                            self._collected_tool_calls[idx]["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            self._collected_tool_calls[idx]["arguments"] += tc.function.arguments

                yield chunk

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
            tool_calls = [
                {
                    "id": tc["id"],
                    "name": tc["name"],
                    "arguments": json.loads(tc["arguments"]) if tc["arguments"] else {},
                }
                for tc in self._collected_tool_calls.values()
            ]

        if self._interaction:
            span = SpanData(
                span_id=self._trace_id,
                parent_id=self._interaction.interaction_id,
                name=f"openai:{self._model}",
                type="ai",
                start_time=self._start_time,
                end_time=end_time,
                latency_ms=int((end_time - self._start_time) * 1000),
                input=self._messages,
                output=output if not error else None,
                error=error,
                properties={
                    **self._properties,
                    "tool_calls": tool_calls,
                },
            )
            self._interaction.spans.append(span)
        else:
            self._context.send_trace(
                TraceData(
                    trace_id=self._trace_id,
                    provider="openai",
                    model=self._model,
                    input=self._messages,
                    output=output if not error else None,
                    start_time=self._start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - self._start_time) * 1000),
                    tool_calls=tool_calls,
                    user_id=self._user_id,
                    conversation_id=self._conversation_id,
                    properties=self._properties,
                    error=error,
                )
            )


class WrappedChat:
    """Wrapped chat namespace."""

    def __init__(self, original: Any, context: WrapperContext):
        self._original = original
        self._context = context
        self.completions = WrappedChatCompletions(original.completions, context)


class WrappedOpenAI:
    """Wrapped OpenAI client that traces all calls."""

    def __init__(self, client: Any, context: WrapperContext):
        self._client = client
        self._context = context
        self.chat = WrappedChat(client.chat, context)

    def __getattr__(self, name: str) -> Any:
        """Forward other attributes to original client."""
        return getattr(self._client, name)


def wrap_openai(client: Any, context: WrapperContext) -> WrappedOpenAI:
    """Wrap an OpenAI client for automatic tracing."""
    return WrappedOpenAI(client, context)
