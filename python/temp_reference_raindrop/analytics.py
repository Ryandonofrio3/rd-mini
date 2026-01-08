import sys
import time
import threading
import os
from contextlib import contextmanager
from typing import Callable, Union, List, Dict, Optional, Literal, Any
import requests
from datetime import datetime, timezone
import logging
import json
import uuid
import atexit
from pydantic import ValidationError
from threading import Timer
from raindrop.version import VERSION
from raindrop.models import (
    TrackAIEvent,
    Attachment,
    SignalEvent,
    DefaultSignal,
    FeedbackSignal,
    EditSignal,
    PartialTrackAIEvent,
    PartialAIData,
)
from raindrop.interaction import Interaction
from raindrop.redact import perform_pii_redaction
import weakref
import urllib.parse

from traceloop.sdk import Traceloop
from traceloop.sdk.tracing.tracing import (
    TracerWrapper,
    get_chained_entity_path,
    set_entity_path,
)
from opentelemetry.trace import get_current_span
from opentelemetry import trace
from opentelemetry import context as context_api
from opentelemetry.semconv_ai import SpanAttributes
from opentelemetry.trace.status import Status, StatusCode
from traceloop.sdk.utils.json_encoder import JSONEncoder
from traceloop.sdk.tracing.context_manager import get_tracer
from traceloop.sdk.decorators import (
    task as tlp_task,
    workflow as tlp_workflow,
    TraceloopSpanKindValues,
    F,
)

__all__ = [
    # Configuration functions
    "set_debug_logs",
    "set_redact_pii",
    "init",
    "identify",
    "track_ai",
    "track_signal",
    "begin",
    "resume_interaction",
    "interaction",
    "task",
    "tool",
    "task_span",
    "tool_span",
    "start_span",
    "ManualSpan",
    "set_span_properties",
    "flush",
    "shutdown",
]


# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

write_key = None
api_url = "https://api.raindrop.ai/v1/"
max_queue_size = 10_000
upload_size = 10
upload_interval = 1.0
buffer = []
flush_lock = threading.Lock()
debug_logs = False
redact_pii = False
_tracing_enabled = False
flush_thread = None
shutdown_event = threading.Event()
max_ingest_size_bytes = 1 * 1024 * 1024  # 1 MB

_partial_buffers: dict[str, PartialTrackAIEvent] = {}
_partial_timers: dict[str, Timer] = {}
_PARTIAL_TIMEOUT = 2  # 2 seconds


def set_debug_logs(value: bool):
    global debug_logs
    debug_logs = value
    if debug_logs:
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.INFO)


def set_redact_pii(value: bool):
    global redact_pii
    redact_pii = value
    if redact_pii:
        logger.info("PII redaction enabled")
    else:
        logger.info("PII redaction disabled")


def start_flush_thread():
    logger.debug("Opening flush thread")
    global flush_thread
    if flush_thread is None:
        flush_thread = threading.Thread(target=flush_loop)
        flush_thread.daemon = True
        flush_thread.start()


def flush_loop():
    while not shutdown_event.is_set():
        try:
            flush()
        except Exception as e:
            logger.error(f"Error in flush loop: {e}")
        time.sleep(upload_interval)


def flush() -> None:
    global buffer

    if buffer is None:
        logger.error("No buffer available")
        return

    logger.debug("Starting flush")

    with flush_lock:
        current_buffer = buffer
        buffer = []

    logger.debug(f"Flushing buffer size: {len(current_buffer)}")

    grouped_events = {}
    for event in current_buffer:
        endpoint = event["type"]
        data = event["data"]
        if endpoint not in grouped_events:
            grouped_events[endpoint] = []
        grouped_events[endpoint].append(data)

    for endpoint, events_data in grouped_events.items():
        for i in range(0, len(events_data), upload_size):
            batch = events_data[i : i + upload_size]
            logger.debug(f"Sending {len(batch)} events to {endpoint}")
            send_request(endpoint, batch)

    logger.debug("Flush complete")


def send_request(
    endpoint: str, data_entries: List[Dict[str, Union[str, Dict]]]
) -> None:

    url = f"{api_url}{endpoint}"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {write_key}",
    }

    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.post(url, json=data_entries, headers=headers)
            response.raise_for_status()
            logger.debug(f"Request successful: {response.status_code}")
            break
        except requests.exceptions.RequestException as e:
            logger.error(
                f"Error sending request (attempt {attempt + 1}/{max_retries}): {e}"
            )
            if attempt == max_retries - 1:
                logger.error(f"Failed to send request after {max_retries} attempts")


def save_to_buffer(event: Dict[str, Union[str, Dict]]) -> None:
    global buffer

    if len(buffer) >= max_queue_size * 0.8:
        logger.warning(
            f"Buffer is at {len(buffer) / max_queue_size * 100:.2f}% capacity"
        )

    if len(buffer) >= max_queue_size:
        logger.error("Buffer is full. Discarding event.")
        return

    logger.debug(f"Adding event to buffer: {event}")

    with flush_lock:
        buffer.append(event)

    start_flush_thread()


def identify(user_id: str, traits: Dict[str, Union[str, int, bool, float]]) -> None:
    if not _check_write_key():
        return
    data = {"user_id": user_id, "traits": traits}
    save_to_buffer({"type": "users/identify", "data": data})


def track_ai(
    user_id: str,
    event: str,
    event_id: Optional[str] = None,
    model: Optional[str] = None,
    input: Optional[str] = None,
    output: Optional[str] = None,
    convo_id: Optional[str] = None,
    properties: Optional[Dict[str, Union[str, int, bool, float]]] = None,
    timestamp: Optional[str] = None,
    attachments: Optional[List[Attachment]] = None,
) -> str:
    if not _check_write_key():
        return

    event_id = event_id or str(uuid.uuid4())

    try:
        payload = TrackAIEvent(
            event_id=event_id,
            user_id=user_id,
            event=event,
            timestamp=timestamp or _get_timestamp(),
            properties=properties or {},
            ai_data=dict(  # Pydantic will coerce to AIData
                model=model,
                input=input,
                output=output,
                convo_id=convo_id,
            ),
            attachments=attachments,
        )
    except ValidationError as err:
        logger.error(f"[raindrop] Invalid data passed to track_ai: {err}")
        return None

    if payload.properties is None:
        payload.properties = {}
    payload.properties["$context"] = _get_context()

    data = payload.model_dump(mode="json")

    # Apply PII redaction if enabled
    if redact_pii:
        data = perform_pii_redaction(data)

    size = _get_size(data)
    if size > max_ingest_size_bytes:
        logger.warning(
            f"[raindrop] Events larger than {max_ingest_size_bytes / (1024 * 1024)} MB may have properties truncated - "
            f"an event of size {size / (1024 * 1024):.2f} MB was logged"
        )
        return None  # Skip adding oversized events to buffer

    save_to_buffer({"type": "events/track", "data": data})
    return event_id


def shutdown():
    logger.info("Shutting down raindrop analytics")
    for eid in list(_partial_timers.keys()):
        _flush_partial_event(eid)

    shutdown_event.set()
    if flush_thread:
        flush_thread.join(timeout=10)
    flush()  # Final flush to ensure all events are sent
    if _tracing_enabled:
        try:
            TracerWrapper().flush()
        except Exception as e:
            logger.debug(f"Could not flush TracerWrapper during shutdown: {e}")


def _check_write_key():
    if write_key is None:
        logger.warning(
            "write_key is not set. Please set it before using raindrop analytics."
        )
        return False
    return True


def _get_context():
    return {
        "library": {
            "name": "python-sdk",
            "version": VERSION,
        },
        "metadata": {
            "pyVersion": f"v{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        },
    }


def _get_timestamp():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _get_size(event: dict[str, any]) -> int:
    try:
        # Add default=str to handle types like datetime
        data = json.dumps(event, default=str)
        return len(data.encode("utf-8"))
    except (TypeError, OverflowError) as e:
        logger.error(f"Error serializing event for size calculation: {e}")
        return 0


def _truncate_json_if_needed(json_str: str) -> str:
    """
    Truncate JSON string if it exceeds OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT;
    truncation may yield an invalid JSON string, which is expected for logging purposes.
    """
    limit_str = os.getenv("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT")
    if limit_str:
        try:
            limit = int(limit_str)
            if limit > 0 and len(json_str) > limit:
                return json_str[:limit]
        except ValueError:
            pass
    return json_str


def _should_send_prompts():
    return (
        os.getenv("TRACELOOP_TRACE_CONTENT") or "true"
    ).lower() == "true" or context_api.get_value("override_enable_content_tracing")


# Signal types - This is now defined in models.py
# SignalType = Literal["default", "feedback", "edit"]


def track_signal(
    event_id: str,
    name: str,
    signal_type: Literal["default", "feedback", "edit"] = "default",
    timestamp: Optional[str] = None,
    properties: Optional[Dict[str, Any]] = None,
    attachment_id: Optional[str] = None,
    comment: Optional[str] = None,
    after: Optional[str] = None,
    sentiment: Optional[Literal["POSITIVE", "NEGATIVE"]] = None,
) -> None:
    """
    Track a signal event.

    Args:
        event_id: The ID of the event to attach the signal to
        name: Name of the signal (e.g. "thumbs_up", "thumbs_down")
        signal_type: Type of signal ("default", "feedback", or "edit")
        timestamp: Optional timestamp for the signal (ISO 8601 format)
        properties: Optional dictionary of additional properties.
        attachment_id: Optional ID of an attachment
        comment: Optional comment string (required and used only if signal_type is 'feedback').
        after: Optional after content string (required and used only if signal_type is 'edit').
        sentiment: Optional sentiment indicating if the signal is POSITIVE (default is NEGATIVE)
    """
    if not _check_write_key():
        return

    # Prepare the final properties dictionary
    final_properties = properties.copy() if properties else {}
    if signal_type == "feedback" and comment is not None:
        if "comment" in final_properties:
            logger.warning(
                "'comment' provided as both argument and in properties; argument value used."
            )
        final_properties["comment"] = comment
    elif signal_type == "edit" and after is not None:
        if "after" in final_properties:
            logger.warning(
                "'after' provided as both argument and in properties; argument value used."
            )
        final_properties["after"] = after

    # Prepare base arguments for all signal types
    base_args = {
        "event_id": event_id,
        "signal_name": name,
        "timestamp": timestamp or _get_timestamp(),
        "properties": final_properties,
        "attachment_id": attachment_id,
        "sentiment": sentiment,
    }

    try:
        # Construct the specific signal model based on signal_type
        if signal_type == "feedback":
            payload = FeedbackSignal(**base_args, signal_type=signal_type)
        elif signal_type == "edit":
            payload = EditSignal(**base_args, signal_type=signal_type)
        else:  # signal_type == "default"
            if comment is not None:
                logger.warning(
                    "'comment' argument provided for non-feedback signal type; ignored."
                )
            if after is not None:
                logger.warning(
                    "'after' argument provided for non-edit signal type; ignored."
                )
            payload = DefaultSignal(**base_args, signal_type=signal_type)

    except ValidationError as err:
        logger.error(f"[raindrop] Invalid data passed to track_signal: {err}")
        return None

    # model_dump handles the timestamp correctly
    data = payload.model_dump(mode="json")

    size = _get_size(data)
    if size > max_ingest_size_bytes:
        logger.warning(
            f"[raindrop] Events larger than {max_ingest_size_bytes / (1024 * 1024)} MB may have properties truncated - "
            f"an event of size {size / (1024 * 1024):.2f} MB was logged"
        )
        return  # Skip adding oversized events to buffer

    save_to_buffer({"type": "signals/track", "data": data})


INTERACTION_TRACE_ID_REGISTRY: weakref.WeakValueDictionary[int, Interaction] = (
    weakref.WeakValueDictionary()
)
INTERACTION_EVENT_ID_REGISTRY: weakref.WeakValueDictionary[str, Interaction] = (
    weakref.WeakValueDictionary()
)


def begin(
    user_id: str,
    event: str,
    event_id: str | None = None,
    properties: Optional[Dict[str, Any]] = None,
    input: Optional[str] = None,
    attachments: Optional[List[Attachment]] = None,
    convo_id: Optional[str] = None,
) -> Interaction:
    """
    Starts (or resumes) an interaction and returns a helper object.
    """
    eid = event_id or str(uuid.uuid4())

    # Instantiate ai_data if either input or convo_id is supplied so that convo_id isn't lost when input is set later
    ai_data_partial = None
    if input is not None or convo_id is not None:
        ai_data_partial = PartialAIData(input=input, convo_id=convo_id)

    # Combine properties with initial_fields, giving precedence to initial_fields if keys clash
    final_properties = (properties or {}).copy()

    current_trace_id = _safe_current_trace_id()
    if current_trace_id is not None:
        final_properties["trace_id"] = f"{current_trace_id:032x}"

    partial_event = PartialTrackAIEvent(
        event_id=eid,
        user_id=user_id,
        event=event,
        ai_data=ai_data_partial,
        properties=final_properties
        or None,  # Pass None if empty, matching PartialTrackAIEvent defaults
        attachments=attachments,
    )

    span_attributes = {
        "user_id": user_id,
        "convo_id": convo_id,
        "event": event,
        "event_id": eid,
    }
    if _tracing_enabled:
        Traceloop.set_association_properties(
            {k: v for k, v in span_attributes.items() if v is not None}
        )

    interaction = Interaction(eid, user_id=user_id, event=event, convo_id=convo_id)
    INTERACTION_EVENT_ID_REGISTRY[eid] = interaction
    if current_trace_id is not None and current_trace_id != 0:
        INTERACTION_TRACE_ID_REGISTRY[current_trace_id] = interaction

    _track_ai_partial(partial_event)
    return interaction


@contextmanager
def _temp_env(key: str, value: str):
    """Temporarily sets an environment variable. Hacky helper to deal with traceloop's BS"""
    orig = os.environ.get(key)
    os.environ[key] = value
    try:
        yield
    finally:
        if orig is None:
            del os.environ[key]
        else:
            os.environ[key] = orig


def init(
    api_key: str,
    tracing_enabled: bool = False,
    **traceloop_kwargs,
):
    """Initialize Raindrop with Traceloop integration."""
    global write_key
    write_key = api_key

    global _tracing_enabled
    _tracing_enabled = tracing_enabled

    if not _tracing_enabled:
        return

    parsed_url = urllib.parse.urlparse(api_url)
    api_endpoint = f"{parsed_url.scheme}://{parsed_url.netloc}"

    with _temp_env("TRACELOOP_METRICS_ENABLED", "false"):
        Traceloop.init(
            api_endpoint=api_endpoint,
            api_key=api_key,
            telemetry_enabled=False,
            **traceloop_kwargs,
        )


def _safe_current_trace_id() -> int | None:
    """Return current trace id or None if unavailable."""
    try:
        trace_id = get_current_span().get_span_context().trace_id
    except Exception:
        return None
    return trace_id if trace_id else None


def interaction(
    name: Optional[str] = None,
    version: Optional[int] = None,
    method_name: Optional[str] = None,
) -> Callable[[F], F]:
    return tlp_workflow(
        name=name,
        version=version,
        method_name=method_name,
        tlp_span_kind=TraceloopSpanKindValues.WORKFLOW,
    )


def task(
    name: Optional[str] = None,
    version: Optional[int] = None,
    method_name: Optional[str] = None,
    tlp_span_kind: Optional[TraceloopSpanKindValues] = TraceloopSpanKindValues.TASK,
) -> Callable[[F], F]:
    return tlp_task(
        name=name,
        version=version,
        method_name=method_name,
        tlp_span_kind=tlp_span_kind,
    )


def tool(
    name: Optional[str] = None,
    version: Optional[int] = None,
    method_name: Optional[str] = None,
) -> Callable[[F], F]:
    return tlp_task(
        name=name,
        version=version,
        method_name=method_name,
        tlp_span_kind=TraceloopSpanKindValues.TOOL,
    )


def set_span_properties(properties: Dict[str, Any]) -> None:
    """
    Set association properties on the current span for tracing.

    Args:
        properties: Dictionary of properties to associate with the current span
    """
    if not _tracing_enabled:
        return

    Traceloop.set_association_properties(properties)


class TraceEntitySpan:
    def __init__(self, span):
        self._span = span

    def record_input(self, data: Any) -> None:
        if self._span and _should_send_prompts():
            try:
                json_input = json.dumps({"args": [data]}, cls=JSONEncoder)
                truncated = _truncate_json_if_needed(json_input)
                self._span.set_attribute(
                    SpanAttributes.TRACELOOP_ENTITY_INPUT, truncated
                )
            except TypeError as e:
                logger.debug(f"[raindrop] Could not serialize input for span: {e}")

    def record_output(self, data: Any) -> None:
        if self._span and _should_send_prompts():
            try:
                json_output = json.dumps(data, cls=JSONEncoder)
                truncated = _truncate_json_if_needed(json_output)
                self._span.set_attribute(
                    SpanAttributes.TRACELOOP_ENTITY_OUTPUT, truncated
                )
            except TypeError as e:
                logger.debug(f"[raindrop] Could not serialize output for span: {e}")

    def set_properties(self, props: Dict[str, Any]) -> None:
        if _tracing_enabled and props:
            Traceloop.set_association_properties(props)


class ManualSpan:
    """
    A manually-controlled span for async/distributed operations.
    Unlike context-managed spans, this requires explicit .end() calls.
    """

    def __init__(self, span, kind: str, name: str, event_id: str | None = None):
        self._span = span
        self._kind = kind
        self._name = name
        self._event_id = event_id
        self._ended = False

    @property
    def event_id(self) -> str | None:
        return self._event_id

    def record_input(self, data: Any) -> None:
        if self._span and _should_send_prompts():
            try:
                json_input = json.dumps({"args": [data]}, cls=JSONEncoder)
                truncated = _truncate_json_if_needed(json_input)
                self._span.set_attribute(
                    SpanAttributes.TRACELOOP_ENTITY_INPUT, truncated
                )
            except TypeError as e:
                logger.debug(f"[raindrop] Could not serialize input for span: {e}")

    def record_output(self, data: Any) -> None:
        if self._span and _should_send_prompts():
            try:
                json_output = json.dumps(data, cls=JSONEncoder)
                truncated = _truncate_json_if_needed(json_output)
                self._span.set_attribute(
                    SpanAttributes.TRACELOOP_ENTITY_OUTPUT, truncated
                )
            except TypeError as e:
                logger.debug(f"[raindrop] Could not serialize output for span: {e}")

    def set_properties(self, props: Dict[str, Any]) -> None:
        if self._span and props:
            for key, value in props.items():
                if value is not None:
                    self._span.set_attribute(
                        f"traceloop.association.properties.{key}", value
                    )

    def end(self, error: Exception | None = None) -> None:
        if self._ended or not self._span:
            return
        self._ended = True
        if error is not None:
            self._span.set_status(Status(StatusCode.ERROR, str(error)))
            self._span.record_exception(error)
        self._span.end()


class _EntitySpanContext:
    def __init__(self, kind: Literal["task", "tool"], name: str, version: int | None):
        self._kind = kind
        self._name = name
        self._version = version
        self._span = None
        self._ctx_token = None
        self._span_cm = None
        self._helper = TraceEntitySpan(None)

    # internal start/finish
    def _start(self) -> None:
        if not _tracing_enabled or not TracerWrapper.verify_initialized():
            return
        tlp_kind = (
            TraceloopSpanKindValues.TASK
            if self._kind == "task"
            else TraceloopSpanKindValues.TOOL
        )
        span_name = f"{self._name}.{tlp_kind.value}"
        with get_tracer() as tracer:
            self._span_cm = tracer.start_as_current_span(span_name)
            span = self._span_cm.__enter__()

        if tlp_kind in [TraceloopSpanKindValues.TASK, TraceloopSpanKindValues.TOOL]:
            entity_path = get_chained_entity_path(self._name)
            set_entity_path(entity_path)

        span.set_attribute(SpanAttributes.TRACELOOP_SPAN_KIND, tlp_kind.value)
        span.set_attribute(SpanAttributes.TRACELOOP_ENTITY_NAME, self._name)
        if self._version is not None:
            span.set_attribute(SpanAttributes.TRACELOOP_ENTITY_VERSION, self._version)

        self._span = span
        self._helper = TraceEntitySpan(span)

    def _end(self, exc_type, exc, tb) -> bool:
        if not self._span:
            return False
        try:
            if exc is not None:
                self._span.set_status(Status(StatusCode.ERROR, str(exc)))
                self._span.record_exception(exc)
            return False
        finally:
            if self._span_cm is not None:
                self._span_cm.__exit__(exc_type, exc, tb)

    # sync
    def __enter__(self) -> TraceEntitySpan:
        self._start()
        return self._helper

    def __exit__(self, exc_type, exc, tb) -> bool:
        return self._end(exc_type, exc, tb)

    # async
    async def __aenter__(self) -> TraceEntitySpan:
        self._start()
        return self._helper

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return self._end(exc_type, exc, tb)


def task_span(name: str, version: int | None = None) -> _EntitySpanContext:
    return _EntitySpanContext("task", name, version)


def tool_span(name: str, version: int | None = None) -> _EntitySpanContext:
    return _EntitySpanContext("tool", name, version)


def start_span(
    kind: Literal["task", "tool"],
    name: str,
    version: int | None = None,
    event_id: str | None = None,
    user_id: str | None = None,
    event: str | None = None,
    convo_id: str | None = None,
) -> ManualSpan:
    """
    Create a manual span that must be explicitly ended with .end().

    Use this for async/distributed operations where the span lifecycle
    extends beyond a single context manager scope.

    Args:
        kind: Type of span - "task" or "tool"
        name: Name of the span
        version: Optional version number
        event_id: Optional event_id for tracing association
        user_id: Optional user_id for tracing association
        event: Optional event name for tracing association
        convo_id: Optional conversation ID for tracing association

    Returns:
        ManualSpan instance (safe to use even if tracing is disabled)
    """
    if not _tracing_enabled or not TracerWrapper.verify_initialized():
        return ManualSpan(None, kind, name, event_id)

    tlp_kind = (
        TraceloopSpanKindValues.TASK if kind == "task" else TraceloopSpanKindValues.TOOL
    )
    span_name = f"{name}.{tlp_kind.value}"

    with get_tracer() as tracer:
        span = tracer.start_span(span_name)

    span.set_attribute(SpanAttributes.TRACELOOP_SPAN_KIND, tlp_kind.value)
    span.set_attribute(SpanAttributes.TRACELOOP_ENTITY_NAME, name)
    if version is not None:
        span.set_attribute(SpanAttributes.TRACELOOP_ENTITY_VERSION, version)

    # Set association properties directly on the span (not on current context)
    association_props = {
        "event_id": event_id,
        "user_id": user_id,
        "event": event,
        "convo_id": convo_id,
    }
    for key, value in association_props.items():
        if value is not None:
            span.set_attribute(f"traceloop.association.properties.{key}", value)

    return ManualSpan(span, kind, name, event_id)


def resume_interaction(event_id: str | None = None) -> Interaction:
    """Return an Interaction associated with the current trace or given event_id."""

    if event_id is not None:
        if (interaction := INTERACTION_EVENT_ID_REGISTRY.get(event_id)) is not None:
            return interaction
        return Interaction(event_id)

    if (trace_id := _safe_current_trace_id()) is not None:
        if (interaction := INTERACTION_TRACE_ID_REGISTRY.get(trace_id)) is not None:
            return interaction

    # Fallback: create a fresh Interaction when no identifiers are available
    # TODO: Return No-Op interaction if event_id is None
    logger.debug("No interaction found, creating a new one")
    return Interaction()


def _track_ai_partial(event: PartialTrackAIEvent) -> None:
    """
    Merge the incoming patch into an in-memory doc and flush to backend:
      • on `.finish()`  (is_pending == False)
      • or after 20 s of inactivity
    """
    eid = event.event_id

    # 1. merge
    existing = _partial_buffers.get(eid, PartialTrackAIEvent(event_id=eid))
    existing.is_pending = (
        existing.is_pending if existing.is_pending is not None else True
    )
    merged_dict = existing.model_dump(exclude_none=True)
    incoming = event.model_dump(exclude_none=True)

    # deep merge ai_data / properties
    def _deep(d: dict, u: dict):
        for k, v in u.items():
            d[k] = (
                _deep(d.get(k, {}) if isinstance(v, dict) else v, v)
                if isinstance(v, dict)
                else v
            )
        return d

    merged = _deep(merged_dict, incoming)
    merged_obj = PartialTrackAIEvent(**merged)

    _partial_buffers[eid] = merged_obj

    # 2. timer handling
    if t := _partial_timers.get(eid):
        t.cancel()
    if merged_obj.is_pending is False:
        _flush_partial_event(eid)
    else:
        _partial_timers[eid] = Timer(_PARTIAL_TIMEOUT, _flush_partial_event, args=[eid])
        _partial_timers[eid].daemon = True
        _partial_timers[eid].start()

    if debug_logs:
        logger.debug(
            f"[raindrop] updated partial {eid}: {merged_obj.model_dump(exclude_none=True)}"
        )


def _flush_partial_event(event_id: str) -> None:
    """
    Send the accumulated patch as a single object to `events/track_partial`.
    """
    if t := _partial_timers.pop(event_id, None):
        t.cancel()

    evt = _partial_buffers.pop(event_id, None)
    if not evt:
        return

    # convert to ordinary TrackAIEvent-ish dict before send
    data = evt.model_dump(mode="json", exclude_none=True)

    # Apply PII redaction if enabled
    if redact_pii:
        data = perform_pii_redaction(data)

    size = _get_size(data)
    if size > max_ingest_size_bytes:
        logger.warning(f"[raindrop] partial event {event_id} > 1 MB; skipping")
        return

    send_request("events/track_partial", data)


atexit.register(shutdown)
