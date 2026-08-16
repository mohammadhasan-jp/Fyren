/**
 * Core data model.
 *
 * The single most important decision here is that everything is a NODE in a
 * TREE. A node knows its parent (`parentId`) and the root of its tree
 * (`rootId`). Storing `rootId` on every node is redundant information, but it
 * lets us fetch a whole run with one indexed query instead of a recursive
 * walk — worth the duplication.
 *
 * These types are provider-agnostic on purpose. Anthropic is the first
 * provider we wrap, but nothing below mentions it.
 */

/** Node kinds. A run contains steps; steps contain llm_calls and tool_calls; tool_calls can nest. */
export type NodeType = 'run' | 'step' | 'llm_call' | 'tool_call';

export type NodeStatus = 'running' | 'ok' | 'error';

/**
 * Raw token counts as reported by the provider.
 *
 * Important: `thinking` is NOT added to the total. On the Anthropic API,
 * thinking tokens are billed as part of `output`, so counting them separately
 * would double-count. The field exists so that providers which DO report them
 * separately can, and so analysis can answer "what share of output was
 * thinking?".
 */
export interface TokenBreakdown {
  input: number;
  output: number;
  /** Subset of `output`, when the provider reports it. Not added to totals. */
  thinking: number;
  /** Tokens served from the prompt cache (billed at ~0.1x input). */
  cacheRead: number;
  /** Tokens written to the prompt cache (billed at ~1.25x input). */
  cacheWrite: number;
}

export function emptyTokens(): TokenBreakdown {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/* ------------------------------------------------------------------ *
 * Input composition                                                   *
 * ------------------------------------------------------------------ */

/**
 * The five buckets a request's input is split into.
 *
 * They are DISJOINT and EXHAUSTIVE — every character of the request lands in
 * exactly one. That is a hard requirement: a breakdown whose parts don't sum
 * to the whole is not a breakdown. In particular `toolResults` is carved OUT
 * of the messages, so it does not overlap `history` or `latest`.
 */
export type InputSegment = 'toolDefs' | 'system' | 'history' | 'toolResults' | 'latest';

/**
 * Segments in the order they appear in the rendered prompt.
 *
 * Anthropic renders `tools` → `system` → `messages`, and the prompt cache is a
 * PREFIX match. The analysis layer walks this order to decide which segments
 * the cache actually covered, instead of smearing cache savings evenly across
 * everything.
 */
export const SEGMENT_ORDER: readonly InputSegment[] = [
  'toolDefs',
  'system',
  'history',
  'toolResults',
  'latest',
] as const;

export const SEGMENT_LABELS: Record<InputSegment, string> = {
  toolDefs: 'tool definitions',
  system: 'system prompt',
  history: 'conversation history',
  toolResults: 'tool results',
  latest: 'latest message',
};

export type SegmentSizes = Record<InputSegment, number>;

export function emptySegmentSizes(): SegmentSizes {
  return { toolDefs: 0, system: 0, history: 0, toolResults: 0, latest: 0 };
}

export function sumSegments(sizes: SegmentSizes): number {
  return SEGMENT_ORDER.reduce((total, segment) => total + sizes[segment], 0);
}

/**
 * Where a request's input came from.
 *
 * `chars` is always populated and always cheap. `tokens` is populated only
 * when precise mode is on, and is measured with the provider's token-counting
 * endpoint.
 *
 * Why two: the character ratio is NOT constant across segments — raw JSON tool
 * output tokenizes very differently from fluent English prose. Since the whole
 * product rests on this number, precise mode exists. But it costs extra network
 * round trips, so it is opt-in, and `source` records which one produced the
 * numbers so no output can silently pass an estimate off as a measurement.
 */
export interface InputComposition {
  chars: SegmentSizes;
  tokens: SegmentSizes | null;
  source: 'chars' | 'count_tokens';
}

export function emptyComposition(): InputComposition {
  return { chars: emptySegmentSizes(), tokens: null, source: 'chars' };
}

/** The sizes the analysis layer should weight by. */
export function compositionWeights(composition: InputComposition): SegmentSizes {
  return composition.source === 'count_tokens' && composition.tokens
    ? composition.tokens
    : composition.chars;
}

/* ------------------------------------------------------------------ *
 * Nodes                                                               *
 * ------------------------------------------------------------------ */

/** One node in a run tree, as stored. */
export interface RunNode {
  id: string;
  parentId: string | null;
  /** id of the top-level `run` node. For a run node itself, rootId === id. */
  rootId: string;
  type: NodeType;
  /** Human label: run name, step name, tool name, or model name. */
  name: string;
  status: NodeStatus;

  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;

  tokens: TokenBreakdown;
  /** Estimated USD, computed at write time from the pricing table. */
  costUsd: number;

  provider: string | null;
  model: string | null;

  /**
   * Does prompt caching exist as a concept for this node's provider at all?
   * Default `true`. `false` means the zero-valued `cacheRead`/`cacheWrite`
   * fields on `tokens` are not a cache miss — caching was never on the table
   * for this call, e.g. Ollama and most local runtimes. Analysis code must
   * treat "unsupported" and "supported but unused" as different findings;
   * see `analysis/cost-breakdown.ts` § cacheSupport.
   */
  cacheSupported: boolean;

  /** Present when status === 'error'. */
  error: string | null;

  /** Anything the caller wants: prompt version, tool args, raw provider usage. */
  metadata: Record<string, unknown>;

  /** Only meaningful on llm_call nodes. */
  inputComposition: InputComposition | null;
}

/**
 * What the queue hands to storage.
 *
 * A node is written on start and again on end. `composition` is a third,
 * separate op because precise token counting finishes AFTER the node does —
 * it must never delay the caller.
 */
export type WriteOp =
  | { kind: 'insert'; node: RunNode }
  | {
      kind: 'finish';
      id: string;
      status: NodeStatus;
      endedAt: number;
      tokens: TokenBreakdown;
      costUsd: number;
      provider: string | null;
      model: string | null;
      cacheSupported: boolean;
      error: string | null;
      metadata: Record<string, unknown>;
      inputComposition: InputComposition | null;
    }
  | { kind: 'composition'; id: string; inputComposition: InputComposition };
