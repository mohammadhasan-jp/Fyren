/**
 * Anthropic wrapper.
 *
 * Deliberately structural: we type against the SHAPE of the SDK client, not
 * against `@anthropic-ai/sdk` itself. Two reasons —
 *
 *   - the package stays dependency-free, and
 *   - a fake client (see examples/mock-anthropic.ts) works exactly like the
 *     real one, so the whole profiler can be developed without spending a cent
 *     on API calls.
 *
 * Everything here is provider-specific. The moment we add a second provider,
 * only this file gets a sibling — `types.ts`, `storage.ts` and `profiler.ts`
 * do not change.
 */

import type { NodeHandle } from '../profiler.ts';
import type { InputComposition, SegmentSizes, TokenBreakdown } from '../types.ts';
import { emptyComposition, emptySegmentSizes, SEGMENT_ORDER } from '../types.ts';

/* ------------------------------------------------------------------ *
 * Minimal structural types                                            *
 * ------------------------------------------------------------------ */

export interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicMessageLike {
  model?: string;
  stop_reason?: string | null;
  usage?: AnthropicUsageLike;
  content?: unknown;
  [key: string]: unknown;
}

export interface MessageStreamLike {
  finalMessage(): Promise<AnthropicMessageLike>;
  [key: string]: unknown;
}

export interface TokenCountLike {
  input_tokens: number;
}

export interface AnthropicMessagesLike {
  create(params: AnthropicCreateParams, ...rest: unknown[]): Promise<AnthropicMessageLike>;
  stream?(params: AnthropicCreateParams, ...rest: unknown[]): MessageStreamLike;
  countTokens?(params: AnthropicCreateParams, ...rest: unknown[]): Promise<TokenCountLike>;
  [key: string]: unknown;
}

export interface AnthropicLike {
  messages: AnthropicMessagesLike;
  [key: string]: unknown;
}

export interface AnthropicCreateParams {
  model?: string;
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

export interface WrapOptions {
  /**
   * Label for the llm_call node. Defaults to the model id, which is what you
   * usually want to see in a tree.
   */
  name?: string;
  /** Extra metadata attached to every call made through this wrapper. */
  metadata?: Record<string, unknown>;
  /**
   * Measure each input segment with the provider's token-counting endpoint
   * instead of estimating from character counts. OFF by default.
   *
   * Why you might want it: the characters-per-token ratio is not constant.
   * Raw JSON tool output tokenizes far less efficiently than fluent prose, so
   * a character-proportional split systematically under-weights tool results
   * and over-weights natural language.
   *
   * What it costs: up to 5 extra `messages.count_tokens` requests per call
   * (one per non-empty segment), plus a one-off baseline per model. The
   * endpoint is free of token charges but has its own requests-per-minute
   * limit, separate from message creation.
   *
   * What it does NOT cost: your latency. Counting runs AFTER your response has
   * been handed back, and the result is written to the node later.
   */
  precise?: boolean;
  /** Called if precise counting fails. Failure is silent by default. */
  onPreciseError?: (err: unknown) => void;
  /**
   * Recorded on every node this wrapper creates. Defaults to `'anthropic'` —
   * despite the function's name, everything below is structural (it only
   * relies on the `AnthropicLike` shape), so a second provider whose client
   * has been translated into this same shape (see `providers/ollama.ts`) can
   * reuse this exact instrumentation by overriding `provider`.
   */
  provider?: string;
  /**
   * Whether prompt caching is a concept for this client at all. Default
   * `true` (Anthropic's Messages API supports it). Set `false` for a client
   * that has no caching concept whatsoever (Ollama, most local runtimes) —
   * this is a different claim than "caching happened to read 0 tokens on
   * this call", and Cost Breakdown reports the two differently: `false`
   * means the cache columns don't apply, not that caching was tried and
   * missed. See `analysis/cost-breakdown.ts` § cacheSupport.
   */
  cacheSupported?: boolean;
}

/**
 * Return a client that records every `messages.create` / `messages.stream`
 * call as a child of `parent`.
 *
 * The returned value is a Proxy, so any SDK method we do not instrument still
 * works untouched.
 */
export function wrapAnthropic<T extends AnthropicLike>(
  client: T,
  parent: NodeHandle,
  options: WrapOptions = {},
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') {
        return wrapMessages(target.messages, parent, options);
      }
      return bindIfFunction(Reflect.get(target, prop, receiver), target);
    },
  });
}

function wrapMessages(
  messages: AnthropicMessagesLike,
  parent: NodeHandle,
  options: WrapOptions,
): AnthropicMessagesLike {
  const provider = options.provider ?? 'anthropic';

  return new Proxy(messages, {
    get(target, prop, receiver) {
      if (prop === 'create') {
        return async (params: AnthropicCreateParams, ...rest: unknown[]) => {
          const node = startCallNode(parent, params, options);
          const composition = analyzeComposition(params);
          try {
            const response = await target.create(params, ...rest);
            node.end({
              tokens: tokensFromUsage(response?.usage),
              model: response?.model ?? params.model,
              provider,
              inputComposition: composition,
              metadata: responseMetadata(response),
            });
            schedulePreciseCounting(target, node, params, options);
            return response;
          } catch (err) {
            node.end({ error: err, inputComposition: composition, provider });
            throw err;
          }
        };
      }

      if (prop === 'stream' && typeof target.stream === 'function') {
        return (params: AnthropicCreateParams, ...rest: unknown[]) => {
          const node = startCallNode(parent, params, options);
          const composition = analyzeComposition(params);
          let stream: MessageStreamLike;
          try {
            stream = target.stream!(params, ...rest);
          } catch (err) {
            node.end({ error: err, inputComposition: composition, provider });
            throw err;
          }

          // Settle the node when the stream finishes. We never await this on
          // the caller's behalf, and we swallow the rejection here so that
          // profiling can't produce an unhandled rejection in user code —
          // the caller still sees the real error from their own await.
          void stream
            .finalMessage()
            .then((response) => {
              node.end({
                tokens: tokensFromUsage(response?.usage),
                model: response?.model ?? params.model,
                provider,
                inputComposition: composition,
                metadata: { ...responseMetadata(response), streamed: true },
              });
              schedulePreciseCounting(target, node, params, options);
            })
            .catch((err: unknown) => {
              node.end({
                error: err,
                inputComposition: composition,
                provider,
                metadata: { streamed: true },
              });
            });

          return stream;
        };
      }

      return bindIfFunction(Reflect.get(target, prop, receiver), target);
    },
  });
}

function startCallNode(
  parent: NodeHandle,
  params: AnthropicCreateParams,
  options: WrapOptions,
): NodeHandle {
  const model = typeof params.model === 'string' ? params.model : 'unknown';
  return parent.startLlmCall(options.name ?? model, {
    provider: options.provider ?? 'anthropic',
    model,
    cacheSupported: options.cacheSupported,
    metadata: { ...options.metadata, ...requestMetadata(params) },
  });
}

/* ------------------------------------------------------------------ *
 * Usage extraction                                                    *
 * ------------------------------------------------------------------ */

export function tokensFromUsage(usage: AnthropicUsageLike | undefined): TokenBreakdown {
  return {
    input: num(usage?.input_tokens),
    output: num(usage?.output_tokens),
    // Anthropic bills thinking as part of output_tokens and does not report it
    // separately, so we leave this at 0 rather than inventing a number. The
    // field exists for providers that do split it out.
    thinking: 0,
    cacheRead: num(usage?.cache_read_input_tokens),
    cacheWrite: num(usage?.cache_creation_input_tokens),
  };
}

function requestMetadata(params: AnthropicCreateParams): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (params.max_tokens !== undefined) meta.max_tokens = params.max_tokens;
  if (params.thinking !== undefined) meta.thinking = params.thinking;
  if (params.output_config !== undefined) meta.output_config = params.output_config;
  if (Array.isArray(params.tools)) meta.tool_count = params.tools.length;
  if (Array.isArray(params.messages)) meta.message_count = params.messages.length;
  return meta;
}

function responseMetadata(response: AnthropicMessageLike | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (!response) return meta;
  if (response.stop_reason != null) meta.stop_reason = response.stop_reason;
  // Keep the provider's raw usage object verbatim. Fields we don't understand
  // today (server_tool_use, iterations, ...) become analysable later without a
  // re-run.
  if (response.usage) meta.raw_usage = response.usage;

  if (Array.isArray(response.content)) {
    const kinds = new Set<string>();
    let thinkingChars = 0;
    for (const block of response.content as Array<Record<string, unknown>>) {
      const type = typeof block?.type === 'string' ? block.type : 'unknown';
      kinds.add(type);
      if (type === 'thinking' && typeof block.thinking === 'string') {
        thinkingChars += block.thinking.length;
      }
    }
    meta.content_block_types = [...kinds];
    if (thinkingChars > 0) meta.thinking_chars = thinkingChars;
  }
  return meta;
}

/* ------------------------------------------------------------------ *
 * Input composition — segmentation                                    *
 * ------------------------------------------------------------------ */

/**
 * Split the request into the five disjoint segments, as raw text.
 *
 * The `latest` / `toolResults` boundary — the one place this could look like a
 * guess — is actually a fixed function of two facts about each content block,
 * never of its text:
 *
 *   - is this block inside the LAST message of `messages[]`?      → latest, else history
 *   - is this block a `tool_result`?                              → toolResults, always
 *
 * `tool_result` wins regardless of position, and is checked independently of
 * the position rule — so a last message that mixes a tool_result with plain
 * text (e.g. a result plus a comment in the same turn) splits correctly: the
 * tool_result half goes to `toolResults`, the text half to `latest`. Neither
 * rule ever looks at block content, so there is no heuristic to get wrong.
 *
 * Concatenating all five segments reproduces every piece of the request
 * exactly once — that is what makes a percentage breakdown meaningful.
 */
export function extractSegments(params: AnthropicCreateParams): Record<string, string> {
  const parts: Record<string, string[]> = {
    toolDefs: [],
    system: [],
    history: [],
    toolResults: [],
    latest: [],
  };

  if (params.system != null) parts.system!.push(textOf(params.system).text);
  if (params.tools != null) parts.toolDefs!.push(jsonText(params.tools));

  const messages = Array.isArray(params.messages) ? params.messages : [];
  messages.forEach((message, index) => {
    const content = (message as Record<string, unknown> | null)?.content;
    const { text, toolResultText } = textOf(content);
    if (toolResultText) parts.toolResults!.push(toolResultText);
    if (text) {
      if (index === messages.length - 1) parts.latest!.push(text);
      else parts.history!.push(text);
    }
  });

  const out: Record<string, string> = {};
  for (const segment of SEGMENT_ORDER) out[segment] = (parts[segment] ?? []).join('\n');
  return out;
}

/** Character sizes of each segment. Always cheap, always available. */
export function analyzeComposition(params: AnthropicCreateParams): InputComposition {
  const segments = extractSegments(params);
  const composition = emptyComposition();
  for (const segment of SEGMENT_ORDER) {
    composition.chars[segment] = segments[segment]?.length ?? 0;
  }
  return composition;
}

/**
 * Extract text from message content, separating tool_result blocks out.
 * Returns the non-tool-result text and the tool-result text independently so
 * the two never overlap.
 */
function textOf(content: unknown): { text: string; toolResultText: string } {
  if (content == null) return { text: '', toolResultText: '' };
  if (typeof content === 'string') return { text: content, toolResultText: '' };

  if (Array.isArray(content)) {
    const plain: string[] = [];
    const toolResults: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null;
      if (b && b.type === 'tool_result') toolResults.push(blockText(b));
      else plain.push(blockText(block));
    }
    return { text: plain.join('\n'), toolResultText: toolResults.join('\n') };
  }

  return { text: jsonText(content), toolResultText: '' };
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  const b = block as Record<string, unknown> | null;
  if (!b) return '';

  if (typeof b.text === 'string') return b.text;
  if (typeof b.thinking === 'string') return b.thinking;
  if (b.type === 'tool_result') return textOf(b.content).text || jsonText(b.content);
  return jsonText(b);
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Input composition — precise mode                                    *
 * ------------------------------------------------------------------ */

/**
 * Baselines are per (client, model): the fixed prompt overhead the endpoint
 * reports even for an almost-empty request. Cached so it costs one call per
 * model per process, not one per llm_call.
 */
const baselineCache = new WeakMap<AnthropicMessagesLike, Map<string, Promise<number>>>();

/** One token of filler, used to probe the fixed overhead. */
const PROBE = 'a';
const PROBE_TOKENS = 1;

function schedulePreciseCounting(
  messages: AnthropicMessagesLike,
  node: NodeHandle,
  params: AnthropicCreateParams,
  options: WrapOptions,
): void {
  if (!options.precise) return;
  if (typeof messages.countTokens !== 'function') return;

  // Fire and forget. The caller already has their response; this only updates
  // the stored node once it lands.
  void measureComposition(messages, params)
    .then((composition) => {
      if (composition) node.setComposition(composition);
    })
    .catch((err: unknown) => {
      options.onPreciseError?.(err);
    });
}

/**
 * Measure each segment with `messages.count_tokens`.
 *
 * `system` and `toolDefs` are measured EXACTLY, by sending them through the
 * fields they really occupy and subtracting the baseline. The three message
 * segments are interleaved inside `messages[]` and cannot be isolated that
 * way, so they are measured as standalone text — very close, but a proxy.
 */
export async function measureComposition(
  messages: AnthropicMessagesLike,
  params: AnthropicCreateParams,
): Promise<InputComposition | null> {
  if (typeof messages.countTokens !== 'function') return null;

  const model = typeof params.model === 'string' ? params.model : undefined;
  if (!model) return null;

  const segments = extractSegments(params);
  const composition = analyzeComposition(params);
  const baseline = await getBaseline(messages, model);
  const tokens: SegmentSizes = emptySegmentSizes();

  const count = async (probe: AnthropicCreateParams): Promise<number> =>
    (await messages.countTokens!(probe)).input_tokens;

  if (composition.chars.system > 0) {
    tokens.system = Math.max(
      0,
      (await count({ model, system: params.system, messages: probeMessages() })) - baseline,
    );
  }
  if (composition.chars.toolDefs > 0) {
    tokens.toolDefs = Math.max(
      0,
      (await count({ model, tools: params.tools, messages: probeMessages() })) - baseline,
    );
  }

  for (const segment of ['history', 'toolResults', 'latest'] as const) {
    const text = segments[segment];
    if (!text) continue;
    const raw = await count({ model, messages: [{ role: 'user', content: text }] });
    tokens[segment] = Math.max(0, raw - baseline + PROBE_TOKENS);
  }

  composition.tokens = tokens;
  composition.source = 'count_tokens';
  return composition;
}

function probeMessages(): unknown {
  return [{ role: 'user', content: PROBE }];
}

function getBaseline(messages: AnthropicMessagesLike, model: string): Promise<number> {
  let perModel = baselineCache.get(messages);
  if (!perModel) {
    perModel = new Map();
    baselineCache.set(messages, perModel);
  }

  const cached = perModel.get(model);
  if (cached) return cached;

  const pending = messages
    .countTokens!({ model, messages: probeMessages() })
    .then((r) => r.input_tokens)
    .catch((err: unknown) => {
      perModel!.delete(model); // don't cache a failure
      throw err;
    });

  perModel.set(model, pending);
  return pending;
}

/* ------------------------------------------------------------------ */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bindIfFunction(value: unknown, thisArg: object): unknown {
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(thisArg) : value;
}
