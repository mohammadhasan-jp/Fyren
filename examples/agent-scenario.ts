/**
 * A small fake agent, shared by the examples.
 *
 * Shape: plan → two tool calls (each with its own summarizing LLM call) →
 * final answer carrying the whole history. That last call is the interesting
 * one: by then the input is dominated by tool output the agent already read.
 */

import { wrapAnthropic } from '../src/index.ts';
import type { Profiler } from '../src/index.ts';
import type { AnthropicLike } from '../src/providers/anthropic.ts';

export const SYSTEM_PROMPT = `You are a research assistant with access to a search tool.
Always cite your sources. Be concise. Never speculate beyond the evidence.
${'Additional policy text that exists mainly to make this prompt realistically large. '.repeat(12)}`;

export const TOOLS = [
  {
    name: 'search',
    description: 'Search the web for a query and return the top results.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
];

export interface ScenarioOptions {
  /** Measure each input segment with count_tokens instead of estimating. */
  precise?: boolean;
  /** Distinguishes runs of "the same agent" in aggregate views. */
  runName?: string;
}

/** Runs the agent once. Returns the run id. */
export async function runAgent(
  profiler: Profiler,
  anthropic: AnthropicLike,
  options: ScenarioOptions = {},
): Promise<string> {
  const wrapOptions = { precise: options.precise ?? false };

  return profiler.run(options.runName ?? 'research-agent', async (run) => {
    const conversation: Array<Record<string, unknown>> = [
      { role: 'user', content: 'What changed in the EU AI Act in 2026?' },
    ];

    // ---- plan ------------------------------------------------------------
    await run.step('plan', async (step) => {
      const planner = wrapAnthropic(anthropic, step, wrapOptions);
      const response = await planner.messages.create({
        model: 'claude-opus-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversation,
      });
      conversation.push({ role: 'assistant', content: response.content });
    });

    // ---- two tool calls, each burning tokens of its own -------------------
    await run.step('execute', async (step) => {
      for (const query of ['EU AI Act 2026 amendments', 'EU AI Act enforcement timeline']) {
        const tool = step.startToolCall('search', { metadata: { query } });

        // The tool summarizes its own raw output before handing it back —
        // exactly the kind of hidden cost the profiler exists to surface.
        const toolClient = wrapAnthropic(anthropic, tool, wrapOptions);
        const rawResults = `RESULT SET for "${query}": ${JSON.stringify(
          Array.from({ length: 8 }, (_, i) => ({
            rank: i + 1,
            url: `https://example.org/${encodeURIComponent(query)}/${i}`,
            title: `Result ${i + 1} about ${query}`,
            snippet: 'Lorem ipsum result body with enough text to matter. '.repeat(3),
          })),
        )}`;

        await toolClient.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: 'Summarize search results into three bullet points.',
          messages: [{ role: 'user', content: rawResults }],
        });

        tool.end({ metadata: { result_chars: rawResults.length } });

        conversation.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_mock', content: rawResults }],
        });
      }
    });

    // ---- final answer, carrying everything --------------------------------
    await run.step('answer', async (step) => {
      const answerClient = wrapAnthropic(anthropic, step, wrapOptions);
      await answerClient.messages.create({
        model: 'claude-opus-5',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: [...conversation, { role: 'user', content: 'Now write the final answer.' }],
      });
    });

    return run.rootId;
  });
}
