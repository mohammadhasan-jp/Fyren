/**
 * The public entry point and the tree bookkeeping.
 *
 * A handle is a thin object the caller holds onto. Creating a handle writes an
 * `insert` op (status = 'running'); calling `.end()` writes a `finish` op.
 * Writing twice means a crashed run still leaves a visible, half-finished tree
 * in the database instead of vanishing.
 *
 * Note that a node stores only its OWN tokens. Roll-ups (run totals, per-tool
 * totals) are computed by querying the tree, not by mutating parents — so a
 * late-arriving child can never leave a parent with a stale total.
 */

import { randomUUID } from 'node:crypto';

import { Storage, type ListRunsOptions } from './storage.ts';
import { WriteQueue, type QueueOptions } from './queue.ts';
import { estimateCost } from './pricing.ts';
import {
  costBreakdown,
  aggregateCostBreakdown,
  type RunCostBreakdown,
  type AggregateCostBreakdown,
  type CostBreakdownOptions,
} from './analysis/cost-breakdown.ts';
import {
  detectWaste,
  aggregateWaste,
  type RunWasteReport,
  type AggregateWasteReport,
} from './analysis/waste-detection.ts';
import {
  emptyTokens,
  type InputComposition,
  type NodeStatus,
  type NodeType,
  type RunNode,
  type TokenBreakdown,
  type WriteOp,
} from './types.ts';

type FinishOp = Omit<Extract<WriteOp, { kind: 'finish' }>, 'kind'>;

export interface ProfilerOptions extends QueueOptions {
  /** Where the SQLite file lives. Use ':memory:' in tests. */
  dbPath?: string;
  /** Set false to make the profiler a no-op without touching call sites. */
  enabled?: boolean;
}

/** Run selection plus cost-breakdown options, merged for the multi-run convenience methods. */
export type CostBreakdownRecentOptions = ListRunsOptions & CostBreakdownOptions;

export interface EndOptions {
  status?: NodeStatus;
  tokens?: Partial<TokenBreakdown>;
  provider?: string;
  model?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
  inputComposition?: InputComposition;
  /** Override the computed cost. Normally leave unset. */
  costUsd?: number;
}

export interface StartOptions {
  metadata?: Record<string, unknown>;
  provider?: string;
  model?: string;
  /** See `RunNode.cacheSupported`. Default `true`; set once at start, fixed for the node's life. */
  cacheSupported?: boolean;
}

export class NodeHandle {
  readonly id: string;
  readonly rootId: string;
  readonly parentId: string | null;
  readonly type: NodeType;
  readonly name: string;
  readonly startedAt: number;

  #profiler: Profiler;
  #metadata: Record<string, unknown>;
  #provider: string | null;
  #model: string | null;
  #cacheSupported: boolean;
  #ended = false;

  constructor(profiler: Profiler, node: RunNode) {
    this.#profiler = profiler;
    this.id = node.id;
    this.rootId = node.rootId;
    this.parentId = node.parentId;
    this.type = node.type;
    this.name = node.name;
    this.startedAt = node.startedAt;
    this.#metadata = { ...node.metadata };
    this.#provider = node.provider;
    this.#model = node.model;
    this.#cacheSupported = node.cacheSupported;
  }

  startStep(name: string, options: StartOptions = {}): NodeHandle {
    return this.#profiler._createChild(this, 'step', name, options);
  }

  startLlmCall(name: string, options: StartOptions = {}): NodeHandle {
    return this.#profiler._createChild(this, 'llm_call', name, options);
  }

  startToolCall(name: string, options: StartOptions = {}): NodeHandle {
    return this.#profiler._createChild(this, 'tool_call', name, options);
  }

  /** Merge extra metadata before the node is finished. */
  annotate(metadata: Record<string, unknown>): void {
    Object.assign(this.#metadata, metadata);
  }

  /**
   * Replace this node's input composition, even after `end()`.
   *
   * Precise token counting deliberately finishes after the node does — it must
   * never be on the caller's critical path — so it needs a way back in.
   */
  setComposition(composition: InputComposition): void {
    this.#profiler._setComposition(this.id, composition);
  }

  end(options: EndOptions = {}): void {
    if (this.#ended) return;
    this.#ended = true;

    const tokens: TokenBreakdown = { ...emptyTokens(), ...options.tokens };
    const provider = options.provider ?? this.#provider;
    const model = options.model ?? this.#model;
    const metadata = { ...this.#metadata, ...options.metadata };

    const status: NodeStatus =
      options.status ?? (options.error !== undefined && options.error !== null ? 'error' : 'ok');

    this.#profiler._finish({
      id: this.id,
      status,
      endedAt: Date.now(),
      tokens,
      costUsd: options.costUsd ?? estimateCost(model, tokens),
      provider,
      model,
      cacheSupported: this.#cacheSupported,
      error: options.error === undefined || options.error === null ? null : errorToString(options.error),
      metadata,
      inputComposition: options.inputComposition ?? null,
    });
  }

  /**
   * Run `fn` inside a child node, ending it automatically — including on
   * throw. Convenience for `startStep`/`end` pairs.
   */
  async step<T>(name: string, fn: (node: NodeHandle) => Promise<T> | T): Promise<T> {
    const child = this.startStep(name);
    try {
      const result = await fn(child);
      child.end();
      return result;
    } catch (err) {
      child.end({ error: err });
      throw err;
    }
  }
}

export class Profiler {
  #storage: Storage;
  #queue: WriteQueue;
  #enabled: boolean;

  constructor(options: ProfilerOptions = {}) {
    const dbPath = options.dbPath ?? '.fyren/runs.db';
    this.#enabled = options.enabled ?? true;
    this.#storage = new Storage(dbPath);
    this.#queue = new WriteQueue(this.#storage, options);
  }

  startRun(name: string, options: StartOptions = {}): NodeHandle {
    const id = randomUUID();
    const node: RunNode = {
      id,
      parentId: null,
      rootId: id,
      type: 'run',
      name,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      tokens: emptyTokens(),
      costUsd: 0,
      provider: options.provider ?? null,
      model: options.model ?? null,
      cacheSupported: options.cacheSupported ?? true,
      error: null,
      metadata: options.metadata ?? {},
      inputComposition: null,
    };

    if (this.#enabled) this.#queue.enqueue({ kind: 'insert', node });
    return new NodeHandle(this, node);
  }

  /** Run `fn` inside a run node, ending it automatically — including on throw. */
  async run<T>(
    name: string,
    fn: (run: NodeHandle) => Promise<T> | T,
    options: StartOptions = {},
  ): Promise<T> {
    const handle = this.startRun(name, options);
    try {
      const result = await fn(handle);
      handle.end();
      return result;
    } catch (err) {
      handle.end({ error: err });
      throw err;
    }
  }

  /** @internal — used by NodeHandle. */
  _createChild(parent: NodeHandle, type: NodeType, name: string, options: StartOptions): NodeHandle {
    const node: RunNode = {
      id: randomUUID(),
      parentId: parent.id,
      rootId: parent.rootId,
      type,
      name,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      tokens: emptyTokens(),
      costUsd: 0,
      provider: options.provider ?? null,
      model: options.model ?? null,
      cacheSupported: options.cacheSupported ?? true,
      error: null,
      metadata: options.metadata ?? {},
      inputComposition: null,
    };

    if (this.#enabled) this.#queue.enqueue({ kind: 'insert', node });
    return new NodeHandle(this, node);
  }

  /** @internal — used by NodeHandle. */
  _finish(op: FinishOp): void {
    if (!this.#enabled) return;
    this.#queue.enqueue({ kind: 'finish', ...op });
  }

  /** @internal — used by NodeHandle. */
  _setComposition(id: string, inputComposition: InputComposition): void {
    if (!this.#enabled) return;
    this.#queue.enqueue({ kind: 'composition', id, inputComposition });
  }

  /** Force pending events to disk. Call before reading, and before exit. */
  flush(): void {
    this.#queue.flush();
  }

  getTree(rootId: string): RunNode[] {
    this.flush();
    return this.#storage.getTree(rootId);
  }

  /** Several run trees at once, keyed by run id. */
  getTrees(rootIds: readonly string[]): Map<string, RunNode[]> {
    this.flush();
    return this.#storage.getTrees(rootIds);
  }

  /** Most recent runs, newest first. Pass `name` to filter to one agent. */
  listRuns(options: ListRunsOptions | number = {}): RunNode[] {
    this.flush();
    const normalized = typeof options === 'number' ? { limit: options } : options;
    return this.#storage.listRuns(normalized);
  }

  /** Cost breakdown for one run. Pass `priceAs` for a hypothetical cost under a different model — see `CostBreakdownOptions.priceAs`. Never real spend. */
  costBreakdown(rootId: string, costOptions: CostBreakdownOptions = {}): RunCostBreakdown {
    return costBreakdown(this.getTree(rootId), costOptions);
  }

  /** Cost breakdown for each of the most recent runs, newest first. `priceAs` (if given) applies uniformly to every run fetched. */
  costBreakdownRecent(options: CostBreakdownRecentOptions | number = {}): RunCostBreakdown[] {
    const runs = this.listRuns(options);
    const trees = this.getTrees(runs.map((run) => run.id));
    const costOptions: CostBreakdownOptions =
      typeof options === 'number' ? {} : { priceAs: options.priceAs };
    return runs.map((run) => costBreakdown(trees.get(run.id) ?? [], costOptions));
  }

  /** "Across the last N runs of this agent, on average X% went to ...". */
  aggregateCostBreakdown(options: CostBreakdownRecentOptions | number = {}): AggregateCostBreakdown {
    return aggregateCostBreakdown(this.costBreakdownRecent(options));
  }

  /** Waste Detection for one run — currently: uncached static content. Same `priceAs` option as cost breakdown. */
  wasteReport(rootId: string, costOptions: CostBreakdownOptions = {}): RunWasteReport {
    return detectWaste(this.getTree(rootId), costOptions);
  }

  /** Waste Detection for each of the most recent runs, newest first. */
  wasteReportRecent(options: CostBreakdownRecentOptions | number = {}): RunWasteReport[] {
    const runs = this.listRuns(options);
    const trees = this.getTrees(runs.map((run) => run.id));
    const costOptions: CostBreakdownOptions =
      typeof options === 'number' ? {} : { priceAs: options.priceAs };
    return runs.map((run) => detectWaste(trees.get(run.id) ?? [], costOptions));
  }

  /** "Across the last N runs, how much am I overpaying for content that should have been cached." */
  aggregateWasteReport(options: CostBreakdownRecentOptions | number = {}): AggregateWasteReport {
    return aggregateWaste(this.wasteReportRecent(options));
  }

  close(): void {
    this.#queue.close();
    this.#storage.close();
  }
}

export function createProfiler(options: ProfilerOptions = {}): Profiler {
  return new Profiler(options);
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
