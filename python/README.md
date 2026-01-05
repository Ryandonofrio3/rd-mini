# Raindrop Python SDK

Zero-config AI observability. Two lines to get started.

## Installation

```bash
pip install raindrop-ai
```

## Quick Start

```python
from raindrop import Raindrop
from openai import OpenAI

# Initialize once
raindrop = Raindrop(api_key="your-api-key")

# Wrap your client
openai = raindrop.wrap(OpenAI())

# All calls are now automatically traced
response = openai.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)

# Access trace ID from response
print(response._trace_id)
```

## Features

### User Identification

```python
raindrop.identify("user-123", {"name": "John", "plan": "pro"})
```

### Multi-Step Interactions

```python
with raindrop.interaction(user_id="user-123", event="rag_query") as ctx:
    docs = search_docs(query)  # If wrapped with @raindrop.tool
    response = openai.chat.completions.create(...)
    # All steps are automatically linked
```

### Tool Tracing

```python
@raindrop.tool("search_docs")
def search_docs(query: str) -> list[dict]:
    return vector_db.search(query)
```

### Feedback

```python
raindrop.feedback(trace_id, {"score": 0.9, "comment": "Great response!"})
```

## Supported Providers

- OpenAI
- Anthropic

## Documentation

See [docs.raindrop.ai](https://docs.raindrop.ai) for full documentation.
