/**
 * Test: Multi-step Interaction with wrapTool
 *
 * This tests the new withInteraction() and wrapTool() APIs.
 *
 * Run with: RAINDROP_API_KEY=your_key OPENAI_API_KEY=your_key bun run examples/test-interaction.ts
 */

import { Raindrop } from '../src/index.js';

const RAINDROP_API_KEY = process.env.RAINDROP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!RAINDROP_API_KEY) {
  console.error('Missing RAINDROP_API_KEY');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const raindrop = new Raindrop({
  apiKey: RAINDROP_API_KEY,
  debug: true,
});

// Identify a test user
raindrop.identify('test_user_interaction', {
  name: 'Interaction Test User',
  email: 'test@example.com',
});

// Simulate a vector search tool
const searchDocs = raindrop.wrapTool('search_docs', async (query: string) => {
  console.log('  [tool] Searching docs for:', query);
  // Simulate latency
  await new Promise(resolve => setTimeout(resolve, 100));
  return [
    { title: 'Getting Started', content: 'Raindrop is an AI observability platform...' },
    { title: 'API Reference', content: 'The main class is Raindrop...' },
  ];
});

// Simulate a reranker tool
const rerank = raindrop.wrapTool('rerank', async (docs: Array<{ title: string; content: string }>, query: string) => {
  console.log('  [tool] Reranking', docs.length, 'docs');
  await new Promise(resolve => setTimeout(resolve, 50));
  return docs[0]; // Just return the first doc
});

async function main() {
  console.log('🚀 Testing withInteraction() and wrapTool()\n');
  console.log('─'.repeat(60));

  const { default: OpenAI } = await import('openai');
  const openai = raindrop.wrap(new OpenAI({ apiKey: OPENAI_API_KEY }));

  // Test 1: Multi-step RAG pipeline
  console.log('\n📝 Test 1: RAG Pipeline (search → rerank → generate)\n');

  const query = 'How do I use Raindrop?';

  const answer = await raindrop.withInteraction(
    {
      userId: 'test_user_interaction',
      event: 'rag_query',
      input: query,
      properties: { source: 'test-interaction.ts' },
    },
    async () => {
      console.log('  1. Searching docs...');
      const docs = await searchDocs(query);

      console.log('  2. Reranking results...');
      const topDoc = await rerank(docs, query);

      console.log('  3. Generating answer with OpenAI...');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Answer based on this context: ${topDoc.content}`,
          },
          { role: 'user', content: query },
        ],
      });

      return response.choices[0].message.content;
    }
  );

  console.log('\n  Answer:', answer);
  console.log('\n  ✅ Interaction should show 3 spans:');
  console.log('     - tool:search_docs');
  console.log('     - tool:rerank');
  console.log('     - ai:openai:gpt-4o-mini');

  // Test 2: Standalone calls (outside interaction)
  console.log('\n─'.repeat(60));
  console.log('\n📝 Test 2: Standalone calls (outside withInteraction)\n');

  console.log('  1. Standalone tool call...');
  const standaloneDocs = await searchDocs('standalone query');
  console.log('     Got', standaloneDocs.length, 'docs');

  console.log('  2. Standalone OpenAI call...');
  const standaloneResponse = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say "standalone test" in 3 words.' }],
  });
  console.log('     Response:', standaloneResponse.choices[0].message.content);
  console.log('     Trace ID:', standaloneResponse._traceId);

  console.log('\n  ✅ Standalone calls should appear as separate traces');

  // Test 3: Error handling
  console.log('\n─'.repeat(60));
  console.log('\n📝 Test 3: Error handling within interaction\n');

  const failingTool = raindrop.wrapTool('failing_tool', async () => {
    throw new Error('Simulated tool failure');
  });

  try {
    await raindrop.withInteraction(
      { event: 'error_test', input: 'test error handling' },
      async () => {
        await failingTool();
        return 'should not reach here';
      }
    );
  } catch (error) {
    console.log('  Caught expected error:', (error as Error).message);
    console.log('  ✅ Error should be captured in the interaction');
  }

  // Cleanup
  console.log('\n─'.repeat(60));
  console.log('\n⏳ Flushing events...');
  await raindrop.close();
  console.log('✅ Done!');

  console.log('\n📊 Check your Raindrop dashboard to verify:');
  console.log('   1. RAG interaction shows with 3 nested spans');
  console.log('   2. Standalone calls appear as separate events');
  console.log('   3. Error interaction shows the failure');
}

main().catch(console.error);
