/**
 * Runs the docs Q&A agent (examples/doc-qa-agent.ts) against the REAL
 * Anthropic API — Claude Haiku 4.5, a handful of short calls. Costs a few
 * cents, not free, not simulated.
 *
 * Why this exists: before designing Waste Detection thresholds, we need to
 * see what a Cost Breakdown looks like on a real agent's real numbers, not a
 * mock's fabricated ones. This agent has three waste patterns left in on
 * purpose — see the header of doc-qa-agent.ts.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node examples/run-real-agent.ts
 *
 * Optional:
 *   FYREN_PRECISE=0   skip count_tokens measurement, use the char estimate only
 *
 * ── Shutdown discipline ────────────────────────────────────────────────────
 *
 * `profiler.close()` runs in a `finally`, so a call that fails partway
 * through (auth error, insufficient credit, rate limit, network drop) still
 * flushes and closes cleanly — whatever was already recorded (earlier
 * sessions, the failed run's error node) survives on disk. And this script
 * never force-kills the process with `process.exit()` after that point; it
 * sets `process.exitCode` and lets Node drain its own handles. Skipping the
 * flush and forcing an immediate exit while the SQLite handle was still open
 * is what caused a native crash here before this file looked like this
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Windows) — see
 * `test/failure.test.ts` for the tests this fix is backed by.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import {
  createProfiler,
  formatCostBreakdown,
  formatAggregateCostBreakdown,
  formatWasteReport,
  formatAggregateWasteReport,
} from '../src/index.ts';
import type { AnthropicLike } from '../src/providers/anthropic.ts';
import { parseDocSections, runDocsQaSession } from './doc-qa-agent.ts';

const RUN_NAME = 'docs-qa-agent';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    [
      'ANTHROPIC_API_KEY is not set.',
      '',
      'This example makes real calls to the Anthropic API (Claude Haiku 4.5).',
      'Total cost for one run of this script is a few cents.',
      '',
      'Set the key and run again:',
      '',
      '  export ANTHROPIC_API_KEY=sk-ant-...',
      '  node examples/run-real-agent.ts',
    ].join('\n'),
  );
  // Nothing async has started yet — no handles to drain, an immediate exit is fine here.
  process.exit(1);
}

const precise = process.env.FYREN_PRECISE !== '0';

// Each question set is one multi-turn session — the conversation grows across
// its own questions and is never pruned (waste pattern #3). The second
// session's follow-up explicitly asks for related reading, which is the only
// question in this whole run expected to trigger get_related_topics.
const SESSIONS: readonly (readonly string[])[] = [
  ['How do I authenticate requests to the API?', 'What happens if I exceed the rate limit?'],
  ['How does pagination work?', 'What related topics should I read about after pagination?'],
  ['What should I do when I get a 500 error?'],
];

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const docsText = await readFile(path.join(here, 'data', 'sample-docs.md'), 'utf8');
  const docs = parseDocSections(docsText);

  const anthropic = new Anthropic({ apiKey });
  // The real SDK types `messages.create` as an overloaded function requiring
  // `max_tokens`; `AnthropicLike` is intentionally loose so src/ never
  // depends on @anthropic-ai/sdk's types. Every call site below always
  // supplies max_tokens, so this widening is safe even though the compiler
  // can't verify it structurally through the SDK's overloads.
  const client = anthropic as unknown as AnthropicLike;
  const profiler = createProfiler({ dbPath: '.fyren/real-agent.db' });

  try {
    console.log(
      `Running ${SESSIONS.length} session(s) against claude-haiku-4-5` +
        ` (precise mode: ${precise ? 'on' : 'off'})...\n`,
    );

    const runIds: string[] = [];
    for (const [index, questions] of SESSIONS.entries()) {
      process.stdout.write(`  session ${index + 1}/${SESSIONS.length}: ${questions.length} question(s)... `);
      const runId = await runDocsQaSession(profiler, client, docs, questions, {
        runName: RUN_NAME,
        precise,
      });
      runIds.push(runId);
      console.log('done');
    }

    // Precise counting finishes after each call returns, off the critical path —
    // give it a moment to land before reading the numbers back.
    if (precise) await new Promise((resolve) => setTimeout(resolve, 1500));

    const firstRunId = runIds[0];
    if (firstRunId) {
      console.log('\n=== cost breakdown — first session ===');
      console.log(formatCostBreakdown(profiler.costBreakdown(firstRunId)));

      console.log('\n=== waste detection — first session ===');
      console.log(formatWasteReport(profiler.wasteReport(firstRunId)));
    }

    console.log('\n=== aggregate across all sessions ===');
    const agg = profiler.aggregateCostBreakdown({ name: RUN_NAME, limit: SESSIONS.length });
    console.log(formatAggregateCostBreakdown(agg));

    console.log('\n=== waste detection — aggregate across all sessions ===');
    console.log(formatAggregateWasteReport(profiler.aggregateWasteReport({ name: RUN_NAME, limit: SESSIONS.length })));

    console.log(`\nrecorded to .fyren/real-agent.db — ${runIds.length} run(s), rootIds:`);
    for (const id of runIds) console.log(`  ${id}`);
  } finally {
    // Always flush + close — success or failure. Whatever was recorded before
    // a failure (earlier sessions, the failing run's error node) must still
    // reach disk; skipping this on the error path is what caused the crash.
    profiler.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeApiError(err)}`);
  // NOT process.exit(): let Node drain its own handles (the HTTP client, the
  // now-closed SQLite file) and exit naturally once nothing is pending.
  process.exitCode = 1;
});

/** A clear, bilingual explanation for the failures people actually hit running this. */
function describeApiError(err: unknown): string {
  if (!(err instanceof Anthropic.APIError)) {
    return err instanceof Error ? err.message : String(err);
  }

  const raw = err.message ?? String(err);

  // `err.type` mirrors the API response body's `error.type` — check it first.
  // Fall back to matching the message text in case an older/odd response
  // doesn't carry a typed `billing_error`.
  if (err.type === 'billing_error' || /credit|balance|billing/i.test(raw)) {
    return [
      'اعتبار حساب Anthropic برای این کلید کافی نیست.',
      "Your Anthropic account doesn't have enough credit for this API key.",
      'حساب را از این آدرس شارژ کنید و دوباره امتحان کنید:',
      'Add credit, then try again: https://console.anthropic.com/settings/billing',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (err instanceof Anthropic.AuthenticationError) {
    return [
      'کلید ANTHROPIC_API_KEY نامعتبر یا باطل‌شده است.',
      'ANTHROPIC_API_KEY is invalid or has been revoked.',
      'یک کلید جدید بسازید: https://console.anthropic.com/settings/keys',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (err instanceof Anthropic.RateLimitError) {
    return [
      'به محدودیت نرخ درخواست برخورد کردید.',
      'Rate limited — wait a moment and run again.',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  if (err instanceof Anthropic.PermissionDeniedError) {
    return [
      'این کلید اجازه‌ی این درخواست را ندارد.',
      'This key does not have permission for this request.',
      '',
      `(raw: ${raw})`,
    ].join('\n');
  }

  return `Anthropic API error (${err.status ?? '?'}): ${raw}`;
}
