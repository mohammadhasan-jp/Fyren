/**
 * The OpenAI-compatible chat wire format, shared by every provider that
 * speaks it.
 *
 * Two providers here use this exact request/response shape: OpenAI itself
 * (`providers/openai.ts`) and Ollama's compatibility endpoint
 * (`providers/ollama.ts`). The translation between fyren's internal
 * Anthropic-shaped params and this format is identical for both, so it lives
 * here once instead of being duplicated and drifting.
 *
 * What each provider keeps for itself is the part that genuinely differs:
 * base URL, authentication, and — the one that matters most — how `usage` maps
 * onto a `TokenBreakdown`. Ollama reports no cache fields at all; OpenAI
 * reports cached tokens as a SUBSET of `prompt_tokens` that has to be
 * subtracted back out. Getting that wrong would double-count every cached
 * token, which is exactly why it is not shared code.
 *
 * These translations are pinned in `test/ollama.test.ts` against real JSON
 * captured from a live Ollama server — not a guess at the spec.
 */

import type { AnthropicCreateParams, AnthropicMessageLike } from './anthropic.ts';

export interface OpenAiCompatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiCompatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiCompatToolCall[];
  tool_call_id?: string;
}

export interface OpenAiCompatRequest {
  model: string;
  max_tokens?: number;
  messages: OpenAiCompatMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: unknown };
  }>;
  stream: false;
}

export interface OpenAiCompatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAiCompatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Request translation                                                 *
 * ------------------------------------------------------------------ */

/**
 * Anthropic-shaped `messages[]` → flat OpenAI-shaped messages.
 *
 * The one non-obvious rule: Anthropic bundles several `tool_result` blocks
 * inside ONE user-turn content array; OpenAI wants each as its OWN message
 * with `role: "tool"`. So one Anthropic message can expand into several
 * OpenAI ones — this is why the function returns a flat array rather than
 * mapping 1:1.
 */
function toOpenAiMessages(anthropicMessages: readonly unknown[]): OpenAiCompatMessage[] {
  const out: OpenAiCompatMessage[] = [];

  for (const raw of anthropicMessages) {
    const message = raw as { role?: unknown; content?: unknown };
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.content;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const textParts: string[] = [];
    const toolCalls: OpenAiCompatToolCall[] = [];
    const toolResults: Array<{ toolCallId: string; text: string }> = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      } else if (b?.type === 'tool_use') {
        toolCalls.push({
          id: String(b.id),
          type: 'function',
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b?.type === 'tool_result') {
        const resultContent = b.content;
        const text =
          typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent ?? '');
        toolResults.push({ toolCallId: String(b.tool_use_id), text });
      }
    }

    if (role === 'assistant') {
      out.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // tool_result blocks first (matches the order they'd appear in the
      // Anthropic-shaped message), then any plain text from the same turn.
      for (const result of toolResults) {
        out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.text });
      }
      if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
    }
  }

  return out;
}

export function toOpenAiCompatRequest(params: AnthropicCreateParams): OpenAiCompatRequest {
  const messages: OpenAiCompatMessage[] = [];

  if (typeof params.system === 'string' && params.system.length > 0) {
    messages.push({ role: 'system', content: params.system });
  }
  messages.push(...toOpenAiMessages(Array.isArray(params.messages) ? params.messages : []));

  const tools = Array.isArray(params.tools)
    ? (params.tools as Array<Record<string, unknown>>).map((tool) => ({
        type: 'function' as const,
        function: {
          name: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : undefined,
          parameters: tool.input_schema,
        },
      }))
    : undefined;

  return {
    model: typeof params.model === 'string' ? params.model : '',
    max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens : undefined,
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    stream: false,
  };
}

/* ------------------------------------------------------------------ *
 * Response translation                                                *
 * ------------------------------------------------------------------ */

/**
 * OpenAI-shaped response → Anthropic-shaped message.
 *
 * `usage` is deliberately left as a passthrough of the raw prompt/completion
 * counts with no cache fields. Providers that DO report cache usage overwrite
 * it after calling this — see the file header.
 */
export function fromOpenAiCompatResponse(
  response: OpenAiCompatResponse,
  requestedModel: string,
): AnthropicMessageLike {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];

  if (message?.content) content.push({ type: 'text', text: message.content });

  for (const call of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      // A model that emits malformed JSON arguments is a real failure mode;
      // surface an empty object rather than throwing out of a translation
      // layer the agent loop can't recover from mid-response.
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }

  const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  return {
    model: response.model ?? requestedModel,
    stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    content,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}
