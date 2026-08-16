import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProfiler } from '../src/index.ts';
import type { RunNode } from '../src/index.ts';

function byName(tree: readonly RunNode[], name: string): RunNode {
  const node = tree.find((n) => n.name === name);
  assert.ok(node, `expected a node named "${name}"`);
  return node;
}

test('a run is its own root and has no parent', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  run.end();

  const tree = profiler.getTree(run.rootId);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.id, run.rootId);
  assert.equal(tree[0]!.rootId, run.rootId);
  assert.equal(tree[0]!.parentId, null);
  assert.equal(tree[0]!.type, 'run');
  profiler.close();
});

test('children carry their parent and inherit the run as root, at any depth', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const step = run.startStep('execute');
  const tool = step.startToolCall('search');
  const nested = tool.startLlmCall('claude-haiku-4-5');
  const deepest = nested.startToolCall('inner');

  for (const node of [deepest, nested, tool, step, run]) node.end();

  const tree = profiler.getTree(run.rootId);
  assert.equal(tree.length, 5);
  for (const node of tree) assert.equal(node.rootId, run.rootId);

  assert.equal(byName(tree, 'execute').parentId, run.id);
  assert.equal(byName(tree, 'search').parentId, step.id);
  assert.equal(byName(tree, 'claude-haiku-4-5').parentId, tool.id);
  assert.equal(byName(tree, 'inner').parentId, nested.id);
  profiler.close();
});

test('two runs never mix', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const a = profiler.startRun('a');
  a.startStep('a-step').end();
  const b = profiler.startRun('b');
  b.startStep('b-step').end();
  a.end();
  b.end();

  assert.deepEqual(
    profiler.getTree(a.rootId).map((n) => n.name).sort(),
    ['a', 'a-step'],
  );
  assert.deepEqual(
    profiler.getTree(b.rootId).map((n) => n.name).sort(),
    ['b', 'b-step'],
  );
  profiler.close();
});

test('a node is visible as running before it ends', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  run.startStep('in-flight');

  const tree = profiler.getTree(run.rootId);
  assert.equal(byName(tree, 'in-flight').status, 'running');
  assert.equal(byName(tree, 'in-flight').endedAt, null);
  profiler.close();
});

test('end() records tokens, cost and duration', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const call = run.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
  call.end({ tokens: { input: 1000, output: 100 } });
  run.end();

  const node = byName(profiler.getTree(run.rootId), 'claude-opus-5');
  assert.equal(node.status, 'ok');
  assert.equal(node.tokens.input, 1000);
  assert.equal(node.tokens.output, 100);
  // 1000 * $5/1M + 100 * $25/1M
  assert.equal(node.costUsd.toFixed(6), (0.005 + 0.0025).toFixed(6));
  assert.ok(node.durationMs !== null && node.durationMs >= 0);
  profiler.close();
});

test('end() is idempotent — a second call is ignored', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const step = run.startStep('once');
  step.end({ tokens: { input: 10 } });
  step.end({ tokens: { input: 99999 }, status: 'error' });
  run.end();

  const node = byName(profiler.getTree(run.rootId), 'once');
  assert.equal(node.tokens.input, 10);
  assert.equal(node.status, 'ok');
  profiler.close();
});

test('run() and step() close their node even when the body throws', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  let rootId = '';

  await assert.rejects(
    profiler.run('agent', async (run) => {
      rootId = run.rootId;
      await run.step('doomed', async () => {
        throw new Error('kaboom');
      });
    }),
    /kaboom/,
  );

  const tree = profiler.getTree(rootId);
  assert.equal(byName(tree, 'agent').status, 'error');
  assert.equal(byName(tree, 'doomed').status, 'error');
  assert.match(byName(tree, 'doomed').error ?? '', /kaboom/);
  profiler.close();
});

test('annotate merges metadata before end', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent', { metadata: { promptVersion: 1 } });
  run.annotate({ tenant: 'acme' });
  run.end({ metadata: { outcome: 'ok' } });

  const node = profiler.getTree(run.rootId)[0]!;
  assert.deepEqual(node.metadata, { promptVersion: 1, tenant: 'acme', outcome: 'ok' });
  profiler.close();
});

test('setComposition still lands after the node has ended', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const call = run.startLlmCall('claude-opus-5');
  call.end({ tokens: { input: 10 } });

  call.setComposition({
    chars: { toolDefs: 1, system: 2, history: 3, toolResults: 4, latest: 5 },
    tokens: { toolDefs: 1, system: 2, history: 3, toolResults: 4, latest: 5 },
    source: 'count_tokens',
  });
  run.end();

  const node = byName(profiler.getTree(run.rootId), 'claude-opus-5');
  assert.equal(node.inputComposition?.source, 'count_tokens');
  assert.equal(node.inputComposition?.tokens?.latest, 5);
  // the rest of the finished node survived the composition-only update
  assert.equal(node.tokens.input, 10);
  assert.equal(node.status, 'ok');
  profiler.close();
});

test('listRuns returns runs only, newest first, and filters by name', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  for (const name of ['alpha', 'beta', 'alpha']) {
    const run = profiler.startRun(name);
    run.startStep('inner').end();
    run.end();
  }

  const all = profiler.listRuns(10);
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => r.type === 'run'));
  assert.ok(all[0]!.startedAt >= all[all.length - 1]!.startedAt);

  const alphas = profiler.listRuns({ name: 'alpha' });
  assert.equal(alphas.length, 2);
  assert.ok(alphas.every((r) => r.name === 'alpha'));
  profiler.close();
});

test('getTrees fetches many runs at once, keyed by run id', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const ids = ['x', 'y'].map((name) => {
    const run = profiler.startRun(name);
    run.startStep(`${name}-step`).end();
    run.end();
    return run.rootId;
  });

  const trees = profiler.getTrees(ids);
  assert.equal(trees.size, 2);
  for (const id of ids) assert.equal(trees.get(id)?.length, 2);
  profiler.close();
});

test('enabled:false records nothing but keeps the same API', () => {
  const profiler = createProfiler({ dbPath: ':memory:', enabled: false });
  const run = profiler.startRun('agent');
  run.startStep('x').end();
  run.end();

  assert.equal(profiler.getTree(run.rootId).length, 0);
  assert.equal(profiler.listRuns(10).length, 0);
  profiler.close();
});
