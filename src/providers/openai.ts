/**
 * OpenAI, via the Chat Completions API (`POST /v1/chat/completions`).
 *
 * Like `providers/ollama.ts`, this presents itself as an `AnthropicLike`
 * client so `wrapAnthropic` can instrument it unchanged (see that function's
 * `provider` option — despite the name it is structurally generic). Agent
 * code keeps speaking `AnthropicCreateParams` in / `AnthropicMessageLike` out;
 * only this file knows OpenAI's wire format exists.
 *
 * Because OpenAI's Chat Completions format is the same OpenAI-compatible
 * shape Ollama exposes, the request/response TRANSLATION is shared with
 * `providers/openai-compat.ts` rather than written twice. What this file adds
 * on top of that shared core is the parts that are genuinely OpenAI-specific:
 * authentication, the base URL, and — the important one — cache reporting.
 *
 * ── Caching: automatic, prefix-based, and NOT opt-in ──────────────────────
 *
 * Verified against OpenAI's prompt-caching docs (2026-08):
 *
 *   - Caching is ON by default. There is no `cache_control` equivalent and
 *     nothing to enable; any request at or above the minimum cacheable prefix
 *     participates automatically.
 *   - It is PREFIX-based, exactly like Anthropic's — "cache hits are only
 *     possible for exact prefix matches" — which is why fyren's existing
 *     prefix-fill attribution (see analysis/cost-breakdown.ts) applies here
 *     unchanged. The difference is that OpenAI picks the longest matching
 *     prefix itself instead of honouring caller-placed breakpoints.
 *   - Minimum 1,024 tokens; hits occur in 128-token increments. Below that
 *     floor nothing caches at all, which matters for Waste Detection: a small
 *     uncached prompt on OpenAI is not a missing-breakpoint bug the way it
 *     would be on Anthropic, it is simply under the threshold.
 *   - Usage fields (Chat Completions): `usage.prompt_tokens_details.cached_tokens`
 *     and, on GPT-5.6+, `usage.prompt_tokens_details.cache_write_tokens`.
 *     The Responses API renames these to `usage.input_tokens_details.*`;
 *     `tokensFromOpenAiUsage` reads either.
 *
 * A note on what `cached_tokens` means for cost. OpenAI reports cached tokens
 * as a SUBSET of `prompt_tokens`, not in addition to it — so fresh input is
 * `prompt_tokens - cached_tokens - cache_write_tokens`, not `prompt_tokens`.
 * Getting this backwards would double-count every cached token. Anthropic's
 * fields are disjoint from `input_tokens`, hence the different arithmetic.
 */

import type {
  AnthropicCreateParams,
  AnthropicLike,
  AnthropicMessageLike,
} from './anthropic.ts';
import type { TokenBreakdown } from '../types.ts';
import {
  toOpenAiCompatRequest,
  fromOpenAiCompatResponse,
  type OpenAiCompatResponse,
} from './openai-compat.ts';

/** Below this prompt size OpenAI does not cache at all — see the file header. */
export const OPENAI_MIN_CACHEABLE_TOKENS = 1024;

/** OpenAI's usage object, covering both the Chat Completions and Responses field names. */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: OpenAiPromptTokensDetails;
  /** Responses API spells the same thing this way. */
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: OpenAiPromptTokensDetails;
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OpenAiPromptTokensDetails {
  cached_tokens?: number;
  /** GPT-5.6 and later only; absent on models that write to cache for free. */
  cache_write_tokens?: number;
  [key: string]: unknown;
}

/**
 * Map OpenAI usage onto fyren's `TokenBreakdown`.
 *
 * The subtraction is the load-bearing part: `cached_tokens` and
 * `cache_write_tokens` are both counted INSIDE `prompt_tokens`, so `input`
 * (fresh, full-price tokens) is what's left after removing them. Clamped at 0
 * so a provider-side inconsistency can never produce a negative token count.
 */
export function tokensFromOpenAiUsage(usage: OpenAiUsage | undefined): TokenBreakdown {
  const promptTokens = num(usage?.prompt_tokens ?? usage?.input_tokens);
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details;

  const cacheRead = num(details?.cached_tokens);
  const cacheWrite = num(details?.cache_write_tokens);

  return {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output: num(usage?.completion_tokens ?? usage?.output_tokens),
    // OpenAI reports reasoning tokens inside completion_tokens, exactly as
    // Anthropic folds thinking into output — so it is not added to any total.
    thinking: num(usage?.completion_tokens_details?.reasoning_tokens),
    cacheRead,
    cacheWrite,
  };
}

export interface OpenAiClientOptions {
  apiKey: string;
  /** Default `https://api.openai.com/v1`. Point this at any compatible gateway. */
  baseUrl?: string;
  /** Per-request timeout, ms. Default 2 minutes. */
  timeoutMs?: number;
  /**
   * Optional `prompt_cache_key` sent on every request. OpenAI routes requests
   * sharing a key to the same cache, materially improving hit rate for a
   * long-running agent session. Omitted entirely when unset.
   */
  promptCacheKey?: string;
}

/** Build an `AnthropicLike` client backed by the real OpenAI API. */
export function createOpenAiClient(options: OpenAiClientOptions): AnthropicLike {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    messages: {
      async create(params: AnthropicCreateParams): Promise<AnthropicMessageLike> {
        const body: Record<string, unknown> = { ...toOpenAiCompatRequest(params) };
        if (options.promptCacheKey) body.prompt_cache_key = options.promptCacheKey;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();

        let response: Response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          throw connectionError(err, baseUrl);
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(
            `OpenAI request failed (${response.status} ${response.statusText}): ${text || '(no body)'}`,
          );
        }

        const json = (await response.json()) as OpenAiCompatResponse;
        const message = fromOpenAiCompatResponse(json, String(body.model ?? ''));
        // Replace the shared translator's usage mapping with the OpenAI-aware
        // one — it is the only part that differs, and it differs a lot.
        message.usage = tokensToUsageShape(tokensFromOpenAiUsage(json.usage as OpenAiUsage));
        return message;
      },
      // No `countTokens`: OpenAI's token-counting endpoint accepts only the
      // Responses API request format, which is not what this client sends.
      // `wrapAnthropic`'s precise mode detects the missing method and falls
      // back to the character estimate rather than erroring.
    },
  };
}

/**
 * `wrapAnthropic` reads usage through `tokensFromUsage`, which expects
 * Anthropic's field names — so hand the already-correct numbers back in that
 * shape rather than re-deriving them.
 */
function tokensToUsageShape(tokens: TokenBreakdown): Record<string, number> {
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_input_tokens: tokens.cacheRead,
    cache_creation_input_tokens: tokens.cacheWrite,
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function connectionError(err: unknown, baseUrl: string): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(`OpenAI request timed out against ${baseUrl}.`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Could not reach OpenAI at ${baseUrl} (${message}).`);
}
