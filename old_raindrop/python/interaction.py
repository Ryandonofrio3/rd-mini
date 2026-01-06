from __future__ import annotations
from typing import (
    Any,
    Dict,
    List,
    Literal,
    Optional,
    TYPE_CHECKING,
    Union,
    Iterator,
)
from uuid import uuid4
from dataclasses import dataclass

from .models import Attachment, PartialTrackAIEvent
from . import analytics as _core
from opentelemetry import context as context_api

if TYPE_CHECKING:
    from .analytics import ManualSpan


class Interaction:
    """
    Thin helper returned by analytics.begin().
    Each mutator just relays a partial update back to Analytics.
    """

    __slots__ = (
        "_event_id",
        "_user_id",
        "_event",
        "_convo_id",
        "_analytics",
        "__weakref__",
    )

    def __init__(
        self,
        event_id: Optional[str] = None,
        user_id: Optional[str] = None,
        event: Optional[str] = None,
        convo_id: Optional[str] = None,
    ):
        self._event_id = event_id or str(uuid4())
        self._user_id = user_id
        self._event = event
        self._convo_id = convo_id
        self._analytics = _core

    # -- mutators ----------------------------------------------------------- #
    def set_input(self, text: str) -> None:
        self._analytics._track_ai_partial(
            PartialTrackAIEvent(event_id=self._event_id, ai_data={"input": text})
        )

    def add_attachments(self, attachments: List[Attachment]) -> None:
        self._analytics._track_ai_partial(
            PartialTrackAIEvent(event_id=self._event_id, attachments=attachments)
        )

    def set_properties(self, props: Dict[str, Any]) -> None:
        self._analytics._track_ai_partial(
            PartialTrackAIEvent(event_id=self._event_id, properties=props)
        )

    def set_property(self, key: str, value: Any) -> None:
        self.set_properties({key: value})

    def finish(self, *, output: str | None = None, **extra) -> None:

        payload = PartialTrackAIEvent(
            event_id=self._event_id,
            ai_data={"output": output} if output is not None else None,
            is_pending=False,
            **extra,
        )
        self._analytics._track_ai_partial(payload)

    def start_span(
        self,
        kind: Literal["task", "tool"],
        name: str,
        version: int | None = None,
    ) -> "ManualSpan":
        """
        Create a manual span tied to this interaction.

        The span automatically inherits association properties from this interaction
        (event_id, user_id, event, convo_id) for proper tracing.

        Args:
            kind: Type of span - "task" or "tool"
            name: Name of the span
            version: Optional version number

        Returns:
            ManualSpan instance that must be explicitly ended with .end()
        """
        return self._analytics.start_span(
            kind,
            name,
            version,
            event_id=self._event_id,
            user_id=self._user_id,
            event=self._event,
            convo_id=self._convo_id,
        )

    # convenience
    @property
    def id(self) -> str:
        return self._event_id
