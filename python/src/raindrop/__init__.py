"""
Raindrop - Zero-config AI Observability SDK

Usage:
    from raindrop import Raindrop
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

from raindrop.client import Interaction, Raindrop
from raindrop.types import (
    Attachment,
    BeginOptions,
    FeedbackOptions,
    FinishOptions,
    InteractionContext,
    InteractionOptions,
    RaindropConfig,
    UserTraits,
)

__all__ = [
    "Raindrop",
    "Interaction",
    "RaindropConfig",
    "UserTraits",
    "FeedbackOptions",
    "InteractionOptions",
    "InteractionContext",
    "BeginOptions",
    "FinishOptions",
    "Attachment",
]

__version__ = "0.1.0"
