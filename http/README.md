# Raindrop HTTP API

Direct HTTP API for AI observability. Use this when you don't have an SDK available for your language.

## Base URL

```
https://api.raindrop.ai/v1
```

## Authentication

All requests require a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

## Endpoints

### Track Events

`POST /events/track`

Track AI interactions and custom events.

```bash
curl -X POST https://api.raindrop.ai/v1/events/track \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "event_id": "trace_abc123",
    "user_id": "user_123",
    "event": "ai_interaction",
    "timestamp": "2024-01-15T10:30:00Z",
    "properties": {
      "provider": "openai",
      "latency_ms": 1234,
      "input_tokens": 100,
      "output_tokens": 50
    },
    "ai_data": {
      "model": "gpt-4",
      "input": "[{\"role\": \"user\", \"content\": \"Hello\"}]",
      "output": "Hi there! How can I help?",
      "convo_id": "conv_xyz"
    }
  }]'
```

### Send Feedback/Signals

`POST /signals/track`

Send feedback signals for AI responses.

```bash
curl -X POST https://api.raindrop.ai/v1/signals/track \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[{
    "event_id": "trace_abc123",
    "signal_name": "thumbs_up",
    "sentiment": "POSITIVE",
    "signal_type": "feedback",
    "timestamp": "2024-01-15T10:31:00Z",
    "properties": {
      "comment": "Great response!"
    }
  }]'
```

### Identify Users

`POST /users/identify`

Identify users and set traits.

```bash
curl -X POST https://api.raindrop.ai/v1/users/identify \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user_123",
    "traits": {
      "name": "John Doe",
      "email": "john@example.com",
      "plan": "pro"
    }
  }'
```

## Event Schema

### AI Interaction Event

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | Yes | Unique trace ID |
| `user_id` | string | No | User identifier |
| `event` | string | Yes | Event type (e.g., `ai_interaction`) |
| `timestamp` | string | Yes | ISO 8601 timestamp |
| `properties` | object | No | Custom properties |
| `ai_data` | object | No | AI-specific data |

### AI Data Object

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model name (e.g., `gpt-4`) |
| `input` | string | JSON-stringified input messages |
| `output` | string | Model output text |
| `convo_id` | string | Conversation thread ID |

### Signal Event

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | string | Yes | Trace ID to attach feedback to |
| `signal_name` | string | Yes | Signal type (e.g., `thumbs_up`, `thumbs_down`) |
| `sentiment` | string | Yes | `POSITIVE` or `NEGATIVE` |
| `signal_type` | string | No | `default`, `feedback`, `edit` |
| `timestamp` | string | Yes | ISO 8601 timestamp |
| `properties` | object | No | Additional properties |

## Code Examples

### Python (requests)

```python
import requests
import json
from datetime import datetime

API_KEY = "your-api-key"
BASE_URL = "https://api.raindrop.ai/v1"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

# Track an AI interaction
event = {
    "event_id": "trace_123",
    "user_id": "user_456",
    "event": "ai_interaction",
    "timestamp": datetime.utcnow().isoformat() + "Z",
    "properties": {
        "provider": "openai",
        "latency_ms": 500
    },
    "ai_data": {
        "model": "gpt-4",
        "input": json.dumps([{"role": "user", "content": "Hello"}]),
        "output": "Hi there!"
    }
}

response = requests.post(
    f"{BASE_URL}/events/track",
    headers=headers,
    json=[event]
)
```

### Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "net/http"
    "time"
)

func trackEvent() error {
    event := map[string]interface{}{
        "event_id":  "trace_123",
        "user_id":   "user_456",
        "event":     "ai_interaction",
        "timestamp": time.Now().UTC().Format(time.RFC3339),
        "ai_data": map[string]string{
            "model":  "gpt-4",
            "input":  `[{"role": "user", "content": "Hello"}]`,
            "output": "Hi there!",
        },
    }

    body, _ := json.Marshal([]interface{}{event})

    req, _ := http.NewRequest("POST", "https://api.raindrop.ai/v1/events/track", bytes.NewBuffer(body))
    req.Header.Set("Authorization", "Bearer YOUR_API_KEY")
    req.Header.Set("Content-Type", "application/json")

    client := &http.Client{}
    return client.Do(req)
}
```

### Ruby

```ruby
require 'net/http'
require 'json'
require 'time'

uri = URI('https://api.raindrop.ai/v1/events/track')
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = true

event = {
  event_id: 'trace_123',
  user_id: 'user_456',
  event: 'ai_interaction',
  timestamp: Time.now.utc.iso8601,
  ai_data: {
    model: 'gpt-4',
    input: [{ role: 'user', content: 'Hello' }].to_json,
    output: 'Hi there!'
  }
}

request = Net::HTTP::Post.new(uri)
request['Authorization'] = 'Bearer YOUR_API_KEY'
request['Content-Type'] = 'application/json'
request.body = [event].to_json

response = http.request(request)
```

## Best Practices

1. **Batch events**: Send multiple events in a single request when possible
2. **Fire and forget**: Don't block on API responses in production
3. **Generate unique IDs**: Use UUIDs or similar for `event_id`
4. **Include timestamps**: Always include ISO 8601 timestamps
5. **Link conversations**: Use `convo_id` to group related interactions
