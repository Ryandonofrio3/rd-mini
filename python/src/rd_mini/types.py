"""
Raindrop SDK Types
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:
    from rd_mini.types import InteractionContext, SpanData, TraceData


@runtime_checkable
class RaindropPlugin(Protocol):
    """
    Plugin interface for extending Raindrop SDK behavior.
    Plugins receive lifecycle hooks and can mutate data before it's sent.

    Example:
        class MyPlugin:
            name = "my-plugin"

            def on_trace(self, trace: TraceData) -> None:
                # Mutate trace data before sending
                trace.properties["custom_field"] = "value"
    """

    name: str
    """Unique plugin name for debugging."""

    def on_interaction_start(self, ctx: "InteractionContext") -> None:
        """Called when an interaction starts (begin/with_interaction)."""
        ...

    def on_interaction_end(self, ctx: "InteractionContext") -> None:
        """Called when an interaction ends (before sending to transport)."""
        ...

    def on_span(self, span: "SpanData") -> None:
        """Called when a span completes (tool/AI call within interaction)."""
        ...

    def on_trace(self, trace: "TraceData") -> None:
        """Called when a trace is created (standalone wrapped AI call)."""
        ...

    async def flush(self) -> None:
        """Called during flush - plugins should send any buffered data."""
        ...

    async def shutdown(self) -> None:
        """Called during shutdown - plugins should cleanup resources."""
        ...


@dataclass
class RaindropConfig:
    """Configuration for Raindrop SDK."""

    api_key: str
    base_url: str = "https://api.raindrop.ai"
    debug: bool = False
    disabled: bool = False
    flush_interval: float = 1.0  # seconds
    max_queue_size: int = 100
    max_retries: int = 3
    plugins: list[RaindropPlugin] = field(default_factory=list)
    redact_pii: bool = False  # Convenience option to enable PII redaction


@dataclass
class UserTraits:
    """User traits for identification."""

    name: Optional[str] = None
    email: Optional[str] = None
    plan: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.name:
            result["name"] = self.name
        if self.email:
            result["email"] = self.email
        if self.plan:
            result["plan"] = self.plan
        result.update(self.extra)
        return result


@dataclass
class FeedbackOptions:
    """Options for sending feedback."""

    type: Optional[Literal["thumbs_up", "thumbs_down"]] = None
    score: Optional[float] = None
    comment: Optional[str] = None
    signal_type: Literal["default", "feedback", "edit", "standard"] = "feedback"
    attachment_id: Optional[str] = None
    timestamp: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class SignalOptions:
    """Options for tracking signals with full control."""

    event_id: str
    name: str
    type: Literal["default", "feedback", "edit"] = "default"
    sentiment: Optional[Literal["POSITIVE", "NEGATIVE"]] = None
    comment: Optional[str] = None
    after: Optional[str] = None
    attachment_id: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class InteractionOptions:
    """Options for withInteraction context."""

    user_id: Optional[str] = None
    event: Optional[str] = None
    input: Optional[str] = None
    conversation_id: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class TraceData:
    """Internal trace data structure."""

    trace_id: str
    provider: Literal["openai", "anthropic", "unknown"]
    model: str
    input: Any
    start_time: float
    output: Optional[Any] = None
    end_time: Optional[float] = None
    latency_ms: Optional[int] = None
    tokens: Optional[dict[str, int]] = None
    tool_calls: Optional[list[dict[str, Any]]] = None
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    error: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class SpanData:
    """Internal span data for interactions."""

    span_id: str
    name: str
    type: Literal["tool", "ai"]
    start_time: float
    parent_id: Optional[str] = None
    end_time: Optional[float] = None
    latency_ms: Optional[int] = None
    input: Optional[Any] = None
    output: Optional[Any] = None
    error: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class Attachment:
    """Attachment for events."""

    type: Literal["code", "text", "image", "iframe"]
    value: str
    role: Literal["input", "output"]
    name: Optional[str] = None
    language: Optional[str] = None
    attachment_id: Optional[str] = None  # For targeting with signals


@dataclass
class InteractionContext:
    """Internal context for tracking interaction state."""

    interaction_id: str
    start_time: float
    spans: list[SpanData] = field(default_factory=list)
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    input: Optional[str] = None
    output: Optional[str] = None
    model: Optional[str] = None
    event: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)
    attachments: list[Attachment] = field(default_factory=list)


@dataclass
class BeginOptions:
    """Options for begin() method."""

    event_id: Optional[str] = None
    user_id: Optional[str] = None
    event: Optional[str] = None
    input: Optional[str] = None
    model: Optional[str] = None
    conversation_id: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)
    attachments: list[Attachment] = field(default_factory=list)


@dataclass
class FinishOptions:
    """Options for finish() method."""

    output: Optional[str] = None
    properties: dict[str, Any] = field(default_factory=dict)
    attachments: list[Attachment] = field(default_factory=list)
