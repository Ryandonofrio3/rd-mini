/**
 * Unit tests for Transport
 * Tests batching, retry logic, and data formatting
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Transport } from '../../src/transport.js';

describe('Transport', () => {
  let transport: Transport;
  let fetchMock: ReturnType<typeof mock>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    transport = new Transport({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.test.com',
      debug: false,
      disabled: false,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('disabled mode', () => {
    test('does not send when disabled', async () => {
      const disabledTransport = new Transport({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.test.com',
        debug: false,
        disabled: true,
      });

      disabledTransport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      await disabledTransport.flush();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sendTrace', () => {
    test('queues trace and flushes', async () => {
      transport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        input: 'Hello',
        output: 'Hi there!',
        startTime: Date.now() - 100,
        endTime: Date.now(),
        latencyMs: 100,
        tokens: { input: 10, output: 5, total: 15 },
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.com/v1/events/track');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-api-key',
      });

      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(1);
      expect(body[0].event_id).toBe('trace_123');
      expect(body[0].ai_data.model).toBe('gpt-4o');
      expect(body[0].properties.input_tokens).toBe(10);
    });

    test('includes userId when provided', async () => {
      transport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
        userId: 'user_456',
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].user_id).toBe('user_456');
    });

    test('includes conversationId when provided', async () => {
      transport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
        conversationId: 'conv_789',
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].ai_data.convo_id).toBe('conv_789');
    });

    test('includes error when provided', async () => {
      transport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
        error: 'Something went wrong',
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].properties.error).toBe('Something went wrong');
    });

    test('includes tool calls as attachments', async () => {
      transport.sendTrace({
        traceId: 'trace_123',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
        toolCalls: [
          { name: 'get_weather', arguments: '{"location":"SF"}', result: '72F' },
        ],
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].attachments).toHaveLength(1);
      expect(body[0].attachments[0].name).toBe('tool:get_weather');
    });
  });

  describe('sendFeedback', () => {
    test('sends feedback with thumbs_up', async () => {
      transport.sendFeedback('trace_123', {
        type: 'thumbs_up',
        comment: 'Great response!',
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.com/v1/signals/track');

      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(1);
      expect(body[0].event_id).toBe('trace_123');
      expect(body[0].signal_name).toBe('thumbs_up');
      expect(body[0].sentiment).toBe('POSITIVE');
      expect(body[0].properties.comment).toBe('Great response!');
    });

    test('sends feedback with thumbs_down', async () => {
      transport.sendFeedback('trace_123', {
        type: 'thumbs_down',
        comment: 'Not helpful',
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].sentiment).toBe('NEGATIVE');
    });

    test('sends feedback with score', async () => {
      transport.sendFeedback('trace_123', {
        score: 0.75,
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].sentiment).toBe('POSITIVE'); // 0.75 >= 0.5
      expect(body[0].properties.score).toBe(0.75);
    });

    test('sends feedback with low score as negative', async () => {
      transport.sendFeedback('trace_123', {
        score: 0.3,
      });

      await transport.flush();

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body[0].sentiment).toBe('NEGATIVE'); // 0.3 < 0.5
    });
  });

  describe('sendIdentify', () => {
    test('sends identify request', async () => {
      transport.sendIdentify('user_123', {
        name: 'Test User',
        email: 'test@example.com',
        plan: 'pro',
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.com/v1/users/identify');

      const body = JSON.parse(options.body as string);
      expect(body.user_id).toBe('user_123');
      expect(body.traits.name).toBe('Test User');
      expect(body.traits.email).toBe('test@example.com');
    });
  });

  describe('sendInteraction', () => {
    test('sends interaction with spans', async () => {
      transport.sendInteraction({
        interactionId: 'int_123',
        userId: 'user_456',
        event: 'rag_query',
        input: 'What is X?',
        output: 'X is...',
        startTime: Date.now() - 500,
        endTime: Date.now(),
        latencyMs: 500,
        spans: [
          {
            spanId: 'span_1',
            parentId: 'int_123',
            name: 'search_docs',
            type: 'tool',
            startTime: Date.now() - 400,
            endTime: Date.now() - 300,
            latencyMs: 100,
            input: 'What is X?',
            output: [{ title: 'Doc 1' }],
          },
        ],
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test.com/v1/events/track');

      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(1);
      expect(body[0].event_id).toBe('int_123');
      expect(body[0].event).toBe('rag_query');
      expect(body[0].ai_data.input).toBe('What is X?');
      expect(body[0].ai_data.output).toBe('X is...');
      expect(body[0].attachments).toHaveLength(1);
      expect(body[0].attachments[0].name).toBe('tool:search_docs');
    });
  });

  describe('batching', () => {
    test('batches multiple traces', async () => {
      transport.sendTrace({
        traceId: 'trace_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      transport.sendTrace({
        traceId: 'trace_2',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(2);
    });

    test('separates events by endpoint', async () => {
      transport.sendTrace({
        traceId: 'trace_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      transport.sendFeedback('trace_1', { type: 'thumbs_up' });

      await transport.flush();

      // Should be 2 calls - one to /events/track, one to /signals/track
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const calls = fetchMock.mock.calls as [string, RequestInit][];
      const urls = calls.map(([url]) => url);
      expect(urls).toContain('https://api.test.com/v1/events/track');
      expect(urls).toContain('https://api.test.com/v1/signals/track');
    });
  });

  describe('retry logic', () => {
    test('retries on failure', async () => {
      let callCount = 0;
      fetchMock = mock(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(new Response('Error', { status: 500 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      });
      global.fetch = fetchMock as unknown as typeof global.fetch;

      transport.sendTrace({
        traceId: 'trace_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      await transport.flush();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('gives up after max retries', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Error', { status: 500 }))
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      transport.sendTrace({
        traceId: 'trace_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      await transport.flush();

      // 1 initial + 3 retries = 4 calls max
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    });
  });

  describe('close', () => {
    test('flushes on close', async () => {
      transport.sendTrace({
        traceId: 'trace_1',
        provider: 'openai',
        model: 'gpt-4o',
        startTime: Date.now(),
        endTime: Date.now(),
        latencyMs: 100,
      });

      await transport.close();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
