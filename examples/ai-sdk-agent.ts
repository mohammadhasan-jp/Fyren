/**
 * A REAL Vercel AI SDK agent, profiled by fyren, running entirely on-device.
 *
 *   node examples/ai-sdk-agent.ts
 *
 * No API key, no network egress, no cost: the model is a local Ollama served
 * through the AI SDK's OpenAI-compatible provider, so this is genuine
 * `generateText` / `streamText` traffic going through genuine
 * `wrapLanguageModel` middleware — not a mock of either.
 *
 * Optional:
 *   OLLAMA_MODEL      default `qwen2.5:7b`
 *   OLLAMA_BASE_URL   default `http://localhost:11434`
 *   FYREN_PRICE_AS    default `claude-haiku-4-5` — the model this free run is
 *                     ALSO hypothetically priced as. Never real spend; always
 *                     printed under a HYPOTHETICAL banner.
 *
 * `cacheSupported: false` is set for the same reason as run-ollama-agent.ts:
 * a local model has no prompt cache, and reporting a wall of zeros would read
 * as "caching was available and every call missed" rather than "the concept
 * does not apply here."
 *
 * The agent below is deliberately shaped to produce something worth looking
 * at: a long system prompt and a fully-schema'd tool, both resent verbatim on
 * every call, against one short question. That is the ordinary shape of an
 * agent, and it is what makes the breakdown's `system` + `toolDefs` share so
 * much larger than `latest`.
 */

import { generateText, streamText, stepCountIs, tool, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

import {
  createProfiler,
  fyrenMiddleware,
  formatCostBreakdown,
  formatWasteReport,
} from '../src/index.ts';

const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b';
const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const HYPOTHETICAL_PRICE_MODEL = process.env.FYREN_PRICE_AS ?? 'claude-haiku-4-5';

const SYSTEM_PROMPT = [
  'You are a documentation assistant for a small HTTP API.',
  'Answer in at most two sentences. Never invent endpoints or parameters.',
  'If the user asks about authentication, rate limits, pagination or errors,',
  'call search_docs first and answer only from what it returns.',
  'If nothing relevant comes back, say so plainly instead of guessing.',
].join(' ');

const DOCS: Record<string, string> = {
  auth: 'Authenticate with a bearer token in the Authorization header.',
  ratelimit: 'The rate limit is 100 requests per minute per token; exceeding it returns 429.',
  pagination: 'List endpoints are cursor-paginated via ?cursor= and return next_cursor.',
  errors: 'A 500 means a server fault; retry once with backoff, then open a ticket.',
};

async function main(): Promise<void> {
  const ollama = createOpenAICompatible({ name: 'ollama', baseURL: `${BASE_URL}/v1` });
  const profiler = createProfiler({ dbPath: '.fyren/ai-sdk-agent.db' });

  try {
    console.log(`Running an AI SDK agent against Ollama's "${MODEL}" at ${BASE_URL}...`);
    console.log('(local CPU inference — the first call is slow, it has to load the model)\n');

    const runId = await profiler.run('ai-sdk-agent', async (run) => {
      // One middleware instance per node: everything this model does is
      // recorded under `run`. Your agent code below is ordinary AI SDK code.
      const model = wrapLanguageModel({
        model: ollama(MODEL),
        middleware: fyrenMiddleware(run, { provider: 'ollama', cacheSupported: false }),
      });

      process.stdout.write('  generateText (with a tool)... ');
      const answered = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: 'What happens if I exceed the rate limit?',
        tools: {
          search_docs: tool({
            description: 'Search the API documentation for a topic and return the matching section.',
            inputSchema: z.object({
              topic: z.enum(['auth', 'ratelimit', 'pagination', 'errors']).describe('Topic to look up'),
            }),
            execute: async ({ topic }) => DOCS[topic] ?? 'no matching section',
          }),
        },
        // Two steps so a tool call and the follow-up answer both get recorded.
        stopWhen: stepCountIs(2),
      });
      console.log(`done\n    → ${answered.text.trim().slice(0, 120)}`);

      // The streaming path goes through `wrapStream`, which settles its node
      // only once the stream is drained — usage arrives on the final part.
      await run.step('stream', async (step) => {
        process.stdout.write('  streamText... ');
        const streamed = streamText({
          model: wrapLanguageModel({
            model: ollama(MODEL),
            middleware: fyrenMiddleware(step, { provider: 'ollama', cacheSupported: false }),
          }),
          system: SYSTEM_PROMPT,
          prompt: 'How does pagination work?',
        });

        let text = '';
        for await (const delta of streamed.textStream) text += delta;
        console.log(`done\n    → ${text.trim().slice(0, 120)}`);
      });

      // `profiler.run()` hands back whatever the callback returns, so the run
      // id has to be returned explicitly to report on it afterwards.
      return run.rootId;
    });

    console.log('\n=== cost breakdown (real: $0, a local model is free) ===');
    console.log(formatCostBreakdown(profiler.costBreakdown(runId)));

    console.log(`\n=== the same run, hypothetically priced as ${HYPOTHETICAL_PRICE_MODEL} ===`);
    console.log(formatCostBreakdown(profiler.costBreakdown(runId, { priceAs: HYPOTHETICAL_PRICE_MODEL })));

    console.log('\n=== waste detection ===');
    console.log(formatWasteReport(profiler.wasteReport(runId, { priceAs: HYPOTHETICAL_PRICE_MODEL })));

    console.log(`\nrecorded to .fyren/ai-sdk-agent.db — rootId ${runId}`);
    console.log('Inspect it with:  npm run fyren -- --db .fyren/ai-sdk-agent.db');
  } finally {
    // Always flush + close, success or failure — same discipline as the other
    // example drivers, for the same reason (see run-real-agent.ts's header).
    profiler.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeError(err)}`);
  // Not process.exit(): let Node drain its own handles rather than being
  // killed mid-write.
  process.exitCode = 1;
});

/** A clear, bilingual explanation for the failures people actually hit here. */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/ECONNREFUSED/i.test(raw) || /fetch failed/i.test(raw)) {
    return [
      `Ollama در آدرس ${BASE_URL} در دسترس نیست.`,
      `Ollama is not reachable at ${BASE_URL}.`,
      'با این دستور اجراش کنید:  ollama serve',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (/not found/i.test(raw) || /does not exist/i.test(raw)) {
    return [
      `مدل "${MODEL}" روی این سیستم موجود نیست.`,
      `The model "${MODEL}" is not pulled on this machine.`,
      `پول کنید:  ollama pull ${MODEL}`,
      `Or point at one you already have: OLLAMA_MODEL=<name> node examples/ai-sdk-agent.ts`,
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  return raw;
}
