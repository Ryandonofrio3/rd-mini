"""
HTTP Transport for Raindrop
Fire-and-forget with buffering and retry
"""

import atexit
import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

import httpx

from raindrop.types import FeedbackOptions, SpanData, TraceData, UserTraits


@dataclass
class QueuedEvent:
    """Event queued for sending."""

    type: Literal["trace", "feedback", "identify", "interaction"]
    data: dict[str, Any]
    timestamp: float


class Transport:
    """HTTP transport with batching and retry."""

    FLUSH_INTERVAL = 1.0  # seconds
    MAX_QUEUE_SIZE = 100
    MAX_RETRIES = 3

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.raindrop.ai",
        debug: bool = False,
        disabled: bool = False,
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.debug = debug
        self.disabled = disabled

        self._queue: list[QueuedEvent] = []
        self._lock = threading.Lock()
        self._flush_timer: threading.Timer | None = None
        self._client = httpx.Client(timeout=30.0)
        self._closed = False

        # Register cleanup on exit
        atexit.register(self.close)

    def send_trace(self, trace: TraceData) -> None:
        """Send a trace event."""
        if self.disabled:
            return

        self._enqueue(
            QueuedEvent(
                type="trace",
                data=self._format_trace(trace),
                timestamp=time.time(),
            )
        )

    def send_feedback(self, trace_id: str, feedback: FeedbackOptions) -> None:
        """Send feedback/signal event."""
        if self.disabled:
            return

        # Determine signal name and sentiment
        if feedback.score is not None:
            signal_name = "positive" if feedback.score >= 0.5 else "negative"
            sentiment = "POSITIVE" if feedback.score >= 0.5 else "NEGATIVE"
        else:
            signal_name = feedback.type or "negative"
            sentiment = "POSITIVE" if feedback.type == "thumbs_up" else "NEGATIVE"

        data: dict[str, Any] = {
            "event_id": trace_id,
            "signal_name": signal_name,
            "sentiment": sentiment,
            "signal_type": feedback.signal_type,
            "timestamp": feedback.timestamp or datetime.now(timezone.utc).isoformat(),
            "properties": {
                "score": feedback.score,
                "comment": feedback.comment,
                **feedback.properties,
            },
        }

        if feedback.attachment_id:
            data["attachment_id"] = feedback.attachment_id

        self._enqueue(QueuedEvent(type="feedback", data=data, timestamp=time.time()))

    def send_identify(self, user_id: str, traits: UserTraits) -> None:
        """Send user identification."""
        if self.disabled:
            return

        self._enqueue(
            QueuedEvent(
                type="identify",
                data={"user_id": user_id, "traits": traits.to_dict()},
                timestamp=time.time(),
            )
        )

    def send_interaction(
        self,
        interaction_id: str,
        user_id: str | None,
        event: str,
        input_text: str | None,
        output: str | None,
        start_time: float,
        end_time: float,
        latency_ms: int,
        conversation_id: str | None,
        properties: dict[str, Any],
        error: str | None,
        spans: list[SpanData],
        attachments: list[dict[str, Any]] | None = None,
    ) -> None:
        """Send an interaction with nested spans."""
        if self.disabled:
            return

        # Convert spans to attachments
        span_attachments = []
        for span in spans:
            span_attachments.append(
                {
                    "type": "code",
                    "name": f"{span.type}:{span.name}",
                    "value": json.dumps(
                        {
                            "spanId": span.span_id,
                            "input": span.input,
                            "output": span.output,
                            "latencyMs": span.latency_ms,
                            "error": span.error,
                            "properties": span.properties,
                        }
                    ),
                    "role": "output",
                    "language": "json",
                }
            )

        # Combine user attachments with span attachments
        all_attachments = (attachments or []) + span_attachments

        data: dict[str, Any] = {
            "event_id": interaction_id,
            "user_id": user_id,
            "event": event,
            "timestamp": datetime.fromtimestamp(start_time, tz=timezone.utc).isoformat(),
            "properties": {
                "latency_ms": latency_ms,
                "span_count": len(spans),
                **({"error": error} if error else {}),
                **properties,
            },
            "ai_data": {
                "input": input_text,
                "output": output,
                "convo_id": conversation_id,
            },
        }

        if all_attachments:
            data["attachments"] = all_attachments

        self._enqueue(QueuedEvent(type="interaction", data=data, timestamp=time.time()))

    def _format_trace(self, trace: TraceData) -> dict[str, Any]:
        """Format trace data for API."""
        data: dict[str, Any] = {
            "event_id": trace.trace_id,
            "user_id": trace.user_id,
            "event": "ai_interaction",
            "timestamp": datetime.fromtimestamp(trace.start_time, tz=timezone.utc).isoformat(),
            "properties": {
                "provider": trace.provider,
                "conversation_id": trace.conversation_id,
                "latency_ms": trace.latency_ms,
                **(
                    {
                        "input_tokens": trace.tokens.get("input"),
                        "output_tokens": trace.tokens.get("output"),
                        "total_tokens": trace.tokens.get("total"),
                    }
                    if trace.tokens
                    else {}
                ),
                **({"error": trace.error} if trace.error else {}),
                **trace.properties,
            },
            "ai_data": {
                "model": trace.model,
                "input": json.dumps(trace.input) if not isinstance(trace.input, str) else trace.input,
                "output": (
                    json.dumps(trace.output)
                    if trace.output and not isinstance(trace.output, str)
                    else trace.output
                ),
                "convo_id": trace.conversation_id,
            },
        }

        # Add tool calls as attachments
        if trace.tool_calls:
            data["attachments"] = [
                {
                    "type": "code",
                    "name": f"tool:{tc.get('name', 'unknown')}",
                    "value": json.dumps(
                        {"arguments": tc.get("arguments"), "result": tc.get("result")}
                    ),
                    "role": "output",
                    "language": "json",
                }
                for tc in trace.tool_calls
            ]

        return data

    def _enqueue(self, event: QueuedEvent) -> None:
        """Add event to queue and schedule flush."""
        with self._lock:
            self._queue.append(event)

            if self.debug:
                print(f"[raindrop] Queued event: {event.type} {event.data}")

            # Flush if queue is full
            if len(self._queue) >= self.MAX_QUEUE_SIZE:
                self._flush_now()
                return

            # Schedule flush if not already scheduled
            if self._flush_timer is None and not self._closed:
                self._flush_timer = threading.Timer(self.FLUSH_INTERVAL, self._flush_now)
                self._flush_timer.daemon = True
                self._flush_timer.start()

    def _flush_now(self) -> None:
        """Flush all queued events."""
        with self._lock:
            if self._flush_timer:
                self._flush_timer.cancel()
                self._flush_timer = None

            if not self._queue:
                return

            events = self._queue[:]
            self._queue = []

        # Group by type
        traces = [e.data for e in events if e.type in ("trace", "interaction")]
        feedbacks = [e.data for e in events if e.type == "feedback"]
        identifies = [e.data for e in events if e.type == "identify"]

        # Send in parallel (fire-and-forget)
        if traces:
            self._send_batch("/events/track", traces)
        if feedbacks:
            self._send_batch("/signals/track", feedbacks)
        for identify in identifies:
            self._send_single("/users/identify", identify)

    def _send_batch(self, endpoint: str, data: list[dict[str, Any]], retries: int = 0) -> None:
        """Send a batch of events."""
        try:
            response = self._client.post(
                f"{self.base_url}/v1{endpoint}",
                json=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
            )

            if not response.is_success and retries < self.MAX_RETRIES:
                if self.debug:
                    print(f"[raindrop] Request failed ({response.status_code}), retrying...")
                time.sleep(0.1 * (2**retries))
                return self._send_batch(endpoint, data, retries + 1)

            if self.debug and response.is_success:
                print(f"[raindrop] Sent {len(data)} events to {endpoint}")

        except Exception as e:
            if retries < self.MAX_RETRIES:
                time.sleep(0.1 * (2**retries))
                return self._send_batch(endpoint, data, retries + 1)
            if self.debug:
                print(f"[raindrop] Failed to send events: {e}")

    def _send_single(self, endpoint: str, data: dict[str, Any], retries: int = 0) -> None:
        """Send a single event."""
        try:
            response = self._client.post(
                f"{self.base_url}/v1{endpoint}",
                json=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
            )

            if not response.is_success and retries < self.MAX_RETRIES:
                time.sleep(0.1 * (2**retries))
                return self._send_single(endpoint, data, retries + 1)

        except Exception as e:
            if retries < self.MAX_RETRIES:
                time.sleep(0.1 * (2**retries))
                return self._send_single(endpoint, data, retries + 1)
            if self.debug:
                print(f"[raindrop] Failed to send event: {e}")

    def flush(self) -> None:
        """Manually flush all pending events."""
        self._flush_now()

    def close(self) -> None:
        """Close transport and flush remaining events."""
        self._closed = True
        self._flush_now()
        self._client.close()
