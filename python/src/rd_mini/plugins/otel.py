"""
OpenTelemetry Export Plugin

Exports traces to OpenTelemetry-compatible backends (Datadog, Honeycomb, Jaeger, etc.)
Uses the OTEL API as an optional dependency - bring your own TracerProvider.

Example:
    from rd_mini import Raindrop
    from rd_mini.plugins import create_otel_plugin

    raindrop = Raindrop(
        api_key=api_key,
        plugins=[create_otel_plugin(service_name="my-ai-service")],
    )
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from rd_mini.types import InteractionContext, SpanData, TraceData

# Try to import opentelemetry
try:
    from opentelemetry import trace
    from opentelemetry.trace import Status, StatusCode, Span, Tracer

    OTEL_AVAILABLE = True
except ImportError:
    OTEL_AVAILABLE = False
    trace = None  # type: ignore
    Status = None  # type: ignore
    StatusCode = None  # type: ignore
    Span = None  # type: ignore
    Tracer = None  # type: ignore


# ============================================
# Types
# ============================================


@dataclass
class OtelPluginOptions:
    """Options for the OpenTelemetry export plugin."""

    service_name: str = "raindrop"
    """Service name for OTEL spans"""

    tracer_name: str = "raindrop"
    """Custom tracer name"""

    include_content: bool = True
    """Whether to include input/output as span attributes"""

    attribute_prefix: str = "raindrop"
    """Custom attribute prefix"""


# ============================================
# Plugin Class
# ============================================


class OtelPlugin:
    """
    OpenTelemetry export plugin for Raindrop SDK.

    Creates OTEL spans for all traced AI interactions and tool calls.
    Uses the global OTEL API, so you need to configure your TracerProvider
    separately (via Datadog SDK, Honeycomb SDK, or manual OTEL setup).
    """

    name = "otel-export"

    def __init__(self, options: OtelPluginOptions | None = None) -> None:
        opts = options or OtelPluginOptions()
        self.service_name = opts.service_name
        self.tracer_name = opts.tracer_name
        self.include_content = opts.include_content
        self.prefix = opts.attribute_prefix

        self._tracer: Any = None
        self._active_spans: dict[str, Any] = {}

        if not OTEL_AVAILABLE:
            print(
                "[raindrop] opentelemetry not found. Install it to enable OTEL export: "
                "pip install opentelemetry-api opentelemetry-sdk"
            )

    def _get_tracer(self) -> Any:
        """Get or create the OTEL tracer."""
        if not OTEL_AVAILABLE:
            return None
        if self._tracer is None:
            self._tracer = trace.get_tracer(self.tracer_name)
        return self._tracer

    def _set_common_attributes(
        self,
        span: Any,
        user_id: str | None = None,
        conversation_id: str | None = None,
        model: str | None = None,
        provider: str | None = None,
        latency_ms: int | None = None,
        error: str | None = None,
    ) -> None:
        """Set common attributes on a span."""
        span.set_attribute(f"{self.prefix}.service", self.service_name)
        if user_id:
            span.set_attribute(f"{self.prefix}.user_id", user_id)
        if conversation_id:
            span.set_attribute(f"{self.prefix}.conversation_id", conversation_id)
        if model:
            span.set_attribute(f"{self.prefix}.model", model)
        if provider:
            span.set_attribute(f"{self.prefix}.provider", provider)
        if latency_ms:
            span.set_attribute(f"{self.prefix}.latency_ms", latency_ms)
        if error:
            span.set_attribute(f"{self.prefix}.error", error)
            span.set_status(Status(StatusCode.ERROR, error))

    def on_interaction_start(self, ctx: "InteractionContext") -> None:
        """Called when an interaction starts - create parent span."""
        tracer = self._get_tracer()
        if not tracer:
            return

        span = tracer.start_span(
            f"interaction:{ctx.event or 'default'}",
            start_time=int(ctx.start_time * 1e9),  # Convert to nanoseconds
        )

        span.set_attribute(f"{self.prefix}.interaction_id", ctx.interaction_id)
        span.set_attribute(f"{self.prefix}.type", "interaction")

        if self.include_content and ctx.input:
            span.set_attribute(f"{self.prefix}.input", ctx.input)

        self._set_common_attributes(
            span,
            user_id=ctx.user_id,
            conversation_id=ctx.conversation_id,
            model=ctx.model,
        )

        self._active_spans[ctx.interaction_id] = span

    def on_interaction_end(self, ctx: "InteractionContext") -> None:
        """Called when an interaction ends - finish parent span."""
        span = self._active_spans.pop(ctx.interaction_id, None)
        if not span:
            return

        if self.include_content and ctx.output:
            span.set_attribute(f"{self.prefix}.output", ctx.output)

        import time

        end_time = time.time()
        latency_ms = int((end_time - ctx.start_time) * 1000)
        span.set_attribute(f"{self.prefix}.latency_ms", latency_ms)

        span.set_status(Status(StatusCode.OK))
        span.end(end_time=int(end_time * 1e9))

    def on_span(self, span_data: "SpanData") -> None:
        """Called when a span completes - create child span."""
        tracer = self._get_tracer()
        if not tracer:
            return

        span = tracer.start_span(
            f"{span_data.type}:{span_data.name}",
            start_time=int(span_data.start_time * 1e9),
        )

        span.set_attribute(f"{self.prefix}.span_id", span_data.span_id)
        span.set_attribute(f"{self.prefix}.type", span_data.type)
        span.set_attribute(f"{self.prefix}.name", span_data.name)

        if span_data.parent_id:
            span.set_attribute(f"{self.prefix}.parent_id", span_data.parent_id)

        if self.include_content:
            if span_data.input:
                input_str = (
                    span_data.input
                    if isinstance(span_data.input, str)
                    else str(span_data.input)
                )
                span.set_attribute(f"{self.prefix}.input", input_str)
            if span_data.output:
                output_str = (
                    span_data.output
                    if isinstance(span_data.output, str)
                    else str(span_data.output)
                )
                span.set_attribute(f"{self.prefix}.output", output_str)

        self._set_common_attributes(span, latency_ms=span_data.latency_ms, error=span_data.error)

        status = StatusCode.ERROR if span_data.error else StatusCode.OK
        span.set_status(Status(status))

        end_time = span_data.end_time or span_data.start_time
        span.end(end_time=int(end_time * 1e9))

    def on_trace(self, trace_data: "TraceData") -> None:
        """Called when a trace is created - create AI span."""
        tracer = self._get_tracer()
        if not tracer:
            return

        span = tracer.start_span(
            f"ai:{trace_data.provider}:{trace_data.model}",
            start_time=int(trace_data.start_time * 1e9),
        )

        span.set_attribute(f"{self.prefix}.trace_id", trace_data.trace_id)
        span.set_attribute(f"{self.prefix}.type", "ai")

        if self.include_content:
            if trace_data.input:
                input_str = (
                    trace_data.input
                    if isinstance(trace_data.input, str)
                    else str(trace_data.input)
                )
                span.set_attribute(f"{self.prefix}.input", input_str)
            if trace_data.output:
                output_str = (
                    trace_data.output
                    if isinstance(trace_data.output, str)
                    else str(trace_data.output)
                )
                span.set_attribute(f"{self.prefix}.output", output_str)

        # Token counts
        if trace_data.tokens:
            if trace_data.tokens.get("input"):
                span.set_attribute(f"{self.prefix}.tokens.input", trace_data.tokens["input"])
            if trace_data.tokens.get("output"):
                span.set_attribute(f"{self.prefix}.tokens.output", trace_data.tokens["output"])
            if trace_data.tokens.get("total"):
                span.set_attribute(f"{self.prefix}.tokens.total", trace_data.tokens["total"])

        # Tool calls
        if trace_data.tool_calls:
            span.set_attribute(f"{self.prefix}.tool_calls_count", len(trace_data.tool_calls))
            tool_names = [tc.get("name", "unknown") for tc in trace_data.tool_calls]
            span.set_attribute(f"{self.prefix}.tool_calls", str(tool_names))

        self._set_common_attributes(
            span,
            user_id=trace_data.user_id,
            conversation_id=trace_data.conversation_id,
            model=trace_data.model,
            provider=trace_data.provider,
            latency_ms=trace_data.latency_ms,
            error=trace_data.error,
        )

        status = StatusCode.ERROR if trace_data.error else StatusCode.OK
        span.set_status(Status(status))

        end_time = trace_data.end_time or trace_data.start_time
        span.end(end_time=int(end_time * 1e9))

    async def flush(self) -> None:
        """Called during flush - OTEL providers handle their own flushing."""
        pass

    async def shutdown(self) -> None:
        """Called during shutdown - clean up active spans."""
        self._active_spans.clear()


# ============================================
# Factory Function
# ============================================


def create_otel_plugin(
    service_name: str = "raindrop",
    tracer_name: str = "raindrop",
    include_content: bool = True,
    attribute_prefix: str = "raindrop",
) -> OtelPlugin:
    """
    Create an OpenTelemetry export plugin.

    This plugin creates OTEL spans for all traced AI interactions and tool calls.
    You need to configure your TracerProvider separately (via Datadog SDK,
    Honeycomb SDK, or manual OTEL setup).

    Args:
        service_name: Service name for OTEL spans
        tracer_name: Custom tracer name (default: raindrop)
        include_content: Whether to include input/output as span attributes
        attribute_prefix: Custom attribute prefix (default: raindrop)

    Returns:
        OtelPlugin instance

    Example:
        # With Datadog (assumes ddtrace is initialized)
        create_otel_plugin(service_name="my-ai-service")

        # With Honeycomb
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider = TracerProvider()
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)

        create_otel_plugin(service_name="my-ai-service")
    """
    options = OtelPluginOptions(
        service_name=service_name,
        tracer_name=tracer_name,
        include_content=include_content,
        attribute_prefix=attribute_prefix,
    )
    return OtelPlugin(options)
