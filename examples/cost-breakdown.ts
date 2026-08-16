/**
 * Analysis #1 — Cost Breakdown.
 *
 *   node examples/cost-breakdown.ts
 *
 * Runs the same fake agent several times, then shows:
 *   1. the breakdown of one run, estimated from character counts (the default)
 *   2. the same run measured with count_tokens (`precise: true`)
 *   3. the aggregate across all runs
 *
 * Comparing 1 and 2 is the point: the mock tokenizer packs dense JSON more
 * tightly than prose, so the character estimate systematically UNDER-counts
 * the tool-result segment — which is exactly why precise mode exists.
 */

import {
  createProfiler,
  formatCostBreakdown,
  formatAggregateCostBreakdown,
} from '../src/index.ts';
import { createMockAnthropic } from './mock-anthropic.ts';
import { runAgent } from './agent-scenario.ts';

const profiler = createProfiler({ dbPath: ':memory:' });
const anthropic = createMockAnthropic();

// ---- 1. default: fast, character-based estimate -----------------------------
const estimatedRunId = await runAgent(profiler, anthropic, { runName: 'research-agent' });

console.log('=== one run — default (estimated) ===');
console.log(formatCostBreakdown(profiler.costBreakdown(estimatedRunId)));

// ---- 2. precise: measured with count_tokens ---------------------------------
const preciseRunId = await runAgent(profiler, anthropic, {
  runName: 'research-agent',
  precise: true,
});

// Precise counting is deliberately off the caller's critical path, so it is
// still in flight when the run ends. In an application you would simply read
// the numbers later; here we wait for the counting requests to land.
await new Promise((resolve) => setTimeout(resolve, 200));

console.log('\n=== the same run — precise (measured) ===');
console.log(formatCostBreakdown(profiler.costBreakdown(preciseRunId)));

// ---- 3. across runs ---------------------------------------------------------
for (let i = 0; i < 4; i += 1) {
  await runAgent(profiler, anthropic, { runName: 'research-agent' });
}

console.log('\n=== across the last 20 runs of this agent ===');
console.log(
  formatAggregateCostBreakdown(
    profiler.aggregateCostBreakdown({ name: 'research-agent', limit: 20 }),
  ),
);

// The same numbers are available as plain data, not just as text.
const agg = profiler.aggregateCostBreakdown({ name: 'research-agent', limit: 20 });
const top = [...agg.segments].sort((a, b) => b.meanRunShare - a.meanRunShare)[0];
if (top) {
  console.log(
    `\nheadline: across ${agg.runCount} runs, on average ` +
      `${(top.meanRunShare * 100).toFixed(0)}% of input tokens went to ${top.label}.`,
  );
}

profiler.close();
