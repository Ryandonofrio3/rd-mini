/**
 * Unit tests for Gemini and Bedrock wrappers
 * These tests run without API keys using mocked clients
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Raindrop } from '../../src/raindrop.js';

// ============================================
// Mock Gemini Client
// ============================================

class MockGeminiResponse {
  text = 'Hello from Gemini!';
  candidates = [
    {
      content: {
        parts: [{ text: 'Hello from Gemini!' }],
      },
    },
  ];
  usageMetadata = {
    promptTokenCount: 10,
    candidatesTokenCount: 20,
    totalTokenCount: 30,
  };
  _traceId?: string;
}

class MockGeminiStream {
  private chunks = ['Hello', ' from', ' Gemini', '!'];
  private index = 0;
  _traceId?: string;

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.index >= this.chunks.length) {
          return { done: true, value: undefined };
        }
        const chunk = {
          text: this.chunks[this.index],
          candidates: [{ content: { parts: [{ text: this.chunks[this.index] }] } }],
          usageMetadata:
            this.index === this.chunks.length - 1
              ? { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
              : undefined,
        };
        this.index++;
        return { done: false, value: chunk };
      },
    };
  }
}

class MockGeminiModels {
  calls: unknown[] = [];

  generateContent = async (params: unknown) => {
    this.calls.push({ method: 'generateContent', params });
    return new MockGeminiResponse();
  };

  generateContentStream = async (params: unknown) => {
    this.calls.push({ method: 'generateContentStream', params });
    return new MockGeminiStream();
  };
}

class MockGeminiClient {
  models = new MockGeminiModels();
}

// ============================================
// Mock Bedrock Client
// ============================================

class MockConverseCommand {
  input: {
    modelId: string;
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };

  constructor(input: {
    modelId: string;
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  }) {
    this.input = input;
  }

  static get name() {
    return 'ConverseCommand';
  }
}

class MockConverseStreamCommand {
  input: {
    modelId: string;
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  };

  constructor(input: {
    modelId: string;
    messages: Array<{ role: string; content: Array<{ text?: string }> }>;
  }) {
    this.input = input;
  }

  static get name() {
    return 'ConverseStreamCommand';
  }
}

// Make constructor name work properly
Object.defineProperty(MockConverseCommand.prototype.constructor, 'name', {
  value: 'ConverseCommand',
});
Object.defineProperty(MockConverseStreamCommand.prototype.constructor, 'name', {
  value: 'ConverseStreamCommand',
});

class MockBedrockStream {
  private events = [
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0 } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' from' } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' Bedrock!' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 } } },
  ];
  private index = 0;

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.index >= this.events.length) {
          return { done: true, value: undefined };
        }
        const event = this.events[this.index];
        this.index++;
        return { done: false, value: event };
      },
    };
  }
}

class MockBedrockClient {
  calls: unknown[] = [];

  send = async (command: MockConverseCommand | MockConverseStreamCommand) => {
    const commandName = command.constructor.name;
    this.calls.push({ command: commandName, input: command.input });

    if (commandName === 'ConverseStreamCommand') {
      return {
        stream: new MockBedrockStream(),
        _traceId: undefined as string | undefined,
      };
    }

    return {
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello from Bedrock!' }],
        },
      },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 15,
        totalTokens: 25,
      },
      _traceId: undefined as string | undefined,
    };
  };
}

// ============================================
// Tests
// ============================================

describe('Gemini Wrapper', () => {
  let raindrop: Raindrop;
  let mockClient: MockGeminiClient;

  beforeEach(() => {
    raindrop = new Raindrop({
      apiKey: 'test-api-key',
      disabled: true, // Disable actual API calls
      debug: false,
    });
    mockClient = new MockGeminiClient();
  });

  describe('detection', () => {
    test('detects Gemini client by models.generateContent', () => {
      const wrapped = raindrop.wrap(mockClient);
      expect(wrapped).toBeDefined();
      expect(wrapped.models).toBeDefined();
      expect(wrapped.models.generateContent).toBeDefined();
    });
  });

  describe('generateContent', () => {
    test('traces non-streaming call', async () => {
      const wrapped = raindrop.wrap(mockClient);

      const response = await wrapped.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: 'Hello!',
      });

      expect(response.text).toBe('Hello from Gemini!');
      expect(response._traceId).toBeDefined();
      expect(response._traceId).toMatch(/^trace_/);
    });

    test('captures model and contents', async () => {
      const wrapped = raindrop.wrap(mockClient);

      await wrapped.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: 'Test prompt',
      });

      expect(mockClient.models.calls).toHaveLength(1);
      expect(mockClient.models.calls[0]).toEqual({
        method: 'generateContent',
        params: { model: 'gemini-2.0-flash', contents: 'Test prompt' },
      });
    });

    test('passes raindrop options', async () => {
      const wrapped = raindrop.wrap(mockClient);

      const response = await wrapped.models.generateContent(
        {
          model: 'gemini-2.0-flash',
          contents: 'Hello!',
        },
        {
          raindrop: {
            userId: 'user_123',
            conversationId: 'conv_456',
          },
        }
      );

      expect(response._traceId).toBeDefined();
    });
  });

  describe('generateContentStream', () => {
    test('traces streaming call', async () => {
      const wrapped = raindrop.wrap(mockClient);

      const stream = await wrapped.models.generateContentStream({
        model: 'gemini-2.0-flash',
        contents: 'Write a poem',
      });

      expect(stream._traceId).toBeDefined();
      expect(stream._traceId).toMatch(/^trace_/);

      // Consume stream
      const chunks: string[] = [];
      for await (const chunk of stream) {
        if (chunk.text) chunks.push(chunk.text);
      }

      expect(chunks.join('')).toBe('Hello from Gemini!');
    });
  });
});

describe('Bedrock Wrapper', () => {
  let raindrop: Raindrop;
  let mockClient: MockBedrockClient;

  beforeEach(() => {
    raindrop = new Raindrop({
      apiKey: 'test-api-key',
      disabled: true,
      debug: false,
    });
    mockClient = new MockBedrockClient();
  });

  describe('detection', () => {
    test('detects Bedrock client by constructor name pattern', () => {
      // Create a mock with BedrockRuntimeClient-like name
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const client = new BedrockRuntimeClient();

      const wrapped = raindrop.wrap(client);
      expect(wrapped).toBeDefined();
      expect(wrapped.send).toBeDefined();
    });
  });

  describe('ConverseCommand', () => {
    test('traces non-streaming Converse call', async () => {
      // Use a class with Bedrock in the name for detection
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const client = new BedrockRuntimeClient();
      const wrapped = raindrop.wrap(client);

      const command = new MockConverseCommand({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
      });

      const response = await wrapped.send(command);

      expect(response.output?.message?.content?.[0]?.text).toBe('Hello from Bedrock!');
      expect(response._traceId).toBeDefined();
      expect(response._traceId).toMatch(/^trace_/);
    });

    test('captures model ID and messages', async () => {
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const client = new BedrockRuntimeClient();
      const wrapped = raindrop.wrap(client);

      const command = new MockConverseCommand({
        modelId: 'meta.llama3-70b-instruct-v1:0',
        messages: [{ role: 'user', content: [{ text: 'Test' }] }],
      });

      await wrapped.send(command);

      expect(mockClient.calls).toHaveLength(1);
      expect((mockClient.calls[0] as any).input.modelId).toBe('meta.llama3-70b-instruct-v1:0');
    });
  });

  describe('ConverseStreamCommand', () => {
    test('traces streaming Converse call', async () => {
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const client = new BedrockRuntimeClient();
      const wrapped = raindrop.wrap(client);

      const command = new MockConverseStreamCommand({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: [{ text: 'Write a poem' }] }],
      });

      const response = await wrapped.send(command);

      expect(response._traceId).toBeDefined();
      expect(response._traceId).toMatch(/^trace_/);
      expect(response.stream).toBeDefined();

      // Consume stream
      const chunks: string[] = [];
      for await (const event of response.stream!) {
        if ((event as any).contentBlockDelta?.delta?.text) {
          chunks.push((event as any).contentBlockDelta.delta.text);
        }
      }

      expect(chunks.join('')).toBe('Hello from Bedrock!');
    });
  });

  describe('provider inference', () => {
    test('infers anthropic from model ID', async () => {
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const wrapped = raindrop.wrap(new BedrockRuntimeClient());

      const command = new MockConverseCommand({
        modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      });

      const response = await wrapped.send(command);
      expect(response._traceId).toBeDefined();
    });

    test('infers amazon from model ID', async () => {
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const wrapped = raindrop.wrap(new BedrockRuntimeClient());

      const command = new MockConverseCommand({
        modelId: 'amazon.titan-text-express-v1',
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      });

      const response = await wrapped.send(command);
      expect(response._traceId).toBeDefined();
    });

    test('infers meta from model ID', async () => {
      const BedrockRuntimeClient = class BedrockRuntimeClient {
        send = mockClient.send;
      };
      const wrapped = raindrop.wrap(new BedrockRuntimeClient());

      const command = new MockConverseCommand({
        modelId: 'meta.llama3-8b-instruct-v1:0',
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      });

      const response = await wrapped.send(command);
      expect(response._traceId).toBeDefined();
    });
  });
});
