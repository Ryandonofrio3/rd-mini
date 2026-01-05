"""
Tests for Raindrop Python SDK
"""

import time
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from raindrop import Raindrop


# Mock OpenAI response classes
@dataclass
class MockUsage:
    prompt_tokens: int = 10
    completion_tokens: int = 20
    total_tokens: int = 30


@dataclass
class MockMessage:
    content: str = "Hello! How can I help you?"
    tool_calls: list[Any] | None = None


@dataclass
class MockChoice:
    message: MockMessage
    index: int = 0
    finish_reason: str = "stop"


@dataclass
class MockChatCompletion:
    id: str = "chatcmpl-123"
    choices: list[MockChoice] | None = None
    usage: MockUsage | None = None

    def __post_init__(self) -> None:
        if self.choices is None:
            self.choices = [MockChoice(message=MockMessage())]
        if self.usage is None:
            self.usage = MockUsage()


# Mock streaming chunk classes
@dataclass
class MockDelta:
    content: str | None = None
    tool_calls: list[Any] | None = None


@dataclass
class MockStreamChoice:
    delta: MockDelta
    index: int = 0


@dataclass
class MockStreamChunk:
    choices: list[MockStreamChoice] | None = None


class MockStream:
    """Mock streaming response."""

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks
        self._index = 0

    def __iter__(self) -> "MockStream":
        return self

    def __next__(self) -> MockStreamChunk:
        if self._index >= len(self.chunks):
            raise StopIteration
        chunk = MockStreamChunk(
            choices=[MockStreamChoice(delta=MockDelta(content=self.chunks[self._index]))]
        )
        self._index += 1
        return chunk


class MockCompletions:
    """Mock chat.completions."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> MockChatCompletion | MockStream:
        self.calls.append(kwargs)
        if kwargs.get("stream"):
            return MockStream(["Hello", " world", "!"])
        return MockChatCompletion()


class MockChat:
    """Mock chat namespace."""

    def __init__(self) -> None:
        self.completions = MockCompletions()


class MockOpenAI:
    """Mock OpenAI client."""

    def __init__(self) -> None:
        self.chat = MockChat()


class TestRaindropBasic:
    """Basic SDK functionality tests."""

    def test_initialization(self) -> None:
        """Test SDK initializes correctly."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        assert raindrop._api_key == "test-key"
        assert raindrop._disabled is True

    def test_wrap_openai(self) -> None:
        """Test wrapping OpenAI client."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        wrapped = raindrop.wrap(mock_client)

        # Should have wrapped chat.completions
        assert hasattr(wrapped, "chat")
        assert hasattr(wrapped.chat, "completions")

    def test_non_streaming_call(self) -> None:
        """Test non-streaming chat completion."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.chat.completions.create(
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}],
        )

        assert response.choices[0].message.content == "Hello! How can I help you?"
        assert hasattr(response, "_trace_id")
        assert response._trace_id.startswith("trace_")

    def test_streaming_call(self) -> None:
        """Test streaming chat completion."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.chat.completions.create(
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}],
            stream=True,
        )

        # Collect all chunks
        content = []
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                content.append(chunk.choices[0].delta.content)

        assert "".join(content) == "Hello world!"

    def test_trace_id_passthrough(self) -> None:
        """Test custom trace_id is used."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.chat.completions.create(
            model="gpt-4",
            messages=[{"role": "user", "content": "Hello"}],
            raindrop={"trace_id": "custom-trace-123"},
        )

        assert response._trace_id == "custom-trace-123"


class TestRaindropIdentify:
    """User identification tests."""

    def test_identify_sets_user(self) -> None:
        """Test identify sets current user."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        raindrop.identify("user-123")
        assert raindrop._current_user_id == "user-123"

    def test_identify_with_traits(self) -> None:
        """Test identify with user traits."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        raindrop.identify("user-123", {"name": "John", "email": "john@example.com"})
        assert raindrop._current_user_id == "user-123"
        assert raindrop._current_user_traits is not None
        assert raindrop._current_user_traits.name == "John"


class TestRaindropInteraction:
    """Interaction context tests."""

    def test_interaction_context(self) -> None:
        """Test interaction context manager."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        wrapped = raindrop.wrap(mock_client)

        with raindrop.interaction(user_id="user-123", event="rag_query") as ctx:
            assert ctx.interaction_id.startswith("trace_")
            assert ctx.user_id == "user-123"
            assert ctx.event == "rag_query"

            response = wrapped.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": "Hello"}],
            )

            # Response should have trace_id
            assert hasattr(response, "_trace_id")

            # Context should have spans after call
            assert len(ctx.spans) == 1
            assert ctx.spans[0].name == "openai:gpt-4"

    def test_interaction_with_tools(self) -> None:
        """Test interaction with wrapped tools."""
        raindrop = Raindrop(api_key="test-key", disabled=True)

        @raindrop.tool("search_docs")
        def search_docs(query: str) -> list[str]:
            return ["doc1", "doc2", "doc3"]

        with raindrop.interaction(user_id="user-123") as ctx:
            results = search_docs("test query")
            assert results == ["doc1", "doc2", "doc3"]
            assert len(ctx.spans) == 1
            assert ctx.spans[0].name == "search_docs"
            assert ctx.spans[0].type == "tool"


class TestRaindropTool:
    """Tool wrapping tests."""

    def test_tool_decorator(self) -> None:
        """Test @tool decorator."""
        raindrop = Raindrop(api_key="test-key", disabled=True)

        @raindrop.tool("my_tool")
        def my_tool(x: int) -> int:
            return x * 2

        result = my_tool(5)
        assert result == 10

    def test_wrap_tool_function(self) -> None:
        """Test wrap_tool function."""
        raindrop = Raindrop(api_key="test-key", disabled=True)

        def original_fn(x: int) -> int:
            return x * 2

        wrapped = raindrop.wrap_tool("double", original_fn)
        result = wrapped(5)
        assert result == 10

    def test_tool_captures_error(self) -> None:
        """Test tool captures errors."""
        raindrop = Raindrop(api_key="test-key", disabled=True)

        @raindrop.tool("failing_tool")
        def failing_tool() -> None:
            raise ValueError("Tool failed!")

        with raindrop.interaction() as ctx:
            with pytest.raises(ValueError):
                failing_tool()

            assert len(ctx.spans) == 1
            assert ctx.spans[0].error == "Tool failed!"


class TestRaindropFeedback:
    """Feedback tests."""

    def test_feedback_with_score(self) -> None:
        """Test sending feedback with score."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        # Just verify it doesn't raise
        raindrop.feedback("trace-123", {"score": 0.8, "comment": "Great response!"})

    def test_feedback_with_type(self) -> None:
        """Test sending feedback with type."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        raindrop.feedback("trace-123", {"type": "thumbs_up"})


class TestRaindropFlush:
    """Flush and close tests."""

    def test_flush(self) -> None:
        """Test flush doesn't raise."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        raindrop.flush()

    def test_close(self) -> None:
        """Test close doesn't raise."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        raindrop.close()


class TestRaindropProviderDetection:
    """Provider detection tests."""

    def test_detect_openai(self) -> None:
        """Test OpenAI detection."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockOpenAI()
        provider = raindrop._detect_provider(mock_client)
        assert provider == "openai"

    def test_detect_unknown(self) -> None:
        """Test unknown provider."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        provider = raindrop._detect_provider(object())
        assert provider == "unknown"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
