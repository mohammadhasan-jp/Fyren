/**
 * Analysis #1 — the numbers the whole product rests on.
 *
 * The invariants worth defending:
 *   - segment shares add up to 100%
 *   - segment costs add up to the run's real input cost
 *   - the cache is attributed by PREFIX, not smeared evenly
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  costBreakdown,
  aggregateCostBreakdown,
  formatCostBreakdown,
  formatAggregateCostBreakdown,
  formatCostTrend,
} from '../src/analysis/cost-breakdown.ts';
import { createProfiler } from '../src/index.ts';
import type { InputComposition, RunNode, SegmentSizes, TokenBreakdown } from '../src/index.ts';

const EQUAL_CHARS: SegmentSizes = {
  toolDefs: 100,
  system: 100,
  history: 100,
  toolResults: 100,
  latest: 100,
};

function composition(chars: Partial<SegmentSizes>, source: 'chars' | 'count_tokens' = 'chars'): InputComposition {
  const full: SegmentSizes = {
    toolDefs: 0,
    system: 0,
    history: 0,
    toolResults: 0,
    latest: 0,
    ...chars,
  };
  return { chars: full, tokens: source === 'count_tokens' ? full : null, source };
}

function tokens(t: Partial<TokenBreakdown>): TokenBreakdown {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, ...t };
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

const sumShares = (b: { segments: Array<{ share: number }> }): number =>
  b.segments.reduce((total, s) => total + s.share, 0);

test('shares sum to 100% and tokens sum to the real input total', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 1000, output: 200 }),
        inputComposition: composition(EQUAL_CHARS),
      },
    ]),
  );

  assert.equal(sumShares(breakdown).toFixed(9), '1.000000000');
  const attributed = breakdown.segments.reduce((t, s) => t + s.tokens, 0);
  assert.equal(Math.round(attributed), 1000);
  for (const segment of breakdown.segments) assert.equal(Math.round(segment.tokens), 200);
});

test('segment costs sum to the run real input cost', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 600, cacheRead: 400, output: 0 }),
        inputComposition: composition(EQUAL_CHARS),
      },
    ]),
  );

  const summed = breakdown.segments.reduce((t, s) => t + s.costUsd, 0);
  assert.equal(summed.toFixed(9), breakdown.inputCostUsd.toFixed(9));
  // 600 fresh @ $5/1M + 400 cache reads @ 0.1x
  assert.equal(breakdown.inputCostUsd.toFixed(9), (0.003 + 0.0002).toFixed(9));
});

test('cached tokens are attributed to the prompt PREFIX, not spread evenly', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        // 1000 input tokens, 400 of them cache reads → 200 tokens per segment
        tokens: tokens({ input: 600, cacheRead: 400 }),
        inputComposition: composition(EQUAL_CHARS),
      },
    ]),
  );

  const bySegment = new Map(breakdown.segments.map((s) => [s.segment, s]));

  // tools render first, then system — exactly 400 tokens of cache to give away
  assert.equal(Math.round(bySegment.get('toolDefs')!.cacheReadTokens), 200);
  assert.equal(Math.round(bySegment.get('system')!.cacheReadTokens), 200);
  assert.equal(Math.round(bySegment.get('toolDefs')!.freshTokens), 0);
  assert.equal(Math.round(bySegment.get('system')!.freshTokens), 0);

  // everything after the cached prefix pays full price
  for (const segment of ['history', 'toolResults', 'latest'] as const) {
    assert.equal(Math.round(bySegment.get(segment)!.cacheReadTokens), 0);
    assert.equal(Math.round(bySegment.get(segment)!.freshTokens), 200);
  }
});

test('the interleaved history/toolResults zone splits its cache proportionally', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        // 500 cached: 200 to toolDefs, 200 to system, 100 left for the zone
        tokens: tokens({ input: 500, cacheRead: 500 }),
        inputComposition: composition(EQUAL_CHARS),
      },
    ]),
  );

  const bySegment = new Map(breakdown.segments.map((s) => [s.segment, s]));
  assert.equal(Math.round(bySegment.get('history')!.cacheReadTokens), 50);
  assert.equal(Math.round(bySegment.get('toolResults')!.cacheReadTokens), 50);
  assert.equal(Math.round(bySegment.get('latest')!.cacheReadTokens), 0);
});

test('cache writes and reads are told apart', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheWrite: 200 }),
        inputComposition: composition({ toolDefs: 100 }),
      },
    ]),
  );

  const toolDefs = breakdown.segments.find((s) => s.segment === 'toolDefs')!;
  assert.equal(Math.round(toolDefs.cacheWriteTokens), 200);
  assert.equal(Math.round(toolDefs.cacheReadTokens), 0);
  // 200 * $5/1M * 1.25
  assert.equal(toolDefs.costUsd.toFixed(9), (0.00125).toFixed(9));
});

test('cache that fits entirely in the front of the prompt is NOT flagged uncertain', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        // 400 cached tokens, well inside toolDefs+system (400 tokens total)
        tokens: tokens({ input: 100, cacheRead: 400 }),
        inputComposition: composition({ toolDefs: 200, system: 200, latest: 100 }),
      },
    ]),
  );
  assert.equal(breakdown.cacheBoundaryUncertain, false);
  assert.equal(breakdown.uncertainCacheCallCount, 0);
});

test('cache that reaches the latest-message segment is flagged uncertain', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        // every char is in "latest" — the fill has nowhere else to put the cache
        tokens: tokens({ input: 0, cacheRead: 100 }),
        inputComposition: composition({ latest: 100 }),
      },
    ]),
  );
  assert.equal(breakdown.cacheBoundaryUncertain, true);
  assert.equal(breakdown.uncertainCacheCallCount, 1);
});

test('the uncertain flag on one call does not contaminate other calls or invalidate the totals', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 100 }),
        inputComposition: composition({ latest: 100 }), // uncertain
      },
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 100 }),
        inputComposition: composition({ system: 100 }), // clean
      },
    ]),
  );
  assert.equal(breakdown.uncertainCacheCallCount, 1);
  assert.equal(breakdown.cacheBoundaryUncertain, true);
  // the invariant from the earlier tests still holds across a mixed batch
  assert.equal(sumShares(breakdown).toFixed(9), '1.000000000');
});

test('an aggregate counts how many runs were flagged, not how many calls', () => {
  const uncertainRun = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 50 }),
        inputComposition: composition({ latest: 50 }),
      },
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 50 }),
        inputComposition: composition({ latest: 50 }),
      },
    ]),
  );
  const cleanRun = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );

  const agg = aggregateCostBreakdown([uncertainRun, cleanRun]);
  assert.equal(agg.uncertainCacheRunCount, 1, 'one run had 2 flagged calls, the other had 0');
});

test('formatCostBreakdown prints the warning only when the run is actually flagged', () => {
  const flagged = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheRead: 50 }),
        inputComposition: composition({ latest: 50 }),
      },
    ]),
  );
  const clean = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  assert.match(formatCostBreakdown(flagged), /cache attribution uncertain/);
  assert.doesNotMatch(formatCostBreakdown(clean), /cache attribution uncertain/);
});

test('cacheSupport is "yes" by default — matches every run before the field existed', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  assert.equal(breakdown.cacheSupport, 'yes');
  assert.equal(breakdown.cacheUnsupportedCallCount, 0);
});

test('a run entirely on a cache-unsupported provider reports cacheSupport "no", not zero cache numbers', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'qwen2.5:0.5b',
        tokens: tokens({ input: 100, output: 20 }),
        inputComposition: composition({ system: 40, latest: 60 }),
        cacheSupported: false,
      },
      {
        model: 'qwen2.5:0.5b',
        tokens: tokens({ input: 50, output: 10 }),
        inputComposition: composition({ latest: 50 }),
        cacheSupported: false,
      },
    ]),
  );

  assert.equal(breakdown.cacheSupport, 'no');
  assert.equal(breakdown.cacheUnsupportedCallCount, 2);
  // Zero cache is correct here — but for the RIGHT reason (no concept), not a
  // miss. All the input tokens must still be attributed and priced normally.
  for (const segment of breakdown.segments) {
    assert.equal(segment.cacheReadTokens, 0);
    assert.equal(segment.cacheWriteTokens, 0);
  }
  assert.equal(sumShares(breakdown).toFixed(9), '1.000000000');
  // no cache multiplier applied — cacheSupport being false must not change the
  // arithmetic, only the label. 150 fresh input tokens, unpriced model → $0.
  assert.equal(breakdown.inputCostUsd, 0);
});

test('a run mixing a cache-supported and cache-unsupported call reports "mixed"', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100, cacheRead: 50 }),
        inputComposition: composition({ system: 150 }),
        cacheSupported: true,
      },
      {
        model: 'qwen2.5:0.5b',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ latest: 100 }),
        cacheSupported: false,
      },
    ]),
  );
  assert.equal(breakdown.cacheSupport, 'mixed');
  assert.equal(breakdown.cacheUnsupportedCallCount, 1);
});

test('formatCostBreakdown drops the cache columns (not just zeros them) when cacheSupport is "no"', () => {
  const unsupported = costBreakdown(
    tree([
      {
        model: 'qwen2.5:0.5b',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
        cacheSupported: false,
      },
    ]),
  );
  const text = formatCostBreakdown(unsupported);
  assert.doesNotMatch(text, /cache rd/, 'the misleading "always zero" column must not be printed at all');
  assert.doesNotMatch(text, /cache wr/);
  assert.match(text, /not applicable/i);
  assert.match(text, /no prompt-caching concept/i);

  // A cache-supporting run keeps the columns exactly as before this feature.
  const supported = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  assert.match(formatCostBreakdown(supported), /cache rd/);
});

test('formatCostBreakdown notes the mixed case without hiding the cache columns', () => {
  const mixed = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100, cacheRead: 50 }),
        inputComposition: composition({ system: 150 }),
        cacheSupported: true,
      },
      {
        model: 'qwen2.5:0.5b',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ latest: 100 }),
        cacheSupported: false,
      },
    ]),
  );
  const text = formatCostBreakdown(mixed);
  assert.match(text, /cache rd/, 'some calls DO support caching — the columns still carry information');
  assert.match(text, /no caching concept/i);
});

test('aggregateCostBreakdown rolls cacheSupport up across runs', () => {
  const noCache = costBreakdown(
    tree(
      [
        {
          model: 'qwen2.5:0.5b',
          tokens: tokens({ input: 100 }),
          inputComposition: composition({ system: 100 }),
          cacheSupported: false,
        },
      ],
      'ollama-agent',
    ),
  );
  const withCache = costBreakdown(
    tree(
      [
        {
          model: 'claude-opus-5',
          tokens: tokens({ input: 100 }),
          inputComposition: composition({ system: 100 }),
        },
      ],
      'ollama-agent',
    ),
  );

  assert.equal(aggregateCostBreakdown([noCache]).cacheSupport, 'no');
  assert.equal(aggregateCostBreakdown([withCache]).cacheSupport, 'yes');
  assert.equal(aggregateCostBreakdown([noCache, withCache]).cacheSupport, 'mixed');
});

test('precision reflects how the numbers were obtained', () => {
  const estimated = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition(EQUAL_CHARS),
      },
    ]),
  );
  assert.equal(estimated.precision, 'estimated');

  const measured = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition(EQUAL_CHARS, 'count_tokens'),
      },
    ]),
  );
  assert.equal(measured.precision, 'measured');

  const mixed = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition(EQUAL_CHARS),
      },
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition(EQUAL_CHARS, 'count_tokens'),
      },
    ]),
  );
  assert.equal(mixed.precision, 'mixed');
});

test('measured token weights are preferred over character weights', () => {
  // chars say the two segments are equal; measured tokens say 3:1.
  const weighted: InputComposition = {
    chars: { toolDefs: 0, system: 100, history: 0, toolResults: 100, latest: 0 },
    tokens: { toolDefs: 0, system: 75, history: 0, toolResults: 25, latest: 0 },
    source: 'count_tokens',
  };

  const breakdown = costBreakdown(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 400 }), inputComposition: weighted }]),
  );

  const bySegment = new Map(breakdown.segments.map((s) => [s.segment, s]));
  assert.equal(Math.round(bySegment.get('system')!.tokens), 300);
  assert.equal(Math.round(bySegment.get('toolResults')!.tokens), 100);
});

test('calls without composition are counted but reported as unattributed', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
      { model: 'claude-opus-5', tokens: tokens({ input: 900 }), inputComposition: null },
    ]),
  );

  assert.equal(breakdown.totalInputTokens, 1000);
  assert.equal(breakdown.attributedCallCount, 1);
  assert.equal(breakdown.unattributedInputTokens, 900);
  assert.equal(breakdown.unattributedInputCostUsd.toFixed(9), (0.0045).toFixed(9));
  // shares describe the attributed part, and still add to 100%
  assert.equal(sumShares(breakdown).toFixed(9), '1.000000000');
});

test('an unpriced model is flagged instead of silently costing zero', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'some-unreleased-model',
        tokens: tokens({ input: 1000, output: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  assert.equal(breakdown.unpricedCallCount, 1);
  assert.equal(breakdown.totalCostUsd, 0);
  assert.equal(breakdown.totalInputTokens, 1000);
});

test('a run with no llm calls degrades gracefully', () => {
  const breakdown = costBreakdown(tree([]));
  assert.equal(breakdown.llmCallCount, 0);
  assert.equal(breakdown.precision, 'none');
  assert.equal(breakdown.totalCostUsd, 0);
  assert.equal(sumShares(breakdown), 0);
  assert.doesNotThrow(() => formatCostBreakdown(breakdown));
});

/* ---------------- hypothetical pricing (priceAs) ---------------- */

test('without priceAs, pricingMode is "actual" and behavior is unchanged — the default', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 1000, output: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  assert.equal(breakdown.pricingMode, 'actual');
  assert.equal(breakdown.pricedAsModel, null);
  assert.doesNotMatch(formatCostBreakdown(breakdown), /HYPOTHETICAL/);
});

test('priceAs re-prices real token counts under a different model — tokens and shares are untouched', () => {
  const treeData = tree([
    {
      model: 'claude-opus-5', // real rate: $5 / $25 per MTok
      tokens: tokens({ input: 1000, output: 200 }),
      inputComposition: composition({ system: 1000 }),
    },
  ]);

  const actual = costBreakdown(treeData);
  const hypothetical = costBreakdown(treeData, { priceAs: 'claude-haiku-4-5' }); // $1 / $5 per MTok

  assert.equal(hypothetical.pricingMode, 'hypothetical');
  assert.equal(hypothetical.pricedAsModel, 'claude-haiku-4-5');
  assert.equal(hypothetical.totalInputTokens, actual.totalInputTokens);
  assert.equal(hypothetical.totalOutputTokens, actual.totalOutputTokens);
  assert.equal(hypothetical.segments[0]!.tokens, actual.segments[0]!.tokens, 'attribution is unaffected by price');

  // 1000 input @ $1/1M + 200 output @ $5/1M
  assert.equal(hypothetical.inputCostUsd.toFixed(9), (0.001).toFixed(9));
  assert.equal(hypothetical.outputCostUsd.toFixed(9), (0.001).toFixed(9));
  assert.notEqual(hypothetical.totalCostUsd, actual.totalCostUsd, 'a real model must not accidentally match the hypothetical one here');
});

test('priceAs still applies the real cache multipliers to the real cache token counts', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 0, cacheWrite: 1_000_000 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
    { priceAs: 'claude-haiku-4-5' }, // $1/1M input, so a cache write costs $1 * 1.25
  );
  assert.equal(breakdown.inputCostUsd.toFixed(9), (1.25).toFixed(9));
});

test('priceAs with an unknown model prices everything at $0 and says exactly why', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5', // itself perfectly well-priced — irrelevant once priceAs is set
        tokens: tokens({ input: 1000, output: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
    { priceAs: 'some-made-up-model-id' },
  );

  assert.equal(breakdown.pricingMode, 'hypothetical');
  assert.equal(breakdown.pricedAsModel, 'some-made-up-model-id');
  assert.equal(breakdown.unpricedCallCount, 1);
  assert.equal(breakdown.totalCostUsd, 0);

  const text = formatCostBreakdown(breakdown);
  assert.match(text, /"priceAs" model "some-made-up-model-id" has no price on file/);
  // must not be confused with the unrelated "actual mode, real model unpriced" wording
  assert.doesNotMatch(text, /call\(s\) used a model with no price on file/);
});

test('priceAs on a cache-unsupported (e.g. Ollama) run still produces a real hypothetical figure', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'qwen2.5:3b',
        tokens: tokens({ input: 1000, output: 200 }), // no cache tokens — Ollama has none
        inputComposition: composition({ system: 1000 }),
        cacheSupported: false,
      },
    ]),
    { priceAs: 'claude-haiku-4-5' },
  );
  assert.equal(breakdown.cacheSupport, 'no'); // priceAs must not change this — it's about the real provider
  assert.equal(breakdown.pricingMode, 'hypothetical');
  assert.equal(breakdown.totalCostUsd.toFixed(9), (0.001 + 0.001).toFixed(9)); // 1000 in @ $1/1M + 200 out @ $5/1M
});

test('formatCostBreakdown prints an unmissable HYPOTHETICAL banner, in the header and inline on the total', () => {
  const breakdown = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100, output: 10 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
    { priceAs: 'claude-haiku-4-5' },
  );
  const text = formatCostBreakdown(breakdown);
  assert.match(text, /⚠⚠ HYPOTHETICAL COST — priced as claude-haiku-4-5, NOT real spend ⚠⚠/);
  assert.match(text, /total \$[\d.]+ \(HYPOTHETICAL, priced as claude-haiku-4-5\)/);
});

test('aggregateCostBreakdown reports "hypothetical" only when every run used the SAME priceAs model', () => {
  const runA = costBreakdown(
    tree(
      [{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ system: 100 }) }],
      'agent',
    ),
    { priceAs: 'claude-haiku-4-5' },
  );
  const runB = costBreakdown(
    tree(
      [{ model: 'claude-sonnet-5', tokens: tokens({ input: 100 }), inputComposition: composition({ system: 100 }) }],
      'agent',
    ),
    { priceAs: 'claude-haiku-4-5' },
  );

  const agg = aggregateCostBreakdown([runA, runB]);
  assert.equal(agg.pricingMode, 'hypothetical');
  assert.equal(agg.pricedAsModel, 'claude-haiku-4-5');
  assert.doesNotMatch(formatAggregateCostBreakdown(agg), /MIXED PRICING/);
});

test('aggregateCostBreakdown reports "mixed" when runs disagree on pricing basis, and warns loudly', () => {
  const actualRun = costBreakdown(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ system: 100 }) }]),
  );
  const hypotheticalRun = costBreakdown(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ system: 100 }) }]),
    { priceAs: 'claude-haiku-4-5' },
  );

  const mixedBasis = aggregateCostBreakdown([actualRun, hypotheticalRun]);
  assert.equal(mixedBasis.pricingMode, 'mixed');
  assert.equal(mixedBasis.pricedAsModel, null);
  assert.match(formatAggregateCostBreakdown(mixedBasis), /MIXED PRICING BASES/);

  // also mixed when hypothetical but under two DIFFERENT priceAs models
  const hypotheticalOther = costBreakdown(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100 }), inputComposition: composition({ system: 100 }) }]),
    { priceAs: 'claude-sonnet-5' },
  );
  const mixedModels = aggregateCostBreakdown([hypotheticalRun, hypotheticalOther]);
  assert.equal(mixedModels.pricingMode, 'mixed');
});

/* ---------------- aggregation ---------------- */

test('pooled share is cost-weighted while mean-per-run treats runs equally', () => {
  // A tiny run that is all system prompt, and a large run that is all history.
  const small = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 100 }),
        inputComposition: composition({ system: 100 }),
      },
    ]),
  );
  const large = costBreakdown(
    tree([
      {
        model: 'claude-opus-5',
        tokens: tokens({ input: 900 }),
        inputComposition: composition({ history: 100 }),
      },
    ]),
  );

  const agg = aggregateCostBreakdown([small, large]);
  const bySegment = new Map(agg.segments.map((s) => [s.segment, s]));

  assert.equal(agg.runCount, 2);
  assert.equal(agg.runName, 'agent');

  // pooled: system is 100 of 1000 tokens
  assert.equal(bySegment.get('system')!.pooledShare.toFixed(3), '0.100');
  // mean-per-run: system was 100% of one run and 0% of the other
  assert.equal(bySegment.get('system')!.meanRunShare.toFixed(3), '0.500');

  assert.equal(agg.totalInputTokens, 1000);
  assert.doesNotThrow(() => formatAggregateCostBreakdown(agg));
});

test('aggregating runs with different names reports no single name', () => {
  const a = costBreakdown(
    tree(
      [
        {
          model: 'claude-opus-5',
          tokens: tokens({ input: 10 }),
          inputComposition: composition({ system: 10 }),
        },
      ],
      'alpha',
    ),
  );
  const b = costBreakdown(
    tree(
      [
        {
          model: 'claude-opus-5',
          tokens: tokens({ input: 10 }),
          inputComposition: composition({ system: 10 }),
        },
      ],
      'beta',
    ),
  );
  assert.equal(aggregateCostBreakdown([a, b]).runName, null);
});

test('aggregating nothing does not divide by zero', () => {
  const agg = aggregateCostBreakdown([]);
  assert.equal(agg.runCount, 0);
  assert.equal(agg.totalCostUsd, 0);
  for (const segment of agg.segments) {
    assert.equal(segment.pooledShare, 0);
    assert.equal(segment.meanRunShare, 0);
  }
});

/* ---------------- Profiler convenience methods, end to end ---------------- */

test('profiler.costBreakdown(rootId, { priceAs }) works through the real storage layer', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });

  const run = profiler.startRun('agent');
  const call = run.startLlmCall('local-model', { model: 'qwen2.5:3b', cacheSupported: false });
  call.setComposition(composition({ system: 1000 }));
  call.end({ tokens: tokens({ input: 1000, output: 200 }) });
  run.end();

  const actual = profiler.costBreakdown(run.rootId);
  assert.equal(actual.totalCostUsd, 0, 'a real local model has no price on file');

  const hypothetical = profiler.costBreakdown(run.rootId, { priceAs: 'claude-haiku-4-5' });
  assert.equal(hypothetical.pricingMode, 'hypothetical');
  assert.ok(hypothetical.totalCostUsd > 0, 'the same real tokens now have a comparable dollar figure');

  profiler.close();
});

test('profiler.aggregateCostBreakdown applies priceAs uniformly across every fetched run', () => {
  const profiler = createProfiler({ dbPath: ':memory:' });

  for (let i = 0; i < 3; i += 1) {
    const run = profiler.startRun('local-agent');
    const call = run.startLlmCall('local-model', { model: 'qwen2.5:3b', cacheSupported: false });
    call.setComposition(composition({ system: 500 }));
    call.end({ tokens: tokens({ input: 500, output: 100 }) });
    run.end();
  }

  const agg = profiler.aggregateCostBreakdown({ name: 'local-agent', limit: 10, priceAs: 'claude-haiku-4-5' });
  assert.equal(agg.pricingMode, 'hypothetical');
  assert.equal(agg.pricedAsModel, 'claude-haiku-4-5');
  assert.ok(agg.totalCostUsd > 0);

  profiler.close();
});

test('formatCostTrend on an empty array says so, not a crash', () => {
  assert.equal(formatCostTrend([]), '  (no runs to trend)');
});

test('formatCostTrend covers a single run: one-block sparkline, min = max = avg', () => {
  const run = costBreakdown(tree([{ model: 'claude-opus-5', tokens: tokens({ input: 1000, output: 100 }) }]));
  const out = formatCostTrend([run]);
  const cost = `$${run.totalCostUsd.toFixed(6)}`;

  assert.ok(out.includes('oldest → newest (1 runs):'));
  assert.ok(out.includes(`min ${cost}`));
  assert.ok(out.includes(`max ${cost}`));
  assert.ok(out.includes(`avg ${cost}`));
});

test('formatCostTrend on runs that all cost $0 (e.g. every call on a free provider) is a flat line, not a divide-by-zero', () => {
  const runs = [0, 1, 2].map(() =>
    costBreakdown(
      tree([
        {
          model: 'qwen2.5:3b',
          tokens: tokens({ input: 500, output: 50 }),
          cacheSupported: false,
        },
      ]),
    ),
  );
  const out = formatCostTrend(runs);

  assert.ok(out.includes('min $0.000000  ·  max $0.000000  ·  avg $0.000000'));
  const sparkline = out.split('\n')[0]?.split(': ')[1] ?? '';
  assert.equal(sparkline.length, 3);
  assert.equal(new Set(sparkline).size, 1);
});

test('formatCostTrend reverses newest-first input to chronological order and reports the real min/max/avg', () => {
  const cheap = costBreakdown(tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100, output: 10 }) }]));
  const expensive = costBreakdown(
    tree([{ model: 'claude-opus-5', tokens: tokens({ input: 100_000, output: 10_000 }) }]),
  );
  assert.ok(expensive.totalCostUsd > cheap.totalCostUsd);

  // Shaped like costBreakdownRecent()'s output: newest first.
  const out = formatCostTrend([expensive, cheap]);
  const avg = (cheap.totalCostUsd + expensive.totalCostUsd) / 2;

  assert.ok(out.includes('oldest → newest (2 runs):'));
  assert.ok(out.includes(`min $${cheap.totalCostUsd.toFixed(6)}`));
  assert.ok(out.includes(`max $${expensive.totalCostUsd.toFixed(6)}`));
  assert.ok(out.includes(`avg $${avg.toFixed(6)}`));
});
