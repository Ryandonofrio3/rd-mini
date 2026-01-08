"""
Google Gemini SDK Wrapper
Wraps google-genai client to auto-capture all generateContent calls

Supports:
- ai.models.generate_content() (non-streaming)
- ai.models.generate_content_stream() (streaming)
- Thinking/reasoning features
- Multi-modal inputs
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


class WrappedModels:
    """Wrapped models namespace that traces all calls."""

    def __init__(self, original: Any, context: WrapperContext):
        self._original = original
        self._context = context

    def generate_content(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Generate content with automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        if self._context.debug:
            print(f"[raindrop] Gemini generate_content started: {trace_id}")

        model = kwargs.get("model", "unknown")
        contents = kwargs.get("contents", args[0] if args else None)
        config = kwargs.get("config", {})
        thinking_level = None
        if config and isinstance(config, dict):
            thinking_config = config.get("thinkingConfig", config.get("thinking_config", {}))
            if thinking_config:
                thinking_level = thinking_config.get("thinkingLevel", thinking_config.get("thinking_level"))

        try:
            response = self._original.generate_content(*args, **kwargs)
            end_time = time.time()

            # Extract output text
            output = ""
            if hasattr(response, "text"):
                output = response.text
            elif hasattr(response, "candidates"):
                output = _extract_text_from_candidates(response.candidates)

            # Extract function calls
            tool_calls = _extract_function_calls(getattr(response, "candidates", None))

            # Extract usage
            usage_metadata = getattr(response, "usage_metadata", None)
            tokens = None
            thoughts_tokens = None
            if usage_metadata:
                tokens = {
                    "input": getattr(usage_metadata, "prompt_token_count", 0),
                    "output": getattr(usage_metadata, "candidates_token_count", 0),
                    "total": getattr(usage_metadata, "total_token_count", 0),
                }
                thoughts_tokens = getattr(usage_metadata, "thoughts_token_count", None)

            # Check for interaction context
            interaction = self._context.get_interaction_context()

            if interaction:
                span = SpanData(
                    span_id=trace_id,
                    parent_id=interaction.interaction_id,
                    name=f"gemini:{model}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=contents,
                    output=output,
                    properties={
                        **properties,
                        "input_tokens": tokens["input"] if tokens else None,
                        "output_tokens": tokens["output"] if tokens else None,
                        "thoughts_tokens": thoughts_tokens,
                        "thinking_level": thinking_level,
                        "tool_calls": tool_calls if tool_calls else None,
                    },
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider="google",
                        model=model,
                        input=contents,
                        output=output,
                        start_time=start_time,
                        end_time=end_time,
                        latency_ms=int((end_time - start_time) * 1000),
                        tokens=tokens,
                        tool_calls=tool_calls if tool_calls else None,
                        user_id=user_id,
                        conversation_id=conversation_id,
                        properties={
                            **properties,
                            "thoughts_tokens": thoughts_tokens,
                            "thinking_level": thinking_level,
                        },
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
                    name=f"gemini:{model}",
                    type="ai",
                    start_time=start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - start_time) * 1000),
                    input=contents,
                    error=str(e),
                )
                interaction.spans.append(span)
            else:
                self._context.send_trace(
                    TraceData(
                        trace_id=trace_id,
                        provider="google",
                        model=model,
                        input=contents,
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

    def generate_content_stream(
        self,
        *args: Any,
        raindrop: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        """Generate content with streaming and automatic tracing."""
        trace_id = (raindrop or {}).get("trace_id") or self._context.generate_trace_id()
        start_time = time.time()
        user_id = (raindrop or {}).get("user_id") or self._context.get_user_id()
        conversation_id = (raindrop or {}).get("conversation_id")
        properties = (raindrop or {}).get("properties", {})

        if self._context.debug:
            print(f"[raindrop] Gemini generate_content_stream started: {trace_id}")

        model = kwargs.get("model", "unknown")
        contents = kwargs.get("contents", args[0] if args else None)
        config = kwargs.get("config", {})
        thinking_level = None
        if config and isinstance(config, dict):
            thinking_config = config.get("thinkingConfig", config.get("thinking_config", {}))
            if thinking_config:
                thinking_level = thinking_config.get("thinkingLevel", thinking_config.get("thinking_level"))

        stream = self._original.generate_content_stream(*args, **kwargs)

        return TracedGeminiStream(
            stream=stream,
            trace_id=trace_id,
            start_time=start_time,
            user_id=user_id,
            conversation_id=conversation_id,
            properties=properties,
            model=model,
            contents=contents,
            thinking_level=thinking_level,
            context=self._context,
        )

    def __getattr__(self, name: str) -> Any:
        """Forward other attributes to original models."""
        return getattr(self._original, name)


class TracedGeminiStream:
    """Wrapper around Gemini stream that traces on completion."""

    def __init__(
        self,
        stream: Any,
        trace_id: str,
        start_time: float,
        user_id: str | None,
        conversation_id: str | None,
        properties: dict[str, Any],
        model: str,
        contents: Any,
        thinking_level: str | None,
        context: WrapperContext,
    ):
        self._stream = stream
        self.__trace_id = trace_id
        self._start_time = start_time
        self._user_id = user_id
        self._conversation_id = conversation_id
        self._properties = properties
        self._model = model
        self._contents = contents
        self._thinking_level = thinking_level
        self._context = context
        self._collected_text: list[str] = []
        self._tool_calls: list[dict[str, Any]] = []
        self._usage_metadata: Any = None
        self._interaction = context.get_interaction_context()

    @property
    def _trace_id(self) -> str:
        return self.__trace_id

    def __iter__(self) -> Iterator[Any]:
        try:
            for chunk in self._stream:
                # Collect text
                if hasattr(chunk, "text") and chunk.text:
                    self._collected_text.append(chunk.text)
                elif hasattr(chunk, "candidates"):
                    text = _extract_text_from_candidates(chunk.candidates)
                    if text:
                        self._collected_text.append(text)
                    # Collect function calls
                    calls = _extract_function_calls(chunk.candidates)
                    self._tool_calls.extend(calls)

                # Capture usage metadata (usually in final chunk)
                if hasattr(chunk, "usage_metadata") and chunk.usage_metadata:
                    self._usage_metadata = chunk.usage_metadata

                yield chunk

            # Stream complete - send trace
            self._finalize()

        except Exception as e:
            self._finalize(error=str(e))
            raise

    async def __aiter__(self) -> AsyncIterator[Any]:
        try:
            async for chunk in self._stream:
                # Collect text
                if hasattr(chunk, "text") and chunk.text:
                    self._collected_text.append(chunk.text)
                elif hasattr(chunk, "candidates"):
                    text = _extract_text_from_candidates(chunk.candidates)
                    if text:
                        self._collected_text.append(text)
                    # Collect function calls
                    calls = _extract_function_calls(chunk.candidates)
                    self._tool_calls.extend(calls)

                # Capture usage metadata (usually in final chunk)
                if hasattr(chunk, "usage_metadata") and chunk.usage_metadata:
                    self._usage_metadata = chunk.usage_metadata

                yield chunk

            # Stream complete - send trace
            self._finalize()

        except Exception as e:
            self._finalize(error=str(e))
            raise

    def _finalize(self, error: str | None = None) -> None:
        """Send trace on stream completion."""
        end_time = time.time()
        output = "".join(self._collected_text)

        tokens = None
        thoughts_tokens = None
        if self._usage_metadata:
            tokens = {
                "input": getattr(self._usage_metadata, "prompt_token_count", 0),
                "output": getattr(self._usage_metadata, "candidates_token_count", 0),
                "total": getattr(self._usage_metadata, "total_token_count", 0),
            }
            thoughts_tokens = getattr(self._usage_metadata, "thoughts_token_count", None)

        if self._interaction:
            span = SpanData(
                span_id=self._trace_id,
                parent_id=self._interaction.interaction_id,
                name=f"gemini:{self._model}",
                type="ai",
                start_time=self._start_time,
                end_time=end_time,
                latency_ms=int((end_time - self._start_time) * 1000),
                input=self._contents,
                output=output if not error else None,
                error=error,
                properties={
                    **self._properties,
                    "input_tokens": tokens["input"] if tokens else None,
                    "output_tokens": tokens["output"] if tokens else None,
                    "thoughts_tokens": thoughts_tokens,
                    "thinking_level": self._thinking_level,
                    "tool_calls": self._tool_calls if self._tool_calls else None,
                },
            )
            self._interaction.spans.append(span)
        else:
            self._context.send_trace(
                TraceData(
                    trace_id=self._trace_id,
                    provider="google",
                    model=self._model,
                    input=self._contents,
                    output=output if not error else None,
                    start_time=self._start_time,
                    end_time=end_time,
                    latency_ms=int((end_time - self._start_time) * 1000),
                    tokens=tokens,
                    tool_calls=self._tool_calls if self._tool_calls else None,
                    user_id=self._user_id,
                    conversation_id=self._conversation_id,
                    properties={
                        **self._properties,
                        "thoughts_tokens": thoughts_tokens,
                        "thinking_level": self._thinking_level,
                    },
                    error=error,
                )
            )


class WrappedGemini:
    """Wrapped Gemini client that traces all calls."""

    def __init__(self, client: Any, context: WrapperContext):
        self._client = client
        self._context = context
        self.models = WrappedModels(client.models, context)

    def __getattr__(self, name: str) -> Any:
        """Forward other attributes to original client."""
        return getattr(self._client, name)


def wrap_gemini(client: Any, context: WrapperContext) -> WrappedGemini:
    """Wrap a Gemini client for automatic tracing."""
    return WrappedGemini(client, context)


def _extract_text_from_candidates(candidates: Any) -> str:
    """Extract text from candidates array."""
    if not candidates:
        return ""

    texts = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        if content:
            parts = getattr(content, "parts", [])
            for part in parts:
                text = getattr(part, "text", None)
                if text:
                    texts.append(text)

    return "".join(texts)


def _extract_function_calls(candidates: Any) -> list[dict[str, Any]]:
    """Extract function calls from candidates."""
    if not candidates:
        return []

    calls = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        if content:
            parts = getattr(content, "parts", [])
            for part in parts:
                func_call = getattr(part, "function_call", None)
                if func_call:
                    calls.append({
                        "id": "",  # Gemini doesn't use IDs for function calls
                        "name": getattr(func_call, "name", ""),
                        "arguments": getattr(func_call, "args", {}),
                    })

    return calls
