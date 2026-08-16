/**
 * The OpenAI provider.
 *
 * The load-bearing thing here is the usage mapping. OpenAI reports cached
 * tokens as a SUBSET of `prompt_tokens`; Anthropic reports them as separate
 * additive fields. Getting that backwards double-counts every cached token,
 * which would quietly inflate every cost figure downstream — so most of this
 * file is about that one subtraction.
 *
 * No network: `fetch` is stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOpenAiClient,
  tokensFromOpenAiUsage,
  OPENAI_MIN_CACHEABLE_TOKENS,
} from '../src/providers/openai.ts';
import { toOpenAiCompatRequest } from '../src/providers/openai-compat.ts';

/* ---------------- usage mapping — the risky part ---------------- */

test('cached tokens are subtracted out of prompt_tokens, not added to them', () => {
  // A real-shaped Chat Completions usage object: 1000 prompt tokens TOTAL,
  // of which 800 came from cache. Fresh (full-price) input is therefore 200.
  const tokens = tokensFromOpenAiUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 },
  });

  assert.equal(tokens.input, 200, 'fresh input excludes the cached portion');
  assert.equal(tokens.cacheRead, 800);
  assert.equal(tokens.output, 50);
  // The invariant that matters: the parts still sum to what OpenAI billed as prompt.
  assert.equal(tokens.input + tokens.cacheRead + tokens.cacheWrite, 1000);
});

test('cache_write_tokens is also carved out of prompt_tokens (GPT-5.6+ shape)', () => {
  const tokens = tokensFromOpenAiUsage({
    prompt_tokens: 1000,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
  });

  assert.equal(tokens.cacheRead, 600);
  assert.equal(tokens.cacheWrite, 300);
  assert.equal(tokens.input, 100, '1000 - 600 - 300');
  assert.equal(tokens.input + tokens.cacheRead + tokens.cacheWrite, 1000);
});

test('the Responses API field names (input_tokens_details) are read too', () => {
  const tokens = tokensFromOpenAiUsage({
    input_tokens: 500,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 400 },
  });
  assert.equal(tokens.input, 100);
  assert.equal(tokens.cacheRead, 400);
  assert.equal(tokens.output, 20);
});

test('a response with no caching at all reports everything as fresh input', () => {
  const tokens = tokensFromOpenAiUsage({ prompt_tokens: 300, completion_tokens: 40 });
  assert.equal(tokens.input, 300);
  assert.equal(tokens.cacheRead, 0);
  assert.equal(tokens.cacheWrite, 0);
});

test('reasoning tokens are recorded but never inflate the totals', () => {
  const tokens = tokensFromOpenAiUsage({
    prompt_tokens: 100,
    completion_tokens: 200,
    completion_tokens_details: { reasoning_tokens: 150 },
  });
  // Same relationship Anthropic has between thinking and output: billed
  // inside completion_tokens, so output stays 200, not 350.
  assert.equal(tokens.output, 200);
  assert.equal(tokens.thinking, 150);
});

test('inconsistent provider numbers clamp at zero instead of going negative', () => {
  const tokens = tokensFromOpenAiUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 500 }, // nonsense, but must not produce -400
  });
  assert.equal(tokens.input, 0);
});

test('a missing usage object does not throw', () => {
  const tokens = tokensFromOpenAiUsage(undefined);
  assert.deepEqual(tokens, { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 });
});

test('the documented minimum cacheable prefix is exported for waste analysis', () => {
  // Below this, OpenAI does not cache at all — so "uncached" on a small
  // prompt is not a missing-breakpoint bug the way it is on Anthropic.
  assert.equal(OPENAI_MIN_CACHEABLE_TOKENS, 1024);
});

/* ---------------- request translation (shared with Ollama) ---------------- */

test('requests use the shared OpenAI-compatible translation', () => {
  const body = toOpenAiCompatRequest({
    model: 'gpt-5.6-terra',
    max_tokens: 100,
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(body.stream, false);
});

/* ---------------- client ---------------- */

function okResponse(usage: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: 'gpt-5.6-terra',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

test('the client authenticates, hits /chat/completions, and returns Anthropic-shaped usage', async (t) => {
  let capturedUrl = '';
  let capturedAuth = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedAuth = (init.headers as Record<string, string>).Authorization ?? '';
    return okResponse({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 900 },
    });
  });

  const client = createOpenAiClient({ apiKey: 'sk-test-key' });
  const response = await client.messages.create({
    model: 'gpt-5.6-terra',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capturedAuth, 'Bearer sk-test-key');

  // Usage must arrive in the Anthropic field names wrapAnthropic reads, with
  // the subtraction already applied.
  assert.equal(response.usage?.input_tokens, 100);
  assert.equal(response.usage?.cache_read_input_tokens, 900);
  assert.equal(response.usage?.output_tokens, 25);
  assert.deepEqual(response.content, [{ type: 'text', text: 'hello' }]);
});

test('prompt_cache_key is sent only when configured', async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return okResponse({ prompt_tokens: 10, completion_tokens: 1 });
  });

  const withKey = createOpenAiClient({ apiKey: 'k', promptCacheKey: 'session-42' });
  await withKey.messages.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'a' }] });
  assert.equal(bodies[0]!.prompt_cache_key, 'session-42');

  const without = createOpenAiClient({ apiKey: 'k' });
  await without.messages.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'a' }] });
  assert.equal('prompt_cache_key' in bodies[1]!, false, 'omitted entirely, not sent as undefined');
});

test('a non-2xx response becomes a clear thrown Error', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('bad model', { status: 404, statusText: 'Not Found' }),
  );
  const client = createOpenAiClient({ apiKey: 'k' });
  await assert.rejects(
    client.messages.create({ model: 'nope', messages: [] }),
    /404.*bad model/,
  );
});

test('a connection failure names the endpoint it could not reach', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  const client = createOpenAiClient({ apiKey: 'k', baseUrl: 'https://example.invalid/v1' });
  await assert.rejects(
    client.messages.create({ model: 'gpt-5', messages: [] }),
    /Could not reach OpenAI at https:\/\/example\.invalid\/v1/,
  );
});

test('the client has no countTokens — precise mode has something to detect and skip', () => {
  const client = createOpenAiClient({ apiKey: 'k' });
  assert.equal('countTokens' in client.messages, false);
});
