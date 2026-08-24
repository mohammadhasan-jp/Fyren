/**
 * `fyren runs` — the table of recent runs, on its own.
 */

import type { CliContext } from '../index.ts';
import { emptyDatabaseMessage, printJson, selectorFor, withProfiler } from '../session.ts';
import { colorStatus, duration, int, relativeTime, table, usd } from '../format.ts';
import type { RunCostBreakdown } from '../../analysis/cost-breakdown.ts';

export async function runsCommand(ctx: CliContext): Promise<number> {
  return withProfiler(ctx, (profiler) => {
    const breakdowns = profiler.costBreakdownRecent(selectorFor(ctx));

    if (ctx.json) return printJson(ctx, { dbPath: ctx.dbPath, runs: breakdowns });

    if (breakdowns.length === 0) {
      ctx.out(emptyDatabaseMessage(ctx));
      return 0;
    }

    ctx.out(runsTable(breakdowns, ctx));
    return 0;
  });
}

/**
 * Per-run tokens and cost come from the breakdown, never from a run node's own
 * `tokens`/`costUsd`. A node stores only its OWN tokens and a run node has
 * none of its own, so reading those fields prints a silent, confident zero —
 * see DECISIONS.md § "The runs table reads from costBreakdownRecent()".
 */
export function runsTable(breakdowns: readonly RunCostBreakdown[], ctx: CliContext): string {
  const { palette } = ctx;

  const rows = breakdowns.map((run) => [
    palette.cyan(run.runId.slice(0, 8)),
    run.name,
    colorStatus(run.status, palette),
    palette.dim(relativeTime(run.startedAt)),
    palette.dim(duration(run.durationMs)),
    int(run.totalInputTokens + run.totalOutputTokens),
    run.totalCostUsd > 0 ? usd(run.totalCostUsd) : palette.dim(usd(0)),
  ]);

  return table(
    [
      { header: 'id' },
      { header: 'name' },
      { header: 'status' },
      { header: 'started', align: 'right' },
      { header: 'took', align: 'right' },
      { header: 'tokens', align: 'right' },
      { header: 'cost', align: 'right' },
    ],
    rows,
    palette,
  );
}
