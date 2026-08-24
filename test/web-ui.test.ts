/**
 * Real integration test — an actual server on an OS-assigned port, not a
 * mock. Matches this project's stated preference for testing against real
 * behavior (see AGENT.md rule #2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProfiler } from '../src/index.ts';
import type { AggregateCostBreakdown, RunCostBreakdown } from '../src/index.ts';
import { startWebUi } from '../src/web/server.ts';

interface SummaryResponse {
  breakdowns: RunCostBreakdown[];
  aggregate: AggregateCostBreakdown;
}

function seededDb(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-web-test-'));
  const dbPath = path.join(dir, 'runs.db');
  const profiler = createProfiler({ dbPath });

  for (let i = 0; i < 2; i += 1) {
    const run = profiler.startRun('web-ui-test-agent');
    const call = run.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
    call.setComposition({
      chars: { toolDefs: 0, system: 200, history: 0, toolResults: 0, latest: 100 },
      tokens: null,
      source: 'chars',
    });
    call.end({ tokens: { input: 300, output: 50, thinking: 0, cacheRead: 0, cacheWrite: 0 } });
    run.end();
  }

  profiler.close();
  return { dbPath, dir };
}

test('GET /api/summary returns the same shape costBreakdownRecent()/aggregateCostBreakdown() produce', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0, name: 'web-ui-test-agent' });

  try {
    const res = await fetch(`${ui.url}api/summary`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const body = (await res.json()) as SummaryResponse;
    assert.equal(body.breakdowns.length, 2);
    assert.equal(body.breakdowns[0]?.name, 'web-ui-test-agent');
    assert.ok(body.aggregate.totalCostUsd > 0);
    assert.equal(body.aggregate.runCount, 2);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET / serves the HTML shell, GET /app.js and /style.css serve the static assets', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const html = await fetch(ui.url);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await html.text(), /<title>fyren<\/title>/);

    const js = await fetch(`${ui.url}app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    const css = await fetch(`${ui.url}style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /css/);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown path 404s instead of leaking the filesystem', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const res = await fetch(`${ui.url}../../../etc/passwd`);
    assert.equal(res.status, 404);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close() shuts down both the http server and the profiler — a second close() on the profiler would throw if it were not idempotent', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  ui.close();
  assert.doesNotThrow(() => ui.close());

  rmSync(dir, { recursive: true, force: true });
});

test('an empty database reports zero runs through the API, not an error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-web-test-empty-'));
  const dbPath = path.join(dir, 'runs.db');
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const res = await fetch(`${ui.url}api/summary`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as SummaryResponse;
    assert.deepEqual(body.breakdowns, []);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ *
 * Endpoints added alongside the v2 UI: metadata, per-run drill-down, and
 * per-request selector overrides. Same rule as the rest of this file — a real
 * server on a real port, not a mocked request object.
 * ------------------------------------------------------------------------ */

interface MetaResponse {
  version: string;
  dbPath: string;
  runNames: Array<{ name: string; runCount: number; lastStartedAt: number }>;
  pricedModels: string[];
}

test('GET /api/meta describes the database well enough to build the filter controls', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const res = await fetch(`${ui.url}api/meta`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as MetaResponse;
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.equal(body.dbPath, dbPath);
    assert.deepEqual(
      body.runNames.map((entry) => [entry.name, entry.runCount]),
      [['web-ui-test-agent', 2]],
    );
    // The "price as" box offers these; every one must actually have a rate,
    // or picking a suggestion would silently produce a $0 report.
    assert.ok(body.pricedModels.includes('claude-opus-5'));
    assert.ok(body.pricedModels.length > 5);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/runs/<id> returns the breakdown, the waste report and the tree for one run', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const summary = (await (await fetch(`${ui.url}api/summary`)).json()) as SummaryResponse;
    const runId = summary.breakdowns[0]?.runId ?? '';

    const res = await fetch(`${ui.url}api/runs/${runId}`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      breakdown: RunCostBreakdown;
      waste: { runId: string; findings: unknown[] };
      tree: Array<{ id: string; type: string; parentId: string | null }>;
    };

    assert.equal(body.breakdown.runId, runId);
    assert.equal(body.waste.runId, runId);
    // run + llm_call, and the tree must be linked, not a flat orphan list.
    assert.equal(body.tree.length, 2);
    assert.ok(body.tree.some((node) => node.type === 'run' && node.parentId === null));
    assert.ok(body.tree.some((node) => node.type === 'llm_call' && node.parentId === body.tree.find((n) => n.type === 'run')?.id));
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/runs/<prefix> resolves a prefix, and 404s on one that matches nothing', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const summary = (await (await fetch(`${ui.url}api/summary`)).json()) as SummaryResponse;
    const runId = summary.breakdowns[0]?.runId ?? '';

    const byPrefix = await fetch(`${ui.url}api/runs/${runId.slice(0, 8)}`);
    assert.equal(byPrefix.status, 200);
    assert.equal(((await byPrefix.json()) as { breakdown: RunCostBreakdown }).breakdown.runId, runId);

    const missing = await fetch(`${ui.url}api/runs/ffffffffff`);
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /no run matches/);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('?priceAs re-prices through the API and is labelled hypothetical, never as real spend', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const actual = (await (await fetch(`${ui.url}api/summary`)).json()) as SummaryResponse;
    const hypothetical = (await (
      await fetch(`${ui.url}api/summary?priceAs=claude-haiku-4-5`)
    ).json()) as SummaryResponse;

    assert.equal(actual.aggregate.pricingMode, 'actual');
    assert.equal(hypothetical.aggregate.pricingMode, 'hypothetical');
    assert.equal(hypothetical.aggregate.pricedAsModel, 'claude-haiku-4-5');
    assert.ok(hypothetical.aggregate.totalCostUsd < actual.aggregate.totalCostUsd);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty ?name clears the server-level filter instead of being read as "no default"', async () => {
  const { dbPath, dir } = seededDb();
  const profiler = createProfiler({ dbPath });
  profiler.startRun('a-different-agent').end();
  profiler.close();

  // Started with --name, the way `fyren ui --name web-ui-test-agent` would.
  const ui = await startWebUi({ dbPath, port: 0, name: 'web-ui-test-agent' });

  try {
    const defaulted = (await (await fetch(`${ui.url}api/summary`)).json()) as SummaryResponse;
    assert.equal(defaulted.breakdowns.length, 2);

    const cleared = (await (await fetch(`${ui.url}api/summary?name=`)).json()) as SummaryResponse;
    assert.equal(cleared.breakdowns.length, 3);

    const other = (await (
      await fetch(`${ui.url}api/summary?name=a-different-agent`)
    ).json()) as SummaryResponse;
    assert.equal(other.breakdowns.length, 1);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nonsense ?limit falls back to the default rather than throwing or returning everything', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    for (const limit of ['abc', '-1', '0', '']) {
      const res = await fetch(`${ui.url}api/summary?limit=${limit}`);
      assert.equal(res.status, 200, `limit=${limit}`);
      assert.equal(((await res.json()) as SummaryResponse).breakdowns.length, 2);
    }
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown /api/ path returns a JSON 404, not the HTML shell', async () => {
  const { dbPath, dir } = seededDb();
  const ui = await startWebUi({ dbPath, port: 0 });

  try {
    const res = await fetch(`${ui.url}api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
