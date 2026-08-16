/**
 * The step-1 smoke test: run a small fake agent, record it, read it back.
 *
 *   node examples/basic-run.ts
 *
 * Requires Node >= 22.18. Makes no network calls and costs nothing.
 */

import { createProfiler } from '../src/index.ts';
import type { RunNode } from '../src/index.ts';
import { createMockAnthropic } from './mock-anthropic.ts';
import { runAgent } from './agent-scenario.ts';

const profiler = createProfiler({ dbPath: '.fyren/runs.db' });
const anthropic = createMockAnthropic();

const rootId = await runAgent(profiler, anthropic);
const tree = profiler.getTree(rootId);

console.log('\n=== run tree ===');
printTree(tree);

console.log('\n=== totals ===');
const totals = tree.reduce(
  (acc, n) => ({
    input: acc.input + n.tokens.input,
    output: acc.output + n.tokens.output,
    cacheRead: acc.cacheRead + n.tokens.cacheRead,
    cacheWrite: acc.cacheWrite + n.tokens.cacheWrite,
    cost: acc.cost + n.costUsd,
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
);
console.log(
  `input=${totals.input}  output=${totals.output}  ` +
    `cache_read=${totals.cacheRead}  cache_write=${totals.cacheWrite}  ` +
    `cost=$${totals.cost.toFixed(6)}`,
);

console.log('\n=== raw input composition (chars) of each llm_call ===');
for (const node of tree) {
  if (node.type !== 'llm_call' || !node.inputComposition) continue;
  const c = node.inputComposition.chars;
  console.log(
    `${node.name.padEnd(20)} tools=${c.toolDefs} system=${c.system} ` +
      `history=${c.history} tool_results=${c.toolResults} latest=${c.latest}`,
  );
}

console.log('\n=== last runs ===');
for (const run of profiler.listRuns(10)) {
  console.log(
    `${new Date(run.startedAt).toISOString()}  ${run.name}  ${run.status}  ${run.durationMs}ms  ${run.id}`,
  );
}

profiler.close();

/* ---------------------------------------------------------------- */

function printTree(nodes: readonly RunNode[]): void {
  const byParent = new Map<string | null, RunNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }

  const walk = (parentId: string | null, depth: number): void => {
    for (const node of byParent.get(parentId) ?? []) {
      const indent = '  '.repeat(depth);
      const t = node.tokens;
      const usage =
        node.type === 'llm_call'
          ? ` in=${t.input} out=${t.output} cr=${t.cacheRead} cw=${t.cacheWrite} $${node.costUsd.toFixed(6)}`
          : '';
      console.log(`${indent}${node.type.padEnd(9)} ${node.name}${usage}  (${node.durationMs}ms)`);
      walk(node.id, depth + 1);
    }
  };

  walk(null, 0);
}
