/**
 * Analysis #1 — Cost Breakdown.
 *
 * Answers: of everything this run sent to the model, what share was the system
 * prompt, the tool definitions, the conversation history, the tool results,
 * and the actual new message — in tokens, in percent, and in dollars.
 *
 * ── How cache is handled ──────────────────────────────────────────────────
 *
 * A naive breakdown multiplies each segment's share by one price. That is
 * wrong, because the same token costs three different amounts depending on how
 * it was billed: fresh input (1x), cache write (1.25x), cache read (0.1x).
 *
 * We can do better than smearing the cache evenly, because the prompt cache is
 * a PREFIX match and we know the render order: tools → system → messages. So
 * cached tokens are allocated from the FRONT of that order. If a run cached
 * 3,000 tokens and the tool definitions plus system prompt come to 2,800, then
 * those two are (almost) entirely cache hits and the history is paying full
 * price — which is exactly the kind of thing a developer needs to see.
 *
 * ── Three honest caveats, all surfaced in the output ──────────────────────
 *
 *  1. Segment weights come from character counts unless the call was recorded
 *     in precise mode. `precision` says which, per run. Never present an
 *     estimate as a measurement.
 *  2. `history` and `toolResults` are interleaved inside messages[], so they
 *     cannot be ordered against each other. Within that zone the cache is
 *     split between them proportionally.
 *  3. The prefix-fill algorithm below is arithmetic, not verification — given
 *     any (composition, cacheRead, cacheWrite) it always produces SOME split,
 *     even if the render order it assumes doesn't hold for that call (a
 *     `cache_control` placed somewhere unusual, a retried request, a future
 *     provider change). One sentinel is cheap to check without deeper access
 *     to the raw request: the prompt's LAST segment ("latest message") should
 *     never legitimately be a cache hit — caching it would require the exact
 *     same newest message to have been sent before. If the fill has to reach
 *     that far, `cacheBoundaryUncertain` is set so the numbers are shown, not
 *     hidden, but flagged as resting on an assumption that didn't hold here.
 *
 * ── Hypothetical pricing (`priceAs`) ───────────────────────────────────────
 *
 * A run on a provider with no real price (a local Ollama model) reports every
 * dollar figure as $0.00. That's correct — and useless: percentages alone
 * don't make anyone react the way a dollar figure does. `priceAs` re-prices
 * every call's REAL token counts as if they had gone to a different model —
 * useful both for giving a free/local run a comparable number, and for a
 * genuine "what would this have cost on claude-sonnet-5 instead of
 * claude-opus-5" comparison.
 *
 * This must never be mistaken for real spend. `pricingMode`/`pricedAsModel`
 * on the result say which mode produced the numbers, and `formatCostBreakdown`
 * prints an unmissable `HYPOTHETICAL — priced as <model>` banner instead of
 * quietly changing the total.
 */

import { rateFor, effectiveRate, type ModelRate } from '../pricing.ts';
import {
  SEGMENT_LABELS,
  SEGMENT_ORDER,
  compositionWeights,
  emptySegmentSizes,
  type InputSegment,
  type NodeStatus,
  type RunNode,
  type SegmentSizes,
} from '../types.ts';

/**
 * Cost of one call's input, given its model's rate.
 *
 * Cache multipliers come from the RATE, not from constants — they differ by
 * provider and even by model generation (OpenAI bills cache writes on GPT-5.6+
 * but not before; GPT-4.1 discounts reads 0.25x, not 0.1x). See src/pricing.ts.
 */
function inputCostFor(
  rate: ModelRate,
  effective: Pick<ModelRate, 'input'>,
  tokens: { input: number; cacheRead: number; cacheWrite: number },
): number {
  return (
    (tokens.input * effective.input +
      tokens.cacheWrite * effective.input * rate.cacheWriteMultiplier +
      tokens.cacheRead * effective.input * rate.cacheReadMultiplier) /
    1_000_000
  );
}

/** Tokens of slop allowed before "cache touched the latest segment" counts as real, not float noise. */
const BOUNDARY_EPSILON_TOKENS = 0.5;

/**
 * Segments in prompt-prefix order, grouped. Members of the same group are
 * interleaved in the real prompt and so share their group's cache
 * proportionally.
 */
const CACHE_FILL_GROUPS: ReadonlyArray<readonly InputSegment[]> = [
  ['toolDefs'],
  ['system'],
  ['history', 'toolResults'],
  ['latest'],
];

export type Precision = 'measured' | 'estimated' | 'mixed' | 'none';

/** 'actual' = each call priced at its own recorded model (default). 'hypothetical' = every call re-priced at `pricedAsModel` — see the file header, never real spend. */
export type PricingMode = 'actual' | 'hypothetical';
/** Same idea, rolled up across several runs — 'mixed' when summing them would combine incompatible bases. */
export type AggregatePricingMode = 'actual' | 'hypothetical' | 'mixed';

export interface CostBreakdownOptions {
  /**
   * Ignore each call's own recorded model and price every token as if it had
   * been sent to this model id instead. Two real uses: (1) a provider with no
   * real price (a local Ollama model) gets a comparable dollar figure instead
   * of a wall of $0.00 that carries no weight; (2) "what would this run have
   * cost on claude-sonnet-5 instead of claude-opus-5" — a genuine what-if.
   *
   * Applies to every call uniformly, using each call's REAL recorded token
   * counts (including real cache read/write counts, still discounted at the
   * usual 0.1x/1.25x multipliers) — only the per-token rate changes. If
   * `priceAs` itself has no entry in the pricing table, every call becomes
   * "unpriced" under the hypothetical rate and costs read $0 — `formatCostBreakdown`
   * explains why rather than showing an unexplained zero.
   *
   * This NEVER reflects real spend — see `pricingMode`/`pricedAsModel` on the
   * result, and the `HYPOTHETICAL` banner in `formatCostBreakdown`.
   */
  priceAs?: string;
}

export interface SegmentCost {
  segment: InputSegment;
  label: string;
  /** Raw characters, summed across the run's calls. */
  chars: number;
  /** Input tokens attributed to this segment. */
  tokens: number;
  /** Fraction of the run's total input tokens, 0..1. */
  share: number;
  /** How those tokens were billed. */
  freshTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface RunCostBreakdown {
  runId: string;
  name: string;
  startedAt: number;
  durationMs: number | null;
  status: NodeStatus;

  llmCallCount: number;
  /** Calls we could split into segments (had composition data). */
  attributedCallCount: number;
  /** Calls whose model has no entry in the pricing table — their cost reads 0. */
  unpricedCallCount: number;
  precision: Precision;
  /**
   * True if any call's fill had to reach into the "latest message" segment to
   * place its cached tokens — a sign the tools→system→messages prefix
   * assumption may not hold for that call. See the file header. The numbers
   * are still reported; treat them with less confidence.
   */
  cacheBoundaryUncertain: boolean;
  uncertainCacheCallCount: number;
  /**
   * Whether prompt caching is even a concept for this run's calls.
   * `'yes'` — every call's provider supports caching (the default; matches
   * every run before this field existed). `'no'` — none of them do (e.g. a
   * pure-Ollama run) — the cache columns are all zero because there is
   * nothing to cache, not because caching was tried and missed; don't read
   * them as a cache-miss finding. `'mixed'` — some calls' providers support
   * it and some don't (e.g. one step called Anthropic, another called a
   * local model) — the per-segment cache numbers still mean something, just
   * not uniformly across every call.
   */
  cacheSupport: 'yes' | 'no' | 'mixed';
  /** Calls whose provider has no caching concept at all. */
  cacheUnsupportedCallCount: number;

  /** 'actual' unless `priceAs` was given — see `CostBreakdownOptions.priceAs`. */
  pricingMode: PricingMode;
  /** The model id costs were computed as, when `pricingMode === 'hypothetical'`. Null otherwise. */
  pricedAsModel: string | null;

  /** input + cacheRead + cacheWrite, across every llm_call. */
  totalInputTokens: number;
  totalOutputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;

  /** Input tokens from calls with no composition data — excluded from `segments`. */
  unattributedInputTokens: number;
  unattributedInputCostUsd: number;

  segments: SegmentCost[];
}

/* ------------------------------------------------------------------ *
 * Per-run                                                             *
 * ------------------------------------------------------------------ */

/** Build the breakdown for one run tree (as returned by `profiler.getTree`). */
export function costBreakdown(
  tree: readonly RunNode[],
  options: CostBreakdownOptions = {},
): RunCostBreakdown {
  const root = tree.find((node) => node.type === 'run') ?? tree[0];
  const calls = tree.filter((node) => node.type === 'llm_call');

  // Resolved once: every call is priced under this SAME rate in hypothetical
  // mode, regardless of what it was actually sent to. Null means either
  // 'actual' mode (per-call lookup happens below instead) or `priceAs` itself
  // has no entry in the pricing table.
  const hypotheticalRate = options.priceAs ? rateFor(options.priceAs) : null;

  const chars = emptySegmentSizes();
  const tokens = emptySegmentSizes();
  const fresh = emptySegmentSizes();
  const cacheRead = emptySegmentSizes();
  const cacheWrite = emptySegmentSizes();
  const cost = emptySegmentSizes();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let inputCostUsd = 0;
  let outputCostUsd = 0;
  let unattributedInputTokens = 0;
  let unattributedInputCostUsd = 0;
  let attributedCallCount = 0;
  let unpricedCallCount = 0;
  let uncertainCacheCallCount = 0;
  let cacheUnsupportedCallCount = 0;
  let sawCacheSupported = false;
  let sawMeasured = false;
  let sawEstimated = false;

  for (const call of calls) {
    const rate = options.priceAs ? hypotheticalRate : rateFor(call.model);
    if (!rate) unpricedCallCount += 1;
    if (call.cacheSupported) sawCacheSupported = true;
    else cacheUnsupportedCallCount += 1;

    const inTokens = call.tokens.input + call.tokens.cacheRead + call.tokens.cacheWrite;
    totalInputTokens += inTokens;
    totalOutputTokens += call.tokens.output;

    // Context-length tiers (Gemini Pro prices differently above 200k prompt
    // tokens) resolve per call, from that call's own input size.
    const effective = rate ? effectiveRate(rate, inTokens) : null;
    outputCostUsd += effective ? (call.tokens.output * effective.output) / 1_000_000 : 0;

    const callInputCost = rate && effective ? inputCostFor(rate, effective, call.tokens) : 0;
    inputCostUsd += callInputCost;

    const attributed = attributeCall(call, inTokens);
    if (!attributed) {
      unattributedInputTokens += inTokens;
      unattributedInputCostUsd += callInputCost;
      continue;
    }

    attributedCallCount += 1;
    if (attributed.boundaryUncertain) uncertainCacheCallCount += 1;
    if (call.inputComposition?.source === 'count_tokens') sawMeasured = true;
    else sawEstimated = true;

    for (const segment of SEGMENT_ORDER) {
      chars[segment] += call.inputComposition?.chars[segment] ?? 0;
      tokens[segment] += attributed.tokens[segment];
      fresh[segment] += attributed.fresh[segment];
      cacheRead[segment] += attributed.cacheRead[segment];
      cacheWrite[segment] += attributed.cacheWrite[segment];
      cost[segment] +=
        rate && effective
          ? inputCostFor(rate, effective, {
              input: attributed.fresh[segment],
              cacheRead: attributed.cacheRead[segment],
              cacheWrite: attributed.cacheWrite[segment],
            })
          : 0;
    }
  }

  const attributedTokens = SEGMENT_ORDER.reduce((sum, s) => sum + tokens[s], 0);

  const segments: SegmentCost[] = SEGMENT_ORDER.map((segment) => ({
    segment,
    label: SEGMENT_LABELS[segment],
    chars: chars[segment],
    tokens: tokens[segment],
    share: attributedTokens > 0 ? tokens[segment] / attributedTokens : 0,
    freshTokens: fresh[segment],
    cacheReadTokens: cacheRead[segment],
    cacheWriteTokens: cacheWrite[segment],
    costUsd: cost[segment],
  }));

  return {
    runId: root?.rootId ?? '',
    name: root?.name ?? '',
    startedAt: root?.startedAt ?? 0,
    durationMs: root?.durationMs ?? null,
    status: root?.status ?? 'running',
    llmCallCount: calls.length,
    attributedCallCount,
    unpricedCallCount,
    precision: precisionOf(sawMeasured, sawEstimated),
    totalInputTokens,
    totalOutputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    unattributedInputTokens,
    unattributedInputCostUsd,
    cacheBoundaryUncertain: uncertainCacheCallCount > 0,
    uncertainCacheCallCount,
    cacheSupport: cacheSupportOf(sawCacheSupported, cacheUnsupportedCallCount > 0),
    cacheUnsupportedCallCount,
    pricingMode: options.priceAs ? 'hypothetical' : 'actual',
    pricedAsModel: options.priceAs ?? null,
    segments,
  };
}

/**
 * Same three-way shape as `precisionOf` — 'yes' is also the default for a
 * call-free run. Exported so Waste Detection reports `cacheSupport` the same
 * way Cost Breakdown does, from one definition.
 */
export function cacheSupportOf(sawSupported: boolean, sawUnsupported: boolean): 'yes' | 'no' | 'mixed' {
  if (sawSupported && sawUnsupported) return 'mixed';
  if (sawUnsupported) return 'no';
  return 'yes';
}

/**
 * 'mixed' whenever summing the runs' dollar figures would combine
 * incompatible bases: some actual and some hypothetical, or hypothetical
 * under more than one `priceAs` model. Only a single, uniform hypothetical
 * model across every run earns the (useful) 'hypothetical' label.
 */
/** Exported for the same reason as `cacheSupportOf` — one definition, reused by Waste Detection's aggregate report. */
export function aggregatePricingModeOf(
  sawActual: boolean,
  sawHypothetical: boolean,
  pricedAsModels: ReadonlySet<string>,
): { pricingMode: AggregatePricingMode; pricedAsModel: string | null } {
  if (sawActual && sawHypothetical) return { pricingMode: 'mixed', pricedAsModel: null };
  if (sawHypothetical) {
    if (pricedAsModels.size !== 1) return { pricingMode: 'mixed', pricedAsModel: null };
    return { pricingMode: 'hypothetical', pricedAsModel: [...pricedAsModels][0]! };
  }
  return { pricingMode: 'actual', pricedAsModel: null };
}

export interface AttributedCall {
  tokens: SegmentSizes;
  fresh: SegmentSizes;
  cacheRead: SegmentSizes;
  cacheWrite: SegmentSizes;
  /** See the file header — cache reached into the "latest message" segment. */
  boundaryUncertain: boolean;
}

/**
 * Split one call's input tokens across the five segments, then decide which of
 * those tokens the cache covered.
 *
 * Exported (unlike the rest of this module's internals) because Waste
 * Detection needs the SAME per-call fresh/cache split at finer grain than
 * `costBreakdown`'s run-level totals give — reusing this instead of
 * re-deriving the prefix-fill logic keeps there being exactly one place that
 * knows how cache tokens map onto segments.
 */
export function attributeCall(call: RunNode, totalInputTokens: number): AttributedCall | null {
  const composition = call.inputComposition;
  if (!composition || totalInputTokens <= 0) return null;

  const weights = compositionWeights(composition);
  const weightSum = SEGMENT_ORDER.reduce((sum, s) => sum + weights[s], 0);
  if (weightSum <= 0) return null;

  // 1. Proportional split of the call's real input tokens.
  const tokens = emptySegmentSizes();
  for (const segment of SEGMENT_ORDER) {
    tokens[segment] = (weights[segment] / weightSum) * totalInputTokens;
  }

  // 2. Fill cached tokens from the front of the prompt.
  const fresh = emptySegmentSizes();
  const cached = emptySegmentSizes();
  let cachedRemaining = call.tokens.cacheRead + call.tokens.cacheWrite;

  for (const group of CACHE_FILL_GROUPS) {
    const groupTotal = group.reduce((sum, s) => sum + tokens[s], 0);
    if (groupTotal <= 0) continue;

    const take = Math.min(groupTotal, cachedRemaining);
    cachedRemaining -= take;

    for (const segment of group) {
      const portion = (tokens[segment] / groupTotal) * take;
      cached[segment] = portion;
      fresh[segment] = tokens[segment] - portion;
    }
  }

  // 3. Split each segment's cached tokens into reads vs writes.
  const cacheTotal = call.tokens.cacheRead + call.tokens.cacheWrite;
  const readShare = cacheTotal > 0 ? call.tokens.cacheRead / cacheTotal : 0;
  const cacheRead = emptySegmentSizes();
  const cacheWrite = emptySegmentSizes();
  for (const segment of SEGMENT_ORDER) {
    cacheRead[segment] = cached[segment] * readShare;
    cacheWrite[segment] = cached[segment] - cacheRead[segment];
  }

  return {
    tokens,
    fresh,
    cacheRead,
    cacheWrite,
    boundaryUncertain: cached.latest > BOUNDARY_EPSILON_TOKENS,
  };
}

function precisionOf(measured: boolean, estimated: boolean): Precision {
  if (measured && estimated) return 'mixed';
  if (measured) return 'measured';
  if (estimated) return 'estimated';
  return 'none';
}

/* ------------------------------------------------------------------ *
 * Across runs                                                         *
 * ------------------------------------------------------------------ */

export interface AggregateSegmentCost {
  segment: InputSegment;
  label: string;
  tokens: number;
  costUsd: number;
  /**
   * Segment tokens / all attributed input tokens. This is the cost-honest
   * number: a long run counts more than a short one.
   */
  pooledShare: number;
  /**
   * Mean of the per-run shares, weighting every run equally. This is the
   * number behind "on average, 62% of input went to the system prompt".
   */
  meanRunShare: number;
}

export interface AggregateCostBreakdown {
  runCount: number;
  /** Non-empty when every run analysed had the same name. */
  runName: string | null;
  precision: Precision;
  llmCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  unattributedInputTokens: number;
  /** How many of the runs had at least one call with `cacheBoundaryUncertain`. */
  uncertainCacheRunCount: number;
  /** Same three-way meaning as `RunCostBreakdown.cacheSupport`, rolled up across runs. */
  cacheSupport: 'yes' | 'no' | 'mixed';
  /**
   * 'hypothetical' only when EVERY run was priced with the same `priceAs`
   * model. 'mixed' when runs disagree — some actual, some hypothetical, or
   * hypothetical under different models — summing incompatible cost bases
   * into one total is exactly the kind of thing that should be loud, not
   * silent; see `formatAggregateCostBreakdown`.
   */
  pricingMode: AggregatePricingMode;
  /** Set only when `pricingMode === 'hypothetical'`. */
  pricedAsModel: string | null;
  segments: AggregateSegmentCost[];
}

/** Roll several run breakdowns into one. */
export function aggregateCostBreakdown(
  breakdowns: readonly RunCostBreakdown[],
): AggregateCostBreakdown {
  const tokens = emptySegmentSizes();
  const cost = emptySegmentSizes();
  const shareSums = emptySegmentSizes();

  let runsWithAttribution = 0;
  let llmCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let inputCostUsd = 0;
  let outputCostUsd = 0;
  let unattributedInputTokens = 0;
  let uncertainCacheRunCount = 0;
  let sawCacheSupported = false;
  let sawCacheUnsupported = false;
  let sawMeasured = false;
  let sawEstimated = false;
  let sawActualPricing = false;
  let sawHypotheticalPricing = false;
  const pricedAsModels = new Set<string>();

  for (const run of breakdowns) {
    llmCallCount += run.llmCallCount;
    totalInputTokens += run.totalInputTokens;
    totalOutputTokens += run.totalOutputTokens;
    inputCostUsd += run.inputCostUsd;
    outputCostUsd += run.outputCostUsd;
    unattributedInputTokens += run.unattributedInputTokens;
    if (run.cacheBoundaryUncertain) uncertainCacheRunCount += 1;
    if (run.cacheSupport === 'yes' || run.cacheSupport === 'mixed') sawCacheSupported = true;
    if (run.cacheSupport === 'no' || run.cacheSupport === 'mixed') sawCacheUnsupported = true;
    if (run.pricingMode === 'hypothetical') {
      sawHypotheticalPricing = true;
      if (run.pricedAsModel) pricedAsModels.add(run.pricedAsModel);
    } else {
      sawActualPricing = true;
    }

    if (run.precision === 'measured' || run.precision === 'mixed') sawMeasured = true;
    if (run.precision === 'estimated' || run.precision === 'mixed') sawEstimated = true;

    const runAttributed = run.segments.reduce((sum, s) => sum + s.tokens, 0);
    if (runAttributed > 0) runsWithAttribution += 1;

    for (const segment of run.segments) {
      tokens[segment.segment] += segment.tokens;
      cost[segment.segment] += segment.costUsd;
      if (runAttributed > 0) shareSums[segment.segment] += segment.share;
    }
  }

  const pooledTotal = SEGMENT_ORDER.reduce((sum, s) => sum + tokens[s], 0);
  const names = new Set(breakdowns.map((b) => b.name));

  return {
    runCount: breakdowns.length,
    runName: names.size === 1 ? ([...names][0] ?? null) : null,
    precision: precisionOf(sawMeasured, sawEstimated),
    llmCallCount,
    totalInputTokens,
    totalOutputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    unattributedInputTokens,
    uncertainCacheRunCount,
    cacheSupport: cacheSupportOf(sawCacheSupported, sawCacheUnsupported),
    ...aggregatePricingModeOf(sawActualPricing, sawHypotheticalPricing, pricedAsModels),
    segments: SEGMENT_ORDER.map((segment) => ({
      segment,
      label: SEGMENT_LABELS[segment],
      tokens: tokens[segment],
      costUsd: cost[segment],
      pooledShare: pooledTotal > 0 ? tokens[segment] / pooledTotal : 0,
      meanRunShare: runsWithAttribution > 0 ? shareSums[segment] / runsWithAttribution : 0,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Terminal output                                                     *
 * ------------------------------------------------------------------ */

const PRECISION_NOTE: Record<Precision, string> = {
  measured: 'measured via count_tokens',
  estimated: 'ESTIMATED from character counts',
  mixed: 'MIXED — some calls measured, some estimated',
  none: 'no composition data',
};

export function formatCostBreakdown(run: RunCostBreakdown): string {
  const lines: string[] = [];
  lines.push(`run "${run.name}"  ${run.status}  ${run.durationMs ?? '?'}ms  ${run.runId}`);

  const hypothetical = run.pricingMode === 'hypothetical';
  if (hypothetical) {
    lines.push(`  ⚠⚠ HYPOTHETICAL COST — priced as ${run.pricedAsModel}, NOT real spend ⚠⚠`);
  }

  lines.push(
    `  ${run.llmCallCount} llm calls  ·  input ${int(run.totalInputTokens)} tok  ·  ` +
      `output ${int(run.totalOutputTokens)} tok  ·  total ${usd(run.totalCostUsd)}` +
      (hypothetical ? ` (HYPOTHETICAL, priced as ${run.pricedAsModel})` : ''),
  );
  lines.push(`  input breakdown (${PRECISION_NOTE[run.precision]}):`);

  // 'no': the fresh/cache rd/cache wr columns would be a wall of "tokens / 0 /
  // 0" — technically not wrong, but reads exactly like a cache-miss finding on
  // a provider where caching was never on the table. Drop them and say so once.
  const showCacheColumns = run.cacheSupport !== 'no';

  lines.push(
    '    ' +
      pad('segment', 22) +
      pad('share', 9) +
      pad('tokens', 11) +
      (showCacheColumns ? pad('fresh', 10) + pad('cache rd', 10) + pad('cache wr', 10) : '') +
      'cost',
  );

  for (const segment of run.segments) {
    if (segment.tokens < 0.5) continue;
    lines.push(
      '    ' +
        pad(segment.label, 22) +
        pad(pct(segment.share), 9) +
        pad(int(segment.tokens), 11) +
        (showCacheColumns
          ? pad(int(segment.freshTokens), 10) +
            pad(int(segment.cacheReadTokens), 10) +
            pad(int(segment.cacheWriteTokens), 10)
          : '') +
        usd(segment.costUsd),
    );
  }

  if (run.unattributedInputTokens > 0) {
    lines.push(
      '    ' +
        pad('(unattributed)', 22) +
        pad('', 9) +
        pad(int(run.unattributedInputTokens), 11) +
        (showCacheColumns ? pad('', 30) : '') +
        usd(run.unattributedInputCostUsd),
    );
  }

  lines.push(`  output cost: ${usd(run.outputCostUsd)}   input cost: ${usd(run.inputCostUsd)}`);
  if (run.unpricedCallCount > 0) {
    lines.push(
      hypothetical
        ? `  note: "priceAs" model "${run.pricedAsModel}" has no price on file — every hypothetical cost above is $0`
        : `  note: ${run.unpricedCallCount} call(s) used a model with no price on file`,
    );
  }

  if (run.cacheSupport === 'no') {
    lines.push(
      `  cache: not applicable — every call's provider has no prompt-caching concept ` +
        `(${run.cacheUnsupportedCallCount} call(s)). The tokens above are the full cost, not a cache miss.`,
    );
  } else if (run.cacheSupport === 'mixed') {
    lines.push(
      `  note: ${run.cacheUnsupportedCallCount} of ${run.llmCallCount} call(s) used a provider with no ` +
        `caching concept — their zero cache rd/wr reflects that, not a cache miss.`,
    );
  }

  if (run.cacheBoundaryUncertain) {
    lines.push(
      `  ⚠ cache attribution uncertain on ${run.uncertainCacheCallCount} call(s): cached tokens ` +
        `reached the "latest message" segment, which should never itself be a cache hit. The ` +
        `tools→system→messages prefix assumption may not hold for this call — read the numbers ` +
        `with that in mind.`,
    );
  }
  return lines.join('\n');
}

export function formatAggregateCostBreakdown(agg: AggregateCostBreakdown): string {
  const lines: string[] = [];
  const label = agg.runName ? `"${agg.runName}"` : 'all runs';
  lines.push(`last ${agg.runCount} runs of ${label}  ·  ${agg.llmCallCount} llm calls`);

  if (agg.pricingMode === 'hypothetical') {
    lines.push(`  ⚠⚠ HYPOTHETICAL COST — priced as ${agg.pricedAsModel}, NOT real spend ⚠⚠`);
  } else if (agg.pricingMode === 'mixed') {
    lines.push(
      '  ⚠⚠ MIXED PRICING BASES — these runs were not all priced the same way (some actual, some ' +
        'hypothetical, or hypothetical under different models). The total below sums incompatible ' +
        'numbers and is not meaningful — re-run with a single, consistent `priceAs`. ⚠⚠',
    );
  }

  lines.push(
    `  input ${int(agg.totalInputTokens)} tok  ·  output ${int(agg.totalOutputTokens)} tok  ·  ` +
      `total ${usd(agg.totalCostUsd)}` +
      (agg.pricingMode === 'hypothetical' ? ` (HYPOTHETICAL, priced as ${agg.pricedAsModel})` : ''),
  );
  lines.push(`  input breakdown (${PRECISION_NOTE[agg.precision]}):`);
  lines.push(
    '    ' + pad('segment', 22) + pad('avg/run', 10) + pad('pooled', 10) + pad('tokens', 12) + 'cost',
  );

  for (const segment of agg.segments) {
    if (segment.tokens < 0.5) continue;
    lines.push(
      '    ' +
        pad(segment.label, 22) +
        pad(pct(segment.meanRunShare), 10) +
        pad(pct(segment.pooledShare), 10) +
        pad(int(segment.tokens), 12) +
        usd(segment.costUsd),
    );
  }

  lines.push(
    '  avg/run = every run counted equally.  pooled = share of all tokens (cost-weighted).',
  );

  if (agg.cacheSupport === 'no') {
    lines.push('  cache: not applicable — none of these runs used a provider with a caching concept.');
  } else if (agg.cacheSupport === 'mixed') {
    lines.push('  note: some runs used a provider with no caching concept — see per-run breakdown.');
  }

  if (agg.uncertainCacheRunCount > 0) {
    lines.push(
      `  ⚠ cache attribution uncertain on ${agg.uncertainCacheRunCount} of ${agg.runCount} run(s) — see per-run breakdown`,
    );
  }
  return lines.join('\n');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function int(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}
