/**
 * Integration tests for OpenAI wrapper
 *
 * These tests require real API keys:
 * - RAINDROP_API_KEY
 * - OPENAI_API_KEY
 *
 * Run: bun test tests/integration/
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Raindrop } from '../../src/index.js';

const RAINDROP_API_KEY = process.env.RAINDROP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const canRun = RAINDROP_API_KEY && OPENAI_API_KEY;

describe.skipIf(!canRun)('OpenAI Integration', () => {
  let raindrop: Raindrop;
  let openai: Awaited<ReturnType<typeof setupOpenAI>>;

  async function setupOpenAI() {
    const { default: OpenAI } = await import('openai');
    return raindrop.wrap(new OpenAI({ apiKey: OPENAI_API_KEY }));
  }

  beforeAll(async () => {
    raindrop = new Raindrop({
      apiKey: RAINDROP_API_KEY!,
      debug: false,
    });
    openai = await setupOpenAI();
  });

  afterAll(async () => {
    await raindrop.close();
  });

  describe('Non-streaming', () => {
    test('completes chat request and returns traceId', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "test" in one word.' }],
      });

      expect(response.choices[0].message.content).toBeDefined();
      expect(response._traceId).toMatch(/^trace_/);
    });

    test('includes token usage', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.usage).toBeDefined();
      expect(response.usage?.prompt_tokens).toBeGreaterThan(0);
      expect(response.usage?.completion_tokens).toBeGreaterThan(0);
    });

    test('handles tool calls', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location'],
              },
            },
          },
        ],
        tool_choice: 'auto',
      });

      expect(response.choices[0].message.tool_calls).toBeDefined();
      expect(response.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
      expect(response._traceId).toMatch(/^trace_/);
    });
  });

  describe('Streaming', () => {
    test('streams chat response and returns traceId', async () => {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Count 1 2 3' }],
        stream: true,
      });

      expect(stream._traceId).toMatch(/^trace_/);

      let content = '';
      for await (const chunk of stream) {
        content += chunk.choices[0]?.delta?.content || '';
      }

      expect(content).toContain('1');
      expect(content).toContain('2');
      expect(content).toContain('3');
    });

    test('streams tool calls', async () => {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Get weather in NYC' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: {
                type: 'object',
                properties: { location: { type: 'string' } },
                required: ['location'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        stream: true,
      });

      let toolName = '';
      for await (const chunk of stream) {
        const tc = chunk.choices[0]?.delta?.tool_calls?.[0];
        if (tc?.function?.name) toolName = tc.function.name;
      }

      expect(toolName).toBe('get_weather');
    });
  });

  describe('Context', () => {
    test('uses global userId from identify', async () => {
      raindrop.identify('integration_test_user', {
        name: 'Test User',
        email: 'test@example.com',
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response._traceId).toMatch(/^trace_/);
      // userId is sent to Raindrop - verify in dashboard
    });

    test('accepts per-request userId override', async () => {
      const response = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Hi' }],
        },
        {
          raindrop: { userId: 'override_user' },
        }
      );

      expect(response._traceId).toMatch(/^trace_/);
    });

    test('accepts conversationId', async () => {
      const conversationId = `conv_test_${Date.now()}`;

      const response1 = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'My name is Alice' }],
        },
        {
          raindrop: { conversationId },
        }
      );

      const response2 = await openai.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'user', content: 'My name is Alice' },
            { role: 'assistant', content: response1.choices[0].message.content || '' },
            { role: 'user', content: 'What is my name?' },
          ],
        },
        {
          raindrop: { conversationId },
        }
      );

      expect(response1._traceId).toMatch(/^trace_/);
      expect(response2._traceId).toMatch(/^trace_/);
      // Both should be linked by conversationId in dashboard
    });
  });

  describe('Error Handling', () => {
    test('captures error for invalid model', async () => {
      await expect(
        openai.chat.completions.create({
          model: 'invalid-model-name',
          messages: [{ role: 'user', content: 'test' }],
        })
      ).rejects.toThrow();

      // Error should be traced - verify in dashboard
      expect(raindrop.getLastTraceId()).toBeDefined();
    });
  });

  describe('Feedback', () => {
    test('sends thumbs up feedback', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Tell me a joke' }],
      });

      await raindrop.feedback(response._traceId, {
        type: 'thumbs_up',
        comment: 'Integration test - thumbs up',
      });

      // Feedback should appear in dashboard
    });

    test('sends thumbs down feedback', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      });

      await raindrop.feedback(response._traceId, {
        type: 'thumbs_down',
        comment: 'Integration test - thumbs down',
      });
    });

    test('sends numeric score', async () => {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Explain AI' }],
      });

      await raindrop.feedback(response._traceId, {
        score: 0.85,
        comment: 'Integration test - score 0.85',
      });
    });
  });
});

// Skip message if tests are skipped
if (!canRun) {
  console.log('Skipping OpenAI integration tests - missing API keys');
  console.log('Set RAINDROP_API_KEY and OPENAI_API_KEY to run');
}
