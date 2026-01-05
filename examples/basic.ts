/**
 * Raindrop SDK v2 - Basic Usage Examples
 *
 * This file demonstrates the simplified API design.
 * Run with: bun run examples/basic.ts
 */

import { Raindrop } from '../src/index.js';

// === INITIALIZATION ===
// Just 2 lines to get started!
const raindrop = new Raindrop({
  apiKey: process.env.RAINDROP_API_KEY || 'test_key',
  debug: true, // Enable for development
  // disabled: true, // Uncomment for tests
});

// === EXAMPLE 1: OpenAI ===
async function openaiExample() {
  // Dynamic import to handle optional peer dependency
  const { default: OpenAI } = await import('openai');

  // Wrap the client - that's it!
  const openai = raindrop.wrap(new OpenAI());

  // Use normally - everything is auto-traced
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Say hello!' }],
  });

  console.log('Response:', response.choices[0].message.content);
  console.log('Trace ID:', response._traceId);

  // Send feedback linked to this trace
  await raindrop.feedback(response._traceId, {
    type: 'thumbs_up',
    comment: 'Great response!',
  });
}

// === EXAMPLE 2: OpenAI Streaming ===
async function openaiStreamingExample() {
  const { default: OpenAI } = await import('openai');
  const openai = raindrop.wrap(new OpenAI());

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Count to 5' }],
    stream: true,
  });

  // Trace ID available immediately
  console.log('Stream Trace ID:', stream._traceId);

  // Consume stream normally
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
  console.log('\n');

  // Trace is automatically completed when stream ends
}

// === EXAMPLE 3: Anthropic ===
async function anthropicExample() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  const anthropic = raindrop.wrap(new Anthropic());

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Say hello!' }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  console.log('Response:', text);
  console.log('Trace ID:', response._traceId);
}

// === EXAMPLE 4: Vercel AI SDK ===
async function aiSdkExample() {
  const { openai } = await import('@ai-sdk/openai');
  const { generateText } = await import('ai');

  // Wrap the model, not the client
  const model = raindrop.wrap(openai('gpt-4o'));

  const result = await generateText({
    model,
    prompt: 'Say hello!',
  });

  console.log('Response:', result.text);
  // Note: For AI SDK, trace ID is on the model response
}

// === EXAMPLE 5: User Identification ===
async function userIdentificationExample() {
  const { default: OpenAI } = await import('openai');
  const openai = raindrop.wrap(new OpenAI());

  // Identify user globally
  raindrop.identify('user_123', {
    name: 'Jane Doe',
    email: 'jane@example.com',
    plan: 'pro',
  });

  // All subsequent calls will include this user
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'What is my account status?' }],
  });

  console.log('Response for user_123:', response.choices[0].message.content);
}

// === EXAMPLE 6: Conversation Threading ===
async function conversationExample() {
  const { default: OpenAI } = await import('openai');
  const openai = raindrop.wrap(new OpenAI());

  const conversationId = 'conv_' + Date.now();
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Turn 1
  messages.push({ role: 'user', content: 'My name is Alice' });
  const response1 = await openai.chat.completions.create(
    { model: 'gpt-4o', messages },
    { raindrop: { conversationId } }
  );
  messages.push({ role: 'assistant', content: response1.choices[0].message.content || '' });

  // Turn 2
  messages.push({ role: 'user', content: 'What is my name?' });
  const response2 = await openai.chat.completions.create(
    { model: 'gpt-4o', messages },
    { raindrop: { conversationId } }
  );

  console.log('Response:', response2.choices[0].message.content);
  console.log('Both traces linked to conversation:', conversationId);
}

// === COMPARISON: Old vs New ===
function showComparison() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                           BEFORE (Current Raindrop)                          ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  // 1. Complex OTEL setup in instrumentation.ts (15+ lines)                  ║
║  import { registerOTel, OTLPHttpProtoTraceExporter } from '@vercel/otel';    ║
║  import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';         ║
║                                                                              ║
║  export function register() {                                                ║
║    registerOTel({                                                            ║
║      serviceName: 'ai-chatbot',                                              ║
║      spanProcessors: [                                                       ║
║        new BatchSpanProcessor(                                               ║
║          new OTLPHttpProtoTraceExporter({                                    ║
║            url: 'https://api.raindrop.ai/v1/traces',                         ║
║            headers: { 'Authorization': \`Bearer \${...}\` },                   ║
║          }),                                                                 ║
║        ),                                                                    ║
║      ],                                                                      ║
║    });                                                                       ║
║  }                                                                           ║
║                                                                              ║
║  // 2. Add telemetry at EVERY call site (easy to forget!)                    ║
║  const result = await generateText({                                         ║
║    model: openai('gpt-4o'),                                                  ║
║    prompt: message,                                                          ║
║    experimental_telemetry: {                                                 ║
║      isEnabled: true,                                                        ║
║      functionId: 'chat',                                                     ║
║      metadata: { ...raindrop.metadata({ userId: 'user_123' }) },             ║
║    },                                                                        ║
║  });                                                                         ║
║                                                                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                            AFTER (New Raindrop SDK)                          ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  // 1. One-time init (2 lines!)                                              ║
║  const raindrop = new Raindrop({ apiKey: process.env.RAINDROP_API_KEY });    ║
║  const openai = raindrop.wrap(new OpenAI());                                 ║
║                                                                              ║
║  // 2. Use normally - everything auto-traced                                 ║
║  const result = await openai.chat.completions.create({                       ║
║    model: 'gpt-4o',                                                          ║
║    messages: [{ role: 'user', content: message }],                           ║
║  });                                                                         ║
║                                                                              ║
║  // That's it! Trace ID available: result._traceId                           ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);
}

// === RUN EXAMPLES ===
async function main() {
  showComparison();

  console.log('\n--- Running examples (mock mode) ---\n');

  // Note: These will fail without actual API keys, but demonstrate the API
  try {
    // await openaiExample();
    // await anthropicExample();
    // await aiSdkExample();
    console.log('Examples ready to run with actual API keys!');
  } catch (error) {
    console.log('(Expected: Install dependencies and set API keys to run)');
  }

  // Cleanup
  await raindrop.close();
}

main();
