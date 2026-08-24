/**
 * `listRunNames` and `resolveRunId` — the two lookups every user-facing
 * surface depends on to turn what it printed back into something it can be
 * asked about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProfiler } from '../src/index.ts';
import { Storage } from '../src/storage.ts';

test('listRunNames groups by name, counts runs, and orders by most recent use', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    // 'old' first so 'recent' genuinely has the later MAX(started_at).
    profiler.startRun('old').end();
    profiler.startRun('old').end();
    await new Promise((resolve) => setTimeout(resolve, 5));
    profiler.startRun('recent').end();

    const names = profiler.listRunNames();
    assert.deepEqual(
      names.map((entry) => [entry.name, entry.runCount]),
      [
        ['recent', 1],
        ['old', 2],
      ],
    );
    assert.ok(names[0]!.lastStartedAt >= names[1]!.lastStartedAt);
  } finally {
    profiler.close();
  }
});

test('listRunNames counts only run nodes — a step sharing a name must not inflate it', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    const run = profiler.startRun('shared-name');
    run.startStep('shared-name').end();
    run.startToolCall('shared-name').end();
    run.end();

    const names = profiler.listRunNames();
    assert.equal(names.length, 1);
    assert.equal(names[0]?.runCount, 1);
  } finally {
    profiler.close();
  }
});

test('resolveRunId accepts a full id and any unique prefix of one', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    const run = profiler.startRun('resolvable');
    run.end();
    profiler.flush();

    assert.deepEqual(profiler.resolveRunId(run.id), { kind: 'ok', id: run.id });
    assert.deepEqual(profiler.resolveRunId(run.id.slice(0, 8)), { kind: 'ok', id: run.id });
  } finally {
    profiler.close();
  }
});

test('resolveRunId reports no match rather than returning an arbitrary run', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    profiler.startRun('only-one').end();
    assert.deepEqual(profiler.resolveRunId('zzzzzzzz'), { kind: 'none' });
  } finally {
    profiler.close();
  }
});

test('resolveRunId reports ambiguity instead of picking one — the wrong run would be silent', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    for (let i = 0; i < 3; i += 1) profiler.startRun('many').end();

    // The empty prefix matches everything, which exercises the ambiguity path
    // without depending on two uuids happening to share a leading digit.
    const result = profiler.resolveRunId('');
    assert.equal(result.kind, 'ambiguous');
    if (result.kind === 'ambiguous') assert.equal(result.matches.length, 3);
  } finally {
    profiler.close();
  }
});

test('a full id that also prefixes other ids resolves to itself, not to ambiguity', () => {
  // Constructed directly through Storage: uuids never nest like this, but the
  // rule ("an exact hit wins") has to hold regardless of how the ids arose.
  const storage = new Storage(':memory:');
  try {
    const base = Date.now();
    for (const [index, id] of ['abc', 'abcdef', 'abcxyz'].entries()) {
      storage.applyBatch([
        {
          kind: 'insert',
          node: {
            id,
            parentId: null,
            rootId: id,
            type: 'run',
            name: 'nested-ids',
            status: 'ok',
            startedAt: base + index,
            endedAt: base + index,
            durationMs: 0,
            tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
            costUsd: 0,
            provider: null,
            model: null,
            cacheSupported: true,
            error: null,
            metadata: {},
            inputComposition: null,
          },
        },
      ]);
    }

    assert.deepEqual(storage.resolveRunId('abc'), { kind: 'ok', id: 'abc' });
    assert.deepEqual(storage.resolveRunId('abcd'), { kind: 'ok', id: 'abcdef' });
    assert.equal(storage.resolveRunId('ab').kind, 'ambiguous');
  } finally {
    storage.close();
  }
});

test('resolveRunId only ever resolves to a run, never to a step or call inside one', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  try {
    const run = profiler.startRun('with-children');
    const step = run.startStep('inner');
    step.end();
    run.end();
    profiler.flush();

    assert.deepEqual(profiler.resolveRunId(step.id), { kind: 'none' });
  } finally {
    profiler.close();
  }
});
