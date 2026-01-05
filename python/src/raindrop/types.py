"""
Raindrop SDK Types
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


@dataclass
class RaindropConfig:
    """Configuration for Raindrop SDK."""

    api_key: str
    base_url: str = "https://api.raindrop.ai"
    debug: bool = False
    disabled: bool = False


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
    signal_type: Literal["default", "feedback", "edit", "standard"] = "default"
    attachment_id: Optional[str] = None
    timestamp: Optional[str] = None
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
