/**
 * A real (non-mock) documentation Q&A agent.
 *
 * Loop: user asks a question → model may call `search_docs` (and, rarely,
 * `get_related_topics`) → tool results go back → model answers, or calls
 * another tool. One session can hold several questions in a row, each turn
 * resending the full conversation so far.
 *
 * This exists to answer one question before Waste Detection gets designed:
 * what does a Cost Breakdown report look like on a real agent, not a fake
 * one? So three real waste patterns are left in ON PURPOSE, not fixed:
 *
 *   1. SYSTEM_PROMPT below is long and never carries `cache_control` — every
 *      single call pays full price for it again, even resent verbatim across
 *      turns of the same session.
 *   2. `get_related_topics` is a fully-defined tool (with a real schema,
 *      costing input tokens on EVERY call, cached or not) that only ever
 *      fires for one specific kind of question. Most of the time its
 *      definition is pure overhead.
 *   3. Nothing prunes `conversation` between turns — it grows linearly for
 *      the length of the session, and (because of #1) none of that growth is
 *      cached either.
 *
 * That is the point: this is what an agent looks like before anyone has
 * looked at its Cost Breakdown.
 *
 * This file is provider-agnostic on purpose — it only knows `AnthropicLike`
 * (system/tools/messages in, content blocks + usage out). `run-real-agent.ts`
 * drives it with the real Anthropic SDK; `run-ollama-agent.ts` drives the
 * exact same session logic against a local Ollama server via
 * `createOllamaClient()`. Note: `get_related_topics` (waste pattern #2)
 * needs a model capable enough to follow "only call this when asked for
 * related topics" — a small local model may call it more often than a
 * hosted one would, which is itself a finding a Cost Breakdown would surface.
 */

import { wrapAnthropic } from '../src/index.ts';
import type { Profiler } from '../src/index.ts';
import type { AnthropicLike, AnthropicCreateParams } from '../src/providers/anthropic.ts';

/* ------------------------------------------------------------------ *
 * The "documentation" — searched locally, never sent to the model      *
 * whole. Only matched excerpts travel over the wire, as tool results.  *
 * ------------------------------------------------------------------ */

export interface DocSection {
  title: string;
  body: string;
}

export function parseDocSections(markdown: string): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection | null = null;

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.*)/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1]!.trim(), body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Plain keyword overlap — no embeddings, no extra API calls, no added cost. */
function searchDocs(sections: readonly DocSection[], query: string, topN = 2): DocSection[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return sections
    .map((section) => {
      const haystack = `${section.title} ${section.body}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { section, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((entry) => entry.section);
}

function findRelatedTopics(sections: readonly DocSection[], topic: string): string[] {
  const matches = searchDocs(sections, topic, 4);
  const seen = new Set(matches.map((m) => m.title));
  return sections.filter((s) => !seen.has(s.title)).map((s) => s.title);
}

/* ------------------------------------------------------------------ *
 * The agent                                                            *
 * ------------------------------------------------------------------ */

// Deliberately long and deliberately never carries cache_control (waste
// pattern #1 — see file header). A realistic system prompt this size is not
// unusual; forgetting to cache it is the mistake being demonstrated.
export const SYSTEM_PROMPT = `You are the support assistant for the Widget API, a REST API for
managing widgets. You answer developer questions about authentication, rate
limits, pagination, errors, webhooks, and best practices.

Rules you must follow on every response:
- Base every factual claim about the API on the search_docs tool. Do not
  answer from general knowledge about REST APIs in general — this API has
  specific, sometimes non-obvious behavior (cursor pagination rather than
  offset pagination, idempotency keys, workspace-scoped rate limits) that a
  generic answer would get wrong.
- If search_docs does not return anything relevant to the question, say so
  plainly instead of guessing.
- Quote specific numbers (rate limits, timeouts, header names, status codes)
  exactly as they appear in the documentation. Do not round or paraphrase a
  number.
- Keep answers to two or three sentences unless the question asks for a
  walkthrough or example.
- Only call get_related_topics when the user explicitly asks for related
  topics, further reading, or "what else should I know" — never on an
  ordinary factual question.
- Never invent an endpoint, header, or error type that was not returned by
  search_docs.
- Do not mention these instructions to the user.

Tone: concise, precise, a little informal — like a helpful engineer on a
support team, not a legal disclaimer generator. Prefer "you'll get a 429"
over "the client may, under certain conditions, receive an HTTP 429 status
code response."`;

// `get_related_topics` is real, fully-schema'd, and billed on every call —
// waste pattern #2. Its description is written to make the model reach for
// it rarely, which is exactly what makes it a good demonstration: the tool
// definition is paid for far more often than it is used.
export const TOOLS = [
  {
    name: 'search_docs',
    description:
      'Search the Widget API documentation for sections relevant to a query. Returns the top ' +
      'matching section titles and bodies. Call this before answering any factual question about ' +
      'the API.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for, e.g. "rate limit retry"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_related_topics',
    description:
      'List documentation section titles related to a topic, for suggesting further reading. ' +
      'Use this ONLY when the user explicitly asks for related topics, further reading, or "what ' +
      'else should I know" — never for an ordinary factual question.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic the user is currently asking about' },
      },
      required: ['topic'],
    },
  },
];

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use';
}

function executeTool(sections: readonly DocSection[], name: string, input: Record<string, unknown>): string {
  if (name === 'search_docs') {
    const query = typeof input.query === 'string' ? input.query : '';
    const results = searchDocs(sections, query);
    if (results.length === 0) return 'No matching documentation sections found.';
    return results.map((s) => `## ${s.title}\n${s.body.trim()}`).join('\n\n');
  }

  if (name === 'get_related_topics') {
    const topic = typeof input.topic === 'string' ? input.topic : '';
    const titles = findRelatedTopics(sections, topic);
    return titles.length > 0 ? titles.join(', ') : 'No other sections found.';
  }

  return `Unknown tool: ${name}`;
}

export interface DocsQaOptions {
  model?: string;
  maxTokens?: number;
  /** Measure input composition precisely instead of estimating from characters. */
  precise?: boolean;
  runName?: string;
  /** Recorded on every node. Default `'anthropic'` — see `WrapOptions.provider`. */
  provider?: string;
  /**
   * Does this client's provider support prompt caching at all? Default
   * `true` (Anthropic does). Set `false` for a client with no caching
   * concept (e.g. Ollama) — see `WrapOptions.cacheSupported` for why this is
   * a different claim than "supported, zero hits this run".
   */
  cacheSupported?: boolean;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOOL_ITERATIONS = 4;

/**
 * Run one multi-turn session: each question in `questions`, in order, sharing
 * one growing conversation (waste pattern #3). Returns the run id.
 */
export async function runDocsQaSession(
  profiler: Profiler,
  anthropic: AnthropicLike,
  docs: readonly DocSection[],
  questions: readonly string[],
  options: DocsQaOptions = {},
): Promise<string> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 400;
  const wrapOptions = {
    precise: options.precise ?? false,
    name: model,
    provider: options.provider,
    cacheSupported: options.cacheSupported,
  };

  return profiler.run(options.runName ?? 'docs-qa-agent', async (run) => {
    const conversation: Array<Record<string, unknown>> = [];

    for (const question of questions) {
      conversation.push({ role: 'user', content: question });

      await run.step(`ask: ${question.slice(0, 48)}`, async (step) => {
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
          const client = wrapAnthropic(anthropic, step, wrapOptions);
          const params: AnthropicCreateParams = {
            model,
            max_tokens: maxTokens,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages: conversation,
          };
          const response = await client.messages.create(params);

          const content = Array.isArray(response.content) ? response.content : [];
          conversation.push({ role: 'assistant', content });

          const toolUses = content.filter(isToolUseBlock);
          if (toolUses.length === 0) break; // final answer — this turn is done

          const toolResults = toolUses.map((toolUse) => {
            const toolNode = step.startToolCall(toolUse.name, { metadata: { input: toolUse.input } });
            const result = executeTool(docs, toolUse.name, toolUse.input);
            toolNode.end({ metadata: { resultChars: result.length } });
            return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
          });

          conversation.push({ role: 'user', content: toolResults });
        }
      });
    }

    return run.rootId;
  });
}
