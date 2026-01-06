"""
Raindrop - Zero-config AI Observability SDK

Usage:
    from rd_mini import Raindrop
    from openai import OpenAI

    raindrop = Raindrop(api_key=os.environ["RAINDROP_API_KEY"])
    client = raindrop.wrap(OpenAI())

    # All calls are now automatically traced
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello!"}]
    )

    print(response._trace_id)  # Access trace ID for feedback
"""

from rd_mini.client import Interaction, ManualSpan, Raindrop
from rd_mini.types import (
    Attachment,
    BeginOptions,
    FeedbackOptions,
    FinishOptions,
    InteractionContext,
    InteractionOptions,
    RaindropConfig,
    RaindropPlugin,
    UserTraits,
)

__all__ = [
    "Raindrop",
    "Interaction",
    "ManualSpan",
    "RaindropConfig",
    "RaindropPlugin",
    "UserTraits",
    "FeedbackOptions",
    "InteractionOptions",
    "InteractionContext",
    "BeginOptions",
    "FinishOptions",
    "Attachment",
]

__version__ = "0.1.0"
