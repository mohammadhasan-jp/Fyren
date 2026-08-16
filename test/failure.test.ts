/**
 * The profiler must never break the program it is profiling.
 *
 * These are the tests for that promise — the error paths, not the happy one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProfiler, wrapAnthropic, Storage, WriteQueue } from '../src/index.ts';
import type { AnthropicLike } from '../src/providers/anthropic.ts';

function throwingClient(error: Error): AnthropicLike {
  return {
    messages: {
      async create() {
        throw error;
      },
    },
  };
}

test('a failing model call rethrows the caller original error, unchanged', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const original = new Error('rate_limit_error: slow down');
  const run = profiler.startRun('agent');
  const client = wrapAnthropic(throwingClient(original), run);

  const thrown = await client.messages
    .create({ model: 'claude-opus-5', messages: [] })
    .then(() => null)
    .catch((err: unknown) => err);

  assert.equal(thrown, original, 'the very same Error instance must come back');
  profiler.close();
});

test('a failing model call is still recorded as an error node', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const client = wrapAnthropic(throwingClient(new Error('boom')), run);

  await assert.rejects(client.messages.create({ model: 'claude-opus-5', messages: [] }));
  run.end();

  const call = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.ok(call);
  assert.equal(call.status, 'error');
  assert.match(call.error ?? '', /boom/);
  assert.equal(call.provider, 'anthropic');
  // composition is still recorded, so a failed call is not a blind spot
  assert.ok(call.inputComposition);
  profiler.close();
});

test('a storage failure is swallowed and reported, never thrown', () => {
  const storage = new Storage(':memory:');
  storage.close(); // every subsequent write will throw

  const errors: unknown[] = [];
  const queue = new WriteQueue(storage, { onError: (err) => errors.push(err) });

  queue.enqueue({
    kind: 'composition',
    id: 'nope',
    inputComposition: {
      chars: { toolDefs: 0, system: 0, history: 0, toolResults: 0, latest: 0 },
      tokens: null,
      source: 'chars',
    },
  });

  assert.doesNotThrow(() => queue.flush());
  assert.equal(errors.length, 1);
  assert.equal(queue.pending, 0, 'the failed batch is dropped, not retried forever');
});

test('enqueue is non-blocking: nothing reaches the database until a flush', () => {
  const storage = new Storage(':memory:');
  const queue = new WriteQueue(storage, { flushIntervalMs: 60_000 });

  queue.enqueue({
    kind: 'insert',
    node: {
      id: 'n1',
      parentId: null,
      rootId: 'n1',
      type: 'run',
      name: 'agent',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      provider: null,
      model: null,
      cacheSupported: true,
      error: null,
      metadata: {},
      inputComposition: null,
    },
  });

  assert.equal(queue.pending, 1);
  assert.equal(storage.getTree('n1').length, 0, 'not written yet');

  queue.flush();
  assert.equal(queue.pending, 0);
  assert.equal(storage.getTree('n1').length, 1, 'written after flush');
  storage.close();
});

test('a queue closed mid-flight drops later events instead of throwing', () => {
  const storage = new Storage(':memory:');
  const queue = new WriteQueue(storage);
  queue.close();

  assert.doesNotThrow(() =>
    queue.enqueue({
      kind: 'composition',
      id: 'x',
      inputComposition: {
        chars: { toolDefs: 0, system: 0, history: 0, toolResults: 0, latest: 0 },
        tokens: null,
        source: 'chars',
      },
    }),
  );
  assert.equal(queue.pending, 0);
  storage.close();
});

test('a stream that rejects does not produce an unhandled rejection', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const failure = new Error('stream died');

  const client: AnthropicLike = {
    messages: {
      async create() {
        throw new Error('unused');
      },
      stream() {
        return { finalMessage: () => Promise.reject(failure) };
      },
    },
  };

  const run = profiler.startRun('agent');
  const wrapped = wrapAnthropic(client, run);
  const stream = wrapped.messages.stream!({ model: 'claude-opus-5', messages: [] });

  // The caller sees the real error from their own await...
  await assert.rejects(stream.finalMessage(), /stream died/);
  // ...and the node is recorded as failed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  run.end();

  const call = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.equal(call?.status, 'error');
  profiler.close();
});

test('precise counting failures are isolated from the response', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const errors: unknown[] = [];

  const client: AnthropicLike = {
    messages: {
      async create() {
        return { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 2 } };
      },
      async countTokens() {
        throw new Error('count_tokens rate limited');
      },
    },
  };

  const run = profiler.startRun('agent');
  const wrapped = wrapAnthropic(client, run, {
    precise: true,
    onPreciseError: (err) => errors.push(err),
  });

  const response = await wrapped.messages.create({
    model: 'claude-opus-5',
    system: 'hello',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(response.usage?.input_tokens, 10, 'the caller still gets their response');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);

  run.end();
  const call = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.equal(call?.status, 'ok');
  assert.equal(call?.inputComposition?.source, 'chars', 'falls back to the estimate');
  profiler.close();
});

test('precise mode is atomic: a failure partway through never leaves a half-measured composition', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  let calls = 0;

  // Baseline succeeds, "system" segment succeeds, then "tools" fails — simulating
  // a count_tokens call that starts succeeding and then hits a rate limit.
  const client: AnthropicLike = {
    messages: {
      async create() {
        return { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 2 } };
      },
      async countTokens() {
        calls += 1;
        if (calls <= 2) return { input_tokens: 5 };
        throw new Error('rate_limit_error');
      },
    },
  };

  const run = profiler.startRun('agent');
  const wrapped = wrapAnthropic(client, run, { precise: true, onPreciseError: () => {} });
  await wrapped.messages.create({
    model: 'claude-opus-5',
    system: 'hello',
    tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  run.end();

  const call = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  // Never "count_tokens for system but chars for everything else" — the whole
  // composition reverts to the estimate as one unit.
  assert.equal(call?.inputComposition?.source, 'chars');
  assert.equal(call?.inputComposition?.tokens, null);
  profiler.close();
});

/**
 * Shutdown safety.
 *
 * A real run of examples/run-real-agent.ts hit an API failure (insufficient
 * credit) and the process then crashed with a native libuv assertion on
 * Windows (`UV_HANDLE_CLOSING`) instead of exiting cleanly. Root cause: the
 * script's error handler called `process.exit(1)` without ever calling
 * `profiler.close()` — the SQLite handle was still open, mid-write, when the
 * process was force-killed. These tests cover the guarantees the fix rests
 * on. They cannot reproduce the native crash itself (that's an OS/timing-
 * dependent libuv interaction, not something a fast, portable unit test
 * should try to force) — instead they pin the three things that make the fix
 * correct: data survives, close() doesn't itself throw when called from more
 * than one place, and no rejection escapes to the process as "unhandled".
 */

test('close() is idempotent — a second call never throws, even after a failure', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const client = throwingClient(new Error('insufficient credit'));
  const run = profiler.startRun('agent');
  const wrapped = wrapAnthropic(client, run);

  await assert.rejects(wrapped.messages.create({ model: 'claude-haiku-4-5', messages: [] }));
  run.end();

  assert.doesNotThrow(() => profiler.close());
  assert.doesNotThrow(() => profiler.close(), 'a second close() — e.g. from a finally AND a catch — must be a no-op');
});

test('data recorded before a mid-run API failure survives close(), and is readable after reopening the same file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fyren-test-'));
  const dbPath = path.join(dir, 'runs.db');

  try {
    const profiler = createProfiler({ dbPath });

    const goodClient: AnthropicLike = {
      messages: {
        async create() {
          return { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 2 } };
        },
      },
    };
    const badClient = throwingClient(new Error('insufficient credit'));

    let firstRunId = '';
    await profiler.run('session-one', async (run) => {
      firstRunId = run.rootId;
      await wrapAnthropic(goodClient, run).messages.create({ model: 'claude-haiku-4-5', messages: [] });
    });

    let failedRunId = '';
    await assert.rejects(
      profiler.run('session-two', async (run) => {
        failedRunId = run.rootId;
        await wrapAnthropic(badClient, run).messages.create({ model: 'claude-haiku-4-5', messages: [] });
      }),
    );

    // The behavior under test: shutdown after a failure must flush to disk,
    // not just to the in-process buffer, and must not itself throw.
    assert.doesNotThrow(() => profiler.close());

    // A fresh Storage instance, pointed at the same file — this is what
    // "survived the process" actually means: not the same object, a new
    // reader against the bytes left on disk.
    const reopened = new Storage(dbPath);
    try {
      const successfulSession = reopened.getTree(firstRunId);
      assert.equal(successfulSession.length, 2, 'run + llm_call');
      assert.equal(successfulSession.find((n) => n.type === 'run')?.status, 'ok');

      const failedSession = reopened.getTree(failedRunId);
      assert.equal(failedSession.length, 2, 'the failed run itself is still recorded, not lost');
      assert.equal(failedSession.find((n) => n.type === 'run')?.status, 'error');
      assert.match(
        failedSession.find((n) => n.type === 'llm_call')?.error ?? '',
        /insufficient credit/,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mid-run API failure produces no unhandled rejection', async () => {
  const seen: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const profiler = createProfiler({ dbPath: ':memory:' });
    const client = throwingClient(new Error('insufficient credit'));

    await assert.rejects(
      profiler.run('agent', async (run) => {
        await wrapAnthropic(client, run).messages.create({ model: 'claude-haiku-4-5', messages: [] });
      }),
    );
    profiler.close();

    // Unhandled rejections surface asynchronously — give the microtask/timer
    // queue a turn before asserting none showed up.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [], 'the failure must be fully handled by the awaited rejects, nothing left dangling');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('unknown models are recorded but priced at zero rather than throwing', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const call = run.startLlmCall('mystery', { model: 'some-unreleased-model' });
  call.end({ tokens: { input: 1000, output: 500 } });
  run.end();

  const node = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.equal(node?.tokens.input, 1000);
  assert.equal(node?.costUsd, 0);
  profiler.close();
});
