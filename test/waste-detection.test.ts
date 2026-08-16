/**
 * Waste Detection.
 *
 * Pattern #1 invariants:
 *   - a single call never produces a finding (nothing to compare against)
 *   - content that legitimately changes size does NOT get flagged
 *   - only `system` and `toolDefs` are ever checked — never history/toolResults/latest
 *   - genuine caching on a recurrence suppresses (or reduces) the finding
 *   - `cacheSupport: 'no'` still detects the pattern — it's structural, not a code bug
 *
 * Pattern #2 invariants:
 *   - a tool_call followed by ANY later llm_call anywhere in the run is not orphaned
 *   - a tool_call with no later llm_call, in a FINISHED run, is orphaned
 *   - a still-`running` run never flags its trailing tool call — it hasn't had its chance yet
 *   - a nested llm_call under an orphaned tool_call contributes real, priced cost
 *   - a pure-function tool with no nested cost is still flagged, just at $0
 *
 * Both patterns share `priceAs` flowing through exactly like cost-breakdown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectWaste,
  aggregateWaste,
  formatWasteReport,
  formatAggregateWasteReport,
  type StaticContentWasteFinding,
  type OrphanedToolCallFinding,
} from '../src/analysis/waste-detection.ts';
import { createProfiler } from '../src/index.ts';
import type { InputComposition, RunNode, SegmentSizes, TokenBreakdown } from '../src/index.ts';

function composition(chars: Partial<SegmentSizes>): InputComposition {
  const full: SegmentSizes = { toolDefs: 0, system: 0, history: 0, toolResults: 0, latest: 0, ...chars };
  return { chars: full, tokens: null, source: 'chars' };
}

function tokens(t: Partial<TokenBreakdown>): TokenBreakdown {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, ...t };
}

/** Narrow the union down to pattern #1 findings, the way calling code has to. */
function staticFindings(findings: readonly { type: string }[]): StaticContentWasteFinding[] {
  return findings.filter((f): f is StaticContentWasteFinding => f.type === 'uncached_static_content');
}
/** Narrow to pattern #2 findings. */
function toolFindings(findings: readonly { type: string }[]): OrphanedToolCallFinding[] {
  return findings.filter((f): f is OrphanedToolCallFinding => f.type === 'orphaned_tool_call');
}

function tree(
  calls: Array<{
    model?: string | null;
    tokens: TokenBreakdown;
    inputComposition?: InputComposition | null;
    cacheSupported?: boolean;
  }>,
  runName = 'agent',
): RunNode[] {
  const root: RunNode = {
    id: 'run-1',
    parentId: null,
    rootId: 'run-1',
    type: 'run',
    name: runName,
    status: 'ok',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    tokens: tokens({}),
    costUsd: 0,
    provider: null,
    model: null,
    cacheSupported: true,
    error: null,
    metadata: {},
    inputComposition: null,
  };

  return [
    root,
    ...calls.map((call, index) => ({
      id: `call-${index}`,
      parentId: 'run-1',
      rootId: 'run-1',
      type: 'llm_call' as const,
      name: call.model ?? 'unknown',
      status: 'ok' as const,
      startedAt: 2 + index,
      endedAt: 3 + index,
      durationMs: 1,
      tokens: call.tokens,
      costUsd: 0,
      provider: 'anthropic',
      model: call.model ?? null,
      cacheSupported: call.cacheSupported ?? true,
      error: null,
      metadata: {},
      inputComposition: call.inputComposition ?? null,
    })),
  ];
}

/** A free-form node builder, for the arbitrary tree shapes pattern #2 needs. */
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
  costUsd?: number;
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
    costUsd: overrides.costUsd ?? 0,
    provider: overrides.model ? 'anthropic' : null,
    model: overrides.model ?? null,
    cacheSupported: true,
    error: null,
    metadata: {},
    inputComposition: null,
  };
}

const STATIC_SYSTEM = { system: 750, toolDefs: 400 };

/* ================== pattern #1: uncached static content ================== */

test('a single call never produces a finding — nothing to compare against yet', () => {
  const report = detectWaste(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 1150 }), inputComposition: composition(STATIC_SYSTEM) }]),
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.totalAvoidableCostUsd, 0);
});

test('the same uncached system prompt resent across calls is flagged, with real token/cost math', () => {
  const report = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
    ]),
  );

  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.ok(finding);
  assert.equal(finding.baselineTokens, 750);
  assert.equal(finding.recurrences, 2); // calls 2 and 3; call 1 established the baseline
  assert.equal(finding.uncachedRecurrences, 2);
  assert.equal(finding.wastedTokens, 1500); // 750 * 2

  // claude-opus-5: $5/1M input. Avoidable = wasted * rate * (1 - 0.1 cache-read multiplier)
  assert.equal(finding.avoidableCostUsd.toFixed(9), (1500 * 5 * 0.9 / 1_000_000).toFixed(9));
  assert.equal(report.totalAvoidableCostUsd.toFixed(9), finding.avoidableCostUsd.toFixed(9));
});

test('content that legitimately changes size resets the baseline instead of being flagged', () => {
  const report = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'claude-opus-5', tokens: tokens({ input: 900 }), inputComposition: composition({ system: 900 }) }, // different size — a real edit
      { model: 'claude-opus-5', tokens: tokens({ input: 900 }), inputComposition: composition({ system: 900 }) }, // now matches the NEW baseline
    ]),
  );

  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.ok(finding, 'call 3 recurs against the new 900-token baseline set by call 2');
  assert.equal(finding.baselineTokens, 900);
  assert.equal(finding.recurrences, 1); // only call 3
});

test('a genuinely static segment is still recognized across calls even as the REST of the conversation grows', () => {
  // Regression test: the recurrence check must compare on character size
  // (which doesn't move when history grows around a static segment), not on
  // the per-call PROPORTIONAL token estimate (which drifts down as history's
  // share of the total grows, even though the segment's own content never
  // changed) — comparing on the drifting estimate would silently stop
  // recognizing a genuinely unchanged system prompt after a few turns.
  const report = detectWaste(
    tree([
      // call 1: system only, no history yet. 750 chars == 750 real tokens.
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      // call 2: SAME 750-char system prompt, but history has grown, and the
      // real total (1000) does not split proportionally the same way char
      // counts would predict (750/1250 * 1000 = 600 ≠ 750) — exactly the
      // drift this test exists to prove doesn't break detection.
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 1000 }),
        inputComposition: composition({ system: 750, history: 500 }),
      },
    ]),
  );

  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.ok(finding, 'the static system prompt must still be recognized as a recurrence');
  assert.equal(finding.recurrences, 1);
  // baselineTokens is reported in real TOKEN units (from call 1, where system
  // was the only segment) — not the raw 750-CHARACTER size, and not call 2's
  // drifted 600-token estimate.
  assert.equal(finding.baselineTokens, 750);
  assert.equal(finding.wastedTokens, 600, "call 2's own proportional token estimate is what gets billed and reported as waste");
});

test('only system and toolDefs are ever checked — history/toolResults/latest never produce a finding', () => {
  const report = detectWaste(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 900 }),
        inputComposition: composition({ history: 300, toolResults: 300, latest: 300 }),
      },
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 900 }),
        inputComposition: composition({ history: 300, toolResults: 300, latest: 300 }),
      },
    ]),
  );
  assert.deepEqual(staticFindings(report.findings), []);
});

test('a recurrence actually served from cache is not counted as waste', () => {
  const report = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      // second call: system fully cache-read, not fresh
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 750 }),
        inputComposition: composition({ system: 750 }),
      },
    ]),
  );
  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.equal(finding, undefined, 'properly cached recurrences are not waste');
});

test('a partially-cached recurrence counts only the fresh remainder as waste', () => {
  const report = detectWaste(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 400, cacheRead: 750 }),
        inputComposition: composition({ system: 750, toolDefs: 400 }), // toolDefs is the earlier, fully-cached prefix
      },
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 400, cacheRead: 750 }),
        inputComposition: composition({ system: 750, toolDefs: 400 }),
      },
    ]),
  );
  // toolDefs (front of the prefix) should be the cached part; system should be fresh.
  // Exact split depends on attributeCall's prefix fill — just assert system shows up as waste and toolDefs does not.
  const found = staticFindings(report.findings);
  assert.ok(found.some((f) => f.segment === 'system'));
  assert.ok(!found.some((f) => f.segment === 'toolDefs'));
});

test('both system and toolDefs can be flagged independently in the same run', () => {
  const report = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 1150 }), inputComposition: composition(STATIC_SYSTEM) },
      { model: 'claude-opus-5', tokens: tokens({ input: 1150 }), inputComposition: composition(STATIC_SYSTEM) },
    ]),
  );
  const segments = staticFindings(report.findings).map((f) => f.segment).sort();
  assert.deepEqual(segments, ['system', 'toolDefs']);
});

test('cacheSupport "no" still detects the pattern — it is structural, not a code bug', () => {
  const report = detectWaste(
    tree([
      {
        model: 'qwen2.5:3b',
        tokens: tokens({ input: 750 }),
        inputComposition: composition({ system: 750 }),
        cacheSupported: false,
      },
      {
        model: 'qwen2.5:3b',
        tokens: tokens({ input: 750 }),
        inputComposition: composition({ system: 750 }),
        cacheSupported: false,
      },
    ]),
  );
  assert.equal(report.cacheSupport, 'no');
  assert.ok(staticFindings(report.findings).some((f) => f.segment === 'system'));
  assert.match(formatWasteReport(report), /no caching concept at all/);
});

test('an unpriced model still tracks wasted tokens, just not a dollar figure', () => {
  const report = detectWaste(
    tree([
      { model: 'some-unreleased-model', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'some-unreleased-model', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
    ]),
  );
  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.ok(finding);
  assert.equal(finding.wastedTokens, 750);
  assert.equal(finding.avoidableCostUsd, 0);
});

test('priceAs re-prices the waste finding under a hypothetical model, labeled as such', () => {
  const treeData = tree([
    { model: 'qwen2.5:3b', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
    { model: 'qwen2.5:3b', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
  ]);
  const report = detectWaste(treeData, { priceAs: 'claude-haiku-4-5' });

  assert.equal(report.pricingMode, 'hypothetical');
  assert.equal(report.pricedAsModel, 'claude-haiku-4-5');
  const finding = staticFindings(report.findings).find((f) => f.segment === 'system')!;
  // $1/1M input for haiku, 750 wasted tokens, * 0.9
  assert.equal(finding.avoidableCostUsd.toFixed(9), (750 * 1 * 0.9 / 1_000_000).toFixed(9));

  const text = formatWasteReport(report);
  assert.match(text, /⚠⚠ HYPOTHETICAL COST — priced as claude-haiku-4-5, NOT real spend ⚠⚠/);
  assert.match(text, /hypothetical\)\./);
});

test('formatWasteReport says so plainly when nothing was found', () => {
  const report = detectWaste(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ latest: 100 }) }]),
  );
  assert.equal(report.findings.length, 0);
  assert.match(formatWasteReport(report), /no waste detected/);
});

/* ================== pattern #2: orphaned tool calls ================== */

test('a tool_call followed by a LATER llm_call anywhere in the run is not orphaned', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'llm1', type: 'llm_call', parentId: 'step', rootId: 'run', startedAt: 2, endedAt: 3, model: 'claude-opus-5' }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
    // a later llm_call — the model got the result back
    node({ id: 'llm2', type: 'llm_call', parentId: 'step', rootId: 'run', startedAt: 6, endedAt: 7, model: 'claude-opus-5' }),
  ];
  const report = detectWaste(t);
  assert.deepEqual(toolFindings(report.findings), []);
});

test('a tool_call with NO later llm_call, in a FINISHED run, is orphaned', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'llm1', type: 'llm_call', parentId: 'step', rootId: 'run', startedAt: 2, endedAt: 3, model: 'claude-opus-5' }),
    // this tool call is the LAST thing that happens — its result never reaches another model call
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
  ];
  const report = detectWaste(t);
  const finding = toolFindings(report.findings).find((f) => f.toolName === 'search_docs');
  assert.ok(finding);
  assert.equal(finding.occurrences, 1);
});

test('a still-running run never flags its trailing tool call — it has not had its chance yet', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: null, status: 'running' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: null, status: 'running' }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
  ];
  const report = detectWaste(t);
  assert.deepEqual(toolFindings(report.findings), []);
});

test('a tool call across steps counts as used if a later llm_call exists in a DIFFERENT step', () => {
  // The check is run-wide on purpose: an agent may legitimately end a step
  // right after a tool call and use the result in the NEXT step.
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step1', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 10 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step1', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
    node({ id: 'step2', type: 'step', parentId: 'run', rootId: 'run', startedAt: 11, endedAt: 20 }),
    node({ id: 'llm2', type: 'llm_call', parentId: 'step2', rootId: 'run', startedAt: 12, endedAt: 13, model: 'claude-opus-5' }),
  ];
  const report = detectWaste(t);
  assert.deepEqual(toolFindings(report.findings), []);
});

test('a nested llm_call under an orphaned tool_call contributes real, priced cost', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'llm1', type: 'llm_call', parentId: 'step', rootId: 'run', startedAt: 2, endedAt: 3, model: 'claude-opus-5' }),
    node({
      id: 'tool1',
      type: 'tool_call',
      parentId: 'step',
      rootId: 'run',
      startedAt: 4,
      endedAt: 8,
      name: 'summarize_search',
    }),
    // a tool that summarizes its own output via a nested model call — see examples/doc-qa-agent.ts
    node({
      id: 'nested-llm',
      type: 'llm_call',
      parentId: 'tool1',
      rootId: 'run',
      startedAt: 5,
      endedAt: 6,
      model: 'claude-haiku-4-5',
      tokens: tokens({ input: 1_000_000, output: 0 }),
    }),
  ];
  const report = detectWaste(t);
  const finding = toolFindings(report.findings).find((f) => f.toolName === 'summarize_search');
  assert.ok(finding);
  // claude-haiku-4-5: $1/1M input, 1,000,000 input tokens spent producing a
  // result that was then discarded.
  assert.equal(finding.avoidableCostUsd.toFixed(9), (1).toFixed(9));
});

test('a pure-function tool with no nested LLM cost is still flagged, just at $0', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'llm1', type: 'llm_call', parentId: 'step', rootId: 'run', startedAt: 2, endedAt: 3, model: 'claude-opus-5' }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
  ];
  const report = detectWaste(t);
  const finding = toolFindings(report.findings).find((f) => f.toolName === 'search_docs');
  assert.ok(finding, 'the wasted WORK is still worth reporting even with no dollar figure');
  assert.equal(finding.avoidableCostUsd, 0);
});

test('multiple orphaned calls to the same tool are grouped into one finding', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
    node({ id: 'tool2', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 6, endedAt: 7, name: 'search_docs' }),
  ];
  const report = detectWaste(t);
  const found = toolFindings(report.findings);
  assert.equal(found.length, 1, 'one finding per tool NAME, not per occurrence');
  assert.equal(found[0]!.occurrences, 2);
});

test('different orphaned tools produce separate findings', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
    node({ id: 'tool2', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 6, endedAt: 7, name: 'get_related_topics' }),
  ];
  const report = detectWaste(t);
  const names = toolFindings(report.findings).map((f) => f.toolName).sort();
  assert.deepEqual(names, ['get_related_topics', 'search_docs']);
});

test('priceAs re-prices an orphaned tool call\'s nested LLM cost too', () => {
  const t = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({
      id: 'tool1',
      type: 'tool_call',
      parentId: 'step',
      rootId: 'run',
      startedAt: 4,
      endedAt: 8,
      name: 'summarize_search',
    }),
    node({
      id: 'nested-llm',
      type: 'llm_call',
      parentId: 'tool1',
      rootId: 'run',
      startedAt: 5,
      endedAt: 6,
      model: 'some-unreleased-model', // unpriced on its own
      tokens: tokens({ input: 1_000_000, output: 0 }),
    }),
  ];
  const withoutPricing = toolFindings(detectWaste(t).findings)[0]!;
  assert.equal(withoutPricing.avoidableCostUsd, 0, 'unpriced model, no priceAs — genuinely unknown');

  const withPricing = toolFindings(detectWaste(t, { priceAs: 'claude-haiku-4-5' }).findings)[0]!;
  assert.equal(withPricing.avoidableCostUsd.toFixed(9), (1).toFixed(9), '$1/1M haiku rate applied to the nested call');
});

test('formatWasteReport renders orphaned-tool findings, with and without a dollar figure', () => {
  const withCost = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 8, name: 'summarize' }),
    node({
      id: 'nested-llm',
      type: 'llm_call',
      parentId: 'tool1',
      rootId: 'run',
      startedAt: 5,
      endedAt: 6,
      model: 'claude-haiku-4-5',
      tokens: tokens({ input: 1_000_000 }),
    }),
  ];
  const textWithCost = formatWasteReport(detectWaste(withCost));
  assert.match(textWithCost, /orphaned tool call — "summarize" ran 1 time\(s\)/);
  assert.match(textWithCost, /\$1\.000000 of that was the tool's own LLM cost/);

  const withoutCost = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
  ];
  const textNoCost = formatWasteReport(detectWaste(withoutCost));
  assert.match(textNoCost, /orphaned tool call — "search_docs" ran 1 time\(s\)/);
  assert.doesNotMatch(textNoCost, /own LLM cost/);
});

/* ================== aggregation ================== */

test('aggregateWaste sums across runs and ranks findings by dollar impact', () => {
  const bigWaste = detectWaste(
    tree(
      [
        { model: 'claude-opus-5', tokens: tokens({ input: 2000 }), inputComposition: composition({ system: 2000 }) },
        { model: 'claude-opus-5', tokens: tokens({ input: 2000 }), inputComposition: composition({ system: 2000 }) },
      ],
      'agent',
    ),
  );
  const smallWaste = detectWaste(
    tree(
      [
        { model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ toolDefs: 100 }) },
        { model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ toolDefs: 100 }) },
      ],
      'agent',
    ),
  );

  const agg = aggregateWaste([bigWaste, smallWaste]);
  assert.equal(agg.runCount, 2);
  assert.equal(agg.runName, 'agent');
  const first = agg.findings[0]!;
  assert.equal(first.type, 'uncached_static_content');
  assert.equal(first.type === 'uncached_static_content' && first.segment, 'system', 'the larger dollar figure sorts first');
  assert.equal(first.affectedRunCount, 1);
  assert.equal(
    agg.totalAvoidableCostUsd.toFixed(9),
    (bigWaste.totalAvoidableCostUsd + smallWaste.totalAvoidableCostUsd).toFixed(9),
  );
});

test('aggregateWaste rolls up orphaned-tool-call findings across runs, separately from static-content ones', () => {
  const runA = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok', name: 'agent' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
  ];
  const runB = [
    node({ id: 'run', type: 'run', parentId: null, rootId: 'run', startedAt: 0, endedAt: 100, status: 'ok', name: 'agent' }),
    node({ id: 'step', type: 'step', parentId: 'run', rootId: 'run', startedAt: 1, endedAt: 100 }),
    node({ id: 'tool1', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 4, endedAt: 5, name: 'search_docs' }),
    node({ id: 'tool2', type: 'tool_call', parentId: 'step', rootId: 'run', startedAt: 6, endedAt: 7, name: 'search_docs' }),
  ];

  const agg = aggregateWaste([detectWaste(runA), detectWaste(runB)]);
  const finding = agg.findings.find((f) => f.type === 'orphaned_tool_call');
  assert.ok(finding && finding.type === 'orphaned_tool_call');
  assert.equal(finding.affectedRunCount, 2, 'both runs had this tool orphaned at least once');
  assert.equal(finding.totalOccurrences, 3, '1 + 2');
});

test('aggregateWaste on runs with no findings at all degrades gracefully', () => {
  const clean = detectWaste(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ latest: 100 }) }]),
  );
  const agg = aggregateWaste([clean, clean]);
  assert.deepEqual(agg.findings, []);
  assert.equal(agg.totalAvoidableCostUsd, 0);
  assert.match(formatAggregateWasteReport(agg), /no waste detected/);
});

test('aggregateWaste flags mixed pricing bases the same way cost breakdown does', () => {
  const actualRun = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
    ]),
  );
  const hypotheticalRun = detectWaste(
    tree([
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
      { model: 'claude-opus-5', tokens: tokens({ input: 750 }), inputComposition: composition({ system: 750 }) },
    ]),
    { priceAs: 'claude-haiku-4-5' },
  );
  const agg = aggregateWaste([actualRun, hypotheticalRun]);
  assert.equal(agg.pricingMode, 'mixed');
  assert.match(formatAggregateWasteReport(agg), /MIXED PRICING BASES/);
});

/* ================== Profiler, end to end ================== */

test('profiler.wasteReport detects a repeated uncached system prompt through the real storage layer', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');

  for (let i = 0; i < 3; i += 1) {
    const call = run.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
    call.setComposition(composition({ system: 750 }));
    call.end({ tokens: tokens({ input: 750 }) });
  }
  run.end();

  const report = profiler.wasteReport(run.rootId);
  const finding = staticFindings(report.findings).find((f) => f.segment === 'system');
  assert.ok(finding);
  assert.equal(finding.recurrences, 2);
  profiler.close();
});

test('profiler.aggregateWasteReport applies priceAs uniformly, like aggregateCostBreakdown', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });

  for (let session = 0; session < 2; session += 1) {
    const run = profiler.startRun('local-agent');
    for (let i = 0; i < 2; i += 1) {
      const call = run.startLlmCall('local-model', { model: 'qwen2.5:3b', cacheSupported: false });
      call.setComposition(composition({ system: 500 }));
      call.end({ tokens: tokens({ input: 500 }) });
    }
    run.end();
  }

  const agg = profiler.aggregateWasteReport({ name: 'local-agent', limit: 10, priceAs: 'claude-haiku-4-5' });
  assert.equal(agg.pricingMode, 'hypothetical');
  assert.ok(agg.totalAvoidableCostUsd > 0);
  profiler.close();
});

test('profiler.wasteReport detects a real hit-iteration-cap scenario end to end', () => {
  // Simulates exactly the bug documented in examples/doc-qa-agent.ts's
  // MAX_TOOL_ITERATIONS: the loop calls a tool, then the run just ends
  // (iteration cap hit) without ever sending the result back to the model.
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const step = run.startStep('ask');
  const llm1 = step.startLlmCall('claude-opus-5', { model: 'claude-opus-5' });
  llm1.end({ tokens: tokens({ input: 500 }) });
  const tool = step.startToolCall('search_docs');
  tool.end();
  // ...loop hits its cap here — no further llm_call ever happens.
  step.end();
  run.end();

  const report = profiler.wasteReport(run.rootId);
  const finding = toolFindings(report.findings).find((f) => f.toolName === 'search_docs');
  assert.ok(finding, 'the tool call with no follow-up model call must be flagged');
  assert.equal(finding.occurrences, 1);
  profiler.close();
});
