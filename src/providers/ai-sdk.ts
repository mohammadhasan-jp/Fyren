/**
 * Vercel AI SDK adapter.
 *
 * The other four providers in this directory wrap a *client* — you hand
 * `wrapAnthropic` an SDK object and it proxies `messages.create`. That shape
 * does not exist in the AI SDK: there is no client to proxy, because the SDK
 * puts a `LanguageModel` behind `generateText`/`streamText` and never lets you
 * hold the call site. What it gives you instead is a documented interception
 * point — `wrapLanguageModel({ model, middleware })` — so this file implements
 * that, not a proxy.
 *
 * Everything here is structural, like the rest of `providers/`. Nothing is
 * imported from `ai` or `@ai-sdk/provider`; the types below describe the shape
 * of the middleware contract loosely enough that a consumer's concrete
 * `LanguageModelV*Middleware` accepts our object, and every field is narrowed
 * at runtime before it is read. The package stays dependency-free.
 *
 * ## Which AI SDK versions this covers
 *
 * The middleware contract is versioned (`specificationVersion: 'v2' | 'v3' |
 * 'v4'`). That tag is *never read at runtime* — `wrapLanguageModel` destructures
 * only `transformParams` / `wrapGenerate` / `wrapStream` / the three `override*`
 * hooks and throws the rest away. It exists purely so the object type-checks
 * against the version your `ai` release declares. So `fyrenMiddleware` takes it
 * as a type parameter, defaulting to `'v4'`; on an older `ai`, pass
 * `{ specificationVersion: 'v3' }` and nothing about the behaviour changes.
 *
 * ## What is NOT available here
 *
 * Precise mode. `wrapAnthropic` can opt into `messages.count_tokens` because it
 * holds the real client; a middleware holds a `doGenerate` closure and nothing
 * else. Segment sizes are therefore always character estimates, and every
 * report says so — `InputComposition.source` stays `'chars'`.
 */

import type { NodeHandle } from '../profiler.ts';
import type { InputComposition, TokenBreakdown } from '../types.ts';
import { emptyComposition, SEGMENT_ORDER } from '../types.ts';

/* ------------------------------------------------------------------ *
 * Minimal structural types                                            *
 * ------------------------------------------------------------------ */

/**
 * The bits of a `LanguageModelV*` we read.
 *
 * Both fields are optional here even though the real interface requires them,
 * because a hand-written test double should not have to supply either to be
 * usable — and a missing `modelId` degrades to `'unknown'`, not a crash.
 */
export interface AiSdkModelLike {
  readonly provider?: string;
  readonly modelId?: string;
}

/**
 * The call options a middleware receives.
 *
 * Deliberately `unknown`-typed rather than a faithful copy of
 * `LanguageModelV4CallOptions`. Two reasons: the real prompt part types are
 * `interface`s, which TypeScript never gives an implicit index signature, so a
 * faithful-looking loose copy would silently fail to accept them; and this file
 * narrows every field at runtime anyway, exactly like `extractSegments` in
 * `providers/anthropic.ts` does with `params.messages`.
 */
export interface AiSdkCallOptions {
  prompt?: unknown;
  tools?: unknown;
}

/** The nested usage shape — AI SDK middleware spec v3 and v4. */
export interface AiSdkNestedUsage {
  inputTokens?: {
    total?: number | undefined;
    noCache?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  };
  outputTokens?: {
    total?: number | undefined;
    text?: number | undefined;
    reasoning?: number | undefined;
  };
  raw?: unknown;
}

/** The flat usage shape — AI SDK middleware spec v2 (the `ai` v5 line). */
export interface AiSdkFlatUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}

/**
 * How to read `cachedInputTokens` in the FLAT (spec v2) usage shape.
 *
 * - `'subset'` — cached tokens are already counted inside `inputTokens`, so
 *   fresh input is `inputTokens - cachedInputTokens`. This is what the OpenAI
 *   and Gemini providers report.
 * - `'additive'` — `inputTokens` excludes cached tokens, so it IS fresh input
 *   and subtracting would under-count. This is what the Anthropic provider
 *   reports.
 *
 * See `tokensFromAiSdkUsage` for why this cannot be inferred from the numbers.
 */
export type CachedTokenConvention = 'subset' | 'additive';

export interface AiSdkMiddlewareOptions<V extends string = 'v4'> {
  /**
   * Middleware spec version tag. Type-level only — see the file header. Set it
   * to whatever your `ai` release's middleware type demands; `'v4'` by default.
   */
  specificationVersion?: V;
  /** Label for the llm_call node. Defaults to the model id. */
  name?: string;
  /** Extra metadata attached to every call made through this middleware. */
  metadata?: Record<string, unknown>;
  /** Recorded on every node. Defaults to the model's own `provider` string. */
  provider?: string;
  /**
   * Whether prompt caching is a concept for this model at all. Default `true`.
   * Set `false` for a local runtime with no cache (an Ollama community
   * provider, say) — see `WrapOptions.cacheSupported` in `anthropic.ts` for
   * why "not applicable" and "missed" are reported differently.
   */
  cacheSupported?: boolean;
  /**
   * Override the flat-usage cached-token convention. Only consulted when the
   * provider reports the spec-v2 flat usage shape; the nested shape is
   * unambiguous and never needs it.
   */
  cachedInputTokensAre?: CachedTokenConvention;
}

/**
 * The object you hand to `wrapLanguageModel`.
 *
 * `wrapGenerate` and `wrapStream` are generic over what the wrapped call
 * returns and hand it straight back, which is what makes this assignable to a
 * concrete `LanguageModelV2Middleware` / `V3` / `V4` without this file ever
 * naming those types.
 */
export interface FyrenMiddleware<V extends string = 'v4'> {
  readonly specificationVersion: V;

  wrapGenerate<R>(options: {
    doGenerate: () => PromiseLike<R>;
    params: AiSdkCallOptions;
    model: AiSdkModelLike;
  }): Promise<R>;

  wrapStream<P>(options: {
    doStream: () => PromiseLike<{ stream: ReadableStream<P> }>;
    params: AiSdkCallOptions;
    model: AiSdkModelLike;
  }): Promise<{ stream: ReadableStream<P> }>;
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/**
 * Record every call made through a wrapped AI SDK model as a child of `parent`.
 *
 * ```ts
 * const model = wrapLanguageModel({
 *   model: anthropic('claude-sonnet-5'),
 *   middleware: fyrenMiddleware(run),
 * });
 * ```
 *
 * Your `generateText` / `streamText` code does not change. One middleware
 * instance is bound to one `parent` node, so create it inside the `run()` or
 * `step()` whose subtree the calls belong under.
 */
export function fyrenMiddleware<V extends string = 'v4'>(
  parent: NodeHandle,
  options: AiSdkMiddlewareOptions<V> = {},
): FyrenMiddleware<V> {
  const specificationVersion = (options.specificationVersion ?? 'v4') as V;

  return {
    specificationVersion,

    async wrapGenerate<R>({
      doGenerate,
      params,
      model,
    }: {
      doGenerate: () => PromiseLike<R>;
      params: AiSdkCallOptions;
      model: AiSdkModelLike;
    }): Promise<R> {
      const node = startCallNode(parent, params, model, options);
      const composition = analyzeAiSdkComposition(params);
      const provider = providerOf(model, options);

      try {
        const result = await doGenerate();
        const usage = (result as { usage?: unknown } | null | undefined)?.usage;
        node.end({
          tokens: tokensFromAiSdkUsage(usage, { provider, convention: options.cachedInputTokensAre }),
          model: model.modelId,
          provider,
          inputComposition: composition,
          metadata: resultMetadata(result, usage),
        });
        return result;
      } catch (err) {
        // Re-thrown unchanged, by identity. Profiling must never replace the
        // error the caller was going to see.
        node.end({ error: err, inputComposition: composition, provider });
        throw err;
      }
    },

    async wrapStream<P>({
      doStream,
      params,
      model,
    }: {
      doStream: () => PromiseLike<{ stream: ReadableStream<P> }>;
      params: AiSdkCallOptions;
      model: AiSdkModelLike;
    }): Promise<{ stream: ReadableStream<P> }> {
      const node = startCallNode(parent, params, model, options);
      const composition = analyzeAiSdkComposition(params);
      const provider = providerOf(model, options);

      let result: { stream: ReadableStream<P> };
      try {
        result = await doStream();
      } catch (err) {
        node.end({ error: err, inputComposition: composition, provider });
        throw err;
      }

      // Usage arrives on the terminal `finish` part, so the node cannot be
      // settled until the consumer has drained the stream. We pass every chunk
      // through untouched and only watch for that one part — a tap, not a
      // transform.
      let usage: unknown;
      let streamError: unknown;

      // `node.end()` is idempotent, so the two paths into this (a clean
      // `flush`, or a rejected pipe) can race harmlessly — whichever arrives
      // first wins and the other is a no-op.
      const settle = (err?: unknown): void => {
        const failure = err ?? streamError;
        if (failure !== undefined && failure !== null) {
          node.end({
            error: failure,
            inputComposition: composition,
            provider,
            metadata: { streamed: true },
          });
          return;
        }
        node.end({
          tokens: tokensFromAiSdkUsage(usage, { provider, convention: options.cachedInputTokensAre }),
          model: model.modelId,
          provider,
          inputComposition: composition,
          metadata: { ...usageMetadata(usage), streamed: true },
        });
      };

      const tap = new TransformStream<P, P>({
        transform(chunk, controller) {
          const part = chunk as { type?: unknown; usage?: unknown; error?: unknown } | null;
          if (part && typeof part === 'object') {
            if (part.type === 'finish') usage = part.usage;
            // An `error` part is how the SDK reports a mid-stream failure; it
            // does not reject the stream, so without this the node would end
            // 'ok' on a call that failed.
            else if (part.type === 'error') streamError = part.error;
          }
          controller.enqueue(chunk);
        },
        flush() {
          settle();
        },
      });

      // `pipeTo` rather than `pipeThrough` for one reason: it returns a promise
      // that REJECTS if the source stream errors. `flush` only runs on a clean
      // finish, so a mid-flight failure would otherwise leave the node stuck in
      // 'running' forever. Handing back `tap.readable` keeps the caller's
      // stream unlocked — teeing the stream we return would lock it and break
      // the consumer outright.
      void result.stream.pipeTo(tap.writable).catch((err: unknown) => settle(err));

      return { ...result, stream: tap.readable };
    },
  };
}

function startCallNode(
  parent: NodeHandle,
  params: AiSdkCallOptions,
  model: AiSdkModelLike,
  options: AiSdkMiddlewareOptions<string>,
): NodeHandle {
  const modelId = typeof model.modelId === 'string' ? model.modelId : 'unknown';
  return parent.startLlmCall(options.name ?? modelId, {
    provider: providerOf(model, options),
    model: modelId,
    cacheSupported: options.cacheSupported,
    metadata: { ...options.metadata, ...requestMetadata(params) },
  });
}

function providerOf(model: AiSdkModelLike, options: AiSdkMiddlewareOptions<string>): string {
  if (options.provider) return options.provider;
  return typeof model.provider === 'string' && model.provider ? model.provider : 'ai-sdk';
}

/* ------------------------------------------------------------------ *
 * Usage extraction                                                    *
 * ------------------------------------------------------------------ */

export interface UsageMappingOptions {
  /** The model's provider id, used to pick a flat-usage convention. */
  provider?: string;
  /** Explicit override for the flat-usage convention. */
  convention?: CachedTokenConvention;
}

/**
 * Map an AI SDK usage object onto fyren's `TokenBreakdown`.
 *
 * This is the highest-risk function in the file, for exactly the reason
 * `providers/openai.ts` documents: whether cached tokens are ADDITIVE to the
 * input count or a SUBSET already inside it differs per provider, and getting
 * it backwards produces a number that is wrong by the size of the cache while
 * looking perfectly plausible.
 *
 * ## The nested shape (spec v3/v4) is unambiguous — prefer it
 *
 * The SDK normalises the providers itself, and both sides of the split agree.
 * Verified against the shipped provider builds rather than the docs:
 *
 *   @ai-sdk/anthropic  total = input + cacheCreation + cacheRead, noCache = input
 *   @ai-sdk/openai     noCache = promptTokens - cachedTokens - cacheWriteTokens
 *
 * Different arithmetic, same meaning: `noCache` is fresh, never-cached input in
 * both. That is precisely fyren's `TokenBreakdown.input`, so it is read
 * straight across with no arithmetic of our own. When `noCache` is absent we
 * fall back to `total - cacheRead - cacheWrite`, which is the identity the
 * first line above states.
 *
 * ## The flat shape (spec v2) is NOT unambiguous
 *
 * It carries `inputTokens` and `cachedInputTokens` with no field saying how
 * they relate, and the providers genuinely disagree — the `ai` v5-era Anthropic
 * provider sets `inputTokens = response.usage.input_tokens`, which EXCLUDES
 * cached tokens, while OpenAI's `prompt_tokens` INCLUDES them. No arithmetic on
 * two numbers can recover which convention produced them. So the provider id
 * decides, and `cachedInputTokensAre` overrides that for a provider we don't
 * know about. Every node records which rule was applied under
 * `usage_convention`, so a wrong call is auditable after the fact instead of
 * being invisible.
 */
export function tokensFromAiSdkUsage(
  usage: unknown,
  options: UsageMappingOptions = {},
): TokenBreakdown {
  if (!usage || typeof usage !== 'object') {
    return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 };
  }

  const nested = usage as AiSdkNestedUsage;
  if (nested.inputTokens && typeof nested.inputTokens === 'object') {
    const cacheRead = num(nested.inputTokens.cacheRead);
    const cacheWrite = num(nested.inputTokens.cacheWrite);
    const input =
      nested.inputTokens.noCache != null
        ? num(nested.inputTokens.noCache)
        : Math.max(0, num(nested.inputTokens.total) - cacheRead - cacheWrite);

    return {
      input,
      output: num(nested.outputTokens?.total),
      // Reasoning tokens are a SUBSET of output on every provider that reports
      // them, so they are recorded but never added — same rule as `thinking`
      // in the Anthropic mapping.
      thinking: num(nested.outputTokens?.reasoning),
      cacheRead,
      cacheWrite,
    };
  }

  const flat = usage as AiSdkFlatUsage;
  const cached = num(flat.cachedInputTokens);
  const convention = options.convention ?? conventionFor(options.provider);
  const reported = num(flat.inputTokens);

  return {
    input: convention === 'additive' ? reported : Math.max(0, reported - cached),
    output: num(flat.outputTokens),
    thinking: num(flat.reasoningTokens),
    cacheRead: cached,
    // The flat shape has no cache-write field at all. Reporting 0 is honest:
    // it is what the provider told us, not a claim that nothing was written.
    cacheWrite: 0,
  };
}

/**
 * Which flat-usage convention a provider id implies.
 *
 * Anthropic reports cached tokens additively; everything else the AI SDK ships
 * reports them as a subset. Provider ids are namespaced (`anthropic`,
 * `anthropic.messages`, `openai.chat`, …), so this matches on the first segment.
 */
export function conventionFor(provider: string | undefined): CachedTokenConvention {
  const root = (provider ?? '').split('.')[0]?.toLowerCase();
  return root === 'anthropic' ? 'additive' : 'subset';
}

function requestMetadata(params: AiSdkCallOptions): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (Array.isArray(params.tools)) meta.tool_count = params.tools.length;
  if (Array.isArray(params.prompt)) meta.message_count = params.prompt.length;
  return meta;
}

function resultMetadata(result: unknown, usage: unknown): Record<string, unknown> {
  const meta: Record<string, unknown> = usageMetadata(usage);
  const r = result as { finishReason?: unknown; providerMetadata?: unknown } | null | undefined;
  if (!r || typeof r !== 'object') return meta;
  if (r.finishReason != null) meta.stop_reason = r.finishReason;
  if (r.providerMetadata != null) meta.provider_metadata = r.providerMetadata;
  return meta;
}

function usageMetadata(usage: unknown): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (!usage || typeof usage !== 'object') return meta;
  // Keep the provider's own numbers verbatim, the same way the Anthropic
  // wrapper keeps `raw_usage`: fields we don't understand today stay
  // analysable later without re-running the agent.
  meta.raw_usage = usage;
  const nested = usage as AiSdkNestedUsage;
  if (!(nested.inputTokens && typeof nested.inputTokens === 'object')) {
    meta.usage_shape = 'flat';
  }
  return meta;
}

/* ------------------------------------------------------------------ *
 * Input composition — segmentation                                    *
 * ------------------------------------------------------------------ */

/**
 * Split an AI SDK call into fyren's five disjoint segments, as raw text.
 *
 * The rules are the same ones `providers/anthropic.ts` uses, restated for a
 * prompt format where the system message lives INSIDE the message array rather
 * than in its own parameter:
 *
 *   - `tools`                                  → toolDefs
 *   - any message with `role: 'system'`        → system
 *   - any `tool-result` part, wherever it sits → toolResults, always
 *   - the last NON-system message              → latest
 *   - every other message                      → history
 *
 * "Last non-system message" is what keeps this equivalent to the Anthropic
 * split: there, `system` is a separate field and cannot be the last element of
 * `messages[]`, so a system message trailing the array here must not steal the
 * `latest` slot. As with the Anthropic version, neither rule ever looks at the
 * text of a part — only at its `role` and `type` — so there is no heuristic to
 * get wrong.
 */
export function extractAiSdkSegments(params: AiSdkCallOptions): Record<string, string> {
  const parts: Record<string, string[]> = {
    toolDefs: [],
    system: [],
    history: [],
    toolResults: [],
    latest: [],
  };

  if (params.tools != null) parts.toolDefs!.push(jsonText(params.tools));

  const prompt = Array.isArray(params.prompt) ? params.prompt : [];

  let lastNonSystem = -1;
  prompt.forEach((message, index) => {
    if ((message as { role?: unknown } | null)?.role !== 'system') lastNonSystem = index;
  });

  prompt.forEach((message, index) => {
    const m = message as { role?: unknown; content?: unknown } | null;
    if (!m) return;

    if (m.role === 'system') {
      parts.system!.push(textOf(m.content).text);
      return;
    }

    const { text, toolResultText } = textOf(m.content);
    if (toolResultText) parts.toolResults!.push(toolResultText);
    if (text) {
      if (index === lastNonSystem) parts.latest!.push(text);
      else parts.history!.push(text);
    }
  });

  const out: Record<string, string> = {};
  for (const segment of SEGMENT_ORDER) out[segment] = (parts[segment] ?? []).join('\n');
  return out;
}

/** Character sizes of each segment. Always cheap, always available. */
export function analyzeAiSdkComposition(params: AiSdkCallOptions): InputComposition {
  const segments = extractAiSdkSegments(params);
  const composition = emptyComposition();
  for (const segment of SEGMENT_ORDER) {
    composition.chars[segment] = segments[segment]?.length ?? 0;
  }
  return composition;
}

/**
 * Text of a message's content, with `tool-result` parts separated out so the
 * two never overlap.
 */
function textOf(content: unknown): { text: string; toolResultText: string } {
  if (content == null) return { text: '', toolResultText: '' };
  // A system message's content is a plain string in every spec version.
  if (typeof content === 'string') return { text: content, toolResultText: '' };

  if (Array.isArray(content)) {
    const plain: string[] = [];
    const toolResults: string[] = [];
    for (const part of content) {
      const p = part as { type?: unknown } | null;
      if (p && p.type === 'tool-result') toolResults.push(partText(p));
      else plain.push(partText(part));
    }
    return { text: plain.join('\n'), toolResultText: toolResults.join('\n') };
  }

  return { text: jsonText(content), toolResultText: '' };
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  const p = part as Record<string, unknown> | null;
  if (!p) return '';

  switch (p.type) {
    case 'text':
    case 'reasoning':
      return typeof p.text === 'string' ? p.text : '';
    case 'tool-call':
      // The assistant's decision to call a tool is ordinary assistant content —
      // it is the RESULT that belongs in `toolResults`.
      return jsonText({ toolName: p.toolName, input: p.input });
    case 'tool-result':
      return toolResultText(p.output);
    case 'file':
    case 'reasoning-file':
      return fileText(p.data);
    default:
      return jsonText(p);
  }
}

/**
 * A tool result's payload is a tagged union — text, JSON, or a denial. Reading
 * `value` blindly would stringify `undefined` for the denial case and lose the
 * JSON case's real size.
 */
function toolResultText(output: unknown): string {
  const o = output as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return jsonText(output);

  switch (o.type) {
    case 'text':
    case 'error-text':
      return typeof o.value === 'string' ? o.value : '';
    case 'json':
    case 'error-json':
      return jsonText(o.value);
    case 'execution-denied':
      return typeof o.reason === 'string' ? o.reason : '';
    default:
      return jsonText(o);
  }
}

/**
 * Size of a file part.
 *
 * Known limitation, stated rather than hidden: an image's byte count is not
 * proportional to its token count the way prose is (providers bill images by
 * area), so a request carrying file parts gets a character-weighted breakdown
 * that under- or over-states that segment. The alternative — dropping files
 * from the count entirely — would break the invariant the whole analysis rests
 * on, that the five segments sum to the request. Counting them and flagging
 * the call is the lesser wrong. `precise: true` is the real fix and is not
 * reachable from a middleware; see the file header.
 */
function fileText(data: unknown): string {
  if (data == null) return '';
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return jsonText(data);

  if (typeof d.data === 'string') return d.data;
  if (d.data instanceof Uint8Array) return 'x'.repeat(d.data.byteLength);
  if (typeof d.url === 'string') return d.url;
  if (typeof d.text === 'string') return d.text;
  return jsonText(d);
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
