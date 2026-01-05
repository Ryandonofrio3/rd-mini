"""
Raindrop - Zero-config AI Observability SDK

Usage:
    raindrop = Raindrop(api_key=os.environ["RAINDROP_API_KEY"])
    client = raindrop.wrap(OpenAI())
    # All calls are now automatically traced
"""

from __future__ import annotations

import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from typing import Any, Callable, Generator, TypeVar

from raindrop.transport import Transport
from raindrop.types import (
    Attachment,
    BeginOptions,
    FeedbackOptions,
    FinishOptions,
    InteractionContext,
    InteractionOptions,
    SpanData,
    TraceData,
    UserTraits,
)
from raindrop.wrappers.anthropic import wrap_anthropic
from raindrop.wrappers.openai import WrapperContext, wrap_openai

# Context variable for interaction tracking
_interaction_context: ContextVar[InteractionContext | None] = ContextVar(
    "interaction_context", default=None
)

T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., Any])


class Interaction:
    """
    Handle for a manually-managed interaction.

    Use this when you need more control than the context manager provides,
    such as when the interaction spans multiple functions or async boundaries.

    Usage:
        interaction = raindrop.begin(event="webhook_handler", user_id="user123")
        # ... do work across multiple functions ...
        interaction.output = "Final response"
        interaction.finish()
    """

    def __init__(self, context: InteractionContext, raindrop: "Raindrop"):
        self._context = context
        self._raindrop = raindrop
        self._finished = False

    @property
    def id(self) -> str:
        """Get the interaction ID."""
        return self._context.interaction_id

    @property
    def output(self) -> str | None:
        """Get the interaction output."""
        return self._context.output

    @output.setter
    def output(self, value: str | None) -> None:
        """Set the interaction output."""
        self._context.output = value

    def set_property(self, key: str, value: Any) -> "Interaction":
        """Set a single property."""
        self._context.properties[key] = value
        return self

    def set_properties(self, props: dict[str, Any]) -> "Interaction":
        """Set multiple properties."""
        self._context.properties.update(props)
        return self

    def add_attachments(self, attachments: list[Attachment]) -> "Interaction":
        """Add attachments to the interaction."""
        self._context.attachments.extend(attachments)
        return self

    def set_input(self, input_text: str) -> "Interaction":
        """Set the input text."""
        self._context.input = input_text
        return self

    def finish(self, options: FinishOptions | dict[str, Any] | None = None) -> None:
        """
        Finish the interaction and send it.

        Args:
            options: Optional finish options (output, properties, attachments)
        """
        if self._finished:
            return

        self._finished = True

        # Handle dict options
        if isinstance(options, dict):
            options = FinishOptions(
                output=options.get("output"),
                properties=options.get("properties", {}),
                attachments=options.get("attachments", []),
            )

        # Merge options
        if options:
            if options.output is not None:
                self._context.output = options.output
            self._context.properties.update(options.properties)
            self._context.attachments.extend(options.attachments)

        self._raindrop._finish_interaction(self._context)


class Raindrop:
    """
    Zero-config AI observability SDK.

    Usage:
        raindrop = Raindrop(api_key=os.environ["RAINDROP_API_KEY"])
        client = raindrop.wrap(OpenAI())

        response = client.chat.completions.create(...)
        print(response._trace_id)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.raindrop.ai",
        debug: bool = False,
        disabled: bool = False,
    ):
        self._api_key = api_key
        self._base_url = base_url
        self._debug = debug
        self._disabled = disabled
        self._current_user_id: str | None = None
        self._current_user_traits: UserTraits | None = None
        self._last_trace_id: str | None = None

        self._transport = Transport(
            api_key=api_key,
            base_url=base_url,
            debug=debug,
            disabled=disabled,
        )

        self._active_interactions: dict[str, Interaction] = {}

        if debug:
            print(f"[raindrop] Initialized (base_url={base_url}, disabled={disabled})")

    def wrap(self, client: T) -> T:
        """
        Wrap an AI client to auto-trace all calls.

        Supports:
        - OpenAI client: raindrop.wrap(OpenAI())
        - Anthropic client: raindrop.wrap(Anthropic())  # coming soon

        Args:
            client: The AI client to wrap

        Returns:
            Wrapped client with automatic tracing
        """
        provider = self._detect_provider(client)

        if self._debug:
            print(f"[raindrop] Wrapping provider: {provider}")

        context = WrapperContext(
            generate_trace_id=self._generate_trace_id,
            send_trace=self._send_trace,
            get_user_id=lambda: self._current_user_id,
            get_interaction_context=lambda: _interaction_context.get(),
            debug=self._debug,
        )

        if provider == "openai":
            return wrap_openai(client, context)  # type: ignore

        if provider == "anthropic":
            return wrap_anthropic(client, context)  # type: ignore

        if self._debug:
            print(f"[raindrop] Unknown provider, returning unwrapped")
        return client

    def identify(self, user_id: str, traits: UserTraits | dict[str, Any] | None = None) -> None:
        """
        Identify a user for all subsequent calls.

        Args:
            user_id: Unique user identifier
            traits: User traits (name, email, plan, etc.)
        """
        self._current_user_id = user_id

        if traits:
            if isinstance(traits, dict):
                traits = UserTraits(
                    name=traits.get("name"),
                    email=traits.get("email"),
                    plan=traits.get("plan"),
                    extra={k: v for k, v in traits.items() if k not in ("name", "email", "plan")},
                )
            self._current_user_traits = traits
            self._transport.send_identify(user_id, traits)

        if self._debug:
            print(f"[raindrop] User identified: {user_id}")

    def feedback(self, trace_id: str, options: FeedbackOptions | dict[str, Any]) -> None:
        """
        Send feedback for a specific trace.

        Args:
            trace_id: The trace ID to send feedback for
            options: Feedback options (type, score, comment, etc.)
        """
        if isinstance(options, dict):
            options = FeedbackOptions(
                type=options.get("type"),
                score=options.get("score"),
                comment=options.get("comment"),
                signal_type=options.get("signal_type", "default"),
                attachment_id=options.get("attachment_id"),
                timestamp=options.get("timestamp"),
                properties=options.get("properties", {}),
            )

        self._transport.send_feedback(trace_id, options)

        if self._debug:
            print(f"[raindrop] Feedback sent: {trace_id}")

    def begin(self, options: BeginOptions | dict[str, Any] | None = None, **kwargs: Any) -> Interaction:
        """
        Begin a new interaction with manual control.

        Use this when you need more flexibility than the context manager,
        such as when the interaction spans multiple functions or async boundaries.

        Args:
            options: BeginOptions or dict with event_id, user_id, event, input, model, etc.
            **kwargs: Alternative to options dict

        Returns:
            Interaction handle to use for setting properties and finishing

        Usage:
            interaction = raindrop.begin(event="webhook_handler", user_id="user123")
            # ... do work across multiple functions ...
            interaction.output = "Final response"
            interaction.finish()
        """
        # Handle dict or kwargs
        if options is None:
            options = BeginOptions(**kwargs)
        elif isinstance(options, dict):
            options = BeginOptions(
                event_id=options.get("event_id"),
                user_id=options.get("user_id"),
                event=options.get("event"),
                input=options.get("input"),
                model=options.get("model"),
                conversation_id=options.get("conversation_id"),
                properties=options.get("properties", {}),
                attachments=options.get("attachments", []),
            )

        interaction_id = options.event_id or self._generate_trace_id()
        resolved_user_id = options.user_id or self._current_user_id

        context = InteractionContext(
            interaction_id=interaction_id,
            user_id=resolved_user_id,
            conversation_id=options.conversation_id,
            start_time=time.time(),
            input=options.input,
            model=options.model,
            event=options.event or "interaction",
            properties=options.properties,
            attachments=list(options.attachments),
            spans=[],
        )

        if self._debug:
            print(f"[raindrop] Interaction began: {interaction_id}")

        interaction = Interaction(context, self)
        self._active_interactions[interaction_id] = interaction
        return interaction

    def resume_interaction(self, event_id: str) -> Interaction:
        """
        Resume an existing interaction by ID.

        Use this to continue an interaction that was started earlier,
        such as when handling a webhook response.

        Args:
            event_id: The interaction ID to resume

        Returns:
            Interaction handle

        Raises:
            KeyError: If no active interaction with that ID exists
        """
        if event_id not in self._active_interactions:
            raise KeyError(f"No active interaction with ID: {event_id}")

        if self._debug:
            print(f"[raindrop] Interaction resumed: {event_id}")

        return self._active_interactions[event_id]

    def _finish_interaction(self, context: InteractionContext) -> None:
        """Internal method to finish and send an interaction."""
        end_time = time.time()

        # Remove from active interactions
        self._active_interactions.pop(context.interaction_id, None)

        # Convert attachments to dict format
        attachments = [
            {
                "type": att.type,
                "name": att.name,
                "value": att.value,
                "role": att.role,
                "language": att.language,
            }
            for att in context.attachments
        ]

        self._transport.send_interaction(
            interaction_id=context.interaction_id,
            user_id=context.user_id,
            event=context.event or "interaction",
            input_text=context.input,
            output=context.output,
            start_time=context.start_time,
            end_time=end_time,
            latency_ms=int((end_time - context.start_time) * 1000),
            conversation_id=context.conversation_id,
            properties=context.properties,
            error=None,
            spans=context.spans,
            attachments=attachments,
        )

        self._last_trace_id = context.interaction_id

        if self._debug:
            print(f"[raindrop] Interaction finished: {context.interaction_id}")

    @contextmanager
    def interaction(
        self,
        user_id: str | None = None,
        event: str = "interaction",
        input: str | None = None,
        conversation_id: str | None = None,
        properties: dict[str, Any] | None = None,
    ) -> Generator[InteractionContext, None, None]:
        """
        Context manager for multi-step interactions.

        All wrapped clients and tools called within will be auto-linked.

        Usage:
            with raindrop.interaction(user_id="user123", event="rag_query") as ctx:
                docs = search_docs(query)  # If wrapped with @raindrop.tool
                response = openai.chat.completions.create(...)
                # ctx.interaction_id contains the trace ID
        """
        interaction_id = self._generate_trace_id()
        start_time = time.time()
        resolved_user_id = user_id or self._current_user_id

        context = InteractionContext(
            interaction_id=interaction_id,
            user_id=resolved_user_id,
            conversation_id=conversation_id,
            start_time=start_time,
            input=input,
            event=event,
            properties=properties or {},
            attachments=[],
            spans=[],
        )

        if self._debug:
            print(f"[raindrop] Interaction started: {interaction_id}")

        token = _interaction_context.set(context)
        error: str | None = None

        try:
            yield context
        except Exception as e:
            error = str(e)
            raise
        finally:
            _interaction_context.reset(token)
            end_time = time.time()

            # Convert attachments to dict format
            attachments = [
                {
                    "type": att.type,
                    "name": att.name,
                    "value": att.value,
                    "role": att.role,
                    "language": att.language,
                }
                for att in context.attachments
            ]

            self._transport.send_interaction(
                interaction_id=context.interaction_id,
                user_id=context.user_id,
                event=context.event or "interaction",
                input_text=context.input,
                output=context.output,
                start_time=context.start_time,
                end_time=end_time,
                latency_ms=int((end_time - context.start_time) * 1000),
                conversation_id=context.conversation_id,
                properties=context.properties,
                error=error,
                spans=context.spans,
                attachments=attachments,
            )

            self._last_trace_id = interaction_id

    def tool(self, name: str, **tool_options: Any) -> Callable[[F], F]:
        """
        Decorator to wrap a tool function for automatic tracing.

        Usage:
            @raindrop.tool("search_docs")
            def search_docs(query: str) -> list[dict]:
                return vector_db.search(query)

            # Use normally - auto-traced
            docs = search_docs("how to use raindrop")
        """

        def decorator(fn: F) -> F:
            @wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                context = _interaction_context.get()
                span_id = self._generate_trace_id()
                start_time = time.time()

                if self._debug:
                    print(f"[raindrop] Tool started: {name} {span_id}")

                span = SpanData(
                    span_id=span_id,
                    parent_id=context.interaction_id if context else None,
                    name=name,
                    type="tool",
                    start_time=start_time,
                    input=args[0] if len(args) == 1 else args if args else kwargs,
                    properties=tool_options.get("properties", {}),
                )

                try:
                    result = fn(*args, **kwargs)
                    end_time = time.time()

                    span.end_time = end_time
                    span.latency_ms = int((end_time - start_time) * 1000)
                    span.output = result

                    if context:
                        context.spans.append(span)
                    else:
                        # Standalone tool call
                        self._send_tool_trace(span)

                    return result

                except Exception as e:
                    end_time = time.time()
                    span.end_time = end_time
                    span.latency_ms = int((end_time - start_time) * 1000)
                    span.error = str(e)

                    if context:
                        context.spans.append(span)
                    else:
                        self._send_tool_trace(span)

                    raise

            return wrapper  # type: ignore

        return decorator

    def wrap_tool(
        self, name: str, fn: Callable[..., T], **tool_options: Any
    ) -> Callable[..., T]:
        """
        Wrap a tool function for automatic tracing (functional style).

        Usage:
            search_docs = raindrop.wrap_tool("search_docs", lambda q: vector_db.search(q))
            docs = search_docs("how to use raindrop")
        """
        return self.tool(name, **tool_options)(fn)

    def get_last_trace_id(self) -> str | None:
        """Get the most recent trace ID."""
        return self._last_trace_id

    def flush(self) -> None:
        """Flush all pending events."""
        self._transport.flush()

    def close(self) -> None:
        """Close the SDK and flush remaining events."""
        self._transport.close()
        if self._debug:
            print("[raindrop] Closed")

    def _generate_trace_id(self) -> str:
        """Generate a unique trace ID."""
        return f"trace_{uuid.uuid4()}"

    def _send_trace(self, trace: TraceData) -> None:
        """Send a trace to the transport."""
        self._last_trace_id = trace.trace_id
        self._transport.send_trace(trace)

    def _send_tool_trace(self, span: SpanData) -> None:
        """Send a standalone tool trace."""
        self._last_trace_id = span.span_id
        self._transport.send_trace(
            TraceData(
                trace_id=span.span_id,
                provider="unknown",
                model=f"tool:{span.name}",
                input=span.input,
                output=span.output,
                start_time=span.start_time,
                end_time=span.end_time,
                latency_ms=span.latency_ms,
                error=span.error,
                properties=span.properties,
            )
        )

    def _detect_provider(self, client: Any) -> str:
        """Detect the provider type from a client."""
        client_type = type(client).__name__
        module = type(client).__module__

        if "openai" in module.lower() or client_type == "OpenAI":
            return "openai"
        if "anthropic" in module.lower() or client_type == "Anthropic":
            return "anthropic"

        # Check for chat.completions (OpenAI-like)
        if hasattr(client, "chat") and hasattr(client.chat, "completions"):
            return "openai"

        # Check for messages (Anthropic-like)
        if hasattr(client, "messages") and hasattr(client.messages, "create"):
            return "anthropic"

        return "unknown"
