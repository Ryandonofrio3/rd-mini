/**
 * Unit tests for Raindrop core functionality
 * These tests run without API keys using mocked transport
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { Raindrop } from '../../src/raindrop.js';

describe('Raindrop', () => {
  let raindrop: Raindrop;

  beforeEach(() => {
    raindrop = new Raindrop({
      apiKey: 'test-api-key',
      debug: false,
    });
  });

  describe('constructor', () => {
    test('initializes with required config', () => {
      const rd = new Raindrop({ apiKey: 'test-key' });
      expect(rd).toBeInstanceOf(Raindrop);
    });

    test('accepts custom baseUrl', () => {
      const rd = new Raindrop({
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com',
      });
      expect(rd).toBeInstanceOf(Raindrop);
    });

    test('accepts debug flag', () => {
      const rd = new Raindrop({
        apiKey: 'test-key',
        debug: true,
      });
      expect(rd).toBeInstanceOf(Raindrop);
    });

    test('accepts disabled flag', () => {
      const rd = new Raindrop({
        apiKey: 'test-key',
        disabled: true,
      });
      expect(rd).toBeInstanceOf(Raindrop);
    });
  });

  describe('identify', () => {
    test('sets current user', () => {
      raindrop.identify('user_123');
      // Can't directly access currentUserId, but we can verify via getUserTraits
      expect(raindrop.getUserTraits()).toBeUndefined();
    });

    test('sets user with traits', () => {
      const traits = { name: 'Test User', email: 'test@example.com' };
      raindrop.identify('user_123', traits);
      expect(raindrop.getUserTraits()).toEqual(traits);
    });
  });

  describe('getLastTraceId', () => {
    test('returns undefined initially', () => {
      expect(raindrop.getLastTraceId()).toBeUndefined();
    });
  });

  describe('begin / finish interaction', () => {
    test('creates interaction with auto-generated ID', () => {
      const interaction = raindrop.begin({ event: 'test' });
      expect(interaction.id).toMatch(/^trace_/);
    });

    test('creates interaction with custom event ID', () => {
      const interaction = raindrop.begin({
        eventId: 'custom_event_id',
        event: 'test',
      });
      expect(interaction.id).toBe('custom_event_id');
    });

    test('interaction allows setting output', () => {
      const interaction = raindrop.begin({ event: 'test' });
      interaction.output = 'test output';
      expect(interaction.output).toBe('test output');
    });

    test('interaction allows setting properties', () => {
      const interaction = raindrop.begin({ event: 'test' });
      interaction.setProperty('key1', 'value1');
      interaction.setProperties({ key2: 'value2', key3: 123 });

      const ctx = interaction.getContext();
      expect(ctx.properties).toEqual({
        key1: 'value1',
        key2: 'value2',
        key3: 123,
      });
    });

    test('interaction allows setting input', () => {
      const interaction = raindrop.begin({ event: 'test' });
      interaction.setInput('new input');

      const ctx = interaction.getContext();
      expect(ctx.input).toBe('new input');
    });

    test('interaction allows adding attachments', () => {
      const interaction = raindrop.begin({ event: 'test' });
      interaction.addAttachments([
        { type: 'code', value: 'console.log("hello")', language: 'javascript' },
      ]);

      const ctx = interaction.getContext();
      expect(ctx.attachments).toHaveLength(1);
      expect(ctx.attachments![0].type).toBe('code');
    });

    test('finish can be called with options', () => {
      const interaction = raindrop.begin({ event: 'test' });
      // Should not throw
      interaction.finish({
        output: 'final output',
        properties: { final: true },
      });
    });

    test('finish can only be called once', () => {
      const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

      const interaction = raindrop.begin({ event: 'test' });
      interaction.finish();
      interaction.finish(); // Should warn

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('resumeInteraction', () => {
    test('returns existing interaction', () => {
      const original = raindrop.begin({ eventId: 'resume_test', event: 'test' });
      const resumed = raindrop.resumeInteraction('resume_test');
      expect(resumed.id).toBe(original.id);
    });

    test('creates new interaction if not found', () => {
      const interaction = raindrop.resumeInteraction('nonexistent_id');
      expect(interaction.id).toBe('nonexistent_id');
    });
  });

  describe('withInteraction', () => {
    test('runs function and returns result', async () => {
      const result = await raindrop.withInteraction(
        { event: 'test', input: 'test input' },
        async () => {
          return 'test result';
        }
      );
      expect(result).toBe('test result');
    });

    test('captures string return as output', async () => {
      await raindrop.withInteraction(
        { event: 'test' },
        async () => 'string output'
      );
      // Output is sent to transport - can't easily verify without mocking
    });

    test('allows setting output via context', async () => {
      await raindrop.withInteraction(
        { event: 'test' },
        async (ctx) => {
          ctx.output = 'explicit output';
          return { someData: true };
        }
      );
    });

    test('captures errors and rethrows', async () => {
      const error = new Error('Test error');

      await expect(
        raindrop.withInteraction(
          { event: 'test' },
          async () => {
            throw error;
          }
        )
      ).rejects.toThrow('Test error');
    });

    test('uses provided userId over global', async () => {
      raindrop.identify('global_user');

      await raindrop.withInteraction(
        { event: 'test', userId: 'override_user' },
        async (ctx) => {
          expect(ctx.userId).toBe('override_user');
        }
      );
    });
  });

  describe('wrapTool', () => {
    test('wraps function and returns result', async () => {
      const myTool = raindrop.wrapTool('my_tool', async (x: number) => x * 2);
      const result = await myTool(5);
      expect(result).toBe(10);
    });

    test('wraps function with multiple args', async () => {
      const add = raindrop.wrapTool('add', async (a: number, b: number) => a + b);
      const result = await add(3, 4);
      expect(result).toBe(7);
    });

    test('captures errors from tool', async () => {
      const failingTool = raindrop.wrapTool('failing', async () => {
        throw new Error('Tool failed');
      });

      await expect(failingTool()).rejects.toThrow('Tool failed');
    });

    test('tool works within withInteraction', async () => {
      const searchDocs = raindrop.wrapTool('search', async (query: string) => {
        return [{ title: 'Doc 1' }, { title: 'Doc 2' }];
      });

      const result = await raindrop.withInteraction(
        { event: 'rag', input: 'test query' },
        async () => {
          const docs = await searchDocs('test query');
          return docs.length;
        }
      );

      expect(result).toBe(2);
    });
  });

  describe('close', () => {
    test('closes without error', async () => {
      await expect(raindrop.close()).resolves.toBeUndefined();
    });
  });
});

describe('Provider Detection', () => {
  let raindrop: Raindrop;

  beforeEach(() => {
    raindrop = new Raindrop({ apiKey: 'test-key' });
  });

  test('detects OpenAI client structure', () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: () => {},
        },
      },
    };

    // wrap() should not throw for OpenAI-like structure
    const wrapped = raindrop.wrap(mockOpenAI);
    expect(wrapped).toBeDefined();
  });

  test('detects Anthropic client structure', () => {
    const mockAnthropic = {
      messages: {
        create: () => {},
      },
    };

    const wrapped = raindrop.wrap(mockAnthropic);
    expect(wrapped).toBeDefined();
  });

  test('detects AI SDK model structure', () => {
    const mockAISDK = {
      modelId: 'gpt-4o',
      provider: 'openai',
    };

    const wrapped = raindrop.wrap(mockAISDK);
    expect(wrapped).toBeDefined();
  });

  test('handles unknown client gracefully', () => {
    const unknownClient = { foo: 'bar' };
    const wrapped = raindrop.wrap(unknownClient);
    expect(wrapped).toBe(unknownClient); // Returns as-is
  });

  test('handles null/undefined gracefully', () => {
    expect(raindrop.wrap(null as any)).toBeNull();
    expect(raindrop.wrap(undefined as any)).toBeUndefined();
  });
});
