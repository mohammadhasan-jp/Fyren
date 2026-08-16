/**
 * Ollama, via its OpenAI-compatible endpoint (`POST /v1/chat/completions`).
 *
 * There is no Ollama SDK to wrap — this file speaks real HTTP to a real
 * server. It presents itself as an `AnthropicLike` client (the same
 * structural shape `wrapAnthropic` already instruments), translating in both
 * directions:
 *
 *   caller → AnthropicCreateParams → toOllamaRequest  → real OpenAI-compat JSON → Ollama
 *   Ollama → OpenAI-compat JSON → fromOllamaResponse → AnthropicMessageLike → caller
 *
 * The translation itself lives in `providers/openai-compat.ts`, shared with
 * `providers/openai.ts` — both speak the identical wire format, so writing it
 * twice would just let the two copies drift. `toOllamaRequest` /
 * `fromOllamaResponse` remain exported here as the Ollama-facing names.
 *
 * Why translate at all instead of writing a parallel instrumentation path:
 * the agent code that drives a run (see examples/doc-qa-agent.ts) is written
 * once, against `AnthropicCreateParams`/`AnthropicMessageLike`, and works
 * unchanged against any provider — only these files know a foreign wire
 * format exists. And reusing `wrapAnthropic` (via its `provider` /
 * `cacheSupported` options — see providers/anthropic.ts) means segmentation,
 * node bookkeeping, and error handling are not duplicated per provider;
 * despite the name, that function only relies on the `AnthropicLike` shape.
 *
 * Verified against a real local Ollama instance (qwen2.5:0.5b): basic replies,
 * a tool_use round trip, and the exact tool_call/tool_result JSON shape all
 * match what the server actually returns — this isn't a guess at the
 * OpenAI-compat spec.
 *
 * Two things Ollama genuinely does not have, and this file does not pretend
 * to:
 *
 *   - Prompt caching. There is no cache_control concept and no cache token
 *     fields in its usage object. Always pass `cacheSupported: false` to
 *     `wrapAnthropic` for a client from here — see that option's doc comment
 *     for why this must be a distinct signal from "supported, zero hits".
 *     (This is the one real behavioural difference from OpenAI, which uses
 *     the same wire format but does cache — see providers/openai.ts.)
 *   - A token-counting endpoint. `.messages.countTokens` is intentionally
 *     absent from the returned client. `wrapAnthropic`'s precise mode already
 *     checks for that and no-ops rather than erroring — `precise: true`
 *     against an Ollama client silently falls back to the character estimate.
 */

import type {
  AnthropicCreateParams,
  AnthropicLike,
  AnthropicMessageLike,
} from './anthropic.ts';
import {
  toOpenAiCompatRequest,
  fromOpenAiCompatResponse,
  type OpenAiCompatRequest,
  type OpenAiCompatResponse,
} from './openai-compat.ts';

/** Ollama speaks the shared OpenAI-compatible format; these are aliases, kept for a stable public API. */
export type OllamaChatRequest = OpenAiCompatRequest;
export type OllamaChatResponse = OpenAiCompatResponse;

export const toOllamaRequest = toOpenAiCompatRequest;
export const fromOllamaResponse = fromOpenAiCompatResponse;

/* ------------------------------------------------------------------ *
 * Client                                                              *
 * ------------------------------------------------------------------ */

export interface OllamaClientOptions {
  /** Default `http://localhost:11434`. */
  baseUrl?: string;
  /**
   * Per-request timeout, ms. Default 5 minutes — local CPU inference on a
   * small model is much slower than a hosted API, and the FIRST call also
   * pays Ollama's model-load time (measured ~16s for a 0.5B model here).
   */
  timeoutMs?: number;
}

/** Build an `AnthropicLike` client backed by a real Ollama server. */
export function createOllamaClient(options: OllamaClientOptions = {}): AnthropicLike {
  const baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 300_000;

  return {
    messages: {
      async create(params: AnthropicCreateParams): Promise<AnthropicMessageLike> {
        const body = toOllamaRequest(params);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();

        let response: Response;
        try {
          response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            `Ollama request failed (${response.status} ${response.statusText}): ${text || '(no body)'}`,
          );
        }

        const json = (await response.json()) as OllamaChatResponse;
        return fromOllamaResponse(json, body.model);
      },
      // No `stream` and no `countTokens` — see the file header.
    },
  };
}

function connectionError(err: unknown, baseUrl: string): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(
      `Ollama request timed out against ${baseUrl}. Is the model loaded, and is Ollama responsive?`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `Could not reach Ollama at ${baseUrl} (${message}). Is it running? Start it with \`ollama serve\`.`,
  );
}
