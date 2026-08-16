/**
 * Google Gemini, via the Generative Language API (`generateContent`).
 *
 * Same contract as the other providers: presents an `AnthropicLike` client so
 * `wrapAnthropic` instruments it unchanged, and only this file knows Gemini's
 * wire format exists.
 *
 * Unlike OpenAI and Ollama, Gemini does NOT speak the OpenAI-compatible chat
 * shape, so none of `providers/openai-compat.ts` applies. Its format differs
 * on every axis that matters:
 *
 *   messages          `contents[]` with `role: "user" | "model"` (not "assistant")
 *   text              `parts[].text` rather than a content string or block list
 *   system prompt     top-level `systemInstruction`, not a message
 *   tools             `tools[].functionDeclarations[]`, schema under `parameters`
 *   tool call         `parts[].functionCall = { name, args }` — `args` is a real
 *                     OBJECT, not OpenAI's JSON-encoded string
 *   tool result       `parts[].functionResponse = { name, response }`, and it is
 *                     keyed by tool NAME, not by a call id — Gemini has no
 *                     `tool_use_id` equivalent, so the id fyren carries
 *                     internally is dropped on the way out and synthesized on
 *                     the way back in.
 *
 * ── Caching: two systems, one field ──────────────────────────────────────
 *
 * Verified against ai.google.dev (2026-08). Gemini has two distinct caching
 * mechanisms that both report through the SAME usage field:
 *
 *   1. EXPLICIT (`cachedContents`) — genuinely unlike Anthropic. You must
 *      POST to a separate `/cachedContents` endpoint FIRST, get back a
 *      resource name, then pass it as `cachedContent` on the generate call.
 *      Billed as discounted cached tokens PLUS storage per hour of TTL.
 *   2. IMPLICIT — automatic on Gemini 2.5+, no storage cost, no hit
 *      guarantee. Prefix-sensitive like OpenAI's. Minimum ~2,048 tokens
 *      (2.5 Flash/Pro) or ~4,096 (newer models).
 *
 * Both surface as `usageMetadata.cachedContentTokenCount` and are otherwise
 * indistinguishable in the response. This client only uses implicit caching
 * (it never creates `cachedContents` resources), so any cache hit reported
 * here is implicit — but `usedExplicitCache` is recorded in metadata anyway,
 * keyed off whether the request carried a `cachedContent` name, so the
 * distinction survives if explicit caching is added later.
 *
 * The storage-per-hour cost of explicit caching is NOT included in any cost
 * figure fyren reports — it is time-based, and this library only models
 * token-based cost. `ModelRate.storagePerHour` records the rate so a report
 * can say the number is incomplete rather than silently omitting a real cost.
 *
 * Like OpenAI (and unlike Anthropic), `cachedContentTokenCount` is a SUBSET of
 * `promptTokenCount`, so fresh input is the difference. See
 * `tokensFromGeminiUsage`.
 */

import type {
  AnthropicCreateParams,
  AnthropicLike,
  AnthropicMessageLike,
} from './anthropic.ts';
import type { TokenBreakdown } from '../types.ts';

/* ------------------------------------------------------------------ *
 * Wire types                                                          *
 * ------------------------------------------------------------------ */

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: unknown };
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    functionDeclarations: Array<{ name: string; description?: string; parameters?: unknown }>;
  }>;
  generationConfig?: { maxOutputTokens?: number };
  /** Explicit-cache resource name (`cachedContents/…`). Unused by this client — see the file header. */
  cachedContent?: string;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
  [key: string]: unknown;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Request translation                                                 *
 * ------------------------------------------------------------------ */

export function toGeminiRequest(params: AnthropicCreateParams): GeminiRequest {
  const contents: GeminiContent[] = [];

  for (const raw of Array.isArray(params.messages) ? params.messages : []) {
    const message = raw as { role?: unknown; content?: unknown };
    // Gemini's assistant role is "model"; everything else maps to "user".
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const content = message.content;

    if (typeof content === 'string') {
      if (content) contents.push({ role, parts: [{ text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: GeminiPart[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'text' && typeof b.text === 'string') {
        parts.push({ text: b.text });
      } else if (b?.type === 'tool_use') {
        parts.push({
          functionCall: {
            name: String(b.name),
            args: (b.input ?? {}) as Record<string, unknown>,
          },
        });
      } else if (b?.type === 'tool_result') {
        // Gemini keys tool results by tool NAME, not by call id. fyren's
        // internal `tool_use_id` has no home in this format; `name` is
        // recovered from the id where the id encodes it, else left blank
        // (Gemini tolerates matching on position within the turn).
        parts.push({
          functionResponse: {
            name: typeof b.name === 'string' ? b.name : '',
            response: normalizeToolResult(b.content),
          },
        });
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  const request: GeminiRequest = { contents };

  if (typeof params.system === 'string' && params.system.length > 0) {
    request.systemInstruction = { parts: [{ text: params.system }] };
  }

  if (Array.isArray(params.tools) && params.tools.length > 0) {
    request.tools = [
      {
        functionDeclarations: (params.tools as Array<Record<string, unknown>>).map((tool) => ({
          name: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : undefined,
          parameters: tool.input_schema,
        })),
      },
    ];
  }

  if (typeof params.max_tokens === 'number') {
    request.generationConfig = { maxOutputTokens: params.max_tokens };
  }

  return request;
}

/** Gemini expects `response` to be a JSON object, so a bare string gets wrapped. */
function normalizeToolResult(content: unknown): unknown {
  if (content === null || content === undefined) return {};
  if (typeof content === 'string') return { result: content };
  return content;
}

/* ------------------------------------------------------------------ *
 * Response translation                                                *
 * ------------------------------------------------------------------ */

export function fromGeminiResponse(
  response: GeminiResponse,
  requestedModel: string,
): AnthropicMessageLike {
  const candidate = response.candidates?.[0];
  const content: Array<Record<string, unknown>> = [];
  let sawFunctionCall = false;

  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === 'string' && part.text) {
      content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      sawFunctionCall = true;
      content.push({
        type: 'tool_use',
        // Gemini returns no call id. Synthesize a stable-enough one so the
        // agent loop (which pairs results to calls by id) still works.
        id: `gemini_${part.functionCall.name}_${content.length}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  return {
    model: response.modelVersion ?? requestedModel,
    stop_reason: sawFunctionCall ? 'tool_use' : 'end_turn',
    content,
    usage: geminiUsageToAnthropicShape(response.usageMetadata),
  };
}

/**
 * Map Gemini usage onto fyren's `TokenBreakdown`.
 *
 * `cachedContentTokenCount` is a SUBSET of `promptTokenCount` (same as
 * OpenAI, opposite of Anthropic), so fresh input is the difference. Gemini
 * reports no cache-WRITE token count at all — explicit caching bills storage
 * time instead — so `cacheWrite` is always 0 here, which is accurate rather
 * than merely unknown.
 */
export function tokensFromGeminiUsage(usage: GeminiUsageMetadata | undefined): TokenBreakdown {
  const prompt = num(usage?.promptTokenCount);
  const cacheRead = num(usage?.cachedContentTokenCount);

  return {
    input: Math.max(0, prompt - cacheRead),
    output: num(usage?.candidatesTokenCount),
    // Gemini reports reasoning separately as thoughtsTokenCount but bills it
    // within candidatesTokenCount — same relationship Anthropic has between
    // thinking and output, so it is recorded, never added to a total.
    thinking: num(usage?.thoughtsTokenCount),
    cacheRead,
    cacheWrite: 0,
  };
}

function geminiUsageToAnthropicShape(
  usage: GeminiUsageMetadata | undefined,
): Record<string, number> {
  const tokens = tokensFromGeminiUsage(usage);
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_input_tokens: tokens.cacheRead,
    cache_creation_input_tokens: tokens.cacheWrite,
  };
}

/* ------------------------------------------------------------------ *
 * Client                                                              *
 * ------------------------------------------------------------------ */

export interface GeminiClientOptions {
  apiKey: string;
  /** Default `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string;
  /** Per-request timeout, ms. Default 2 minutes. */
  timeoutMs?: number;
}

/** Build an `AnthropicLike` client backed by the real Gemini API. */
export function createGeminiClient(options: GeminiClientOptions): AnthropicLike {
  const baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
    /\/+$/,
    '',
  );
  const timeoutMs = options.timeoutMs ?? 120_000;

  const request = async (path: string, body: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': options.apiKey,
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
        `Gemini request failed (${response.status} ${response.statusText}): ${text || '(no body)'}`,
      );
    }
    return response.json();
  };

  return {
    messages: {
      async create(params: AnthropicCreateParams): Promise<AnthropicMessageLike> {
        const model = normalizeModel(params.model);
        const body = toGeminiRequest(params);
        const json = (await request(
          `/models/${model}:generateContent`,
          body,
        )) as GeminiResponse;
        return fromGeminiResponse(json, model);
      },

      /**
       * Gemini has a real token-counting endpoint, so precise mode works here
       * (unlike Ollama and this OpenAI client). Passing the full
       * `generateContentRequest` — rather than bare `contents` — is what makes
       * the count include system instructions and tool declarations.
       */
      async countTokens(params: AnthropicCreateParams): Promise<{ input_tokens: number }> {
        const model = normalizeModel(params.model);
        const json = (await request(`/models/${model}:countTokens`, {
          generateContentRequest: { ...toGeminiRequest(params), model: `models/${model}` },
        })) as { totalTokens?: number };
        return { input_tokens: num(json.totalTokens) };
      },
    },
  };
}

/** Gemini's REST path wants a bare id; callers may pass `models/gemini-…`. */
function normalizeModel(model: unknown): string {
  return typeof model === 'string' ? model.replace(/^models\//, '') : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function connectionError(err: unknown, baseUrl: string): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(`Gemini request timed out against ${baseUrl}.`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Could not reach Gemini at ${baseUrl} (${message}).`);
}
