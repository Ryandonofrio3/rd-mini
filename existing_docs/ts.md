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
Quick-start: the Interaction API
Example: chat completion with the ai SDK
Updating an interaction
Resuming an interaction
Single-shot tracking (legacy trackAi)
Tracking Signals (feedback)
Attachments
Identifying users
PII redaction
Error Handling
Configuration & helpers
AI Tracing (Beta)
Enabling Tracing (Beta)
Explicit Module Instrumentation
Using withSpan for Task Tracing (Beta)
Parameters
Using withTool for Tool Tracing (Beta)
Parameters
Using with OTEL
SDK
TypeScript
The Raindrop SDK allows you to track user events and AI interactions in your app. This documentation provides a brief overview of how to use the TypeScript SDK.

​
Installation
Install with your package manager of choice:

npm

yarn

pnpm

bun
bun add raindrop-ai
import { Raindrop } from "raindrop-ai";

// Replace with the key from your Raindrop dashboard
const raindrop = new Raindrop({ writeKey: RAINDROP_API_KEY });
​
Quick-start: the Interaction API
The new interaction workflow is a three-step pattern:
begin() - creates an interaction object and logs the initial user input.
Update - optionally call setProperty, setProperties, or addAttachments.
finish() - records the AI’s final output and closes the interaction.
Using Vercel AI SDK? If you’re using the Vercel AI SDK, you can use our easy integration here to automatically track AI events and traces. It is currently in beta and we’d love your feedback while we continue to improve the experience!
​
Example: chat completion with the ai SDK
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai'
import { randomUUID } from "crypto";
import { Raindrop } from "raindrop-ai";

const raindrop = new Raindrop({ writeKey: RAINDROP_API_KEY });

const message = "What is love?"
const eventId = randomUUID() // generate your own ID so you can correlate logs

// 1. Start the interaction
const interaction = raindrop.begin({
  eventId,
  event: "chat_message",
  userId : "user_123",
  input: message,
  model: "gpt-4o",
  convoId: "convo_123",
  properties: {
    tool_call: "reasoning_engine",
    system_prompt: "you are a helpful...",
    experiment: "experiment_a",
  },
});

const { text } = await generateText({
  model: openai("gpt-4o"),
  prompt: message
})

// 3. Finish and ship the event
interaction.finish({
  output: text,
});
​
Updating an interaction
You can update an interaction at any time using setProperty, setProperties, or addAttachments.
interaction.setProperty("stage", "embedding");
interaction.addAttachments([
  {
    type: "text",
    name: "Additional Info",
    value: "A very long document",
    role: "input",
  },
  { type: "image", value: "https://example.com/image.png", role: "output" },
  {
    type: "iframe",
    name: "Generated UI",
    value: "https://newui.generated.com",
    role: "output",
  },
]);
​
Resuming an interaction
If you don’t have access to the interaction object that was returned from begin(), you can resume an interaction by calling resumeInteraction().
const interaction = raindrop.resumeInteraction(eventId);
Interactions are subject to the global 1 MB event limit; oversized payloads will be truncated. Contact us if you have custom requirements.
​
Single-shot tracking (legacy trackAi)
If your interaction is atomic (e.g. “user asked, model answered” in one function) you can still call trackAi() directly:
raindrop.trackAi({
  event: "user_message",
  userId: "user123",
  model: "gpt-4o-mini",
  input: "Who won the 2023 AFL Grand Final?",
  output: "Collingwood by four points!",
  properties: {
    tool_call: "reasoning_engine",
    system_prompt: "you are a helpful...",
    experiment: "experiment_a",
  },
});
Heads‑up: We recommend migrating to begin() → finish() for all new code so you gain partial‑event buffering, tracing helpers, and upcoming features such as automatic token counts.
​
Tracking Signals (feedback)
Signals capture explicit or implicit quality ratings on an earlier AI event. Use trackSignal() with the same eventId you used in begin() or trackAi().
Parameter	Type	Description
eventId	string	The ID of the AI event you’re evaluating
name	"thumbs_up", "thumbs_down", string	Name of the signal (e.g. "thumbs_up")
type	"default", "feedback", "edit"	Optional, defaults to "default"
comment	string	For feedback signals
after	string	For edit signals – the user’s final content
sentiment	"POSITIVE", "NEGATIVE"	Indicates whether the signal is positive (default is NEGATIVE)
…others		See API reference
// User clicks a thumbs‑down button
await raindrop.trackSignal({
  eventId: "my_event_id",
  name: "thumbs_down",
  comment: "Answer was off-topic",
});
​
Attachments
Attachments allow you to include context from the user or that the model outputted. These could be documents, generated images, code, or even an entire web page. They work the same way in begin() interactions and in single‑shot trackAi calls.
Each attachment is an object with the following properties:
type (string): The type of attachment. Can be “code”, “text”, “image”, or “iframe”.
name (optional string): A name for the attachment.
value (string): The content or URL of the attachment.
role (string): Either “input” or “output”, indicating whether the attachment is part of the user input or AI output.
language (optional string): For code attachments, specifies the programming language.
interaction.addAttachments([
  {
    type: "code",
    role: "input",
    language: "typescript",
    name: "example.ts",
    value: "console.log('hello');",
  },
  {
    type: "text",
    name: "Additional Info",
    value: "Some extra text",
    role: "input",
  },
  { type: "image", value: "https://example.com/image.png", role: "output" },
  { type: "iframe", value: "https://example.com/embed", role: "output" },
]);
Supported types: code, text, image, iframe.
​
Identifying users
raindrop.setUserDetails({
  userId: "user123",
  traits: {
    name: "Jane",
    email: "jane@example.com",
    plan: "pro",
    os: "macOS",
  },
});
​
PII redaction
Read more on how Raindrop handles privacy and PII redaction here. Note that this doesn’t apply to beta features like tracing. You can enable client-side PII redaction when initializing the Analytics class like so:
new Raindrop({
  writeKey: RAINDROP_API_KEY,
  redactPii: true,
});
​
Error Handling
If an error occurs while sending events to Raindrop, an exception will be raised. Make sure to handle exceptions appropriately in your application.
​
Configuration & helpers
Debug logs – debugLogs: true prints every queued event.
Disabled – disabled: true completely disables event sending and tracing (useful for dev/test).
Closing – call await raindrop.close() before your process exits to flush buffers.
new Raindrop({
  writeKey: RAINDROP_API_KEY,
  debugLogs: process.env.NODE_ENV !== "production",
  disabled: process.env.NODE_ENV === "test",
});
​
AI Tracing (Beta)
AI tracing is currently in beta. We’d love your feedback while we continue to improve the experience!
AI tracing allows you to track detailed AI pipeline execution, capturing step-by-step information of complex multi-model interactions or chained prompts. This helps you:
Visualize the full execution flow of your AI application
Debug and optimize complex prompt chains
Understand intermediate steps that led to a specific generated output
​
Enabling Tracing (Beta)
To keep bundle sizes small, tracing is disabled by default and requires extra steps to enable.
// Important: We need to import initTracing and call it before importing Raindrop (BETA)
import { initTracing } from "raindrop-ai/tracing";
initTracing();

import { Raindrop } from "raindrop-ai";
If you are using Next.js, you will need to add the raindrop-ai package to serverExternalPackages in your Next.js config.
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['raindrop-ai'],
}
 
module.exports = nextConfig
​
Explicit Module Instrumentation
In some environments, automatic instrumentation of AI libraries may not work correctly due to module loading order or bundler behavior. You can use the instrumentModules option to explicitly specify which modules to instrument.
Important for Anthropic users: You must use a module namespace import (import * as ...) for Anthropic, not the default export. See the example below.
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as AnthropicModule from "@anthropic-ai/sdk";  // Module namespace import required!
import { Raindrop } from "raindrop-ai";

const raindrop = new Raindrop({
  writeKey: RAINDROP_API_KEY,
  instrumentModules: {
    openAI: OpenAI,
    anthropic: AnthropicModule,  // Pass the module namespace, NOT the default export
  },
});
Pass the module constructors or namespaces you want to instrument. Supported modules include openAI, anthropic, cohere, bedrock, google_vertexai, google_aiplatform, pinecone, together, langchain, llamaIndex, chromadb, qdrant, and mcp.
​
Using withSpan for Task Tracing (Beta)
The withSpan method allows you to trace specific tasks or operations within your AI application. This is especially useful for tracking LLM requests. Any LLM call within the span will be automatically tracked, no further work required.
// Basic task tracing
const result = await interaction.withSpan(
  { name: "generate_response" },
  async () => {
    // Task implementation
    return "Generated response";
  }
);

// Task with properties and input parameters
const result = await interaction.withSpan(
  {
    name: "embedding_generation",
    properties: { model: "text-embedding-3-large" },
    inputParameters: ["What is the weather today?"]
  },
  async () => {
    // Generate embeddings
    return [0.1, 0.2, 0.3, 0.4];
  }
);
​
Parameters
Parameter	Type	Description
name	string	Name of the task for identification in traces
properties	Record<string, string> (optional)	Key-value pairs for additional metadata
inputParameters	unknown[] (optional)	Array of input parameters for the task
​
Using withTool for Tool Tracing (Beta)
The withTool method allows you to trace any actions your agent takes. This could be as simple as saving or retrieving a memory, or using external services like web search or API calls. Tracing these actions helps you understand your agent’s behavior and what led up to the agent’s response.
// Basic tool usage
const result = await interaction.withTool(
  { name: "search_tool" },
  async () => {
    // Call to external API or service
    return "Search results";
  }
);

// Tool with properties and input parameters
const result = await interaction.withTool(
  {
    name: "calculator",
    properties: { operation: "multiply" },
    inputParameters: { a: 5, b: 10 }
  },
  async () => {
    // Tool implementation
    return "Result: 50";
  }
);
​
Parameters
Parameter	Type	Description
name	string	Name of the tool for identification in traces
version	number (optional)	Version number of the tool
properties	Record<string, string> (optional)	Key-value pairs for additional metadata
inputParameters	Record<string, any> (optional)	Record of input parameters for the tool
traceContent	boolean (optional)	Flag to control whether content is traced
suppressTracing	boolean (optional)	Flag to suppress tracing for this tool invocation
​
Using with OTEL
If you have already set up OTEL tracing, using raindrop will conflict with it.
To disable raindrop’s OTEL tracing, you can set the disableTracing option to true when initializing the SDK.
new Raindrop({
  writeKey: RAINDROP_API_KEY,
  disableTracing: true,
});
You can then use raindrop’s span processor to instrument with your own tracer.
const raindropSpanProcessor = raindrop.createSpanProcessor({
  // It only instruments whitelist of AI libraries + whatever tracer name you pass in the array
  // If you want to instrument anything/everything replace [] with "all"
  allowedInstrumentationLibraries: [],
});

const sdk = new NodeSDK({
  // ... other options
  spanProcessors: [
    raindropSpanProcessor,
    // new BatchSpanProcessor(new OTLPTraceExporter()), add your processors here
  ],
});

That’s it! You’re ready to explore your events in the Raindrop dashboard. Ping us on Slack or email us if you get stuck!
Was this page helpful?


Yes

No
Introduction
Python
Ask a question...

x
Powered by
TypeScript - Raindrop