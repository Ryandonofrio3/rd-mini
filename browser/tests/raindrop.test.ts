/**
 * Unit tests for Browser SDK
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Raindrop } from '../src/index.js';

describe('Raindrop Browser SDK', () => {
  let raindrop: Raindrop;
  let fetchMock: ReturnType<typeof mock>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    raindrop = new Raindrop({
      apiKey: 'test-api-key',
      debug: false,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
  });

  describe('trackAi', () => {
    test('sends AI event to correct endpoint', async () => {
      const result = await raindrop.trackAi({
        event: 'chat',
        userId: 'user_123',
        model: 'gpt-4o',
        input: 'Hello',
        output: 'Hi there!',
      });

      expect(result.eventIds).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/events/track');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-api-key',
      });

      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(1);
      expect(body[0].event).toBe('chat');
      expect(body[0].user_id).toBe('user_123');
      expect(body[0].ai_data.model).toBe('gpt-4o');
      expect(body[0].ai_data.input).toBe('Hello');
      expect(body[0].ai_data.output).toBe('Hi there!');
    });

    test('uses provided eventId', async () => {
      const result = await raindrop.trackAi({
        eventId: 'custom_event_id',
        event: 'chat',
      });

      expect(result.eventIds[0]).toBe('custom_event_id');
    });

    test('generates eventId if not provided', async () => {
      const result = await raindrop.trackAi({ event: 'chat' });
      expect(result.eventIds[0]).toBeDefined();
      expect(typeof result.eventIds[0]).toBe('string');
    });

    test('includes convoId when provided', async () => {
      await raindrop.trackAi({
        event: 'chat',
        convoId: 'conv_123',
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].ai_data.convo_id).toBe('conv_123');
    });

    test('includes properties when provided', async () => {
      await raindrop.trackAi({
        event: 'chat',
        properties: { custom: 'value', count: 42 },
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].properties.custom).toBe('value');
      expect(body[0].properties.count).toBe(42);
    });

    test('includes attachments when provided', async () => {
      await raindrop.trackAi({
        event: 'chat',
        attachments: [
          { type: 'code', value: 'console.log("hello")', role: 'output', language: 'javascript' },
        ],
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].attachments).toHaveLength(1);
      expect(body[0].attachments[0].type).toBe('code');
    });
  });

  describe('trackAiPartial', () => {
    test('creates partial event and allows finishing', async () => {
      const partial = await raindrop.trackAiPartial({
        eventId: 'partial_123',
        event: 'chat',
        model: 'gpt-4o',
        input: 'Hello',
      });

      expect(partial.eventId).toBe('partial_123');
      expect(typeof partial.finish).toBe('function');

      // Finish should send the event
      const result = await partial.finish({ output: 'Final output' });
      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('accumulates output across updates', async () => {
      await raindrop.trackAiPartial({
        eventId: 'stream_123',
        event: 'chat',
        input: 'Hello',
      });

      await raindrop.trackAiPartial({
        eventId: 'stream_123',
        output: 'First chunk',
      });

      const partial = await raindrop.trackAiPartial({
        eventId: 'stream_123',
        output: ' second chunk',
      });

      await partial.finish();

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].ai_data.output).toBe('First chunk second chunk');
    });

    test('finish can override output', async () => {
      const partial = await raindrop.trackAiPartial({
        eventId: 'override_123',
        event: 'chat',
        output: 'Partial output',
      });

      await partial.finish({ output: 'Final complete output' });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].ai_data.output).toBe('Final complete output');
    });

    test('handles non-existent partial gracefully', async () => {
      const partial = await raindrop.trackAiPartial({
        eventId: 'temp_123',
        event: 'chat',
      });

      // Finish it
      await partial.finish();

      // Now create a new "partial" that references the same ID (already finished)
      const newRd = new Raindrop({ apiKey: 'test' });
      (global.fetch as any) = fetchMock;

      const fakePartial = await newRd.trackAiPartial({
        eventId: 'nonexistent',
        event: 'chat',
      });

      // Finish the new one - should work since it just creates a new partial
      const result = await fakePartial.finish();
      expect(result.success).toBe(true);
    });
  });

  describe('trackSignal', () => {
    test('sends signal to correct endpoint', async () => {
      const result = await raindrop.trackSignal({
        eventId: 'evt_123',
        name: 'thumbs_up',
        sentiment: 'POSITIVE',
        type: 'feedback',
      });

      expect(result.success).toBe(true);

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/signals/track');

      const body = JSON.parse(options.body as string);
      expect(body[0].event_id).toBe('evt_123');
      expect(body[0].signal_name).toBe('thumbs_up');
      expect(body[0].sentiment).toBe('POSITIVE');
      expect(body[0].signal_type).toBe('feedback');
    });

    test('includes comment when provided', async () => {
      await raindrop.trackSignal({
        eventId: 'evt_123',
        name: 'thumbs_up',
        comment: 'Great response!',
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].properties.comment).toBe('Great response!');
    });

    test('includes after for edit signals', async () => {
      await raindrop.trackSignal({
        eventId: 'evt_123',
        name: 'edit',
        type: 'edit',
        after: 'Corrected response text',
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].properties.after).toBe('Corrected response text');
    });
  });

  describe('feedback', () => {
    test('sends thumbs_up feedback', async () => {
      await raindrop.feedback('trace_123', {
        type: 'thumbs_up',
        comment: 'Great!',
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].signal_name).toBe('thumbs_up');
      expect(body[0].sentiment).toBe('POSITIVE');
      expect(body[0].properties.comment).toBe('Great!');
    });

    test('sends thumbs_down feedback', async () => {
      await raindrop.feedback('trace_123', {
        type: 'thumbs_down',
        comment: 'Not helpful',
      });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].signal_name).toBe('thumbs_down');
      expect(body[0].sentiment).toBe('NEGATIVE');
    });

    test('sends feedback with score >= 0.5 as positive', async () => {
      await raindrop.feedback('trace_123', { score: 0.75 });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].signal_name).toBe('thumbs_up');
      expect(body[0].sentiment).toBe('POSITIVE');
    });

    test('sends feedback with score < 0.5 as negative', async () => {
      await raindrop.feedback('trace_123', { score: 0.3 });

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body[0].signal_name).toBe('thumbs_down');
      expect(body[0].sentiment).toBe('NEGATIVE');
    });
  });

  describe('identify', () => {
    test('sends single user identification', async () => {
      const result = await raindrop.identify({
        userId: 'user_123',
        traits: { name: 'Test User', email: 'test@example.com' },
      });

      expect(result.success).toBe(true);

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/users/identify');

      const body = JSON.parse(options.body as string);
      expect(body).toHaveLength(1);
      expect(body[0].user_id).toBe('user_123');
      expect(body[0].traits.name).toBe('Test User');
    });

    test('sends batch user identification', async () => {
      const result = await raindrop.identify([
        { userId: 'user_1', traits: { plan: 'free' } },
        { userId: 'user_2', traits: { plan: 'pro' } },
      ]);

      expect(result.success).toBe(true);

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body).toHaveLength(2);
      expect(body[0].user_id).toBe('user_1');
      expect(body[1].user_id).toBe('user_2');
    });

    test('sets current user for subsequent calls', async () => {
      await raindrop.identify({ userId: 'global_user' });

      // Now trackAi should use this userId
      await raindrop.trackAi({ event: 'chat' });

      const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      expect(body[0].user_id).toBe('global_user');
    });
  });

  describe('error handling', () => {
    test('handles fetch errors gracefully', async () => {
      fetchMock = mock(() => Promise.reject(new Error('Network error')));
      global.fetch = fetchMock as unknown as typeof global.fetch;

      // Should not throw
      const result = await raindrop.trackAi({ event: 'chat' });
      expect(result.eventIds).toHaveLength(1);
    });

    test('handles non-ok response gracefully', async () => {
      fetchMock = mock(() =>
        Promise.resolve(new Response('Error', { status: 500 }))
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      // Should not throw
      const result = await raindrop.trackAi({ event: 'chat' });
      expect(result.eventIds).toHaveLength(1);
    });
  });
});
