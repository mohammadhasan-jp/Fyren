/**
 * `fyren` — argument parsing and command dispatch.
 *
 * v1 shipped one command and no subcommands, deliberately (see DECISIONS.md).
 * That scope was widened on purpose once the analysis engine was complete:
 * the library could compute a waste report, a per-run drill-down and a version
 * diff that the CLI had no way to show, which made the tool look less finished
 * than it was. The guard against the scope creep the original decision worried
 * about is that every subcommand here is a thin printer over an analysis
 * function that already existed and was already tested — no command computes
 * anything of its own.
 *
 * Bare `fyren` still prints exactly what it always printed, and `--ui` still
 * works as a flag, so neither change breaks an existing habit.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';

import { paletteFor, type Palette } from './colors.ts';
import { isPricingKnown } from '../pricing.ts';
import { packageVersion } from './version.ts';

import { summaryCommand } from './commands/summary.ts';
import { runsCommand } from './commands/runs.ts';
import { breakdownCommand } from './commands/breakdown.ts';
import { wasteCommand } from './commands/waste.ts';
import { diffCommand } from './commands/diff.ts';
import { uiCommand } from './commands/ui.ts';
import { doctorCommand } from './commands/doctor.ts';

export const DEFAULT_DB_PATH = '.fyren/runs.db';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliContext extends CliIo {
  dbPath: string;
  limit: number;
  name: string | undefined;
  priceAs: string | undefined;
  json: boolean;
  palette: Palette;
  /** `ui` only. */
  port: number;
  openBrowser: boolean;
  /** `diff` only. */
  before: string | undefined;
  after: string | undefined;
}

const USAGE = `fyren — a local-first token profiler for LLM and agent developers

Usage
  fyren [command] [options]

Commands
  summary              Runs table, cost trend, aggregate breakdown   (default)
  runs                 Just the table of recent runs
  breakdown [run]      Where the input tokens went — all runs, or one
  waste [run]          Avoidable spend — all runs, or one
  diff                 Compare two sets of runs (--before / --after)
  ui                   Open the local web UI in a browser
  doctor               Check the environment, the database, and pricing coverage

  [run] is a run id or any unique prefix of one, as printed by \`fyren runs\`.

Options
  --db <path>          Runs database            (default: ${DEFAULT_DB_PATH}, or $FYREN_DB)
  --limit <n>          Recent runs to include   (default: 10)
  --name <agent>       Only runs with this exact name
  --price-as <model>   Re-price these runs at another model's rates.
                       Always labelled as hypothetical — never real spend.
  --json               Machine-readable output
  --no-color           Disable ANSI colour (also: NO_COLOR=1)
  --port <n>           ui: port                 (default: an OS-assigned free port)
  --no-open            ui: do not open a browser
  --before <name>      diff: run name for the "before" side
  --after <name>       diff: run name for the "after" side
  -h, --help           Show this help
  -v, --version        Show the version

Examples
  fyren                                  # what happened lately
  fyren waste                            # what it cost you that it didn't have to
  fyren breakdown 3f9c1a2b               # one run, in detail
  fyren waste --price-as claude-sonnet-4-5-20250929
  fyren diff --before agent-v1 --after agent-v2
  fyren ui --port 4000
`;

type CommandFn = (ctx: CliContext, positional: string | undefined) => Promise<number> | number;

const COMMANDS: Record<string, CommandFn> = {
  summary: summaryCommand,
  runs: runsCommand,
  breakdown: breakdownCommand,
  waste: wasteCommand,
  diff: diffCommand,
  ui: uiCommand,
  doctor: doctorCommand,
};

const PARSE_OPTIONS = {
  db: { type: 'string' },
  limit: { type: 'string' },
  name: { type: 'string' },
  'price-as': { type: 'string' },
  json: { type: 'boolean' },
  // node:util's parseArgs has no automatic --no-x negation (verified — it
  // throws ERR_PARSE_ARGS_UNKNOWN_OPTION), so each negated flag is its own.
  'no-color': { type: 'boolean' },
  'no-open': { type: 'boolean' },
  ui: { type: 'boolean' },
  port: { type: 'string' },
  before: { type: 'string' },
  after: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} satisfies ParseArgsConfig['options'];

export async function runCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: PARSE_OPTIONS,
      allowPositionals: true,
    });
    values = parsed.values as Record<string, string | boolean | undefined>;
    positionals = parsed.positionals;
  } catch (err) {
    io.err(`fyren: ${err instanceof Error ? err.message : String(err)}`);
    io.err('Run `fyren --help` for usage.');
    return 1;
  }

  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }
  if (values.version === true) {
    io.out(packageVersion());
    return 0;
  }

  const palette = paletteFor({ noColorFlag: values['no-color'] === true });

  const [commandName, ...rest] = positionals;
  // `--ui` predates the `ui` subcommand and stays supported: it shipped in the
  // released CLI, and silently breaking it to tidy the surface would cost a
  // real user more than the inconsistency does.
  const resolvedName = commandName ?? (values.ui === true ? 'ui' : 'summary');
  const command = COMMANDS[resolvedName];

  if (!command) {
    io.err(`fyren: unknown command "${resolvedName}".`);
    io.err(`Expected one of: ${Object.keys(COMMANDS).join(', ')}. Run \`fyren --help\`.`);
    return 1;
  }
  if (rest.length > 1) {
    io.err(`fyren: ${resolvedName} takes at most one argument, got ${rest.length}.`);
    return 1;
  }

  const limit = numberOption(values.limit, 10);
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    io.err(`fyren: --limit must be a positive integer, got "${String(values.limit)}".`);
    return 1;
  }

  const port = numberOption(values.port, 0);
  if (port === null || !Number.isInteger(port) || port < 0 || port > 65535) {
    io.err(`fyren: --port must be an integer between 0 and 65535, got "${String(values.port)}".`);
    return 1;
  }

  const priceAs = typeof values['price-as'] === 'string' ? values['price-as'] : undefined;
  if (priceAs !== undefined && !isPricingKnown(priceAs)) {
    // A warning, not an error: an unknown model still produces a structurally
    // valid report, it just prices at zero. Failing outright would be worse
    // than saying plainly that the number will be $0.
    io.err(
      `fyren: warning — no pricing entry for "${priceAs}", so hypothetical costs will read $0. ` +
        'Run `fyren doctor` to list the models fyren knows rates for.',
    );
  }

  const ctx: CliContext = {
    dbPath: stringOption(values.db) ?? process.env.FYREN_DB ?? DEFAULT_DB_PATH,
    limit,
    name: stringOption(values.name),
    priceAs,
    json: values.json === true,
    palette,
    port,
    openBrowser: values['no-open'] !== true,
    before: stringOption(values.before),
    after: stringOption(values.after),
    out: io.out,
    err: io.err,
  };

  try {
    return await command(ctx, rest[0]);
  } catch (err) {
    ctx.err(`fyren: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `null` signals "given but not a number", which the caller reports; `fallback` covers "not given". */
function numberOption(value: string | boolean | undefined, fallback: number): number | null {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function defaultIo(): CliIo {
  return {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  };
}

export { USAGE };
