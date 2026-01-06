"""
PII Redaction Plugin

Redacts personally identifiable information from trace data before it's sent.
Uses regex patterns to identify and replace sensitive data.

Example:
    from rd_mini import Raindrop
    from rd_mini.plugins import create_pii_plugin

    raindrop = Raindrop(
        api_key=api_key,
        plugins=[create_pii_plugin()],
    )
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Pattern, Set

if TYPE_CHECKING:
    from rd_mini.types import InteractionContext, SpanData, TraceData

# ============================================
# Types
# ============================================

PiiPattern = Literal[
    "email", "phone", "ssn", "credit_card", "credentials", "address", "password"
]


@dataclass
class PiiPluginOptions:
    """Options for the PII redaction plugin."""

    patterns: list[PiiPattern] | None = None
    """Which built-in patterns to use (default: all)"""

    custom_patterns: list[Pattern[str]] = field(default_factory=list)
    """Custom regex patterns to add"""

    allow_list: list[str] = field(default_factory=list)
    """Strings to never redact"""

    replacement: str = "<REDACTED>"
    """Replacement string"""

    redact_names: bool = False
    """Whether to redact names using greeting/closing context"""


# ============================================
# Built-in Patterns
# ============================================

PATTERNS: dict[PiiPattern, Pattern[str]] = {
    # Email addresses
    "email": re.compile(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", re.IGNORECASE
    ),
    # Phone numbers (US-style, flexible)
    "phone": re.compile(r"(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),
    # SSN (xxx-xx-xxxx or variations)
    "ssn": re.compile(r"\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b"),
    # Credit card numbers (13-19 digits with optional spaces/dashes)
    "credit_card": re.compile(r"\b(?:\d[ -]*?){13,19}\b"),
    # API keys, tokens, secrets in key=value format
    "credentials": re.compile(
        r"\b(api[_-]?key|token|bearer|authorization|auth[_-]?token|access[_-]?token|secret[_-]?key)\s*[:=]\s*[\"']?[\w-]+[\"']?",
        re.IGNORECASE,
    ),
    # Street addresses (simplified)
    "address": re.compile(
        r"\b\d+\s+[A-Za-z\s]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|plaza|pl|terrace|ter|way|parkway|pkwy)\b",
        re.IGNORECASE,
    ),
    # Password/secret patterns
    "password": re.compile(
        r"\b(pass(word|phrase)?|secret|pwd|passwd)\s*[:=]\s*\S+", re.IGNORECASE
    ),
}

# Greeting patterns for name detection
GREETING_PATTERN = re.compile(
    r"(^|\.\s+)(dear|hi|hello|greetings|hey|hey there)[\s,:-]*", re.IGNORECASE
)


# ============================================
# Redactor Class
# ============================================


class PiiRedactor:
    """Redacts PII from text using regex patterns."""

    def __init__(self, options: PiiPluginOptions | None = None) -> None:
        opts = options or PiiPluginOptions()
        enabled_patterns = opts.patterns or list(PATTERNS.keys())
        self.patterns: list[Pattern[str]] = [PATTERNS[p] for p in enabled_patterns]
        self.patterns.extend(opts.custom_patterns)
        self.allow_list: Set[str] = set(opts.allow_list)
        self.replacement = opts.replacement
        self.redact_names = opts.redact_names

    def redact(self, text: str) -> str:
        """Redact PII from the given text."""
        if not isinstance(text, str):
            return text

        result = text

        # Apply all patterns
        for pattern in self.patterns:

            def replace_match(match: re.Match[str]) -> str:
                if match.group(0) in self.allow_list:
                    return match.group(0)
                return self.replacement

            result = pattern.sub(replace_match, result)

        # Optionally redact names
        if self.redact_names:
            result = self._redact_names_in_context(result)

        return result

    def _redact_names_in_context(self, text: str) -> str:
        """Redact names after greetings and in signature-like lines."""
        result = text

        # Redact names after greetings
        def replace_greeting(match: re.Match[str]) -> str:
            after_match = result[match.end() :]
            name_match = re.match(r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)", after_match)
            if name_match:
                return match.group(0) + self.replacement
            return match.group(0)

        result = GREETING_PATTERN.sub(replace_greeting, result)

        # Redact standalone signature-like lines
        lines = result.split("\n")
        for i, line in enumerate(lines):
            stripped = line.strip()
            if (
                0 < len(stripped) < 50
                and re.match(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[,.]?$", stripped)
            ):
                lines[i] = line.replace(stripped, self.replacement)

        return "\n".join(lines)

    def redact_object(self, obj: Any) -> Any:
        """Recursively redact PII from an object."""
        if obj is None:
            return obj

        if isinstance(obj, str):
            return self.redact(obj)

        if isinstance(obj, list):
            return [self.redact_object(item) for item in obj]

        if isinstance(obj, dict):
            return {key: self.redact_object(value) for key, value in obj.items()}

        return obj


# ============================================
# Plugin Class
# ============================================


class PiiPlugin:
    """
    PII redaction plugin for Raindrop SDK.

    Implements the RaindropPlugin protocol to redact PII from traces,
    spans, and interactions before they're sent.
    """

    name = "pii-redaction"

    def __init__(self, options: PiiPluginOptions | None = None) -> None:
        self.redactor = PiiRedactor(options)

    def on_interaction_start(self, ctx: "InteractionContext") -> None:
        """Called when an interaction starts."""
        pass

    def on_interaction_end(self, ctx: "InteractionContext") -> None:
        """Called when an interaction ends - redact input/output."""
        if ctx.input:
            ctx.input = self.redactor.redact(ctx.input)
        if ctx.output:
            ctx.output = self.redactor.redact(ctx.output)
        # Redact spans within interaction
        for span in ctx.spans:
            if span.input:
                span.input = self.redactor.redact_object(span.input)
            if span.output:
                span.output = self.redactor.redact_object(span.output)

    def on_span(self, span: "SpanData") -> None:
        """Called when a span completes - redact input/output."""
        if span.input:
            span.input = self.redactor.redact_object(span.input)
        if span.output:
            span.output = self.redactor.redact_object(span.output)

    def on_trace(self, trace: "TraceData") -> None:
        """Called when a trace is created - redact input/output."""
        if trace.input:
            trace.input = self.redactor.redact_object(trace.input)
        if trace.output:
            trace.output = self.redactor.redact_object(trace.output)
        # Redact tool call arguments/results
        if trace.tool_calls:
            for call in trace.tool_calls:
                if call.get("arguments"):
                    call["arguments"] = self.redactor.redact_object(call["arguments"])
                if call.get("result"):
                    call["result"] = self.redactor.redact_object(call["result"])

    async def flush(self) -> None:
        """Called during flush."""
        pass

    async def shutdown(self) -> None:
        """Called during shutdown."""
        pass


# ============================================
# Factory Function
# ============================================


def create_pii_plugin(
    patterns: list[PiiPattern] | None = None,
    custom_patterns: list[Pattern[str]] | None = None,
    allow_list: list[str] | None = None,
    replacement: str = "<REDACTED>",
    redact_names: bool = False,
) -> PiiPlugin:
    """
    Create a PII redaction plugin.

    Args:
        patterns: Which built-in patterns to use (default: all)
        custom_patterns: Custom regex patterns to add
        allow_list: Strings to never redact
        replacement: Replacement string (default: <REDACTED>)
        redact_names: Whether to redact names using context

    Returns:
        PiiPlugin instance

    Example:
        # Use all default patterns
        create_pii_plugin()

        # Only redact emails and phone numbers
        create_pii_plugin(patterns=["email", "phone"])

        # Add custom patterns
        create_pii_plugin(
            custom_patterns=[re.compile(r"INTERNAL-\\d+")],
            allow_list=["support@company.com"],
        )
    """
    options = PiiPluginOptions(
        patterns=patterns,
        custom_patterns=custom_patterns or [],
        allow_list=allow_list or [],
        replacement=replacement,
        redact_names=redact_names,
    )
    return PiiPlugin(options)
