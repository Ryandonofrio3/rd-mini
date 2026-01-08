"""
Tests for Gemini and Bedrock wrappers
"""

from dataclasses import dataclass, field
from typing import Any, Iterator
from unittest.mock import MagicMock

import pytest

from rd_mini import Raindrop


# ============================================
# Mock Gemini Client
# ============================================


@dataclass
class MockUsageMetadata:
    prompt_token_count: int = 10
    candidates_token_count: int = 20
    total_token_count: int = 30


@dataclass
class MockPart:
    text: str | None = None
    function_call: Any | None = None


@dataclass
class MockContent:
    parts: list[MockPart] = field(default_factory=list)


@dataclass
class MockCandidate:
    content: MockContent = field(default_factory=MockContent)


@dataclass
class MockGeminiResponse:
    text: str = "Hello from Gemini!"
    candidates: list[MockCandidate] = field(default_factory=list)
    usage_metadata: MockUsageMetadata = field(default_factory=MockUsageMetadata)

    def __post_init__(self) -> None:
        if not self.candidates:
            self.candidates = [
                MockCandidate(content=MockContent(parts=[MockPart(text=self.text)]))
            ]


class MockGeminiStreamChunk:
    def __init__(self, text: str, is_last: bool = False) -> None:
        self.text = text
        self.candidates = [
            MockCandidate(content=MockContent(parts=[MockPart(text=text)]))
        ]
        self.usage_metadata = MockUsageMetadata() if is_last else None


class MockGeminiStream:
    """Mock Gemini streaming response."""

    def __init__(self) -> None:
        self.chunks = ["Hello", " from", " Gemini", "!"]
        self._index = 0

    def __iter__(self) -> "MockGeminiStream":
        return self

    def __next__(self) -> MockGeminiStreamChunk:
        if self._index >= len(self.chunks):
            raise StopIteration
        is_last = self._index == len(self.chunks) - 1
        chunk = MockGeminiStreamChunk(self.chunks[self._index], is_last=is_last)
        self._index += 1
        return chunk


class MockGeminiModels:
    """Mock models namespace."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_content(self, **kwargs: Any) -> MockGeminiResponse:
        self.calls.append({"method": "generate_content", "kwargs": kwargs})
        return MockGeminiResponse()

    def generate_content_stream(self, **kwargs: Any) -> MockGeminiStream:
        self.calls.append({"method": "generate_content_stream", "kwargs": kwargs})
        return MockGeminiStream()


class MockGeminiClient:
    """Mock Google GenAI client."""

    def __init__(self) -> None:
        self.models = MockGeminiModels()


# ============================================
# Mock Bedrock Client
# ============================================


class MockBedrockStream:
    """Mock Bedrock converse_stream response."""

    def __init__(self) -> None:
        self.events = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"contentBlockIndex": 0}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": " from"}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": " Bedrock!"}}},
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 15, "totalTokens": 25}}},
        ]
        self._index = 0

    def __iter__(self) -> "MockBedrockStream":
        return self

    def __next__(self) -> dict[str, Any]:
        if self._index >= len(self.events):
            raise StopIteration
        event = self.events[self._index]
        self._index += 1
        return event


class MockBedrockClient:
    """Mock boto3 bedrock-runtime client."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"method": "converse", "kwargs": kwargs})
        return {
            "output": {
                "message": {
                    "role": "assistant",
                    "content": [{"text": "Hello from Bedrock!"}],
                }
            },
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 15,
                "totalTokens": 25,
            },
        }

    def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"method": "converse_stream", "kwargs": kwargs})
        return {"stream": MockBedrockStream()}


# ============================================
# Gemini Tests
# ============================================


class TestGeminiWrapper:
    """Tests for Gemini wrapper."""

    def test_detection(self) -> None:
        """Test Gemini client detection."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockGeminiClient()
        wrapped = raindrop.wrap(mock_client)

        assert hasattr(wrapped, "models")
        assert hasattr(wrapped.models, "generate_content")

    def test_non_streaming_call(self) -> None:
        """Test non-streaming generate_content."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockGeminiClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.models.generate_content(
            model="gemini-2.0-flash",
            contents="Hello!",
        )

        assert response.text == "Hello from Gemini!"
        assert hasattr(response, "_trace_id")
        assert response._trace_id.startswith("trace_")

    def test_captures_model_and_contents(self) -> None:
        """Test that model and contents are captured."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockGeminiClient()
        wrapped = raindrop.wrap(mock_client)

        wrapped.models.generate_content(
            model="gemini-2.0-flash",
            contents="Test prompt",
        )

        assert len(mock_client.models.calls) == 1
        assert mock_client.models.calls[0]["method"] == "generate_content"
        assert mock_client.models.calls[0]["kwargs"]["model"] == "gemini-2.0-flash"
        assert mock_client.models.calls[0]["kwargs"]["contents"] == "Test prompt"

    def test_streaming_call(self) -> None:
        """Test streaming generate_content_stream."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockGeminiClient()
        wrapped = raindrop.wrap(mock_client)

        stream = wrapped.models.generate_content_stream(
            model="gemini-2.0-flash",
            contents="Write a poem",
        )

        assert hasattr(stream, "_trace_id")
        assert stream._trace_id.startswith("trace_")

        # Consume stream
        chunks = []
        for chunk in stream:
            if hasattr(chunk, "text") and chunk.text:
                chunks.append(chunk.text)

        assert "".join(chunks) == "Hello from Gemini!"

    def test_raindrop_options(self) -> None:
        """Test per-request raindrop options."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockGeminiClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.models.generate_content(
            model="gemini-2.0-flash",
            contents="Hello!",
            raindrop={
                "user_id": "user_123",
                "conversation_id": "conv_456",
            },
        )

        assert hasattr(response, "_trace_id")


# ============================================
# Bedrock Tests
# ============================================


class TestBedrockWrapper:
    """Tests for Bedrock wrapper."""

    def test_detection(self) -> None:
        """Test Bedrock client detection."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        assert hasattr(wrapped, "converse")
        assert hasattr(wrapped, "converse_stream")

    def test_non_streaming_converse(self) -> None:
        """Test non-streaming converse."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
            messages=[{"role": "user", "content": [{"text": "Hello!"}]}],
        )

        assert response["output"]["message"]["content"][0]["text"] == "Hello from Bedrock!"
        assert "_trace_id" in response
        assert response["_trace_id"].startswith("trace_")

    def test_captures_model_and_messages(self) -> None:
        """Test that model ID and messages are captured."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        wrapped.converse(
            modelId="meta.llama3-70b-instruct-v1:0",
            messages=[{"role": "user", "content": [{"text": "Test"}]}],
        )

        assert len(mock_client.calls) == 1
        assert mock_client.calls[0]["method"] == "converse"
        assert mock_client.calls[0]["kwargs"]["modelId"] == "meta.llama3-70b-instruct-v1:0"

    def test_streaming_converse(self) -> None:
        """Test streaming converse_stream."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse_stream(
            modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
            messages=[{"role": "user", "content": [{"text": "Write a poem"}]}],
        )

        assert "_trace_id" in response
        assert response["_trace_id"].startswith("trace_")
        assert "stream" in response

        # Consume stream
        chunks = []
        for event in response["stream"]:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    chunks.append(delta["text"])

        assert "".join(chunks) == "Hello from Bedrock!"

    def test_raindrop_options(self) -> None:
        """Test per-request raindrop options."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
            messages=[{"role": "user", "content": [{"text": "Hello!"}]}],
            raindrop={
                "user_id": "user_123",
                "conversation_id": "conv_456",
            },
        )

        assert "_trace_id" in response


class TestProviderInference:
    """Tests for provider inference from model IDs."""

    def test_anthropic_inference(self) -> None:
        """Test Anthropic provider inference."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
        )

        assert "_trace_id" in response

    def test_amazon_inference(self) -> None:
        """Test Amazon provider inference."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="amazon.titan-text-express-v1",
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
        )

        assert "_trace_id" in response

    def test_meta_inference(self) -> None:
        """Test Meta provider inference."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="meta.llama3-8b-instruct-v1:0",
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
        )

        assert "_trace_id" in response

    def test_mistral_inference(self) -> None:
        """Test Mistral provider inference."""
        raindrop = Raindrop(api_key="test-key", disabled=True)
        mock_client = MockBedrockClient()
        wrapped = raindrop.wrap(mock_client)

        response = wrapped.converse(
            modelId="mistral.mistral-7b-instruct-v0:2",
            messages=[{"role": "user", "content": [{"text": "Hi"}]}],
        )

        assert "_trace_id" in response


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
