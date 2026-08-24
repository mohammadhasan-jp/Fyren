/**
 * `fyren` with no command — the same three things the released CLI always
 * printed (runs table, cost trend, aggregate breakdown), plus a one-line
 * pointer at `fyren waste` when there is avoidable money on the table.
 *
 * The pointer is the only addition, and it is deliberate: the breakdown answers
 * "where did the tokens go", and a user who sees that and stops has missed the
 * half of the product that answers "which of them didn't need to be spent".
 */

import type { CliContext } from '../index.ts';
import { emptyDatabaseMessage, printJson, selectorFor, withProfiler } from '../session.ts';
import { formatAggregateCostBreakdown, formatCostTrend } from '../../analysis/cost-breakdown.ts';
import { runsTable } from './runs.ts';
import { heading, usd } from '../format.ts';

export async function summaryCommand(ctx: CliContext): Promise<number> {
  return withProfiler(ctx, (profiler) => {
    const selector = selectorFor(ctx);
    const breakdowns = profiler.costBreakdownRecent(selector);

    if (ctx.json) {
      return printJson(ctx, {
        dbPath: ctx.dbPath,
        runs: breakdowns,
        aggregate: profiler.aggregateCostBreakdown(selector),
        waste: profiler.aggregateWasteReport(selector),
      });
    }

    if (breakdowns.length === 0) {
      ctx.out(emptyDatabaseMessage(ctx));
      return 0;
    }

    const { palette } = ctx;
    ctx.out(
      `${palette.bold('fyren')} ${palette.dim(`— ${breakdowns.length} run(s) from ${ctx.dbPath}`)}\n`,
    );

    ctx.out(heading('RECENT RUNS', palette));
    ctx.out(runsTable(breakdowns, ctx));
    ctx.out('');

    ctx.out(heading('COST TREND', palette));
    ctx.out(formatCostTrend(breakdowns));
    ctx.out('');

    ctx.out(heading('COST BREAKDOWN', palette));
    ctx.out(formatAggregateCostBreakdown(profiler.aggregateCostBreakdown(selector)));

    const waste = profiler.aggregateWasteReport(selector);
    if (waste.findings.length > 0) {
      ctx.out('');
      const amount = palette.yellow(usd(waste.totalAvoidableCostUsd));
      const label = waste.pricingMode === 'hypothetical' ? ' (hypothetical)' : '';
      ctx.out(
        `${waste.findings.length} waste finding(s), ${amount}${label} avoidable — run ${palette.bold('fyren waste')} for the detail.`,
      );
    }

    return 0;
  });
}
