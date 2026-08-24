/**
 * `fyren waste [run]` — the avoidable half of the bill.
 *
 * This is the command the product exists for; the cost breakdown says where
 * the tokens went, this one says which of them didn't need to be spent. It
 * prints the library's own `formatWasteReport`/`formatAggregateWasteReport`
 * verbatim — those already carry the careful "potential, not a bug" wording
 * for providers with no caching concept, and re-phrasing it here would be a
 * second place for that nuance to drift.
 */

import type { CliContext } from '../index.ts';
import { emptyDatabaseMessage, printJson, resolveRun, selectorFor, withProfiler } from '../session.ts';
import { formatAggregateWasteReport, formatWasteReport } from '../../analysis/waste-detection.ts';

export async function wasteCommand(ctx: CliContext, runArg: string | undefined): Promise<number> {
  return withProfiler(ctx, (profiler) => {
    if (runArg === undefined) {
      const selector = selectorFor(ctx);
      const report = profiler.aggregateWasteReport(selector);
      if (ctx.json) return printJson(ctx, report);
      if (report.runCount === 0) {
        ctx.out(emptyDatabaseMessage(ctx));
        return 0;
      }
      ctx.out(formatAggregateWasteReport(report));
      return 0;
    }

    const resolved = resolveRun(profiler, runArg);
    if (!resolved.ok) {
      ctx.err(resolved.message);
      return 1;
    }

    const costOptions = ctx.priceAs !== undefined ? { priceAs: ctx.priceAs } : {};
    const report = profiler.wasteReport(resolved.id, costOptions);
    if (ctx.json) return printJson(ctx, report);

    ctx.out(formatWasteReport(report));
    return 0;
  });
}
