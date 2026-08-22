/**
 * Analysis #3 — Version Diff.
 *
 * Answers: between two sets of runs (e.g. two versions of a prompt, each
 * given its own run `name`), how did token usage and tool-call behavior
 * change?
 *
 * ── Grouping is entirely the caller's job ─────────────────────────────────
 *
 * There is no first-class `version` field on a run — "before" and "after"
 * are just two `{name, limit}` selectors, the same shape `costBreakdownRecent`
 * already accepts. See DECISIONS.md for why a schema change was rejected.
 *
 * ── Usage diff reuses Cost Breakdown entirely ─────────────────────────────
 *
 * Each side is `aggregateCostBreakdown()`'d exactly as it would be on its
 * own; this module only computes the delta between the two aggregates. No
 * new token math.
 *
 * ── Behavior diff, v1: tool-call frequency by name only ───────────────────
 *
 * fyren never stores raw prompt/response content, so "behavior changed" can
 * only mean something structurally observable. Tool-call frequency — how
 * many times each named tool was called, before vs after — is the v1 signal:
 * it directly answers "did the new prompt make the model reach for a tool
 * more or less," using data every `tool_call` node already carries.
 */

import {
  aggregateCostBreakdown,
  costBreakdown,
  type AggregateCostBreakdown,
  type CostBreakdownOptions,
} from './cost-breakdown.ts';
import { SEGMENT_LABELS, SEGMENT_ORDER, type InputSegment, type RunNode } from '../types.ts';

export interface SegmentDelta {
  segment: InputSegment;
  label: string;
  beforeTokens: number;
  afterTokens: number;
  tokensDelta: number;
  beforeCostUsd: number;
  afterCostUsd: number;
  costDelta: number;
  /** Pooled share (see `AggregateSegmentCost.pooledShare`), before vs after. */
  beforeShare: number;
  afterShare: number;
  shareDelta: number;
}

export interface ToolCallFrequencyDelta {
  name: string;
  beforeCount: number;
  afterCount: number;
  /** Total count / number of runs on that side — comparable even when before/after have different run counts. */
  beforeAvgPerRun: number;
  afterAvgPerRun: number;
  /** afterCount - beforeCount, total (not per-run). */
  delta: number;
}

export interface VersionDiffResult {
  before: AggregateCostBreakdown;
  after: AggregateCostBreakdown;
  totalCostDelta: number;
  /** null when `before.totalCostUsd` is 0 — a percentage change from zero is undefined, not infinite. */
  totalCostDeltaPct: number | null;
  /**
   * False when the two sides' dollar figures do not share a pricing basis —
   * either side is internally `'mixed'`, or the two sides are hypothetical
   * under different `priceAs` models, or one side is real and the other
   * hypothetical. `formatVersionDiff` warns loudly when this is false rather
   * than presenting a cost delta that compares incompatible numbers.
   */
  pricingComparable: boolean;
  segments: SegmentDelta[];
  /** Every tool name seen on EITHER side, sorted by |total-count delta| descending. */
  toolCallFrequency: ToolCallFrequencyDelta[];
}

/** Build the diff from two sets of run trees (as returned by `profiler.getTrees`). */
export function diffVersions(
  before: readonly (readonly RunNode[])[],
  after: readonly (readonly RunNode[])[],
  options: { before?: CostBreakdownOptions; after?: CostBreakdownOptions } = {},
): VersionDiffResult {
  const beforeAgg = aggregateCostBreakdown(before.map((tree) => costBreakdown(tree, options.before)));
  const afterAgg = aggregateCostBreakdown(after.map((tree) => costBreakdown(tree, options.after)));

  const totalCostDelta = afterAgg.totalCostUsd - beforeAgg.totalCostUsd;
  const totalCostDeltaPct = beforeAgg.totalCostUsd > 0 ? totalCostDelta / beforeAgg.totalCostUsd : null;

  const pricingComparable =
    beforeAgg.pricingMode !== 'mixed' &&
    afterAgg.pricingMode !== 'mixed' &&
    beforeAgg.pricingMode === afterAgg.pricingMode &&
    beforeAgg.pricedAsModel === afterAgg.pricedAsModel;

  const beforeSegments = new Map(beforeAgg.segments.map((s) => [s.segment, s]));
  const afterSegments = new Map(afterAgg.segments.map((s) => [s.segment, s]));

  const segments: SegmentDelta[] = SEGMENT_ORDER.map((segment) => {
    const b = beforeSegments.get(segment);
    const a = afterSegments.get(segment);
    const beforeTokens = b?.tokens ?? 0;
    const afterTokens = a?.tokens ?? 0;
    const beforeCostUsd = b?.costUsd ?? 0;
    const afterCostUsd = a?.costUsd ?? 0;
    const beforeShare = b?.pooledShare ?? 0;
    const afterShare = a?.pooledShare ?? 0;
    return {
      segment,
      label: SEGMENT_LABELS[segment],
      beforeTokens,
      afterTokens,
      tokensDelta: afterTokens - beforeTokens,
      beforeCostUsd,
      afterCostUsd,
      costDelta: afterCostUsd - beforeCostUsd,
      beforeShare,
      afterShare,
      shareDelta: afterShare - beforeShare,
    };
  });

  return {
    before: beforeAgg,
    after: afterAgg,
    totalCostDelta,
    totalCostDeltaPct,
    pricingComparable,
    segments,
    toolCallFrequency: diffToolCallFrequency(before, after),
  };
}

function countToolCallsByName(trees: readonly (readonly RunNode[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tree of trees) {
    for (const node of tree) {
      if (node.type !== 'tool_call') continue;
      counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    }
  }
  return counts;
}

function diffToolCallFrequency(
  before: readonly (readonly RunNode[])[],
  after: readonly (readonly RunNode[])[],
): ToolCallFrequencyDelta[] {
  const beforeCounts = countToolCallsByName(before);
  const afterCounts = countToolCallsByName(after);
  const names = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  const beforeRunCount = before.length || 1;
  const afterRunCount = after.length || 1;

  const rows: ToolCallFrequencyDelta[] = [...names].map((name) => {
    const beforeCount = beforeCounts.get(name) ?? 0;
    const afterCount = afterCounts.get(name) ?? 0;
    return {
      name,
      beforeCount,
      afterCount,
      beforeAvgPerRun: beforeCount / beforeRunCount,
      afterAvgPerRun: afterCount / afterRunCount,
      delta: afterCount - beforeCount,
    };
  });

  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.name.localeCompare(y.name));
  return rows;
}

/* ------------------------------------------------------------------ *
 * Terminal output                                                     *
 * ------------------------------------------------------------------ */

export function formatVersionDiff(diff: VersionDiffResult): string {
  const lines: string[] = [];
  const beforeLabel = diff.before.runName ? `"${diff.before.runName}"` : `${diff.before.runCount} run(s)`;
  const afterLabel = diff.after.runName ? `"${diff.after.runName}"` : `${diff.after.runCount} run(s)`;
  lines.push(`version diff:  before = ${beforeLabel} (${diff.before.runCount} run(s))  →  after = ${afterLabel} (${diff.after.runCount} run(s))`);

  if (!diff.pricingComparable) {
    lines.push(
      '  ⚠⚠ PRICING BASES DIFFER between before/after — some combination of mixed, real, and ' +
        'hypothetical-under-different-models. The cost delta below compares incompatible numbers ' +
        'and is not meaningful. ⚠⚠',
    );
  }

  lines.push(
    `  total cost: ${usd(diff.before.totalCostUsd)} → ${usd(diff.after.totalCostUsd)}  ` +
      `(${signed(diff.totalCostDelta, usd)}` +
      (diff.totalCostDeltaPct !== null ? `, ${signed(diff.totalCostDeltaPct * 100, (v) => `${v.toFixed(1)}%`)}` : '') +
      ')',
  );

  lines.push('  input by segment:');
  lines.push(
    '    ' + pad('segment', 22) + pad('before', 11) + pad('after', 11) + pad('Δ tokens', 12) + 'Δ cost',
  );
  for (const segment of diff.segments) {
    if (segment.beforeTokens < 0.5 && segment.afterTokens < 0.5) continue;
    lines.push(
      '    ' +
        pad(segment.label, 22) +
        pad(int(segment.beforeTokens), 11) +
        pad(int(segment.afterTokens), 11) +
        pad(signed(segment.tokensDelta, int), 12) +
        signed(segment.costDelta, usd),
    );
  }

  if (diff.toolCallFrequency.length > 0) {
    lines.push('  tool call frequency (avg per run, before → after):');
    for (const tool of diff.toolCallFrequency) {
      lines.push(
        `    ${pad(tool.name, 22)}${tool.beforeAvgPerRun.toFixed(1)} → ${tool.afterAvgPerRun.toFixed(1)}` +
          `  (${signed(tool.delta, (v) => `${v}`)} total call(s))`,
      );
    }
  } else {
    lines.push('  tool call frequency: no tool calls on either side');
  }

  return lines.join('\n');
}

function signed(value: number, format: (value: number) => string): string {
  return value >= 0 ? `+${format(value)}` : format(value);
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
