/**
 * `fyren breakdown [run]` — where the input tokens went.
 *
 * With no argument: the aggregate across the selected runs, i.e. what the
 * bare `fyren` summary already shows, on its own.
 *
 * With a run id (or a unique prefix): that one run in full, plus its call
 * tree. The tree is the per-run drill-down v1 deliberately left out — it is
 * the view that turns "60% of your input is the system prompt" into "and here
 * are the eleven calls that resent it".
 */

import type { CliContext } from '../index.ts';
import { emptyDatabaseMessage, printJson, resolveRun, selectorFor, withProfiler } from '../session.ts';
import { formatAggregateCostBreakdown, formatCostBreakdown } from '../../analysis/cost-breakdown.ts';
import { colorStatus, duration, heading, int, usd } from '../format.ts';
import type { Palette } from '../colors.ts';
import type { RunNode } from '../../types.ts';

export async function breakdownCommand(ctx: CliContext, runArg: string | undefined): Promise<number> {
  return withProfiler(ctx, (profiler) => {
    if (runArg === undefined) {
      const selector = selectorFor(ctx);
      const aggregate = profiler.aggregateCostBreakdown(selector);
      if (ctx.json) return printJson(ctx, aggregate);
      if (aggregate.runCount === 0) {
        ctx.out(emptyDatabaseMessage(ctx));
        return 0;
      }
      ctx.out(formatAggregateCostBreakdown(aggregate));
      return 0;
    }

    const resolved = resolveRun(profiler, runArg);
    if (!resolved.ok) {
      ctx.err(resolved.message);
      return 1;
    }

    const costOptions = ctx.priceAs !== undefined ? { priceAs: ctx.priceAs } : {};
    const breakdown = profiler.costBreakdown(resolved.id, costOptions);
    const tree = profiler.getTree(resolved.id);

    if (ctx.json) return printJson(ctx, { breakdown, tree });

    ctx.out(formatCostBreakdown(breakdown));
    ctx.out('');
    ctx.out(heading('CALL TREE', ctx.palette));
    ctx.out(renderTree(tree, ctx.palette));
    return 0;
  });
}

/**
 * The run tree as an indented outline.
 *
 * Children are grouped by `parentId` rather than assumed adjacent: the flat
 * array is ordered by start time, and concurrent steps interleave in it, so
 * anything that walked it linearly would nest siblings under each other.
 */
export function renderTree(nodes: readonly RunNode[], palette: Palette): string {
  const childrenOf = new Map<string | null, RunNode[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.startedAt - b.startedAt);
  }

  const lines: string[] = [];

  const walk = (node: RunNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const branch = isRoot ? '' : isLast ? '`- ' : '|- ';
    lines.push(prefix + branch + describe(node, palette));

    const children = childrenOf.get(node.id) ?? [];
    const childPrefix = isRoot ? prefix : prefix + (isLast ? '   ' : '|  ');
    children.forEach((child, i) => walk(child, childPrefix, i === children.length - 1, false));
  };

  const roots = childrenOf.get(null) ?? [];
  roots.forEach((root, i) => walk(root, '', i === roots.length - 1, true));

  return lines.join('\n');
}

function describe(node: RunNode, palette: Palette): string {
  const kind =
    node.type === 'llm_call'
      ? palette.magenta(node.type)
      : node.type === 'tool_call'
        ? palette.blue(node.type)
        : palette.dim(node.type);

  const parts = [kind, palette.bold(node.name), colorStatus(node.status, palette)];

  const total = node.tokens.input + node.tokens.cacheRead + node.tokens.cacheWrite;
  if (total > 0 || node.tokens.output > 0) {
    parts.push(palette.dim(`in ${int(total)} / out ${int(node.tokens.output)}`));
  }
  if (node.tokens.cacheRead > 0) parts.push(palette.green(`cache-read ${int(node.tokens.cacheRead)}`));
  if (node.tokens.cacheWrite > 0) parts.push(palette.yellow(`cache-write ${int(node.tokens.cacheWrite)}`));
  if (node.costUsd > 0) parts.push(usd(node.costUsd));
  if (node.durationMs !== null) parts.push(palette.dim(duration(node.durationMs)));
  if (node.error !== null) parts.push(palette.red(node.error));

  return parts.join('  ');
}
