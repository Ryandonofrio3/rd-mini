/**
 * Real Integration Test
 *
 * Run with actual API keys to validate the SDK works end-to-end:
 *
 *   RAINDROP_API_KEY=your_key OPENAI_API_KEY=your_key bun run examples/real-test.ts
 */

import { Raindrop } from '../src/index.js';

const RAINDROP_API_KEY = process.env.RAINDROP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!RAINDROP_API_KEY) {
  console.error('Missing RAINDROP_API_KEY');
  process.exit(1);
}

const raindrop = new Raindrop({
  apiKey: RAINDROP_API_KEY,
  debug: true, // See what's being sent
});

// Identify a test user
raindrop.identify('test_user_sdk_v2', {
  name: 'SDK Test User',
  email: 'test@example.com',
  plan: 'test',
});

async function testOpenAI() {
  if (!OPENAI_API_KEY) {
    console.log('⏭️  Skipping OpenAI test (no OPENAI_API_KEY)');
    return;
  }

  console.log('\n🧪 Testing OpenAI...');

  const { default: OpenAI } = await import('openai');
  const openai = raindrop.wrap(new OpenAI({ apiKey: OPENAI_API_KEY }));

  // Test 1: Basic completion
  console.log('\n  1. Basic completion...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini', // Cheaper for testing
    messages: [{ role: 'user', content: 'Say "Hello from Raindrop SDK v2 test!" in exactly those words.' }],
  });
  console.log('     Response:', response.choices[0].message.content);
  console.log('     Trace ID:', response._traceId);

  // Test 2: Send feedback
  console.log('\n  2. Sending feedback...');
  await raindrop.feedback(response._traceId, {
    type: 'thumbs_up',
    comment: 'SDK v2 test - this worked!',
  });
  console.log('     Feedback sent!');

  // Test 3: Streaming
  console.log('\n  3. Streaming completion...');
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
    stream: true,
  });
  console.log('     Stream Trace ID:', stream._traceId);
  process.stdout.write('     Response: ');
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
  console.log('\n     Stream complete!');

  // Test 4: Conversation threading
  console.log('\n  4. Conversation threading...');
  const convId = 'test_conv_' + Date.now();

  const msg1 = await openai.chat.completions.create(
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'My favorite color is blue. Remember that.' }],
    },
    { raindrop: { conversationId: convId } }
  );
  console.log('     Turn 1 trace:', msg1._traceId);

  const msg2 = await openai.chat.completions.create(
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'My favorite color is blue. Remember that.' },
        { role: 'assistant', content: msg1.choices[0].message.content || '' },
        { role: 'user', content: 'What is my favorite color?' },
      ],
    },
    { raindrop: { conversationId: convId } }
  );
  console.log('     Turn 2 trace:', msg2._traceId);
  console.log('     Response:', msg2.choices[0].message.content);
  console.log('     Both should be linked to conversation:', convId);

  console.log('\n✅ OpenAI tests complete!');
}

async function testAnthropic() {
  if (!ANTHROPIC_API_KEY) {
    console.log('⏭️  Skipping Anthropic test (no ANTHROPIC_API_KEY)');
    return;
  }

  console.log('\n🧪 Testing Anthropic...');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = raindrop.wrap(new Anthropic({ apiKey: ANTHROPIC_API_KEY }));

  // Test: Basic completion
  console.log('\n  1. Basic completion...');
  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022', // Cheaper for testing
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Say "Hello from Raindrop SDK v2 test!" in exactly those words.' }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  console.log('     Response:', text);
  console.log('     Trace ID:', response._traceId);

  // Test: Send feedback
  console.log('\n  2. Sending feedback...');
  await raindrop.feedback(response._traceId, {
    type: 'thumbs_up',
    comment: 'Anthropic SDK v2 test - this worked!',
  });
  console.log('     Feedback sent!');

  console.log('\n✅ Anthropic tests complete!');
}

async function main() {
  console.log('🚀 Raindrop SDK v2 - Real Integration Test\n');
  console.log('This will send REAL data to Raindrop. Check your dashboard!\n');
  console.log('─'.repeat(60));

  try {
    await testOpenAI();
    await testAnthropic();

    console.log('\n─'.repeat(60));
    console.log('\n🎉 All tests complete!');
    console.log('\n📊 Check your Raindrop dashboard to verify:');
    console.log('   1. Events appear with correct model/input/output');
    console.log('   2. Token counts are captured');
    console.log('   3. Latency is recorded');
    console.log('   4. Feedback is linked to traces');
    console.log('   5. Conversation threading works');
    console.log('   6. User identification shows up');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
  } finally {
    // Important: flush pending events
    console.log('\n⏳ Flushing events...');
    await raindrop.close();
    console.log('✅ Done!');
  }
}

main();
