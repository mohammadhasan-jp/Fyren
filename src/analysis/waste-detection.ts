/**
 * Analysis #2 — Waste Detection.
 *
 * Per PROJECT_CONTEXT.md §4c, this analysis has three planned patterns:
 *   1. context تکراری که هر بار دوباره فرستاده می‌شود (repeated context resent every call) — done
 *   2. خروجی tool که هرگز استفاده نشد (tool output that was never used) — THIS FILE, second half
 *   3. retry ها و هزینه‌شان (retries and their cost)
 *
 * `WasteFinding` is a discriminated union, one member per pattern, meant to
 * grow rather than be redesigned as #3 gets built.
 *
 * ── Pattern #1: uncached static content ─────────────────────────────────
 *
 * `system` and tool definitions are the two segments an agent almost never
 * varies mid-session — they are, by construction, meant to be identical call
 * after call. If a run sends the SAME system prompt (or the same tool defs)
 * on call 2, 3, 4… and none of those later calls shows a cache read for it,
 * every one of those resends is paying full price for something a
 * `cache_control` breakpoint would have made ~90% cheaper. That is real,
 * fixable waste — and on a provider with no caching concept at all
 * (`cacheSupported: false`, e.g. Ollama), it is the SAME pattern with a
 * different fix: no lever to pull on this provider, but the number still
 * tells you what a caching-capable one would save you.
 *
 * How "the same content" is decided without ever storing the actual prompt
 * text (fyren only ever stores segment SIZES, not content — see
 * `InputComposition`): the first call that has a segment non-empty sets a
 * BASELINE token count; any later call whose count for that segment matches
 * the baseline exactly counts as a recurrence. A size mismatch resets the
 * baseline rather than being flagged — a legitimately-changed prompt
 * mid-session must not read as "waste". This is a real limitation, not just
 * a caveat: content that changes size but happens to still be wasteful in
 * some other way would be missed, and (much rarer) a genuine edit that
 * happens to keep the exact same character count would be misread as
 * unchanged. Both are acceptable given the alternative (storing raw prompt
 * text) is a much larger, separate decision this file does not make.
 *
 * Reuses `attributeCall` from cost-breakdown.ts for the per-call fresh/cache
 * split — the prefix-fill cache logic has exactly one definition, here.
 *
 * ── Pattern #2: orphaned tool calls ────────────────────────────────────
 *
 * "Tool output that was never used" cannot mean "the model ignored the
 * content" — fyren never stores tool result TEXT (only sizes, same reason as
 * above), so there is no content to check semantic use against. What IS
 * fully detectable from the tree alone: a `tool_call` whose result was fetched
 * but never had the CHANCE to reach the model, because no `llm_call` anywhere
 * later in the run ever ran again. Concretely: a tool_call in a run that has
 * FINISHED (not still `running`) with no llm_call starting after it ends.
 *
 * Real causes this catches: hitting a tool-loop iteration cap while the model
 * still wanted to call more tools (see MAX_TOOL_ITERATIONS in
 * examples/doc-qa-agent.ts — exactly this bug, left in on purpose there),
 * an early-exit or crash path that drops the accumulated tool result, or a
 * genuine logic error that forgets to loop back after a tool call.
 *
 * The check deliberately looks across the WHOLE run, not just the tool
 * call's immediate step — an agent might legitimately end a step right after
 * a tool call and pick up the result in the NEXT step. Only "nothing, in the
 * entire rest of the run, ever called the model again" is unambiguous enough
 * to flag; anything narrower would false-positive on that pattern.
 *
 * Cost is not the parent llm_call's tokens (those paid for something real —
 * deciding to call the tool) — it is any LLM cost the tool call ITSELF
 * incurred (a nested llm_call under the tool_call, e.g. a tool that
 * summarizes its own output — see examples/doc-qa-agent.ts's search tool
 * pattern). A pure-function tool with no nested LLM cost still gets flagged,
 * just at $0: the finding is about wasted WORK, not only wasted dollars.
 */

import { rateFor, effectiveRate, estimateCost, type ModelRate } from '../pricing.ts';
import {
  attributeCall,
  cacheSupportOf,
  aggregatePricingModeOf,
  type PricingMode,
  type AggregatePricingMode,
  type CostBreakdownOptions,
} from './cost-breakdown.ts';
import { SEGMENT_LABELS, compositionWeights, type InputSegment, type RunNode } from '../types.ts';

/** Tokens of slop before a recurrence's fresh portion counts as real waste, not float noise. */
const WASTE_EPSILON_TOKENS = 0.5;

/** The only segments that are meant to stay constant across calls within one run. */
const STATIC_SEGMENTS: readonly InputSegment[] = ['toolDefs', 'system'];

export interface StaticContentWasteFinding {
  type: 'uncached_static_content';
  segment: InputSegment;
  label: string;
  /** This segment's token count as first observed in the run — what "the same" is measured against. */
  baselineTokens: number;
  /** Calls after the first that matched the baseline size exactly. */
  recurrences: number;
  /** Of those, how many paid a non-trivial fresh (uncached) price for it. */
  uncachedRecurrences: number;
  /** Fresh tokens billed for this segment across all recurrences — the first send is never counted; it has nothing to be cached against yet. */
  wastedTokens: number;
  /** What those fresh tokens cost vs. what they would have cost as cache reads (0.1x, or per-model — see pricing.ts). 0 when the rate is unknown. */
  avoidableCostUsd: number;
}

export interface OrphanedToolCallFinding {
  type: 'orphaned_tool_call';
  toolName: string;
  /** How many times this tool's result was fetched but never reached another model call in this run. */
  occurrences: number;
  /** Sum of any LLM cost the orphaned tool calls incurred on their own (e.g. a summarizing sub-call). 0 for a pure-function tool — the finding still stands; it just cost nothing extra beyond the wasted call itself. */
  avoidableCostUsd: number;
}

/** A discriminated union, one member per Waste Detection pattern — see the file header. */
export type WasteFinding = StaticContentWasteFinding | OrphanedToolCallFinding;

export interface RunWasteReport {
  runId: string;
  name: string;
  llmCallCount: number;
  cacheSupport: 'yes' | 'no' | 'mixed';
  pricingMode: PricingMode;
  pricedAsModel: string | null;
  findings: WasteFinding[];
  totalAvoidableCostUsd: number;
}

/** Build the waste report for one run tree (as returned by `profiler.getTree`). */
export function detectWaste(tree: readonly RunNode[], options: CostBreakdownOptions = {}): RunWasteReport {
  const root = tree.find((node) => node.type === 'run') ?? tree[0];
  const calls = tree.filter((node) => node.type === 'llm_call');

  const hypotheticalRate = options.priceAs ? rateFor(options.priceAs) : null;
  const resolveRate = (call: RunNode): ModelRate | null =>
    options.priceAs ? hypotheticalRate : rateFor(call.model);

  let sawCacheSupported = false;
  let sawCacheUnsupported = false;
  for (const call of calls) {
    if (call.cacheSupported) sawCacheSupported = true;
    else sawCacheUnsupported = true;
  }

  const staticContentFindings = STATIC_SEGMENTS.map((segment) =>
    detectStaticContentForSegment(calls, segment, resolveRate),
  ).filter((finding): finding is StaticContentWasteFinding => finding !== null);

  const orphanedToolFindings = detectOrphanedToolCalls(tree, root, options.priceAs);

  const findings: WasteFinding[] = [...staticContentFindings, ...orphanedToolFindings];

  return {
    runId: root?.rootId ?? '',
    name: root?.name ?? '',
    llmCallCount: calls.length,
    cacheSupport: cacheSupportOf(sawCacheSupported, sawCacheUnsupported),
    pricingMode: options.priceAs ? 'hypothetical' : 'actual',
    pricedAsModel: options.priceAs ?? null,
    findings,
    totalAvoidableCostUsd: findings.reduce((sum, f) => sum + f.avoidableCostUsd, 0),
  };
}

function detectStaticContentForSegment(
  calls: readonly RunNode[],
  segment: InputSegment,
  resolveRate: (call: RunNode) => ModelRate | null,
): StaticContentWasteFinding | null {
  // Two different units are in play, on purpose:
  //
  //   - `baselineSize` (from `compositionWeights`, i.e. characters unless
  //     precise mode is on) is used ONLY to decide "is this the same content
  //     as before". Characters are the right measure for that, because they
  //     don't move when the REST of the conversation grows around a
  //     genuinely-static segment.
  //   - `attributed.tokens[segment]` (from `attributeCall`, always real
  //     tokens) is what gets REPORTED and priced.
  //
  // Why not just use attributeCall's token estimate for the comparison too:
  // it is a call's characters-proportion applied to THAT call's real total —
  // as history grows call to call, system/toolDefs's SHARE of the total
  // shrinks even though the content itself never changed, so its token
  // estimate drifts down across an otherwise-static run. Comparing on that
  // would silently stop matching a truly-unchanged system prompt after a few
  // turns. Comparing on raw character size does not have this problem.
  let baselineSize: number | null = null;
  let baselineTokens = 0;
  let recurrences = 0;
  let uncachedRecurrences = 0;
  let wastedTokens = 0;
  let avoidableCostUsd = 0;

  for (const call of calls) {
    const composition = call.inputComposition;
    if (!composition) continue;

    const segSize = compositionWeights(composition)[segment];
    if (segSize <= 0) continue; // this call doesn't carry the segment at all

    if (baselineSize === null || segSize !== baselineSize) {
      // First sighting, or the content's size changed — either way this
      // occurrence establishes a (new) baseline, not a recurrence of the old one.
      baselineSize = segSize;

      const totalInputTokens = call.tokens.input + call.tokens.cacheRead + call.tokens.cacheWrite;
      const attributed = attributeCall(call, totalInputTokens);
      baselineTokens = attributed ? attributed.tokens[segment] : 0;
      continue;
    }

    recurrences += 1;

    const totalInputTokens = call.tokens.input + call.tokens.cacheRead + call.tokens.cacheWrite;
    const attributed = attributeCall(call, totalInputTokens);
    if (!attributed) continue;

    const freshInSegment = attributed.fresh[segment];
    if (freshInSegment <= WASTE_EPSILON_TOKENS) continue; // effectively fully cached — no waste here

    uncachedRecurrences += 1;
    wastedTokens += freshInSegment;

    const rate = resolveRate(call);
    if (rate) {
      // The saving is the gap between paying full input price and paying the
      // cache-READ price — and that discount is per-model, not a constant
      // (0.1x on most current models, 0.25x on OpenAI's GPT-4.1 family, so the
      // avoidable amount on GPT-4.1 is genuinely smaller). See src/pricing.ts.
      const { input } = effectiveRate(rate, totalInputTokens);
      avoidableCostUsd += (freshInSegment * input * (1 - rate.cacheReadMultiplier)) / 1_000_000;
    }
  }

  if (recurrences === 0 || uncachedRecurrences === 0) return null;

  return {
    type: 'uncached_static_content',
    segment,
    label: SEGMENT_LABELS[segment],
    baselineTokens,
    recurrences,
    uncachedRecurrences,
    wastedTokens,
    avoidableCostUsd,
  };
}

/**
 * A tool_call whose result never had the chance to reach the model — see the
 * file header for exactly what this does and does not claim.
 */
function detectOrphanedToolCalls(
  tree: readonly RunNode[],
  root: RunNode | undefined,
  priceAsModel: string | undefined,
): OrphanedToolCallFinding[] {
  // A run still in progress hasn't had its chance yet — flagging its last
  // tool call as "orphaned" would just be catching it mid-flight.
  if (!root || root.status === 'running') return [];

  const toolCalls = tree.filter((node) => node.type === 'tool_call' && node.status !== 'running');
  if (toolCalls.length === 0) return [];

  const llmCallStarts = tree
    .filter((node) => node.type === 'llm_call')
    .map((node) => node.startedAt);

  const childrenByParent = new Map<string, RunNode[]>();
  for (const node of tree) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }

  const byToolName = new Map<string, { occurrences: number; avoidableCostUsd: number }>();

  for (const tool of toolCalls) {
    const endedAt = tool.endedAt ?? tool.startedAt;
    const hadLaterLlmCall = llmCallStarts.some((startedAt) => startedAt > endedAt);
    if (hadLaterLlmCall) continue; // the model got a chance to use it — not orphaned

    const nestedLlmCost = sumDescendantLlmCost(childrenByParent, tool.id, priceAsModel);
    const entry = byToolName.get(tool.name) ?? { occurrences: 0, avoidableCostUsd: 0 };
    entry.occurrences += 1;
    entry.avoidableCostUsd += nestedLlmCost;
    byToolName.set(tool.name, entry);
  }

  return [...byToolName.entries()].map(([toolName, entry]) => ({
    type: 'orphaned_tool_call' as const,
    toolName,
    ...entry,
  }));
}

/** Sum the cost of every llm_call anywhere under `nodeId` — a tool can nest its own model calls. */
function sumDescendantLlmCost(
  childrenByParent: Map<string, RunNode[]>,
  nodeId: string,
  priceAsModel: string | undefined,
): number {
  let total = 0;
  const stack = [...(childrenByParent.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'llm_call') {
      total += estimateCost(priceAsModel ?? node.model, node.tokens);
    }
    stack.push(...(childrenByParent.get(node.id) ?? []));
  }

  return total;
}

/* ------------------------------------------------------------------ *
 * Across runs                                                         *
 * ------------------------------------------------------------------ */

export type AggregateWasteFinding =
  | {
      type: 'uncached_static_content';
      segment: InputSegment;
      label: string;
      /** How many of the analysed runs had this finding at all. */
      affectedRunCount: number;
      totalWastedTokens: number;
      totalAvoidableCostUsd: number;
    }
  | {
      type: 'orphaned_tool_call';
      toolName: string;
      label: string;
      /** How many of the analysed runs had this finding at all. */
      affectedRunCount: number;
      totalOccurrences: number;
      totalAvoidableCostUsd: number;
    };

export interface AggregateWasteReport {
  runCount: number;
  /** Non-empty when every run analysed had the same name. */
  runName: string | null;
  cacheSupport: 'yes' | 'no' | 'mixed';
  pricingMode: AggregatePricingMode;
  pricedAsModel: string | null;
  findings: AggregateWasteFinding[];
  totalAvoidableCostUsd: number;
}

interface StaticContentAccumulator {
  kind: 'uncached_static_content';
  segment: InputSegment;
  affectedRunCount: number;
  totalWastedTokens: number;
  totalAvoidableCostUsd: number;
}
interface OrphanedToolAccumulator {
  kind: 'orphaned_tool_call';
  toolName: string;
  affectedRunCount: number;
  totalOccurrences: number;
  totalAvoidableCostUsd: number;
}

/** Roll several run waste reports into one, ranked by dollar impact. */
export function aggregateWaste(reports: readonly RunWasteReport[]): AggregateWasteReport {
  const byKey = new Map<string, StaticContentAccumulator | OrphanedToolAccumulator>();

  let sawCacheSupported = false;
  let sawCacheUnsupported = false;
  let sawActualPricing = false;
  let sawHypotheticalPricing = false;
  const pricedAsModels = new Set<string>();
  let totalAvoidableCostUsd = 0;

  for (const report of reports) {
    if (report.cacheSupport === 'yes' || report.cacheSupport === 'mixed') sawCacheSupported = true;
    if (report.cacheSupport === 'no' || report.cacheSupport === 'mixed') sawCacheUnsupported = true;
    if (report.pricingMode === 'hypothetical') {
      sawHypotheticalPricing = true;
      if (report.pricedAsModel) pricedAsModels.add(report.pricedAsModel);
    } else {
      sawActualPricing = true;
    }
    totalAvoidableCostUsd += report.totalAvoidableCostUsd;

    for (const finding of report.findings) {
      if (finding.type === 'uncached_static_content') {
        const key = `static:${finding.segment}`;
        const entry = (byKey.get(key) as StaticContentAccumulator | undefined) ?? {
          kind: 'uncached_static_content',
          segment: finding.segment,
          affectedRunCount: 0,
          totalWastedTokens: 0,
          totalAvoidableCostUsd: 0,
        };
        entry.affectedRunCount += 1;
        entry.totalWastedTokens += finding.wastedTokens;
        entry.totalAvoidableCostUsd += finding.avoidableCostUsd;
        byKey.set(key, entry);
      } else {
        const key = `tool:${finding.toolName}`;
        const entry = (byKey.get(key) as OrphanedToolAccumulator | undefined) ?? {
          kind: 'orphaned_tool_call',
          toolName: finding.toolName,
          affectedRunCount: 0,
          totalOccurrences: 0,
          totalAvoidableCostUsd: 0,
        };
        entry.affectedRunCount += 1;
        entry.totalOccurrences += finding.occurrences;
        entry.totalAvoidableCostUsd += finding.avoidableCostUsd;
        byKey.set(key, entry);
      }
    }
  }

  const names = new Set(reports.map((r) => r.name));
  const { pricingMode, pricedAsModel } = aggregatePricingModeOf(
    sawActualPricing,
    sawHypotheticalPricing,
    pricedAsModels,
  );

  const findings: AggregateWasteFinding[] = [...byKey.values()]
    .map((entry): AggregateWasteFinding =>
      entry.kind === 'uncached_static_content'
        ? {
            type: 'uncached_static_content',
            segment: entry.segment,
            label: SEGMENT_LABELS[entry.segment],
            affectedRunCount: entry.affectedRunCount,
            totalWastedTokens: entry.totalWastedTokens,
            totalAvoidableCostUsd: entry.totalAvoidableCostUsd,
          }
        : {
            type: 'orphaned_tool_call',
            toolName: entry.toolName,
            label: entry.toolName,
            affectedRunCount: entry.affectedRunCount,
            totalOccurrences: entry.totalOccurrences,
            totalAvoidableCostUsd: entry.totalAvoidableCostUsd,
          },
    )
    .sort((a, b) => b.totalAvoidableCostUsd - a.totalAvoidableCostUsd);

  return {
    runCount: reports.length,
    runName: names.size === 1 ? ([...names][0] ?? null) : null,
    cacheSupport: cacheSupportOf(sawCacheSupported, sawCacheUnsupported),
    pricingMode,
    pricedAsModel,
    findings,
    totalAvoidableCostUsd,
  };
}

/* ------------------------------------------------------------------ *
 * Terminal output                                                     *
 * ------------------------------------------------------------------ */

export function formatWasteReport(report: RunWasteReport): string {
  const lines: string[] = [];
  lines.push(`run "${report.name}"  ${report.llmCallCount} llm calls  ${report.runId}`);

  const hypothetical = report.pricingMode === 'hypothetical';

  if (report.findings.length === 0) {
    lines.push('  no waste detected');
    return lines.join('\n');
  }

  if (hypothetical) {
    lines.push(`  ⚠⚠ HYPOTHETICAL COST — priced as ${report.pricedAsModel}, NOT real spend ⚠⚠`);
  }

  for (const finding of report.findings) {
    if (finding.type === 'uncached_static_content') {
      // "N still billed some of it fresh", not "N paid full price" — a resend
      // can be PARTIALLY cached (verified against real Gemini implicit
      // caching: one call cached 4,076 of ~8,600 system-prompt tokens and
      // paid full rate on the rest). Only the fresh remainder is counted in
      // `wastedTokens`, so the wording has to match the arithmetic.
      lines.push(
        `  ⚠ uncached static content — "${finding.label}" (${int(finding.baselineTokens)} tok) was resent ` +
          `${finding.recurrences} time(s) after the first send; ${finding.uncachedRecurrences} of those still ` +
          `billed some of it as fresh input rather than a cache read. ` +
          `${int(finding.wastedTokens)} avoidable tokens, ${usd(finding.avoidableCostUsd)}` +
          `${hypothetical ? ' (hypothetical)' : ''}.`,
      );
    } else {
      lines.push(
        `  ⚠ orphaned tool call — "${finding.toolName}" ran ${finding.occurrences} time(s) but its result ` +
          `never reached another model call before the run ended (hit an iteration cap, or an early exit).` +
          (finding.avoidableCostUsd > 0
            ? ` ${usd(finding.avoidableCostUsd)} of that was the tool's own LLM cost${hypothetical ? ' (hypothetical)' : ''}, spent for nothing.`
            : ''),
      );
    }
  }

  if (report.cacheSupport === 'no') {
    lines.push(
      '  note: this provider has no caching concept at all — the uncached-static-content figures show the ' +
        'POTENTIAL savings on a caching-capable provider, not a fixable bug in your code as written.',
    );
  }

  lines.push(
    `  total avoidable: ${usd(report.totalAvoidableCostUsd)}${hypothetical ? '  (HYPOTHETICAL, priced as ' + report.pricedAsModel + ')' : ''}`,
  );
  return lines.join('\n');
}

export function formatAggregateWasteReport(agg: AggregateWasteReport): string {
  const lines: string[] = [];
  const label = agg.runName ? `"${agg.runName}"` : 'all runs';
  lines.push(`last ${agg.runCount} runs of ${label}`);

  if (agg.pricingMode === 'hypothetical') {
    lines.push(`  ⚠⚠ HYPOTHETICAL COST — priced as ${agg.pricedAsModel}, NOT real spend ⚠⚠`);
  } else if (agg.pricingMode === 'mixed') {
    lines.push(
      '  ⚠⚠ MIXED PRICING BASES — these runs were not all priced the same way — the total below is not ' +
        'meaningful. Re-run with a single, consistent `priceAs`. ⚠⚠',
    );
  }

  if (agg.findings.length === 0) {
    lines.push('  no waste detected');
    return lines.join('\n');
  }

  for (const finding of agg.findings) {
    if (finding.type === 'uncached_static_content') {
      lines.push(
        `  ⚠ "${finding.label}" uncached in ${finding.affectedRunCount} of ${agg.runCount} run(s) — ` +
          `${int(finding.totalWastedTokens)} avoidable tokens, ${usd(finding.totalAvoidableCostUsd)} total.`,
      );
    } else {
      lines.push(
        `  ⚠ "${finding.toolName}" orphaned in ${finding.affectedRunCount} of ${agg.runCount} run(s), ` +
          `${finding.totalOccurrences} occurrence(s) total` +
          (finding.totalAvoidableCostUsd > 0 ? ` — ${usd(finding.totalAvoidableCostUsd)} of wasted LLM cost.` : '.'),
      );
    }
  }

  if (agg.cacheSupport === 'no') {
    lines.push('  note: none of these runs used a provider with a caching concept — see per-run breakdown.');
  }

  lines.push(
    `  total avoidable: ${usd(agg.totalAvoidableCostUsd)}${agg.pricingMode === 'hypothetical' ? '  (HYPOTHETICAL, priced as ' + agg.pricedAsModel + ')' : ''}`,
  );
  return lines.join('\n');
}

function int(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}
