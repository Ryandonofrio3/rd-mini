# Raindrop Browser SDK

Lightweight client-side SDK for AI observability.

## Installation

```bash
npm install @raindrop/browser
```

## Usage

```typescript
import { RaindropBrowser } from "@raindrop/browser";

const raindrop = new RaindropBrowser({
  apiKey: "your-api-key",
});

// Identify user
raindrop.identify("user-123", {
  name: "John Doe",
  email: "john@example.com",
  plan: "pro",
});

// Send feedback on AI responses
raindrop.feedback(traceId, {
  type: "thumbs_up",
  comment: "Great response!",
});

// Or with numeric score
raindrop.feedback(traceId, {
  score: 0.8,
  comment: "Mostly accurate",
});

// Track custom events
raindrop.track("chat_started", {
  properties: {
    source: "homepage",
  },
});
```

## API

### `new RaindropBrowser(config)`

- `apiKey` (required): Your Raindrop API key
- `baseUrl` (optional): API base URL (default: `https://api.raindrop.ai`)
- `debug` (optional): Enable debug logging

### `identify(userId, traits?)`

Identify a user for all subsequent calls.

### `feedback(traceId, options)`

Send feedback for a specific AI trace.

Options:
- `type`: `"thumbs_up"` | `"thumbs_down"`
- `score`: `0-1` numeric score
- `comment`: Text feedback
- `signalType`: `"default"` | `"feedback"` | `"edit"`
- `properties`: Additional properties

### `track(event, options?)`

Track a custom event.

### `flush()`

Manually flush pending events (called automatically on page unload).
