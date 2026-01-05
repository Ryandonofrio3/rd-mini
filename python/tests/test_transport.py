"""
Tests for Raindrop Transport layer
Tests batching, retry logic, and data formatting
"""

import time
from unittest.mock import MagicMock, patch

import pytest

from raindrop.transport import Transport
from raindrop.types import FeedbackOptions, SpanData, TraceData, UserTraits


class TestTransportDisabled:
    """Tests for disabled mode."""

    def test_does_not_send_when_disabled(self) -> None:
        """Test that disabled transport doesn't send."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key", disabled=True)
            transport.send_trace(
                TraceData(
                    trace_id="trace_123",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                )
            )
            transport.flush()

            mock_client.post.assert_not_called()


class TestTransportSendTrace:
    """Tests for send_trace."""

    def test_queues_and_sends_trace(self) -> None:
        """Test trace is queued and sent on flush."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_123",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    output="Hi there!",
                    start_time=time.time() - 0.1,
                    end_time=time.time(),
                    latency_ms=100,
                    tokens={"input": 10, "output": 5, "total": 15},
                )
            )
            transport.flush()

            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            assert "/events/track" in call_args[0][0]
            assert call_args[1]["headers"]["Authorization"] == "Bearer test-key"

            body = call_args[1]["json"]
            assert len(body) == 1
            assert body[0]["event_id"] == "trace_123"
            assert body[0]["ai_data"]["model"] == "gpt-4o"

    def test_includes_user_id(self) -> None:
        """Test userId is included when provided."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_123",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                    user_id="user_456",
                )
            )
            transport.flush()

            body = mock_client.post.call_args[1]["json"]
            assert body[0]["user_id"] == "user_456"

    def test_includes_error(self) -> None:
        """Test error is included when provided."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_123",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                    error="Something went wrong",
                )
            )
            transport.flush()

            body = mock_client.post.call_args[1]["json"]
            assert body[0]["properties"]["error"] == "Something went wrong"


class TestTransportSendFeedback:
    """Tests for send_feedback."""

    def test_sends_thumbs_up(self) -> None:
        """Test sending thumbs up feedback."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_feedback(
                "trace_123",
                FeedbackOptions(type="thumbs_up", comment="Great response!"),
            )
            transport.flush()

            call_args = mock_client.post.call_args
            assert "/signals/track" in call_args[0][0]

            body = call_args[1]["json"]
            assert body[0]["event_id"] == "trace_123"
            assert body[0]["signal_name"] == "thumbs_up"
            assert body[0]["sentiment"] == "POSITIVE"
            assert body[0]["properties"]["comment"] == "Great response!"

    def test_sends_thumbs_down(self) -> None:
        """Test sending thumbs down feedback."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_feedback(
                "trace_123", FeedbackOptions(type="thumbs_down", comment="Not helpful")
            )
            transport.flush()

            body = mock_client.post.call_args[1]["json"]
            assert body[0]["sentiment"] == "NEGATIVE"

    def test_sends_score(self) -> None:
        """Test sending score feedback."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_feedback("trace_123", FeedbackOptions(score=0.75))
            transport.flush()

            body = mock_client.post.call_args[1]["json"]
            assert body[0]["sentiment"] == "POSITIVE"  # 0.75 >= 0.5
            assert body[0]["properties"]["score"] == 0.75

    def test_low_score_is_negative(self) -> None:
        """Test low score results in negative sentiment."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_feedback("trace_123", FeedbackOptions(score=0.3))
            transport.flush()

            body = mock_client.post.call_args[1]["json"]
            assert body[0]["sentiment"] == "NEGATIVE"  # 0.3 < 0.5


class TestTransportSendIdentify:
    """Tests for send_identify."""

    def test_sends_identify(self) -> None:
        """Test sending identify request."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_identify(
                "user_123",
                UserTraits(name="Test User", email="test@example.com", plan="pro"),
            )
            transport.flush()

            call_args = mock_client.post.call_args
            assert "/users/identify" in call_args[0][0]

            body = call_args[1]["json"]
            assert body["user_id"] == "user_123"
            assert body["traits"]["name"] == "Test User"


class TestTransportSendInteraction:
    """Tests for send_interaction."""

    def test_sends_interaction_with_spans(self) -> None:
        """Test sending interaction with spans."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            now = time.time()
            transport.send_interaction(
                interaction_id="int_123",
                user_id="user_456",
                event="rag_query",
                input_text="What is X?",
                output="X is...",
                start_time=now - 0.5,
                end_time=now,
                latency_ms=500,
                conversation_id=None,
                properties={},
                error=None,
                spans=[
                    SpanData(
                        span_id="span_1",
                        parent_id="int_123",
                        name="search_docs",
                        type="tool",
                        start_time=now - 0.4,
                        end_time=now - 0.3,
                        latency_ms=100,
                        input="What is X?",
                        output=[{"title": "Doc 1"}],
                    )
                ],
            )
            transport.flush()

            call_args = mock_client.post.call_args
            assert "/events/track" in call_args[0][0]

            body = call_args[1]["json"]
            assert body[0]["event_id"] == "int_123"
            assert body[0]["event"] == "rag_query"
            assert body[0]["ai_data"]["input"] == "What is X?"
            assert body[0]["ai_data"]["output"] == "X is..."
            assert len(body[0]["attachments"]) == 1
            assert "tool:search_docs" in body[0]["attachments"][0]["name"]


class TestTransportBatching:
    """Tests for batching behavior."""

    def test_batches_multiple_traces(self) -> None:
        """Test multiple traces are batched together."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_1",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                )
            )
            transport.send_trace(
                TraceData(
                    trace_id="trace_2",
                    provider="openai",
                    model="gpt-4o",
                    input="World",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                )
            )
            transport.flush()

            # Should be one call with 2 events
            assert mock_client.post.call_count == 1
            body = mock_client.post.call_args[1]["json"]
            assert len(body) == 2


class TestTransportRetry:
    """Tests for retry logic."""

    def test_retries_on_failure(self) -> None:
        """Test retry on server error."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_responses = [
                MagicMock(is_success=False, status_code=500),
                MagicMock(is_success=False, status_code=500),
                MagicMock(is_success=True),
            ]
            mock_client.post.side_effect = mock_responses
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_1",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                )
            )
            transport.flush()

            assert mock_client.post.call_count == 3


class TestTransportClose:
    """Tests for close behavior."""

    def test_flushes_on_close(self) -> None:
        """Test flush is called on close."""
        with patch("raindrop.transport.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_response = MagicMock()
            mock_response.is_success = True
            mock_client.post.return_value = mock_response
            mock_client_class.return_value = mock_client

            transport = Transport(api_key="test-key")
            transport.send_trace(
                TraceData(
                    trace_id="trace_1",
                    provider="openai",
                    model="gpt-4o",
                    input="Hello",
                    start_time=time.time(),
                    end_time=time.time(),
                    latency_ms=100,
                )
            )
            transport.close()

            # Should have sent the trace
            assert mock_client.post.call_count == 1
