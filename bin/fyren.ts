#!/usr/bin/env node
/**
 * `fyren` — terminal summary: recent runs, cost trend, aggregate cost breakdown.
 *
 * Deliberately one command, no subcommands. Waste Detection output, a
 * per-run drill-down, and `--json` are natural follow-ups once this lands —
 * see DECISIONS.md for why v1 stays this narrow (PRD.md flags CLI/UI scope
 * creep as this project's biggest process risk).
 */

import { parseArgs } from 'node:util';

import {
  createProfiler,
  formatAggregateCostBreakdown,
  formatCostTrend,
  type RunCostBreakdown,
} from '../src/index.ts';

const USAGE = `fyren — local token profiler, terminal summary

Usage: fyren [options]

Options:
  --db <path>     Path to the runs database (default: .fyren/runs.db)
  --limit <n>     Number of recent runs to include (default: 10)
  --name <agent>  Only show runs with this exact name
  -h, --help      Show this help
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      limit: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const dbPath = values.db ?? '.fyren/runs.db';
  const limit = values.limit ? Number(values.limit) : 10;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`fyren: --limit must be a positive integer, got "${values.limit}"`);
    process.exitCode = 1;
    return;
  }

  const profiler = createProfiler({ dbPath });
  try {
    const listOptions = { limit, ...(values.name ? { name: values.name } : {}) };

    // A RunNode's own `tokens`/`costUsd` are always 0 on the root — a node
    // only ever stores ITS OWN tokens (see profiler.ts), and a run node never
    // has any of its own. Real per-run totals only exist after walking the
    // tree, which is exactly what costBreakdownRecent() does — so the table,
    // trend and aggregate below all read from the same breakdown array
    // instead of the cheaper-looking but always-zero listRuns() fields.
    const breakdowns = profiler.costBreakdownRecent(listOptions);

    if (breakdowns.length === 0) {
      console.log(
        [
          `fyren: no runs found in ${dbPath}${values.name ? ` for "${values.name}"` : ''}.`,
          '',
          'Record one first — see examples/basic-run.ts, examples/run-ollama-agent.ts,',
          'or wrap your own agent with createProfiler()/wrapAnthropic() from this package.',
        ].join('\n'),
      );
      return;
    }

    console.log(`fyren — ${breakdowns.length} run(s) from ${dbPath}\n`);
    console.log(formatRunsTable(breakdowns));
    console.log();

    console.log(formatCostTrend(breakdowns));
    console.log();

    console.log(formatAggregateCostBreakdown(profiler.aggregateCostBreakdown(listOptions)));
  } finally {
    profiler.close();
  }
}

function formatRunsTable(breakdowns: readonly RunCostBreakdown[]): string {
  const lines: string[] = [
    '  ' + pad('id', 10) + pad('name', 22) + pad('status', 9) + pad('started', 14) + pad('tokens', 10) + 'cost',
  ];
  for (const run of breakdowns) {
    const totalTokens = run.totalInputTokens + run.totalOutputTokens;
    lines.push(
      '  ' +
        pad(run.runId.slice(0, 8), 10) +
        pad(run.name, 22) +
        pad(run.status, 9) +
        pad(relativeTime(run.startedAt), 14) +
        pad(Math.round(totalTokens).toLocaleString('en-US'), 10) +
        `$${run.totalCostUsd.toFixed(6)}`,
    );
  }
  return lines.join('\n');
}

function relativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

main();
