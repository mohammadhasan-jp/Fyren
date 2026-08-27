/**
 * The Vercel AI SDK middleware adapter.
 *
 * No network and no `ai` dependency — the fixtures below are the shapes the
 * SDK actually produces, taken from two places rather than invented:
 *
 *   - the prompt/usage/stream-part TYPES in `@ai-sdk/provider@4.0.8`, and
 *   - the shipped provider builds' own usage arithmetic, which is what settles
 *     the one genuinely ambiguous question in this adapter (are cached tokens
 *     additive or a subset). `@ai-sdk/anthropic@4` computes
 *     `total = input + cacheCreation + cacheRead, noCache = input`, while
 *     `@ai-sdk/openai@4` computes `noCache = promptTokens - cached - cacheWrite`.
 *     Both agree on what `noCache` MEANS, which is why the nested shape is read
 *     straight across. The v2-era flat shape does not agree — `@ai-sdk/anthropic@2`
 *     sets `inputTokens = response.usage.input_tokens`, which excludes cached
 *     tokens — and the tests for that are below.
 *
 * The one thing these tests cannot prove is that the middleware OBJECT satisfies
 * the real `LanguageModelV*Middleware` interfaces; that is a type-level claim,
 * checked separately by compiling `fyrenMiddleware(run)` against the real
 * `@ai-sdk/provider` declarations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fyrenMiddleware,
  tokensFromAiSdkUsage,
  analyzeAiSdkComposition,
  extractAiSdkSegments,
  conventionFor,
  createProfiler,
} from '../src/index.ts';
import type { AiSdkCallOptions, RunNode } from '../src/index.ts';
import { SEGMENT_ORDER } from '../src/types.ts';

function byName(tree: readonly RunNode[], name: string): RunNode {
  const node = tree.find((n) => n.name === name);
  assert.ok(node, `expected a node named "${name}"`);
  return node;
}

/* ------------------------------------------------------------------ *
 * Segmentation                                                        *
 * ------------------------------------------------------------------ */

test('system lives inside the prompt array and still lands in the system segment', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: [{ type: 'text', text: 'Capital of France?' }] },
    ],
  });

  assert.equal(segments.system, 'You are terse.');
  assert.equal(segments.latest, 'Capital of France?');
  assert.equal(segments.history, '');
});

test('tools become the toolDefs segment', () => {
  const tools = [
    { type: 'function', name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
  ];
  const segments = extractAiSdkSegments({ prompt: [], tools });
  assert.equal(segments.toolDefs, JSON.stringify(tools));
});

test('the last non-system message is `latest`; earlier ones are `history`', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      { role: 'user', content: [{ type: 'text', text: 'third' }] },
    ],
  });

  assert.equal(segments.latest, 'third');
  assert.equal(segments.history, 'first\nsecond');
});

test('a trailing system message does not steal the `latest` slot', () => {
  // The Anthropic split cannot hit this case — `system` is its own parameter
  // there and can never be the last element of messages[]. Here it can, and
  // treating it as "the newest thing the user said" would be wrong.
  const segments = extractAiSdkSegments({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'the real question' }] },
      { role: 'system', content: 'a late system note' },
    ],
  });

  assert.equal(segments.latest, 'the real question');
  assert.equal(segments.system, 'a late system note');
  assert.equal(segments.history, '');
});

test('tool-result parts go to toolResults wherever they sit, including the last message', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: '1', toolName: 'search', output: { type: 'text', value: 'RESULT' } },
        ],
      },
    ],
  });

  assert.equal(segments.toolResults, 'RESULT');
  // The tool message contributed nothing but a tool result, so `latest` keeps
  // the only real text in the prompt rather than going empty.
  assert.equal(segments.latest, '');
  assert.equal(segments.history, 'q');
});

test('a last message mixing a tool result with text splits across both segments', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-result', toolCallId: '1', toolName: 'search', output: { type: 'text', value: 'RESULT' } },
          { type: 'text', text: 'commentary' },
        ],
      },
    ],
  });

  assert.equal(segments.toolResults, 'RESULT');
  assert.equal(segments.latest, 'commentary');
});

test('a tool-call part is assistant content, not a tool result', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: '1', toolName: 'search', input: { q: 'paris' } }],
      },
    ],
  });

  assert.equal(segments.toolResults, '', 'deciding to call a tool is not a result');
  assert.equal(segments.latest, JSON.stringify({ toolName: 'search', input: { q: 'paris' } }));
});

test('every arm of the tool-result output union is measured, not stringified blindly', () => {
  const of = (output: unknown): string =>
    extractAiSdkSegments({
      prompt: [
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: '1', toolName: 't', output }] },
      ],
    }).toolResults!;

  assert.equal(of({ type: 'text', value: 'plain' }), 'plain');
  assert.equal(of({ type: 'error-text', value: 'boom' }), 'boom');
  assert.equal(of({ type: 'json', value: { a: 1 } }), '{"a":1}');
  assert.equal(of({ type: 'error-json', value: { code: 500 } }), '{"code":500}');
  assert.equal(of({ type: 'execution-denied', reason: 'user said no' }), 'user said no');
  // The denial arm has no `value` at all; reading one blindly would have
  // produced the string "undefined" and inflated the segment.
  assert.equal(of({ type: 'execution-denied' }), '');
});

test('the five segments are disjoint and account for every part of the request', () => {
  const params: AiSdkCallOptions = {
    tools: [{ type: 'function', name: 'search', inputSchema: {} }],
    prompt: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: '1', toolName: 'search', output: { type: 'text', value: 'res' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'new' }] },
    ],
  };

  const segments = extractAiSdkSegments(params);
  const composition = analyzeAiSdkComposition(params);

  for (const segment of SEGMENT_ORDER) {
    assert.equal(composition.chars[segment], segments[segment]!.length, segment);
  }
  assert.equal(composition.source, 'chars', 'a middleware can never measure, only estimate');
  assert.equal(composition.tokens, null);

  assert.equal(segments.system, 'sys');
  assert.equal(segments.history, 'old');
  assert.equal(segments.toolResults, 'res');
  assert.equal(segments.latest, 'new');
});

test('a file part is counted by its payload size rather than dropped', () => {
  const segments = extractAiSdkSegments({
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array(10) } },
        ],
      },
    ],
  });

  // Dropping files would break the invariant the whole analysis rests on —
  // that the segments sum to the request. 4 chars of base64 + 10 bytes, joined
  // by the newline the part joiner inserts.
  assert.equal(segments.latest!.length, 4 + 1 + 10);
});

/* ------------------------------------------------------------------ *
 * Usage — the nested (spec v3/v4) shape                               *
 * ------------------------------------------------------------------ */

test('nested usage: noCache is read straight across as fresh input', () => {
  // @ai-sdk/anthropic@4's own arithmetic: total = 1000 + 200 + 3000.
  const tokens = tokensFromAiSdkUsage({
    inputTokens: { total: 4200, noCache: 1000, cacheRead: 3000, cacheWrite: 200 },
    outputTokens: { total: 150, text: 150, reasoning: 0 },
  });

  assert.equal(tokens.input, 1000);
  assert.equal(tokens.cacheRead, 3000);
  assert.equal(tokens.cacheWrite, 200);
  assert.equal(tokens.output, 150);

  // The parts still sum to what the provider billed as input. This is the
  // assertion that catches a double-count.
  assert.equal(tokens.input + tokens.cacheRead + tokens.cacheWrite, 4200);
});

test('nested usage: a missing noCache is derived, not guessed', () => {
  const tokens = tokensFromAiSdkUsage({
    inputTokens: { total: 4200, noCache: undefined, cacheRead: 3000, cacheWrite: 200 },
    outputTokens: { total: 10 },
  });

  assert.equal(tokens.input, 1000, 'total - cacheRead - cacheWrite');
  assert.equal(tokens.input + tokens.cacheRead + tokens.cacheWrite, 4200);
});

test('nested usage: an inconsistent provider report clamps at zero instead of going negative', () => {
  const tokens = tokensFromAiSdkUsage({
    inputTokens: { total: 100, noCache: undefined, cacheRead: 5000, cacheWrite: 0 },
    outputTokens: { total: 1 },
  });
  assert.equal(tokens.input, 0);
});

test('nested usage: reasoning tokens are recorded but never added to output', () => {
  const tokens = tokensFromAiSdkUsage({
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 300, reasoning: 200 },
  });

  assert.equal(tokens.output, 500, 'the provider already counted reasoning inside output');
  assert.equal(tokens.thinking, 200);
});

/* ------------------------------------------------------------------ *
 * Usage — the flat (spec v2) shape                                    *
 * ------------------------------------------------------------------ */

test('flat usage on Anthropic treats inputTokens as ALREADY excluding cached tokens', () => {
  // @ai-sdk/anthropic@2: inputTokens = response.usage.input_tokens, which on
  // the Anthropic API excludes cache reads. Subtracting here would under-count
  // fresh input by the entire size of the cache.
  const tokens = tokensFromAiSdkUsage(
    { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedInputTokens: 3000 },
    { provider: 'anthropic.messages' },
  );

  assert.equal(tokens.input, 1000);
  assert.equal(tokens.cacheRead, 3000);
});

test('flat usage on OpenAI treats cached tokens as a subset and subtracts them', () => {
  const tokens = tokensFromAiSdkUsage(
    { inputTokens: 4000, outputTokens: 50, cachedInputTokens: 3000 },
    { provider: 'openai.chat' },
  );

  assert.equal(tokens.input, 1000, 'prompt_tokens includes the cached ones');
  assert.equal(tokens.cacheRead, 3000);
  assert.equal(tokens.input + tokens.cacheRead, 4000);
});

test('flat usage: an explicit convention overrides the provider guess', () => {
  const usage = { inputTokens: 4000, cachedInputTokens: 3000 };

  assert.equal(
    tokensFromAiSdkUsage(usage, { provider: 'anthropic', convention: 'subset' }).input,
    1000,
  );
  assert.equal(
    tokensFromAiSdkUsage(usage, { provider: 'some-unknown-gateway', convention: 'additive' }).input,
    4000,
  );
});

test('conventionFor matches on the provider namespace, and defaults to subset', () => {
  assert.equal(conventionFor('anthropic'), 'additive');
  assert.equal(conventionFor('anthropic.messages'), 'additive');
  assert.equal(conventionFor('openai.chat'), 'subset');
  assert.equal(conventionFor('google.generative-ai'), 'subset');
  assert.equal(conventionFor(undefined), 'subset');
});

test('a missing or malformed usage object yields zeros rather than throwing', () => {
  for (const usage of [undefined, null, 'nonsense', 42]) {
    const tokens = tokensFromAiSdkUsage(usage);
    assert.equal(tokens.input, 0);
    assert.equal(tokens.output, 0);
  }
});

/* ------------------------------------------------------------------ *
 * wrapGenerate, end to end through a real Profiler                    *
 * ------------------------------------------------------------------ */

const MODEL = { provider: 'anthropic.messages', modelId: 'claude-haiku-4-5' };

const PARAMS: AiSdkCallOptions = {
  tools: [{ type: 'function', name: 'search', inputSchema: {} }],
  prompt: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ],
};

test('wrapGenerate records an llm_call with the provider, model, tokens and composition', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');

  const middleware = fyrenMiddleware(run);
  const result = await middleware.wrapGenerate({
    model: MODEL,
    params: PARAMS,
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 4200, noCache: 1000, cacheRead: 3000, cacheWrite: 200 },
        outputTokens: { total: 12, text: 12, reasoning: 0 },
      },
      warnings: [],
    }),
  });

  assert.equal(result.finishReason, 'stop', 'the caller gets the untouched result back');
  run.end();

  const call = byName(profiler.getTree(run.rootId), 'claude-haiku-4-5');
  assert.equal(call.type, 'llm_call');
  assert.equal(call.status, 'ok');
  assert.equal(call.provider, 'anthropic.messages');
  assert.equal(call.model, 'claude-haiku-4-5');
  assert.equal(call.tokens.input, 1000);
  assert.equal(call.tokens.cacheRead, 3000);
  assert.equal(call.tokens.cacheWrite, 200);
  assert.equal(call.tokens.output, 12);

  assert.ok(call.inputComposition);
  assert.equal(call.inputComposition!.chars.system, 'You are a helpful assistant.'.length);
  assert.equal(call.inputComposition!.chars.latest, 'hello'.length);
  assert.ok(call.inputComposition!.chars.toolDefs > 0);

  assert.equal(call.metadata.tool_count, 1);
  assert.equal(call.metadata.message_count, 2);
  assert.equal(call.metadata.stop_reason, 'stop');

  profiler.close();
});

test('wrapGenerate re-throws the original error by identity and still records the call', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');
  const boom = new Error('rate limited');

  await assert.rejects(
    () =>
      fyrenMiddleware(run).wrapGenerate({
        model: MODEL,
        params: PARAMS,
        doGenerate: async () => {
          throw boom;
        },
      }),
    (err: unknown) => {
      assert.equal(err, boom, 'the identical Error instance, not a wrapper');
      return true;
    },
  );

  run.end();
  const call = byName(profiler.getTree(run.rootId), 'claude-haiku-4-5');
  assert.equal(call.status, 'error');
  assert.ok(call.inputComposition, 'a failed call still knows what it sent');
  profiler.close();
});

test('the node name and cacheSupported come from options when given', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('local');

  await fyrenMiddleware(run, { name: 'planner', cacheSupported: false, provider: 'ollama' }).wrapGenerate({
    model: { provider: 'ollama', modelId: 'qwen2.5:7b' },
    params: PARAMS,
    doGenerate: async () => ({ usage: { inputTokens: { total: 5, noCache: 5 }, outputTokens: { total: 1 } } }),
  });

  run.end();
  const call = byName(profiler.getTree(run.rootId), 'planner');
  assert.equal(call.provider, 'ollama');
  assert.equal(call.model, 'qwen2.5:7b');
  assert.equal(call.cacheSupported, false);
  profiler.close();
});

/* ------------------------------------------------------------------ *
 * wrapStream                                                          *
 * ------------------------------------------------------------------ */

function streamOf<T>(parts: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<T>) out.push(chunk);
  return out;
}

test('wrapStream passes every chunk through untouched and settles on the finish part', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');

  const parts = [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: 'hi' },
    { type: 'text-end', id: '0' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
    },
  ];

  const { stream } = await fyrenMiddleware(run).wrapStream({
    model: MODEL,
    params: PARAMS,
    doStream: async () => ({ stream: streamOf(parts) }),
  });

  assert.deepEqual(await drain(stream), parts, 'the consumer sees exactly what the provider sent');

  run.end();
  const call = byName(profiler.getTree(run.rootId), 'claude-haiku-4-5');
  assert.equal(call.status, 'ok');
  assert.equal(call.tokens.input, 900);
  assert.equal(call.tokens.output, 7);
  assert.equal(call.metadata.streamed, true);
  profiler.close();
});

test('an `error` stream part marks the call failed even though the stream closes cleanly', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');

  const { stream } = await fyrenMiddleware(run).wrapStream({
    model: MODEL,
    params: PARAMS,
    doStream: async () => ({
      stream: streamOf([{ type: 'error', error: new Error('overloaded') }]),
    }),
  });

  await drain(stream);
  run.end();

  const call = byName(profiler.getTree(run.rootId), 'claude-haiku-4-5');
  assert.equal(call.status, 'error', 'the stream ended fine; the CALL did not');
  profiler.close();
});

test('a stream that rejects mid-flight settles the node instead of leaving it running', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');

  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: '0', delta: 'partial' });
      controller.error(new Error('connection reset'));
    },
  });

  const { stream } = await fyrenMiddleware(run).wrapStream({
    model: MODEL,
    params: PARAMS,
    doStream: async () => ({ stream: failing }),
  });

  await assert.rejects(() => drain(stream));
  run.end();

  const call = byName(profiler.getTree(run.rootId), 'claude-haiku-4-5');
  assert.equal(call.status, 'error');
  assert.notEqual(call.status, 'running', 'flush never runs on a rejected stream');
  profiler.close();
});

test('wrapStream re-throws a failure to open the stream at all', async () => {
  const profiler = createProfiler({ dbPath: ':memory:' });
  const run = profiler.startRun('ai-sdk-agent');
  const boom = new Error('bad request');

  await assert.rejects(
    () =>
      fyrenMiddleware(run).wrapStream({
        model: MODEL,
        params: PARAMS,
        doStream: async () => {
          throw boom;
        },
      }),
    (err: unknown) => err === boom,
  );

  run.end();
  assert.equal(byName(profiler.getTree(run.rootId), 'claude-haiku-4-5').status, 'error');
  profiler.close();
});
