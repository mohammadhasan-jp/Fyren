/**
 * Analysis #3 — Version Diff.
 *
 * Invariants:
 *   - the usage side is nothing but `aggregateCostBreakdown` applied to each
 *     side, then diffed — no independent token math to get wrong
 *   - tool-call frequency is counted per NAME, across every tree on a side,
 *     and compared as an average-per-run so unequal run counts stay fair
 *   - a tool called on only one side still appears, with a zero count on
 *     the other — never silently dropped
 *   - mismatched pricing bases (mixed, or hypothetical under different
 *     models) between the two sides make the cost delta unusable, and say so
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffVersions, formatVersionDiff } from '../src/analysis/version-diff.ts';
import { createProfiler } from '../src/index.ts';
import type { InputComposition, RunNode, SegmentSizes, TokenBreakdown } from '../src/index.ts';

function composition(chars: Partial<SegmentSizes>): InputComposition {
  const full: SegmentSizes = { toolDefs: 0, system: 0, history: 0, toolResults: 0, latest: 0, ...chars };
  return { chars: full, tokens: null, source: 'chars' };
}

function tokens(t: Partial<TokenBreakdown>): TokenBreakdown {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, ...t };
}

function node(overrides: {
  id: string;
  type: RunNode['type'];
  parentId: string | null;
  rootId: string;
  startedAt: number;
  endedAt?: number | null;
  status?: RunNode['status'];
  name?: string;
  model?: string | null;
  tokens?: TokenBreakdown;
  inputComposition?: InputComposition | null;
  cacheSupported?: boolean;
}): RunNode {
  return {
    id: overrides.id,
    parentId: overrides.parentId,
    rootId: overrides.rootId,
    type: overrides.type,
    name: overrides.name ?? overrides.type,
    status: overrides.status ?? 'ok',
    startedAt: overrides.startedAt,
    endedAt: overrides.endedAt === undefined ? overrides.startedAt + 1 : overrides.endedAt,
    durationMs: 1,
    tokens: overrides.tokens ?? tokens({}),
    costUsd: 0,
    provider: overrides.model ? 'anthropic' : null,
    model: overrides.model ?? null,
    cacheSupported: overrides.cacheSupported ?? true,
    error: null,
    metadata: {},
    inputComposition: overrides.inputComposition ?? null,
  };
}

/** One run: a root, an llm_call with the given system-prompt size, and N named tool calls. */
function run(runId: string, systemChars: number, toolNames: readonly string[]): RunNode[] {
  return [
    node({ id: runId, type: 'run', parentId: null, rootId: runId, startedAt: 0, endedAt: 100 }),
    node({
      id: `${runId}-llm`,
      type: 'llm_call',
      parentId: runId,
      rootId: runId,
      startedAt: 1,
      endedAt: 2,
      model: 'claude-opus-5',
      tokens: tokens({ input: systemChars }),
      inputComposition: composition({ system: systemChars }),
    }),
    ...toolNames.map((name, i) =>
      node({
        id: `${runId}-tool-${i}`,
        type: 'tool_call',
        parentId: runId,
        rootId: runId,
        startedAt: 3 + i,
        endedAt: 4 + i,
        name,
      }),
    ),
  ];
}

test('the usage side is exactly the delta between the two sides aggregateCostBreakdown', () => {
  const before = [run('b1', 1000, [])];
  const after = [run('a1', 400, [])];

  const diff = diffVersions(before, after);
  assert.equal(diff.before.totalInputTokens, 1000);
  assert.equal(diff.after.totalInputTokens, 400);

  const systemDelta = diff.segments.find((s) => s.segment === 'system')!;
  assert.equal(systemDelta.beforeTokens, 1000);
  assert.equal(systemDelta.afterTokens, 400);
  assert.equal(systemDelta.tokensDelta, -600);
  assert.ok(systemDelta.costDelta < 0, 'a shrunk system prompt costs less');

  assert.ok(diff.totalCostDelta < 0);
  assert.equal(diff.totalCostDeltaPct, (diff.after.totalCostUsd - diff.before.totalCostUsd) / diff.before.totalCostUsd);
});

test('a tool called on only one side appears with a zero count on the other, not dropped', () => {
  const before = [run('b1', 100, ['search_docs'])];
  const after = [run('a1', 100, ['search_docs', 'get_related_topics'])];

  const diff = diffVersions(before, after);
  const names = diff.toolCallFrequency.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_related_topics', 'search_docs']);

  const related = diff.toolCallFrequency.find((t) => t.name === 'get_related_topics')!;
  assert.equal(related.beforeCount, 0);
  assert.equal(related.afterCount, 1);
  assert.equal(related.delta, 1);
});

test('tool call frequency is averaged per run, so unequal run counts stay comparable', () => {
  // before: 2 runs, 1 call each (avg 0.5). after: 1 run, 1 call (avg 1.0).
  const before = [run('b1', 100, ['search_docs']), run('b2', 100, [])];
  const after = [run('a1', 100, ['search_docs'])];

  const diff = diffVersions(before, after);
  const finding = diff.toolCallFrequency.find((t) => t.name === 'search_docs')!;
  assert.equal(finding.beforeCount, 1);
  assert.equal(finding.beforeAvgPerRun, 0.5);
  assert.equal(finding.afterCount, 1);
  assert.equal(finding.afterAvgPerRun, 1);
});

test('tool call frequency is sorted by |delta| descending', () => {
  const before = [run('b1', 100, ['a', 'a', 'a', 'b'])];
  const after = [run('a1', 100, ['a', 'b', 'b', 'b', 'b'])];

  const diff = diffVersions(before, after);
  // 'a': 3 -> 1, delta -2 (|2|). 'b': 1 -> 4, delta +3 (|3|). 'b' first.
  assert.deepEqual(
    diff.toolCallFrequency.map((t) => t.name),
    ['b', 'a'],
  );
});

test('no tool calls on either side yields an empty frequency list, not an error', () => {
  const diff = diffVersions([run('b1', 100, [])], [run('a1', 100, [])]);
  assert.deepEqual(diff.toolCallFrequency, []);
});

test('totalCostDeltaPct is null, not Infinity, when the before side cost is zero', () => {
  const before = [
    [
      node({ id: 'b1', type: 'run', parentId: null, rootId: 'b1', startedAt: 0, endedAt: 10 }),
      node({
        id: 'b1-llm',
        type: 'llm_call',
        parentId: 'b1',
        rootId: 'b1',
        startedAt: 1,
        endedAt: 2,
        model: 'unpriced-model-xyz',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      }),
    ],
  ];
  const after = [run('a1', 100, [])];

  const diff = diffVersions(before, after);
  assert.equal(diff.before.totalCostUsd, 0);
  assert.equal(diff.totalCostDeltaPct, null);
});

test('mismatched pricing bases (hypothetical under different models) mark the diff not comparable', () => {
  const before = [run('b1', 100, [])];
  const after = [run('a1', 100, [])];

  const diff = diffVersions(before, after, {
    before: { priceAs: 'claude-haiku-4-5' },
    after: { priceAs: 'claude-opus-5' },
  });
  assert.equal(diff.pricingComparable, false);
  assert.match(formatVersionDiff(diff), /PRICING BASES DIFFER/);
});

test('the same priceAs model on both sides IS comparable', () => {
  const before = [run('b1', 100, [])];
  const after = [run('a1', 50, [])];

  const diff = diffVersions(before, after, {
    before: { priceAs: 'claude-haiku-4-5' },
    after: { priceAs: 'claude-haiku-4-5' },
  });
  assert.equal(diff.pricingComparable, true);
  assert.doesNotMatch(formatVersionDiff(diff), /PRICING BASES DIFFER/);
});

test('formatVersionDiff renders a readable report with segments and tool frequency', () => {
  const before = [run('b1', 1000, ['search_docs', 'search_docs'])];
  const after = [run('a1', 400, ['search_docs'])];

  const text = formatVersionDiff(diffVersions(before, after));
  assert.match(text, /version diff:/);
  assert.match(text, /total cost:/);
  assert.match(text, /system prompt/);
  assert.match(text, /search_docs/);
  assert.match(text, /2\.0 → 1\.0/);
});

/* ================== through the real Profiler/storage layer ================== */

test('profiler.versionDiff groups before/after purely by run name, through real storage', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });

  for (let i = 0; i < 2; i += 1) {
    const r = profiler.startRun('agent-v1');
    const call = r.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
    call.setComposition(composition({ system: 1000 }));
    call.end({ tokens: tokens({ input: 1000 }) });
    const tool = r.startToolCall('search_docs');
    tool.end();
    r.end();
  }

  const r2 = profiler.startRun('agent-v2');
  const call2 = r2.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
  call2.setComposition(composition({ system: 300 }));
  call2.end({ tokens: tokens({ input: 300 }) });
  const tool2a = r2.startToolCall('search_docs');
  tool2a.end();
  const tool2b = r2.startToolCall('get_related_topics');
  tool2b.end();
  r2.end();

  const diff = profiler.versionDiff({
    before: { name: 'agent-v1', limit: 10 },
    after: { name: 'agent-v2', limit: 10 },
  });

  assert.equal(diff.before.runCount, 2);
  assert.equal(diff.after.runCount, 1);

  const searchDocs = diff.toolCallFrequency.find((t) => t.name === 'search_docs')!;
  assert.equal(searchDocs.beforeAvgPerRun, 1);
  assert.equal(searchDocs.afterAvgPerRun, 1);

  const related = diff.toolCallFrequency.find((t) => t.name === 'get_related_topics')!;
  assert.equal(related.beforeCount, 0);
  assert.equal(related.afterCount, 1);

  const systemDelta = diff.segments.find((s) => s.segment === 'system')!;
  assert.ok(systemDelta.tokensDelta < 0, 'v2 has a shorter system prompt, on average');

  profiler.close();
});

test('profiler.versionDiff applies each side\'s own priceAs independently', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });

  const before = profiler.startRun('local-v1');
  const c1 = before.startLlmCall('qwen2.5:3b', { model: 'qwen2.5:3b', cacheSupported: false });
  c1.setComposition(composition({ system: 500 }));
  c1.end({ tokens: tokens({ input: 500 }) });
  before.end();

  const after = profiler.startRun('local-v2');
  const c2 = after.startLlmCall('qwen2.5:3b', { model: 'qwen2.5:3b', cacheSupported: false });
  c2.setComposition(composition({ system: 500 }));
  c2.end({ tokens: tokens({ input: 500 }) });
  after.end();

  const diff = profiler.versionDiff({
    before: { name: 'local-v1', limit: 10, priceAs: 'claude-haiku-4-5' },
    after: { name: 'local-v2', limit: 10 },
  });

  assert.equal(diff.before.pricingMode, 'hypothetical');
  assert.equal(diff.after.pricingMode, 'actual');
  assert.equal(diff.pricingComparable, false);

  profiler.close();
});
