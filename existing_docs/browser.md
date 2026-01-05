Skip to main content
Raindrop home pagelight logo

Search...
⌘K

Ask AI
Support
Raindrop

Getting Started
Introduction
SDK
TypeScript
Python
HTTP API
Browser (JavaScript)
Vercel AI SDK (Beta)
Segment (Beta)
Platform
Signals
Experiments
Alerts
Search
Security
Privacy and PII Redaction
Data Security and Privacy
Privacy Policy
Terms of Use

On this page
Installation
Quickstart
Identify users
Signals
SDK
Browser (JavaScript)
Minimal browser-safe SDK for tracking AI events via /v1/events from web apps.

​
Installation
Install the browser SDK package:

npm

yarn

pnpm

bun
bun add @raindrop-ai/browser-sdk
​
Quickstart
import { Raindrop } from '@raindrop-ai/browser-sdk';

const rd = new Raindrop({ apiKey: 'DAWN_xxx' });

// 1) Single-shot AI event (camelCase fields)
const { eventIds } = await rd.trackAi({
  event: 'ai_completion',
  userId: 'user_123',
  model: 'gpt-4o',
  input: 'hello',
  output: 'hi there',
  convoId: 'convo_123',
  properties: { page: '/home' },
});
console.log('trackAi eventIds:', eventIds);

// 2) Partial AI event flow (returned object includes finish())
const eid = crypto.randomUUID();
const partial = await rd.trackAiPartial({
  eventId: eid,
  event: 'chat',
  userId: 'user_123',
  model: 'gpt-4o',
  convoId: 'convo_123',
  output: 'chunk 1',
});

await rd.trackAiPartial({ eventId: eid, output: 'chunk 2' });
const done = await partial.finish({ output: 'final answer' });
console.log('partial finished:', done);

​
Identify users
await rd.identify({
  userId: 'user_123',
  traits: {
    name: 'Jane',
    email: 'jane@example.com',
    plan: 'pro',
  },
});

// batch
await rd.identify([
  { userId: 'u1', traits: { plan: 'free' } },
  { userId: 'u2', traits: { plan: 'pro' } },
]);
​
Signals
// thumbs down with a comment
await rd.trackSignal({
  eventId: eid,
  name: 'thumbs_down',
  type: 'feedback',
  comment: 'Answer was off-topic',
});

// edit signal capturing the corrected content
await rd.trackSignal({
  eventId: eid,
  name: 'edit',
  type: 'edit',
  after: 'the corrected final text',
});
Was this page helpful?


Yes

No
HTTP API
Vercel AI SDK (Beta)
Ask a question...

x
Powered by
Browser (JavaScript) - Raindrop