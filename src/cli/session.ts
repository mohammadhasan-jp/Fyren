/**
 * The wiring every command shares: open a profiler, build the selector from
 * the global flags, close it again no matter what happened.
 *
 * `close()` in a `finally` is not optional here — the profiler owns a write
 * queue and an open SQLite handle, and a CLI process that exits without
 * flushing them is the one bug this project's whole reliability story is
 * supposed to make impossible.
 */

import { createProfiler, type Profiler } from '../profiler.ts';
import type { CostBreakdownRecentOptions } from '../profiler.ts';
import type { CliContext } from './index.ts';

export async function withProfiler<T>(
  ctx: CliContext,
  fn: (profiler: Profiler) => Promise<T> | T,
): Promise<T> {
  const profiler = createProfiler({ dbPath: ctx.dbPath });
  try {
    return await fn(profiler);
  } finally {
    profiler.close();
  }
}

export function selectorFor(ctx: CliContext): CostBreakdownRecentOptions {
  return {
    limit: ctx.limit,
    ...(ctx.name !== undefined ? { name: ctx.name } : {}),
    ...(ctx.priceAs !== undefined ? { priceAs: ctx.priceAs } : {}),
  };
}

export function emptyDatabaseMessage(ctx: CliContext): string {
  const scope = ctx.name !== undefined ? ` for "${ctx.name}"` : '';
  return [
    `fyren: no runs found in ${ctx.dbPath}${scope}.`,
    '',
    'Record one first:',
    '  npm run example          a mock agent — no network, no cost',
    '  npm run example:ollama   a real local agent — free, needs Ollama running',
    '',
    'Or wrap your own agent — see the README\'s Quick start.',
  ].join('\n');
}

export type ResolvedRun = { ok: true; id: string } | { ok: false; message: string };

/**
 * Turn the user's `[run]` argument into a full run id.
 *
 * Every listing prints an 8-character prefix, so a prefix is what people
 * actually have to hand. An ambiguous one is reported rather than resolved to
 * an arbitrary match — printing the wrong run's cost without saying so is the
 * exact failure mode this project treats as worse than an error.
 */
export function resolveRun(profiler: Profiler, idOrPrefix: string): ResolvedRun {
  const result = profiler.resolveRunId(idOrPrefix);
  if (result.kind === 'ok') return { ok: true, id: result.id };
  if (result.kind === 'none') {
    return { ok: false, message: `fyren: no run matches "${idOrPrefix}". Run \`fyren runs\` to list them.` };
  }
  return {
    ok: false,
    message: [
      `fyren: "${idOrPrefix}" matches ${result.matches.length} runs. Use more characters:`,
      ...result.matches.slice(0, 10).map((id) => `  ${id}`),
    ].join('\n'),
  };
}

export function printJson(ctx: CliContext, payload: unknown): number {
  ctx.out(JSON.stringify(payload, null, 2));
  return 0;
}
