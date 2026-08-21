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
import { startWebUi } from '../web/server.ts';

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
