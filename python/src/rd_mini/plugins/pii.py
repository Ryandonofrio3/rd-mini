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

import json
import os
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

# Mapping from pattern type to specific replacement token
SPECIFIC_REPLACEMENTS: dict[str, str] = {
    "email": "<REDACTED_EMAIL>",
    "phone": "<REDACTED_PHONE>",
    "ssn": "<REDACTED_SSN>",
    "credit_card": "<REDACTED_CREDIT_CARD>",
    "credentials": "<REDACTED_CREDENTIALS>",
    "address": "<REDACTED_ADDRESS>",
    "password": "<REDACTED_SECRET>",
    "name": "<REDACTED_NAME>",
}


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
    """Replacement string (used when specific_tokens=False)"""

    redact_names: bool = False
    """Whether to redact names using greeting/closing context and well-known names"""

    specific_tokens: bool = False
    """Use specific tokens like <REDACTED_EMAIL> instead of generic <REDACTED>"""


# ============================================
# Load well-known names
# ============================================

_WELL_KNOWN_NAMES: set[str] = set()


def _load_well_known_names() -> set[str]:
    """Load well-known names from JSON file."""
    global _WELL_KNOWN_NAMES
    if _WELL_KNOWN_NAMES:
        return _WELL_KNOWN_NAMES

    names_path = os.path.join(os.path.dirname(__file__), "well-known-names.json")
    try:
        with open(names_path, "r") as f:
            names = json.load(f)
            _WELL_KNOWN_NAMES = set(name.lower() for name in names)
    except (FileNotFoundError, json.JSONDecodeError):
        _WELL_KNOWN_NAMES = set()

    return _WELL_KNOWN_NAMES


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

# Closing patterns for name detection (e.g., "Thanks, John" or "Best regards,\nSarah")
CLOSING_PATTERN = re.compile(
    r"(thx|thanks|thank you|regards|best|[a-z]+ly|[a-z]+ regards|all the best|happy [a-z]+ing|take care|have a [a-z]+ (weekend|night|day))\s*[,.!]*",
    re.IGNORECASE,
)

# Common words that look like names but aren't (for signature detection)
SIGNATURE_EXCLUSIONS: set[str] = {
    "thanks",
    "thank",
    "best",
    "regards",
    "sincerely",
    "cheers",
    "hello",
    "hi",
    "hey",
    "dear",
    "greetings",
    "respectfully",
    "cordially",
    "warmly",
    "truly",
    "faithfully",
    "kindly",
    "yours",
}


# ============================================
# Redactor Class
# ============================================


class PiiRedactor:
    """Redacts PII from text using regex patterns."""

    def __init__(self, options: PiiPluginOptions | None = None) -> None:
        opts = options or PiiPluginOptions()
        self.enabled_patterns = opts.patterns or list(PATTERNS.keys())
        self.pattern_map: dict[str, Pattern[str]] = {
            p: PATTERNS[p] for p in self.enabled_patterns
        }
        self.custom_patterns = list(opts.custom_patterns)
        self.allow_list: Set[str] = set(opts.allow_list)
        self.replacement = opts.replacement
        self.redact_names = opts.redact_names
        self.specific_tokens = opts.specific_tokens

        # Load well-known names if name redaction is enabled
        self.well_known_names: set[str] = set()
        self._well_known_pattern: Pattern[str] | None = None
        if self.redact_names:
            self.well_known_names = _load_well_known_names()
            if self.well_known_names:
                # Build regex pattern for well-known names (case-insensitive)
                names_pattern_str = (
                    r"\b(" + "|".join(re.escape(name) for name in self.well_known_names) + r")\b"
                )
                self._well_known_pattern = re.compile(names_pattern_str, re.IGNORECASE)

    def _get_replacement(self, pattern_type: str) -> str:
        """Get the replacement string for a pattern type."""
        if self.specific_tokens:
            return SPECIFIC_REPLACEMENTS.get(pattern_type, self.replacement)
        return self.replacement

    def redact(self, text: str) -> str:
        """Redact PII from the given text."""
        if not isinstance(text, str):
            return text

        result = text

        # Apply built-in patterns with their specific replacements
        for pattern_type, pattern in self.pattern_map.items():
            replacement = self._get_replacement(pattern_type)

            def make_replacer(repl: str) -> Any:
                def replace_match(match: re.Match[str]) -> str:
                    if match.group(0) in self.allow_list:
                        return match.group(0)
                    return repl

                return replace_match

            result = pattern.sub(make_replacer(replacement), result)

        # Apply custom patterns (use generic replacement)
        for pattern in self.custom_patterns:

            def replace_custom(match: re.Match[str]) -> str:
                if match.group(0) in self.allow_list:
                    return match.group(0)
                return self.replacement

            result = pattern.sub(replace_custom, result)

        # Optionally redact names
        if self.redact_names:
            result = self._redact_names(result)

        return result

    def _redact_names(self, text: str) -> str:
        """Redact names using well-known names list and context patterns."""
        result = text
        name_replacement = self._get_replacement("name")

        # First, redact well-known names
        if self._well_known_pattern:
            result = self._well_known_pattern.sub(name_replacement, result)

        # Redact names after greetings (e.g., "Hi John")
        greeting_matches = list(GREETING_PATTERN.finditer(result))
        for match in reversed(greeting_matches):  # Process in reverse to maintain positions
            start_pos = match.end()
            # Find capitalized words after the greeting
            name_match = re.match(r"\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)", result[start_pos:])
            if name_match:
                name_start = start_pos + name_match.start(1)
                name_end = start_pos + name_match.end(1)
                result = result[:name_start] + name_replacement + result[name_end:]

        # Redact names before closings (e.g., "Thanks, John" or "Best regards,\nSarah")
        lines = result.split("\n")
        for i, line in enumerate(lines):
            closing_match = CLOSING_PATTERN.search(line)
            if closing_match:
                # Look for names before the closing
                before_closing = line[: closing_match.start()]
                name_before = re.search(r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*$", before_closing)
                if name_before:
                    lines[i] = (
                        before_closing[: name_before.start(1)]
                        + name_replacement
                        + before_closing[name_before.end(1) :]
                        + line[closing_match.start() :]
                    )

        result = "\n".join(lines)

        # Redact standalone signature-like lines (short lines with just names)
        lines = result.split("\n")
        for i, line in enumerate(lines):
            stripped = line.strip()
            stripped_lower = stripped.lower().rstrip(",.")
            if (
                0 < len(stripped) < 50
                and re.match(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[,.]?$", stripped)
                and name_replacement not in line
                and stripped_lower not in SIGNATURE_EXCLUSIONS
            ):
                lines[i] = line.replace(stripped, name_replacement)

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
        # Redact interaction properties
        if ctx.properties:
            ctx.properties = self.redactor.redact_object(ctx.properties)
        # Redact attachments
        if ctx.attachments:
            for attachment in ctx.attachments:
                attachment.value = self.redactor.redact(attachment.value)
                if attachment.name:
                    attachment.name = self.redactor.redact(attachment.name)
        # Redact spans within interaction
        for span in ctx.spans:
            if span.input:
                span.input = self.redactor.redact_object(span.input)
            if span.output:
                span.output = self.redactor.redact_object(span.output)
            if span.error:
                span.error = self.redactor.redact(span.error)
            if span.properties:
                span.properties = self.redactor.redact_object(span.properties)

    def on_span(self, span: "SpanData") -> None:
        """Called when a span completes - redact input/output."""
        if span.input:
            span.input = self.redactor.redact_object(span.input)
        if span.output:
            span.output = self.redactor.redact_object(span.output)
        if span.error:
            span.error = self.redactor.redact(span.error)
        if span.properties:
            span.properties = self.redactor.redact_object(span.properties)

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
        # Redact error messages (may contain sensitive data)
        if trace.error:
            trace.error = self.redactor.redact(trace.error)
        # Redact custom properties
        if trace.properties:
            trace.properties = self.redactor.redact_object(trace.properties)

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
    specific_tokens: bool = False,
) -> PiiPlugin:
    """
    Create a PII redaction plugin.

    Args:
        patterns: Which built-in patterns to use (default: all)
        custom_patterns: Custom regex patterns to add
        allow_list: Strings to never redact
        replacement: Replacement string (default: <REDACTED>)
        redact_names: Whether to redact names using well-known names list and
                      greeting/closing context (default: False)
        specific_tokens: Use specific tokens like <REDACTED_EMAIL>, <REDACTED_PHONE>,
                        <REDACTED_NAME> instead of generic <REDACTED> (default: False)

    Returns:
        PiiPlugin instance

    Example:
        # Use all default patterns with name redaction
        create_pii_plugin()

        # Only redact emails and phone numbers
        create_pii_plugin(patterns=["email", "phone"])

        # Use specific replacement tokens for debugging
        create_pii_plugin(specific_tokens=True)
        # Result: "Email john@example.com" -> "Email <REDACTED_EMAIL>"

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
        specific_tokens=specific_tokens,
    )
    return PiiPlugin(options)
