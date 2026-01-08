#!/usr/bin/env bun
/**
 * Smoke Test - Verify SDK works end-to-end with real APIs
 *
 * Run: bun run scripts/smoke-test.ts
 *
 * This script tests all major features and outputs results.
 * After running, manually verify traces appear in the Raindrop dashboard.
 */

import { Raindrop } from '../src/index.js';
import OpenAI from 'openai';

// ============================================
// Config
// ============================================

const RAINDROP_API_KEY = process.env.RAINDROP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!RAINDROP_API_KEY || !OPENAI_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('  RAINDROP_API_KEY:', RAINDROP_API_KEY ? '✓' : '✗');
  console.error('  OPENAI_API_KEY:', OPENAI_API_KEY ? '✓' : '✗');
  process.exit(1);
}

// ============================================
// Helpers
// ============================================

const results: Array<{ test: string; status: 'PASS' | 'FAIL'; traceId?: string; error?: string }> = [];

function log(message: string) {
  console.log(`\n${'='.repeat(60)}\n${message}\n${'='.repeat(60)}`);
}

function pass(test: string, traceId?: string) {
  results.push({ test, status: 'PASS', traceId });
  console.log(`  ✓ ${test}${traceId ? ` (${traceId})` : ''}`);
}

function fail(test: string, error: string) {
  results.push({ test, status: 'FAIL', error });
  console.log(`  ✗ ${test}: ${error}`);
}

// ============================================
// Tests
// ============================================

async function main() {
  console.log('\n🧪 RAINDROP SDK SMOKE TEST\n');
  console.log('API Key:', RAINDROP_API_KEY?.slice(0, 8) + '...');
  console.log('Timestamp:', new Date().toISOString());
  console.log('');

  // Initialize
  const raindrop = new Raindrop({
    apiKey: RAINDROP_API_KEY,
    debug: true,  // Show all sends
  });

  const openai = raindrop.wrap(new OpenAI({ apiKey: OPENAI_API_KEY }));

  try {
    // ------------------------------------------
    log('TEST 1: Basic Chat Completion');
    // ------------------------------------------
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "smoke test successful" in exactly 3 words.' }],
      });

      if (response._traceId && response.choices[0]?.message?.content) {
        pass('Non-streaming chat completion', response._traceId);
        console.log(`    Response: "${response.choices[0].message.content}"`);
        console.log(`    Tokens: ${response.usage?.total_tokens || 'N/A'}`);
      } else {
        fail('Non-streaming chat completion', 'Missing traceId or content');
      }
    } catch (e) {
      fail('Non-streaming chat completion', String(e));
    }

    // ------------------------------------------
    log('TEST 2: Streaming Chat Completion');
    // ------------------------------------------
    try {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
        stream: true,
      });

      if (stream._traceId) {
        pass('Stream has traceId immediately', stream._traceId);
      } else {
        fail('Stream has traceId immediately', 'Missing _traceId on stream');
      }

      let content = '';
      for await (const chunk of stream) {
        content += chunk.choices[0]?.delta?.content || '';
      }

      if (content.includes('1') && content.includes('5')) {
        pass('Stream content received');
        console.log(`    Content: "${content.slice(0, 50)}..."`);
      } else {
        fail('Stream content received', 'Missing expected numbers');
      }
    } catch (e) {
      fail('Streaming chat completion', String(e));
    }

    // ------------------------------------------
    log('TEST 3: Tool Calls');
    // ------------------------------------------
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        }],
        tool_choice: 'auto',
      });

      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (toolCall?.function?.name === 'get_weather') {
        pass('Tool call extracted', response._traceId);
        console.log(`    Tool: ${toolCall.function.name}`);
        console.log(`    Args: ${toolCall.function.arguments}`);
      } else {
        fail('Tool call extracted', 'No tool call in response');
      }
    } catch (e) {
      fail('Tool calls', String(e));
    }

    // ------------------------------------------
    log('TEST 4: User Identification');
    // ------------------------------------------
    try {
      const testUserId = `smoke_test_${Date.now()}`;
      raindrop.identify(testUserId, {
        name: 'Smoke Test User',
        email: 'smoke@test.com',
        plan: 'enterprise',
      });
      pass('User identified');
      console.log(`    User ID: ${testUserId}`);
    } catch (e) {
      fail('User identification', String(e));
    }

    // ------------------------------------------
    log('TEST 5: Conversation Threading');
    // ------------------------------------------
    try {
      const conversationId = `smoke_convo_${Date.now()}`;

      const msg1 = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Remember the word "elephant".' }],
        },
        { raindrop: { conversationId } }
      );

      const msg2 = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'user', content: 'Remember the word "elephant".' },
            { role: 'assistant', content: msg1.choices[0].message.content || '' },
            { role: 'user', content: 'What word did I ask you to remember?' },
          ],
        },
        { raindrop: { conversationId } }
      );

      pass('Conversation threading');
      console.log(`    Conversation ID: ${conversationId}`);
      console.log(`    Message 1: ${msg1._traceId}`);
      console.log(`    Message 2: ${msg2._traceId}`);
    } catch (e) {
      fail('Conversation threading', String(e));
    }

    // ------------------------------------------
    log('TEST 6: Feedback / Signals');
    // ------------------------------------------
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Tell me a one-liner joke.' }],
      });

      raindrop.feedback(response._traceId, {
        type: 'thumbs_up',
        comment: 'Smoke test - feedback works!',
      });

      pass('Feedback sent', response._traceId);
      console.log(`    Type: thumbs_up`);
      console.log(`    Linked to: ${response._traceId}`);
    } catch (e) {
      fail('Feedback', String(e));
    }

    // ------------------------------------------
    log('TEST 7: Interaction with Spans');
    // ------------------------------------------
    try {
      const interactionId = await raindrop.withInteraction(
        {
          event: 'smoke_test_rag',
          input: 'Test query for smoke test',
        },
        async (ctx) => {
          // Simulate a tool call
          const searchResults = await raindrop.wrapTool(
            'search_docs',
            async (query: string) => {
              // Fake search
              return [{ title: 'Doc 1', content: 'Relevant content' }];
            }
          )('test query');

          // AI call within interaction
          const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Summarize: ' + JSON.stringify(searchResults) }],
          });

          ctx.output = response.choices[0].message.content || '';

          return ctx.interactionId;
        }
      );

      pass('Interaction with spans');
      console.log(`    Interaction ID: ${interactionId}`);
      console.log(`    Event: smoke_test_rag`);
    } catch (e) {
      fail('Interaction with spans', String(e));
    }

    // ------------------------------------------
    log('TEST 8: Begin/Finish Pattern');
    // ------------------------------------------
    try {
      const interaction = raindrop.begin({
        event: 'smoke_test_manual',
        input: 'Manual interaction test',
      });

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 100));

      interaction.output = 'Manual interaction completed';
      interaction.finish();

      pass('Begin/finish pattern');
      console.log(`    Interaction ID: ${interaction.id}`);
    } catch (e) {
      fail('Begin/finish pattern', String(e));
    }

    // ------------------------------------------
    log('TEST 9: Error Handling');
    // ------------------------------------------
    try {
      await openai.chat.completions.create({
        model: 'not-a-real-model',
        messages: [{ role: 'user', content: 'test' }],
      });
      fail('Error handling', 'Expected error to be thrown');
    } catch (e) {
      const lastTraceId = raindrop.getLastTraceId();
      if (lastTraceId) {
        pass('Error traced', lastTraceId);
        console.log(`    Error: ${String(e).slice(0, 60)}...`);
      } else {
        fail('Error handling', 'Error not traced');
      }
    }

    // ------------------------------------------
    log('TEST 10: Flush & Close');
    // ------------------------------------------
    try {
      await raindrop.flush();
      pass('Flush completed');

      await raindrop.close();
      pass('Close completed');
    } catch (e) {
      fail('Flush/close', String(e));
    }

  } catch (e) {
    console.error('\n\nFATAL ERROR:', e);
    process.exit(1);
  }

  // ------------------------------------------
  // Summary
  // ------------------------------------------
  log('SUMMARY');

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\n  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${results.length}`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`    - ${r.test}: ${r.error}`);
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log('NEXT STEPS:');
  console.log('='.repeat(60));
  console.log('\n1. Open Raindrop dashboard');
  console.log('2. Verify these traces appear within 30 seconds:');
  results.filter((r) => r.traceId).forEach((r) => {
    console.log(`   - ${r.traceId} (${r.test})`);
  });
  console.log('\n3. Check:');
  console.log('   - [ ] Input/output content visible');
  console.log('   - [ ] Token counts displayed');
  console.log('   - [ ] User identified correctly');
  console.log('   - [ ] Conversation traces grouped');
  console.log('   - [ ] Feedback appears on trace');
  console.log('   - [ ] Spans visible in interaction');
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main();
