/**
 * Input segmentation.
 *
 * The load-bearing property is that the five buckets are DISJOINT — tool
 * results must not also be counted as history, or every percentage the product
 * shows is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeComposition,
  extractSegments,
  measureComposition,
  wrapAnthropic,
} from '../src/providers/anthropic.ts';
import type { AnthropicCreateParams, AnthropicMessagesLike } from '../src/providers/anthropic.ts';
import { createProfiler, SEGMENT_ORDER } from '../src/index.ts';

const TOOLS = [{ name: 'search', description: 'find things', input_schema: { type: 'object' } }];

const PARAMS: AnthropicCreateParams = {
  model: 'claude-opus-5',
  system: 'SYSTEM',
  tools: TOOLS,
  messages: [
    { role: 'user', content: 'FIRST-QUESTION' },
    { role: 'assistant', content: [{ type: 'text', text: 'ASSISTANT-REPLY' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT' }] },
    { role: 'user', content: 'LATEST-MESSAGE' },
  ],
};

test('each piece of the request lands in exactly one bucket', () => {
  const segments = extractSegments(PARAMS);

  assert.equal(segments.system, 'SYSTEM');
  assert.equal(segments.toolDefs, JSON.stringify(TOOLS));
  assert.equal(segments.toolResults, 'TOOL-OUTPUT');
  assert.equal(segments.latest, 'LATEST-MESSAGE');
  assert.equal(segments.history, 'FIRST-QUESTION\nASSISTANT-REPLY');

  // the crucial negative: tool output is not double-counted
  assert.ok(!segments.history!.includes('TOOL-OUTPUT'));
  assert.ok(!segments.latest!.includes('TOOL-OUTPUT'));
});

test('char counts match the extracted segment texts', () => {
  const segments = extractSegments(PARAMS);
  const composition = analyzeComposition(PARAMS);
  for (const segment of SEGMENT_ORDER) {
    assert.equal(composition.chars[segment], segments[segment]!.length, segment);
  }
  assert.equal(composition.tokens, null);
  assert.equal(composition.source, 'chars');
});

test('a tool_result as the final message counts as tool output, not as "latest"', () => {
  const composition = analyzeComposition({
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'question' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'RESULT' }] },
    ],
  });
  assert.equal(composition.chars.latest, 0);
  assert.equal(composition.chars.toolResults, 'RESULT'.length);
  assert.equal(composition.chars.history, 'question'.length);
});

test('a last message mixing a tool_result and plain text splits: result to toolResults, text to latest', () => {
  const composition = analyzeComposition({
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'question' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'RESULT-TEXT' },
          { type: 'text', text: 'COMMENT-TEXT' },
        ],
      },
    ],
  });
  // both rules fire on the same (last) message, independently
  assert.equal(composition.chars.toolResults, 'RESULT-TEXT'.length);
  assert.equal(composition.chars.latest, 'COMMENT-TEXT'.length);
  assert.equal(composition.chars.history, 'question'.length);
});

test('a request with no tools, system or history still segments cleanly', () => {
  const composition = analyzeComposition({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'only this' }],
  });
  assert.equal(composition.chars.toolDefs, 0);
  assert.equal(composition.chars.system, 0);
  assert.equal(composition.chars.history, 0);
  assert.equal(composition.chars.toolResults, 0);
  assert.equal(composition.chars.latest, 'only this'.length);
});

test('empty params do not throw', () => {
  const composition = analyzeComposition({});
  for (const segment of SEGMENT_ORDER) assert.equal(composition.chars[segment], 0);
});

/* ---------------- precise mode ---------------- */

/**
 * A counter whose "tokenizer" is 1 token per character, plus a 7-token
 * envelope. That makes the expected numbers exact and easy to reason about.
 */
function countingMessages(): AnthropicMessagesLike & { calls: AnthropicCreateParams[] } {
  const calls: AnthropicCreateParams[] = [];
  return {
    calls,
    async create() {
      return { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } };
    },
    async countTokens(params: AnthropicCreateParams) {
      calls.push(params);
      let total = 7;
      if (typeof params.system === 'string') total += params.system.length;
      if (params.tools) total += JSON.stringify(params.tools).length;
      for (const m of (params.messages as Array<{ content: string }>) ?? []) {
        total += typeof m.content === 'string' ? m.content.length : 0;
      }
      return { input_tokens: total };
    },
  };
}

test('measureComposition reports measured tokens for every non-empty segment', async () => {
  const messages = countingMessages();
  const composition = await measureComposition(messages, PARAMS);

  assert.ok(composition);
  assert.equal(composition.source, 'count_tokens');
  assert.ok(composition.tokens);

  // baseline = 7 + 1 ("a"). system is measured in its real field: 8+6-8 = 6.
  assert.equal(composition.tokens.system, 'SYSTEM'.length);
  assert.equal(composition.tokens.toolDefs, JSON.stringify(TOOLS).length);
  // message-body segments are measured as standalone text, adding the probe back
  assert.equal(composition.tokens.latest, 'LATEST-MESSAGE'.length);
  assert.equal(composition.tokens.toolResults, 'TOOL-OUTPUT'.length);
  assert.equal(composition.tokens.history, 'FIRST-QUESTION\nASSISTANT-REPLY'.length);

  // chars are still recorded, so nothing is lost by switching modes
  assert.equal(composition.chars.system, 'SYSTEM'.length);
});

test('empty segments are not measured, and the baseline is only fetched once', async () => {
  const messages = countingMessages();
  await measureComposition(messages, {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'just one' }],
  });
  await measureComposition(messages, {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'and another' }],
  });

  // 1 baseline + 1 segment, then 1 segment (baseline cached per model)
  assert.equal(messages.calls.length, 3);
});

test('measureComposition is a no-op when the client cannot count tokens', async () => {
  const result = await measureComposition({ async create() { return {}; } }, PARAMS);
  assert.equal(result, null);
});

test('precise:true updates the stored node after the call has returned', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('agent');
  const client = wrapAnthropic({ messages: countingMessages() }, run, { precise: true });

  await client.messages.create(PARAMS);

  // Immediately after the response, the stored composition is still the estimate.
  const immediate = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.equal(immediate?.inputComposition?.source, 'chars');

  await new Promise((resolve) => setTimeout(resolve, 30));
  run.end();

  const later = profiler.getTree(run.rootId).find((n) => n.type === 'llm_call');
  assert.equal(later?.inputComposition?.source, 'count_tokens');
  assert.equal(later?.inputComposition?.tokens?.system, 'SYSTEM'.length);
  profiler.close();
});
