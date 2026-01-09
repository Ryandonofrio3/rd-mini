# Raindrop Python SDK

Zero-config AI observability. Two lines to get started.

## Installation

```bash
uv add rd-mini
```

## Quick Start

```python
from rd_mini import Raindrop
from openai import OpenAI

# Initialize once
rd_mini = Raindrop(api_key="your-api-key")

# Wrap your client
openai = rd_mini.wrap(OpenAI())
```

## Features

### User Identification

```python
rd_mini.identify("user-123", {"name": "John", "plan": "pro"})
```

### Multi-Step Interactions

```python
with rd_mini.interaction(user_id="user-123", event="rag_query") as ctx:
    docs = search_docs(query)  # If wrapped with @raindrop.tool
    response = openai.chat.completions.create(...)
    # All steps are automatically linked
```

### Tool Tracing

```python
@rd_mini.tool("search_docs")
def search_docs(query: str) -> list[dict]:
    return vector_db.search(query)
```

### Feedback

```python
rd_mini.feedback(trace_id, {"score": 0.9, "comment": "Great response!"})
```

