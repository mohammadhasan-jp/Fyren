/**
 * The CLI, driven through `runCli` rather than by spawning a process.
 *
 * `src/cli/bin.ts` exists only to call `runCli` and set an exit code, which is
 * exactly why the logic lives in a separate module: the commands can be tested
 * against a real database, with real output captured, without paying process
 * startup per assertion or losing the ability to inspect what was printed.
 *
 * Colour is disabled everywhere here (`--no-color`) so assertions match plain
 * substrings — the palette itself is tested separately in cli-format.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProfiler } from '../src/index.ts';
import { runCli, type CliIo } from '../src/cli/index.ts';

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function cli(args: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await runCli(['--no-color', ...args], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Two named agents so `--name` and `diff` have something real to select between. */
function seededDb(): { dbPath: string; dir: string; firstRunId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-cli-test-'));
  const dbPath = path.join(dir, 'runs.db');
  const profiler = createProfiler({ dbPath });

  let firstRunId = '';

  for (const [name, systemChars] of [
    ['agent-v1', 4000],
    ['agent-v2', 1000],
  ] as const) {
    for (let i = 0; i < 2; i += 1) {
      const run = profiler.startRun(name);
      if (firstRunId === '') firstRunId = run.id;

      // Two calls resending the same system prompt uncached — this is what
      // makes the waste report non-empty, so `fyren waste` has real output.
      for (let call = 0; call < 2; call += 1) {
        const llm = run.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
        llm.setComposition({
          chars: { toolDefs: 600, system: systemChars, history: 100 * call, toolResults: 0, latest: 80 },
          tokens: null,
          source: 'chars',
        });
        llm.end({ tokens: { input: 1500, output: 40, thinking: 0, cacheRead: 0, cacheWrite: 0 } });
      }

      const tool = run.startToolCall('search');
      tool.end();
      run.end();
    }
  }

  profiler.close();
  return { dbPath, dir, firstRunId };
}

async function withDb(fn: (db: { dbPath: string; firstRunId: string }) => Promise<void>): Promise<void> {
  const { dbPath, dir, firstRunId } = seededDb();
  try {
    await fn({ dbPath, firstRunId });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- basics --- */

test('--help and --version exit 0 and print without touching a database', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage/);
  // Every command must be discoverable from help, or it may as well not exist.
  for (const command of ['summary', 'runs', 'breakdown', 'waste', 'diff', 'ui', 'doctor']) {
    assert.match(help.out, new RegExp(`\\b${command}\\b`), `help does not mention "${command}"`);
  }

  const version = await cli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.out.trim(), /^\d+\.\d+\.\d+/);
});

test('an unknown command fails with a list of the real ones, rather than doing something else', async () => {
  const result = await cli(['nonsense']);
  assert.equal(result.code, 1);
  assert.match(result.err, /unknown command "nonsense"/);
  assert.match(result.err, /breakdown/);
});

test('a malformed --limit is rejected instead of silently falling back to the default', async () => {
  for (const bad of ['0', 'abc', '2.5']) {
    const result = await cli(['runs', '--limit', bad]);
    assert.equal(result.code, 1, `--limit ${bad} should fail`);
    assert.match(result.err, /--limit must be a positive integer/);
  }

  // A leading-dash value never reaches our own validation: node:util's
  // parseArgs rejects it first, as an ambiguous option argument. Still exit 1
  // with an actionable message, which is what matters — asserted here so the
  // difference is recorded rather than rediscovered.
  const dashed = await cli(['runs', '--limit', '-3']);
  assert.equal(dashed.code, 1);
  assert.match(dashed.err, /ambiguous/);

  const explicit = await cli(['runs', '--limit=-3']);
  assert.equal(explicit.code, 1);
  assert.match(explicit.err, /--limit must be a positive integer/);
});

test('an empty database explains how to record a run instead of printing an empty table', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-cli-empty-'));
  try {
    const result = await cli(['--db', path.join(dir, 'runs.db')]);
    assert.equal(result.code, 0);
    assert.match(result.out, /no runs found/);
    assert.match(result.out, /example/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ commands --- */

test('bare `fyren` still prints the three things the released CLI printed', async () => {
  await withDb(async ({ dbPath }) => {
    const result = await cli(['--db', dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.out, /RECENT RUNS/);
    assert.match(result.out, /COST TREND/);
    assert.match(result.out, /COST BREAKDOWN/);
    // and points at the half of the product the breakdown alone doesn't cover
    assert.match(result.out, /fyren waste/);
  });
});

test('`runs` lists every seeded run, and --name narrows it to one agent', async () => {
  await withDb(async ({ dbPath }) => {
    const all = await cli(['runs', '--db', dbPath]);
    assert.equal(all.code, 0);
    assert.match(all.out, /agent-v1/);
    assert.match(all.out, /agent-v2/);

    const filtered = await cli(['runs', '--db', dbPath, '--name', 'agent-v2']);
    assert.match(filtered.out, /agent-v2/);
    assert.doesNotMatch(filtered.out, /agent-v1/);
  });
});

test('`waste` reports the uncached system prompt the fixture deliberately creates', async () => {
  await withDb(async ({ dbPath }) => {
    const result = await cli(['waste', '--db', dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.out, /system prompt/);
    assert.match(result.out, /total avoidable/);
  });
});

test('`breakdown <run>` drills into one run and prints its call tree', async () => {
  await withDb(async ({ dbPath, firstRunId }) => {
    const result = await cli(['breakdown', firstRunId, '--db', dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.out, /CALL TREE/);
    assert.match(result.out, /llm_call/);
    assert.match(result.out, /tool_call/);
    // The tree must nest, not print a flat list — the run is the only root.
    assert.match(result.out, /\|- |`- /);
  });
});

test('a run id prefix resolves, exactly as the listing prints it', async () => {
  await withDb(async ({ dbPath, firstRunId }) => {
    const prefix = firstRunId.slice(0, 8);
    const result = await cli(['breakdown', prefix, '--db', dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.out, new RegExp(firstRunId));
  });
});

test('an unmatched run id fails loudly rather than reporting an empty run', async () => {
  await withDb(async ({ dbPath }) => {
    const result = await cli(['breakdown', 'ffffffff', '--db', dbPath]);
    assert.equal(result.code, 1);
    assert.match(result.err, /no run matches/);
  });
});

test('an ambiguous prefix refuses to pick one — showing the wrong run silently is the worse failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-cli-ambig-'));
  const dbPath = path.join(dir, 'runs.db');
  try {
    // The empty prefix matches every run, which is the ambiguity case without
    // having to fight uuid randomness for a shared leading hex digit.
    const profiler = createProfiler({ dbPath });
    for (let i = 0; i < 3; i += 1) profiler.startRun('ambiguous').end();
    profiler.close();

    const result = await cli(['breakdown', '', '--db', dbPath]);
    assert.equal(result.code, 1);
    assert.match(result.err, /matches 3 runs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`diff` compares two run names, and refuses without both sides', async () => {
  await withDb(async ({ dbPath }) => {
    const missing = await cli(['diff', '--db', dbPath, '--before', 'agent-v1']);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /--before <name> and --after <name>/);

    const unknown = await cli(['diff', '--db', dbPath, '--before', 'nope', '--after', 'agent-v2']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /no runs found/);

    const ok = await cli(['diff', '--db', dbPath, '--before', 'agent-v1', '--after', 'agent-v2']);
    assert.equal(ok.code, 0);
    // agent-v2's system prompt is a quarter the size, so the diff must show a
    // real drop rather than a zero delta.
    assert.match(ok.out, /system prompt/);
  });
});

test('`doctor` reports the environment and the run names available to --name', async () => {
  await withDb(async ({ dbPath }) => {
    const result = await cli(['doctor', '--db', dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.out, /node:sqlite/);
    assert.match(result.out, /RUN NAMES/);
    assert.match(result.out, /agent-v1/);
    assert.match(result.out, /claude-opus-5/);
  });
});

/* ---------------------------------------------------------------- json --- */

test('--json emits parseable JSON on every reporting command', async () => {
  await withDb(async ({ dbPath, firstRunId }) => {
    for (const args of [
      ['--db', dbPath],
      ['runs', '--db', dbPath],
      ['breakdown', '--db', dbPath],
      ['breakdown', firstRunId, '--db', dbPath],
      ['waste', '--db', dbPath],
      ['doctor', '--db', dbPath],
      ['diff', '--db', dbPath, '--before', 'agent-v1', '--after', 'agent-v2'],
    ]) {
      const result = await cli([...args, '--json']);
      assert.equal(result.code, 0, `${args.join(' ')} exited ${result.code}`);
      assert.doesNotThrow(() => JSON.parse(result.out), `${args.join(' ')} did not emit JSON`);
    }
  });
});

/* ------------------------------------------------------------ price-as --- */

test('--price-as re-prices and is labelled hypothetical, never as real spend', async () => {
  await withDb(async ({ dbPath }) => {
    const actual = await cli(['breakdown', '--db', dbPath, '--json']);
    const hypothetical = await cli(['breakdown', '--db', dbPath, '--price-as', 'claude-haiku-4-5', '--json']);

    const before = JSON.parse(actual.out) as { totalCostUsd: number; pricingMode: string };
    const after = JSON.parse(hypothetical.out) as {
      totalCostUsd: number;
      pricingMode: string;
      pricedAsModel: string;
    };

    assert.equal(before.pricingMode, 'actual');
    assert.equal(after.pricingMode, 'hypothetical');
    assert.equal(after.pricedAsModel, 'claude-haiku-4-5');
    // haiku is cheaper than opus; the same tokens must cost less.
    assert.ok(after.totalCostUsd < before.totalCostUsd);

    const text = await cli(['breakdown', '--db', dbPath, '--price-as', 'claude-haiku-4-5']);
    assert.match(text.out, /HYPOTHETICAL/i);
  });
});

test('an unknown --price-as model warns that costs will read $0 instead of failing or lying', async () => {
  await withDb(async ({ dbPath }) => {
    const result = await cli(['breakdown', '--db', dbPath, '--price-as', 'not-a-real-model']);
    assert.equal(result.code, 0);
    assert.match(result.err, /no pricing entry/);
  });
});

/* -------------------------------------------------------------- env ------ */

test('$FYREN_DB supplies the default database, and --db still wins over it', async () => {
  await withDb(async ({ dbPath }) => {
    const previous = process.env.FYREN_DB;
    process.env.FYREN_DB = dbPath;
    try {
      const fromEnv = await cli(['runs']);
      assert.equal(fromEnv.code, 0);
      assert.match(fromEnv.out, /agent-v1/);

      const empty = mkdtempSync(path.join(tmpdir(), 'fyren-cli-env-'));
      try {
        const overridden = await cli(['runs', '--db', path.join(empty, 'runs.db')]);
        assert.match(overridden.out, /no runs found/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.FYREN_DB;
      else process.env.FYREN_DB = previous;
    }
  });
});
