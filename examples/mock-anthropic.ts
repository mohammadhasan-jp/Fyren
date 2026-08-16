/**
 * A fake Anthropic client with the same shape as `@anthropic-ai/sdk`.
 *
 * Per section 7 of PROJECT_CONTEXT.md ("mock API responses during
 * development"), this is what we build against.
 *
 * One detail matters for testing the analysis layer: the fake tokenizer does
 * NOT use a flat characters-per-token ratio. Dense, punctuation-heavy text
 * (raw JSON tool output) packs fewer characters into a token than fluent
 * English prose does. That is true of real tokenizers, and it is exactly the
 * inaccuracy that `precise: true` exists to remove — so the mock has to
 * reproduce it, or precise mode would look pointless.
 *
 * `messages.create` and `messages.countTokens` share the same tokenizer, so
 * the numbers are internally consistent.
 */

import type {
  AnthropicCreateParams,
  AnthropicMessageLike,
  AnthropicLike,
  TokenCountLike,
} from '../src/providers/anthropic.ts';

/** Fixed per-request envelope overhead, like a real prompt has. */
const REQUEST_OVERHEAD_TOKENS = 8;

export interface MockOptions {
  /** Simulated latency per call, in ms. */
  latencyMs?: number;
  /** Simulate prompt caching for repeated system+tools prefixes. */
  simulateCache?: boolean;
}

export function createMockAnthropic(options: MockOptions = {}): AnthropicLike {
  const latencyMs = options.latencyMs ?? 20;
  const simulateCache = options.simulateCache ?? true;
  const seenPrefixes = new Set<string>();

  const messages: AnthropicLike['messages'] = {
    async create(params: AnthropicCreateParams): Promise<AnthropicMessageLike> {
      await sleep(latencyMs);

      const prefixText = stringify(params.system) + stringify(params.tools ?? '');
      const cacheable = simulateCache && prefixText.length > 0;
      const alreadyCached = cacheable && seenPrefixes.has(prefixText);
      if (cacheable) seenPrefixes.add(prefixText);

      const prefixTokens = cacheable ? estimateTokens(prefixText) : 0;
      const total = countParams(params);
      const bodyTokens = Math.max(0, total - prefixTokens);

      const replyText = fakeReply(params);

      return {
        id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`,
        type: 'message',
        role: 'assistant',
        model: params.model ?? 'claude-opus-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: replyText }],
        usage: {
          input_tokens: bodyTokens,
          output_tokens: estimateTokens(replyText),
          cache_creation_input_tokens: cacheable && !alreadyCached ? prefixTokens : 0,
          cache_read_input_tokens: alreadyCached ? prefixTokens : 0,
        },
      };
    },

    async countTokens(params: AnthropicCreateParams): Promise<TokenCountLike> {
      await sleep(Math.min(latencyMs, 5));
      return { input_tokens: countParams(params) };
    },
  };

  return { messages };
}

function countParams(params: AnthropicCreateParams): number {
  let total = REQUEST_OVERHEAD_TOKENS;
  if (params.system != null) total += estimateTokens(stringify(params.system));
  if (params.tools != null) total += estimateTokens(stringify(params.tools));
  const messages = Array.isArray(params.messages) ? params.messages : [];
  for (const message of messages) {
    total += estimateTokens(stringify((message as Record<string, unknown>)?.content));
  }
  return total;
}

/**
 * Density-aware fake tokenizer.
 *
 * Prose (mostly letters and spaces) → ~4.0 chars per token.
 * Dense JSON (braces, quotes, colons) → ~2.4 chars per token.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const dense = (text.match(/[^A-Za-z0-9\s]/g) ?? []).length / text.length;
  const charsPerToken = 4.0 - Math.min(dense, 0.5) * 3.2;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

function fakeReply(params: AnthropicCreateParams): string {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  const hint = stringify(last?.content).slice(0, 60).replace(/\s+/g, ' ').trim();
  return `Acknowledged: "${hint}". Here is a fabricated answer of moderate length so the output token count is not trivially small.`;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
