/**
 * Integration tests for Interactions (withInteraction, wrapTool, begin/finish)
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

describe.skipIf(!canRun)('Interactions Integration', () => {
  let raindrop: Raindrop;
  let openai: Awaited<ReturnType<typeof setupOpenAI>>;

  // Simulated tools
  let searchDocs: (query: string) => Promise<Array<{ title: string; content: string }>>;
  let rerank: (docs: Array<{ title: string; content: string }>, query: string) => Promise<{ title: string; content: string }>;

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

    // Create wrapped tools
    searchDocs = raindrop.wrapTool('search_docs', async (query: string) => {
      await new Promise(resolve => setTimeout(resolve, 50)); // Simulate latency
      return [
        { title: 'Getting Started', content: 'Raindrop is an AI observability platform.' },
        { title: 'API Reference', content: 'The main class is Raindrop.' },
      ];
    });

    rerank = raindrop.wrapTool('rerank', async (docs, query) => {
      await new Promise(resolve => setTimeout(resolve, 25)); // Simulate latency
      return docs[0];
    });
  });

  afterAll(async () => {
    await raindrop.close();
  });

  describe('withInteraction', () => {
    test('wraps multi-step RAG pipeline', async () => {
      const query = 'How do I use Raindrop?';

      const result = await raindrop.withInteraction(
        {
          userId: 'integration_test_user',
          event: 'rag_query',
          input: query,
          properties: { source: 'integration-test' },
        },
        async () => {
          // Step 1: Search
          const docs = await searchDocs(query);

          // Step 2: Rerank
          const topDoc = await rerank(docs, query);

          // Step 3: Generate
          const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `Context: ${topDoc.content}` },
              { role: 'user', content: query },
            ],
          });

          return response.choices[0].message.content;
        }
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      // Check dashboard: should show interaction with 3 spans
    });

    test('captures output set via context', async () => {
      await raindrop.withInteraction(
        { event: 'context_output_test', input: 'test' },
        async (ctx) => {
          ctx.output = 'Explicit output via context';
          return { data: 'ignored' };
        }
      );
      // Verify in dashboard: output should be "Explicit output via context"
    });

    test('captures error within interaction', async () => {
      const failingTool = raindrop.wrapTool('failing_tool', async () => {
        throw new Error('Simulated tool failure');
      });

      await expect(
        raindrop.withInteraction(
          { event: 'error_test', input: 'test error handling' },
          async () => {
            await failingTool();
            return 'should not reach';
          }
        )
      ).rejects.toThrow('Simulated tool failure');

      // Error should be captured in dashboard
    });

    test('includes conversationId', async () => {
      const conversationId = `conv_interaction_${Date.now()}`;

      await raindrop.withInteraction(
        { event: 'convo_test', input: 'Turn 1', conversationId },
        async () => {
          await searchDocs('query 1');
        }
      );

      await raindrop.withInteraction(
        { event: 'convo_test', input: 'Turn 2', conversationId },
        async () => {
          await searchDocs('query 2');
        }
      );

      // Both interactions should be linked by conversationId
    });
  });

  describe('wrapTool standalone', () => {
    test('traces tool call outside interaction', async () => {
      const docs = await searchDocs('standalone query');

      expect(docs).toHaveLength(2);
      expect(docs[0].title).toBe('Getting Started');

      // Should appear as standalone trace in dashboard
    });

    test('traces error from tool', async () => {
      const errorTool = raindrop.wrapTool('error_tool', async () => {
        throw new Error('Tool error');
      });

      await expect(errorTool()).rejects.toThrow('Tool error');
      // Error should be traced
    });
  });

  describe('begin / finish', () => {
    test('manually controls interaction lifecycle', async () => {
      const interaction = raindrop.begin({
        userId: 'manual_test_user',
        event: 'manual_interaction',
        input: 'Starting manual interaction',
      });

      expect(interaction.id).toMatch(/^trace_/);

      // Do some work
      await searchDocs('manual query');

      // Add properties
      interaction.setProperty('step', 'completed');
      interaction.setProperties({ extra: 'data' });

      // Finish with output
      interaction.finish({
        output: 'Manual interaction complete',
        properties: { final: true },
      });

      // Should appear in dashboard with all properties
    });

    test('uses custom eventId', async () => {
      const customId = `custom_${Date.now()}`;

      const interaction = raindrop.begin({
        eventId: customId,
        event: 'custom_id_test',
      });

      expect(interaction.id).toBe(customId);

      interaction.finish({ output: 'Done' });
    });

    test('allows adding attachments', async () => {
      const interaction = raindrop.begin({
        event: 'attachment_test',
        input: 'Test with attachments',
      });

      interaction.addAttachments([
        {
          type: 'code',
          name: 'example.ts',
          value: 'console.log("hello")',
          language: 'typescript',
          role: 'output',
        },
      ]);

      interaction.finish({ output: 'With attachment' });
    });
  });

  describe('resumeInteraction', () => {
    test('resumes existing interaction', async () => {
      const original = raindrop.begin({
        eventId: 'resume_test_id',
        event: 'resume_test',
        input: 'Started',
      });

      // Simulate losing reference
      const resumed = raindrop.resumeInteraction('resume_test_id');

      expect(resumed.id).toBe(original.id);

      resumed.output = 'Resumed and finished';
      resumed.finish();
    });

    test('creates new interaction for unknown ID', async () => {
      const interaction = raindrop.resumeInteraction('unknown_id_12345');

      expect(interaction.id).toBe('unknown_id_12345');

      interaction.finish({ output: 'Created from resume' });
    });
  });
});

// Skip message if tests are skipped
if (!canRun) {
  console.log('Skipping Interactions integration tests - missing API keys');
  console.log('Set RAINDROP_API_KEY and OPENAI_API_KEY to run');
}
