/**
 * `fyren doctor` — answer "is this thing actually working, and can it trust
 * its own numbers?" without making the user read source.
 *
 * Every check here corresponds to a real way this tool goes quietly wrong:
 * a Node too old to run it, a database path that isn't the one the agent is
 * writing to, runs recorded with no composition data (so the breakdown has
 * nothing to attribute), or a model with no pricing entry (so every cost
 * silently reads $0). All four look like "it works, the numbers are just
 * small" from the outside, which is the failure mode this project cares most
 * about avoiding.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CliContext } from '../index.ts';
import { printJson, withProfiler } from '../session.ts';
import { int, relativeTime, table, truncate } from '../format.ts';
import { isPricingKnown } from '../../pricing.ts';
import { DatabaseSync } from '../../sqlite.ts';
import { packageVersion } from '../version.ts';
import type { Profiler } from '../../profiler.ts';

/** The floor from package.json's `engines`. Two features must both be unflagged; see DECISIONS.md. */
const MIN_NODE = { major: 22, minor: 18 };

type CheckLevel = 'ok' | 'warn' | 'fail';

interface Check {
  level: CheckLevel;
  label: string;
  detail: string;
}

export async function doctorCommand(ctx: CliContext): Promise<number> {
  const checks: Check[] = [nodeVersionCheck(), sqliteCheck()];

  const dbAbsolute = resolve(ctx.dbPath);
  const dbExists = existsSync(ctx.dbPath);

  checks.push(
    dbExists
      ? {
          level: 'ok',
          label: 'database',
          detail: `${dbAbsolute} (${formatBytes(statSync(ctx.dbPath).size)})`,
        }
      : {
          level: 'warn',
          label: 'database',
          detail: `${dbAbsolute} does not exist yet — it is created on the first recorded run.`,
        },
  );

  const payload = await withProfiler(ctx, (profiler) => {
    if (!dbExists) return { runNames: [], models: [], checks };
    return inspectDatabase(profiler, checks);
  });

  if (ctx.json) {
    return printJson(ctx, {
      version: packageVersion(),
      node: process.versions.node,
      dbPath: dbAbsolute,
      checks: payload.checks,
      runNames: payload.runNames,
      models: payload.models,
    });
  }

  const { palette } = ctx;
  ctx.out(`${palette.bold('fyren')} ${palette.dim(packageVersion())}\n`);

  for (const check of payload.checks) {
    ctx.out(`${levelMark(check.level, ctx)} ${palette.bold(check.label)}  ${check.detail}`);
  }

  if (payload.runNames.length > 0) {
    ctx.out(`\n${palette.bold('RUN NAMES')} ${palette.dim('(use with --name, or diff --before/--after)')}`);
    ctx.out(
      table(
        [{ header: 'name' }, { header: 'runs', align: 'right' }, { header: 'last seen', align: 'right' }],
        payload.runNames.map((entry) => [
          truncate(entry.name, 60),
          int(entry.runCount),
          palette.dim(relativeTime(entry.lastStartedAt)),
        ]),
        palette,
      ),
    );
  }

  if (payload.models.length > 0) {
    ctx.out(`\n${palette.bold('MODELS SEEN')}`);
    ctx.out(
      table(
        [{ header: 'model' }, { header: 'calls', align: 'right' }, { header: 'pricing' }],
        payload.models.map((entry) => [
          truncate(entry.model, 40),
          int(entry.callCount),
          entry.priced
            ? palette.green('known')
            : palette.yellow('unknown — costs read $0 for this model'),
        ]),
        palette,
      ),
    );
  }

  const failed = payload.checks.some((check) => check.level === 'fail');
  return failed ? 1 : 0;
}

interface ModelUsage {
  model: string;
  callCount: number;
  priced: boolean;
}

function inspectDatabase(
  profiler: Profiler,
  checks: Check[],
): { runNames: ReturnType<Profiler['listRunNames']>; models: ModelUsage[]; checks: Check[] } {
  const runNames = profiler.listRunNames();
  const totalRuns = runNames.reduce((sum, entry) => sum + entry.runCount, 0);

  checks.push(
    totalRuns === 0
      ? {
          level: 'warn',
          label: 'runs',
          detail: 'none recorded yet — try `npm run example`, or wrap your own agent.',
        }
      : { level: 'ok', label: 'runs', detail: `${int(totalRuns)} across ${runNames.length} name(s)` },
  );

  // Sampling the most recent runs, not the whole table: this is a health
  // check, and a database with thousands of runs should not make it slow.
  const recent = profiler.costBreakdownRecent({ limit: 25 });
  const models = new Map<string, number>();
  for (const run of recent) {
    for (const node of profiler.getTree(run.runId)) {
      if (node.type !== 'llm_call' || node.model === null) continue;
      models.set(node.model, (models.get(node.model) ?? 0) + 1);
    }
  }

  if (recent.length > 0) {
    const unattributed = recent.filter((run) => run.attributedCallCount === 0 && run.llmCallCount > 0);
    checks.push(
      unattributed.length === 0
        ? { level: 'ok', label: 'composition', detail: 'every recent run has input-composition data' }
        : {
            level: 'warn',
            label: 'composition',
            detail:
              `${unattributed.length} of ${recent.length} recent runs recorded no input composition — ` +
              'their tokens cannot be split into segments. Record calls through a provider wrapper ' +
              '(wrapAnthropic / createOpenAiClient / createGeminiClient / createOllamaClient) to get it.',
          },
    );

    const measured = recent.filter((run) => run.precision === 'measured').length;
    checks.push(
      measured === recent.length
        ? {
            level: 'ok',
            label: 'precision',
            detail: "measured — segment sizes come from the provider's token counter",
          }
        : {
            // Not 'ok': an estimated breakdown is a real caveat on every number
            // downstream, and a green tick next to "these are estimates" is
            // exactly the kind of quiet reassurance this command exists to avoid.
            level: 'warn',
            label: 'precision',
            detail:
              `${measured}/${recent.length} recent runs are measured; the rest estimate segment sizes from ` +
              'character counts, which is not a constant ratio. Pass { precise: true } to the provider ' +
              'wrapper for exact numbers.',
          },
    );
  }

  const modelList: ModelUsage[] = [...models.entries()]
    .map(([model, callCount]) => ({ model, callCount, priced: isPricingKnown(model) }))
    .sort((a, b) => b.callCount - a.callCount);

  const unpriced = modelList.filter((entry) => !entry.priced);
  if (unpriced.length > 0) {
    checks.push({
      level: 'warn',
      label: 'pricing',
      detail:
        `${unpriced.length} model(s) have no pricing entry, so their cost reads $0. ` +
        'Use --price-as <known-model> to see what the same tokens would cost elsewhere.',
    });
  }

  return { runNames, models: modelList, checks };
}

function nodeVersionCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return ok
    ? { level: 'ok', label: 'node', detail: `v${process.versions.node}` }
    : {
        level: 'fail',
        label: 'node',
        detail: `v${process.versions.node} — fyren needs >= ${MIN_NODE.major}.${MIN_NODE.minor}.`,
      };
}

function sqliteCheck(): Check {
  // Actually open something. A Node build compiled without SQLite, or one
  // where the module loads but cannot create a database, both reach this line
  // — and "the import didn't throw" would report OK for either.
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.close();
    return { level: 'ok', label: 'node:sqlite', detail: 'available, no native build needed' };
  } catch (err) {
    return {
      level: 'fail',
      label: 'node:sqlite',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function levelMark(level: CheckLevel, ctx: CliContext): string {
  const { palette } = ctx;
  if (level === 'ok') return palette.green('ok  ');
  if (level === 'warn') return palette.yellow('warn');
  return palette.red('FAIL');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
