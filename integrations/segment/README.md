# Raindrop Segment Integration

Send AI observability data to Raindrop via Segment.

## Overview

This integration allows you to:
1. Send Raindrop events through your existing Segment pipeline
2. Use Segment as a destination for Raindrop data
3. Enrich Raindrop data with Segment user traits

## Setup Options

### Option 1: Segment Destination (Recommended)

Configure Raindrop as a Segment destination to automatically forward relevant events.

1. In Segment, go to **Destinations** → **Add Destination**
2. Search for "Raindrop" (or use a webhook destination)
3. Configure with your Raindrop API key
4. Map events to Raindrop format

### Option 2: Dual-Send from SDK

Send events to both Segment and Raindrop from your application.

```typescript
import { Raindrop } from "raindrop";
import Analytics from "@segment/analytics-node";

const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });
const analytics = new Analytics({ writeKey: process.env.SEGMENT_WRITE_KEY });

// Identify syncs to both
function identify(userId: string, traits: object) {
  raindrop.identify(userId, traits);
  analytics.identify({ userId, traits });
}

// AI events go to Raindrop, custom events to Segment
const openai = raindrop.wrap(new OpenAI());

// Track business events to Segment
analytics.track({
  userId: "user-123",
  event: "Subscription Upgraded",
  properties: { plan: "pro" },
});
```

### Option 3: Segment Source to Raindrop

Use Segment Functions to transform and forward events to Raindrop.

```javascript
// Segment Function
async function onTrack(event, settings) {
  // Only forward AI-related events
  if (!event.event.startsWith("AI ")) return;

  await fetch("https://api.raindrop.ai/v1/events/track", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.raindropApiKey}`,
    },
    body: JSON.stringify([{
      event_id: event.messageId,
      user_id: event.userId,
      event: event.event,
      timestamp: event.timestamp,
      properties: event.properties,
      ai_data: event.properties.ai_data,
    }]),
  });
}
```

## Event Mapping

### Segment → Raindrop

| Segment Event | Raindrop Event |
|--------------|----------------|
| `AI Chat Completed` | `ai_interaction` |
| `AI Feedback Submitted` | Signal on trace |
| `identify()` | User identification |

### Event Schema

```javascript
// Segment track call
analytics.track({
  userId: "user-123",
  event: "AI Chat Completed",
  properties: {
    // Standard properties
    trace_id: "trace_abc123",
    model: "gpt-4",
    latency_ms: 1234,
    input_tokens: 100,
    output_tokens: 50,

    // AI data
    ai_data: {
      input: "[{\"role\": \"user\", \"content\": \"Hello\"}]",
      output: "Hi there!",
      convo_id: "conv_xyz",
    },
  },
});
```

## Webhook Destination Setup

If using Segment's webhook destination:

**Endpoint:** `https://api.raindrop.ai/v1/events/track`

**Headers:**
```
Authorization: Bearer YOUR_RAINDROP_API_KEY
Content-Type: application/json
```

**Body Transform:**
```javascript
[{
  event_id: $.messageId,
  user_id: $.userId,
  event: $.event,
  timestamp: $.timestamp,
  properties: $.properties,
  ai_data: $.properties.ai_data
}]
```

## Best Practices

1. **Use consistent user IDs**: Ensure `userId` matches between Segment and Raindrop
2. **Include trace IDs**: Always include `trace_id` in properties for feedback linking
3. **Batch events**: Segment handles batching automatically
4. **Filter events**: Only forward AI-related events to avoid noise

## Support

For integration help, contact support@raindrop.ai
