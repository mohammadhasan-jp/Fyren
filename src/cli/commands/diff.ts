/**
 * `fyren diff --before <name> --after <name>` — analysis #3, on the terminal.
 *
 * The two sides are selected by run NAME, because that is the only grouping
 * the data model has: there is no first-class `version` field, deliberately
 * (see DECISIONS.md § "Version Diff groups before/after by caller-supplied
 * selector"). Giving each prompt version its own run name is the documented
 * way to use this, so the flags say `--before <name>` rather than pretending
 * a version concept exists.
 */

import type { CliContext } from '../index.ts';
import { printJson, selectorFor, withProfiler } from '../session.ts';
import { formatVersionDiff } from '../../analysis/version-diff.ts';

export async function diffCommand(ctx: CliContext): Promise<number> {
  if (ctx.before === undefined || ctx.after === undefined) {
    ctx.err('fyren: diff needs both --before <name> and --after <name>.');
    ctx.err('');
    ctx.err('Each names a set of runs to compare, e.g.:');
    ctx.err('  fyren diff --before agent-v1 --after agent-v2');
    ctx.err('');
    ctx.err('Run `fyren doctor` to list the run names in this database.');
    return 1;
  }

  return withProfiler(ctx, (profiler) => {
    const base = selectorFor(ctx);
    const diff = profiler.versionDiff({
      before: { ...base, name: ctx.before as string },
      after: { ...base, name: ctx.after as string },
    });

    if (ctx.json) return printJson(ctx, diff);

    if (diff.before.runCount === 0 || diff.after.runCount === 0) {
      const missing: string[] = [];
      if (diff.before.runCount === 0) missing.push(`--before "${ctx.before as string}"`);
      if (diff.after.runCount === 0) missing.push(`--after "${ctx.after as string}"`);
      ctx.err(`fyren: no runs found for ${missing.join(' or ')} in ${ctx.dbPath}.`);
      ctx.err('Run `fyren doctor` to list the run names in this database.');
      return 1;
    }

    ctx.out(formatVersionDiff(diff));
    return 0;
  });
}
