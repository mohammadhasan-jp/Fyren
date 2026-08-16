/**
 * Runs the docs Q&A agent (examples/doc-qa-agent.ts) against a REAL, LOCAL
 * Ollama server. No API key, no network egress, no cost — everything runs
 * on-device.
 *
 *   node examples/run-ollama-agent.ts
 *
 * Optional:
 *   OLLAMA_MODEL     default `qwen2.5:3b` (~1.9 GB) — see the note below on
 *                     why this default, not the smallest option.
 *   OLLAMA_BASE_URL   default `http://localhost:11434`
 *   FYREN_PRECISE=0   no-op here (Ollama has no count_tokens endpoint — see
 *                     createOllamaClient's doc comment), kept only so this
 *                     script accepts the same env var as run-real-agent.ts
 *   FYREN_PRICE_AS    default `claude-haiku-4-5` — the model the report is
 *                     ALSO hypothetically priced as (see below); never real
 *                     spend, always printed under a HYPOTHETICAL banner.
 *
 * Cache columns: Ollama has no prompt-caching concept at all, so every call
 * here is wrapped with `cacheSupported: false`. The Cost Breakdown report
 * reflects that explicitly — "cache: not applicable" — rather than printing
 * a wall of zeros that would read as "caching was tried and missed."
 *
 * ── Why `qwen2.5:3b`, and what tool-calling reliability actually looked like ──
 *
 * Measured across four sizes on this exact agent and system prompt:
 *
 *   qwen2.5:0.5b (397 MB)  never called a tool — answered every question
 *                          from general knowledge despite the system prompt
 *   qwen2.5:1.5b           same — never called a tool
 *   qwen2.5:3b             called get_related_topics on the one question that
 *                          explicitly asked for it; never called search_docs
 *                          on an ordinary factual question
 *   qwen2.5:7b (4.7 GB)    called both — including search_docs on a plain
 *                          factual question, which produced a real, nonzero
 *                          "tool results" segment in the Cost Breakdown
 *
 * That's a real, useful finding on its own: small local models follow a
 * narrow, explicitly-triggered instruction ("call X when asked for Y") far
 * more reliably than a broad behavioral policy ("always use tool Z for
 * factual claims") — the latter requires recognizing an implicit category,
 * the former is closer to direct pattern matching. `3b` is the default
 * because it is the smallest size that reliably calls a tool at all, giving
 * a non-degenerate report without the multi-minute cold-start of `7b` on
 * CPU. Set `OLLAMA_MODEL=qwen2.5:7b` for the fuller picture, including
 * `tool_results` actually showing up from an ordinary question.
 *
 * Shutdown discipline matches run-real-agent.ts from the start: `profiler.
 * close()` runs in a `finally` so data recorded before a mid-run failure
 * (model not found, Ollama not running, a malformed response) survives, and
 * the script never force-kills the process with `process.exit()` after
 * async work has started — see that file's header for what went wrong the
 * first time this wasn't done, and test/failure.test.ts for the tests this
 * rests on.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createProfiler,
  formatCostBreakdown,
  formatAggregateCostBreakdown,
  formatWasteReport,
  formatAggregateWasteReport,
} from '../src/index.ts';
import { createOllamaClient } from '../src/providers/ollama.ts';
import { parseDocSections, runDocsQaSession } from './doc-qa-agent.ts';

const RUN_NAME = 'docs-qa-agent-ollama';
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b';
const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
// A comparably-sized hosted model, used only to give the free local run a
// dollar figure worth reacting to — see the `priceAs` usage below.
const HYPOTHETICAL_PRICE_MODEL = process.env.FYREN_PRICE_AS ?? 'claude-haiku-4-5';

// Same three sessions as run-real-agent.ts, so the two reports are directly
// comparable. Local CPU inference is much slower than a hosted API — this is
// the whole point (free, but not fast) — so keep max_tokens modest.
const SESSIONS: readonly (readonly string[])[] = [
  ['How do I authenticate requests to the API?', 'What happens if I exceed the rate limit?'],
  ['How does pagination work?', 'What related topics should I read about after pagination?'],
  ['What should I do when I get a 500 error?'],
];

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const docsText = await readFile(path.join(here, 'data', 'sample-docs.md'), 'utf8');
  const docs = parseDocSections(docsText);

  const client = createOllamaClient({ baseUrl: BASE_URL });
  const profiler = createProfiler({ dbPath: '.fyren/ollama-agent.db' });

  try {
    console.log(`Running ${SESSIONS.length} session(s) against Ollama's "${MODEL}" at ${BASE_URL}...`);
    console.log('(local CPU inference — the first call is slow, it has to load the model into memory)\n');

    const runIds: string[] = [];
    for (const [index, questions] of SESSIONS.entries()) {
      process.stdout.write(`  session ${index + 1}/${SESSIONS.length}: ${questions.length} question(s)... `);
      const started = Date.now();
      const runId = await runDocsQaSession(profiler, client, docs, questions, {
        runName: RUN_NAME,
        model: MODEL,
        provider: 'ollama',
        cacheSupported: false, // Ollama has no prompt-caching concept — see file header
        precise: false, // no count_tokens endpoint to call; the char estimate is all there is
      });
      runIds.push(runId);
      console.log(`done (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }

    const firstRunId = runIds[0];
    if (firstRunId) {
      console.log('\n=== cost breakdown — first session (real: $0, Ollama is free) ===');
      console.log(formatCostBreakdown(profiler.costBreakdown(firstRunId)));

      // The real cost is genuinely $0 — but a wall of $0.00 doesn't make the
      // waste in a report land the way a dollar figure does. `priceAs` answers
      // "what would sending THIS SAME traffic to a real model have cost?" —
      // never real spend, always labeled HYPOTHETICAL so it can't be mistaken
      // for one.
      console.log(`\n=== the same session, hypothetically priced as ${HYPOTHETICAL_PRICE_MODEL} ===`);
      console.log(formatCostBreakdown(profiler.costBreakdown(firstRunId, { priceAs: HYPOTHETICAL_PRICE_MODEL })));

      console.log('\n=== waste detection — first session ===');
      console.log(formatWasteReport(profiler.wasteReport(firstRunId, { priceAs: HYPOTHETICAL_PRICE_MODEL })));
    }

    console.log('\n=== aggregate across all sessions ===');
    const agg = profiler.aggregateCostBreakdown({ name: RUN_NAME, limit: SESSIONS.length });
    console.log(formatAggregateCostBreakdown(agg));

    console.log(`\n=== aggregate, hypothetically priced as ${HYPOTHETICAL_PRICE_MODEL} ===`);
    console.log(
      formatAggregateCostBreakdown(
        profiler.aggregateCostBreakdown({
          name: RUN_NAME,
          limit: SESSIONS.length,
          priceAs: HYPOTHETICAL_PRICE_MODEL,
        }),
      ),
    );

    // Waste Detection, pattern #1: SYSTEM_PROMPT and TOOLS (doc-qa-agent.ts's
    // waste patterns #1 and #2) are constant every call — this is exactly the
    // uncached-static-content shape it looks for.
    console.log('\n=== waste detection — aggregate across all sessions ===');
    console.log(
      formatAggregateWasteReport(
        profiler.aggregateWasteReport({
          name: RUN_NAME,
          limit: SESSIONS.length,
          priceAs: HYPOTHETICAL_PRICE_MODEL,
        }),
      ),
    );

    console.log(`\nrecorded to .fyren/ollama-agent.db — ${runIds.length} run(s), rootIds:`);
    for (const id of runIds) console.log(`  ${id}`);
  } finally {
    // Always flush + close — success or failure. See the file header.
    profiler.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeOllamaError(err)}`);
  process.exitCode = 1;
});

/** A clear, bilingual explanation for the failures people actually hit running this. */
function describeOllamaError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/could not reach ollama/i.test(raw) || /ECONNREFUSED/i.test(raw)) {
    return [
      `Ollama در آدرس ${BASE_URL} در دسترس نیست.`,
      `Ollama is not reachable at ${BASE_URL}.`,
      'با این دستور اجراش کنید:  ollama serve',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (/not found/i.test(raw)) {
    return [
      `مدل "${MODEL}" روی این سیستم موجود نیست.`,
      `The model "${MODEL}" is not pulled on this machine.`,
      `پول کنید:  ollama pull ${MODEL}`,
      `Or pick a different one you already have: OLLAMA_MODEL=<name> node examples/run-ollama-agent.ts`,
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (/timed out/i.test(raw)) {
    return [
      'درخواست به Ollama timeout شد — روی CPU، مدل‌های بزرگ‌تر می‌توانند خیلی کند باشند.',
      'The request to Ollama timed out — larger models can be very slow on CPU.',
      'یک مدل کوچک‌تر امتحان کنید یا صبر بیشتری بدهید.',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  return raw;
}
