/**
 * The Gemini provider.
 *
 * Gemini's wire format differs from Anthropic's on every axis (roles, parts,
 * systemInstruction, functionCall/functionResponse), so the translation is
 * written from scratch rather than shared with the OpenAI-compatible pair.
 * These tests pin each of those differences, plus the same cache-subtraction
 * invariant the OpenAI provider has.
 *
 * No network: `fetch` is stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGeminiClient,
  toGeminiRequest,
  fromGeminiResponse,
  tokensFromGeminiUsage,
} from '../src/providers/gemini.ts';

/* ---------------- request translation ---------------- */

test('the system prompt becomes top-level systemInstruction, not a message', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'You are terse.' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
});

test('the assistant role is renamed to "model"', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  });
  assert.equal(body.contents[0]!.role, 'user');
  assert.equal(body.contents[1]!.role, 'model', 'Gemini has no "assistant" role');
});

test('tools become a single functionDeclarations group with input_schema as parameters', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'search_docs',
        description: 'Search the docs.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  });

  assert.equal(body.tools?.length, 1, 'all declarations live under ONE tools entry');
  assert.deepEqual(body.tools?.[0]?.functionDeclarations, [
    {
      name: 'search_docs',
      description: 'Search the docs.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ]);
});

test('a tool_use block becomes functionCall with args as a real object, not a JSON string', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'search_docs', input: { query: 'rate limit' } }],
      },
    ],
  });

  const part = body.contents[0]!.parts[0]!;
  // OpenAI would stringify this; Gemini wants the object itself.
  assert.deepEqual(part.functionCall, { name: 'search_docs', args: { query: 'rate limit' } });
});

test('a tool_result becomes functionResponse, and a bare string gets wrapped into an object', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', name: 'search_docs', content: 'RESULT TEXT' },
        ],
      },
    ],
  });

  const part = body.contents[0]!.parts[0]!;
  assert.equal(part.functionResponse?.name, 'search_docs');
  // Gemini requires `response` to be an object — a raw string is not valid.
  assert.deepEqual(part.functionResponse?.response, { result: 'RESULT TEXT' });
});

test('max_tokens maps into generationConfig.maxOutputTokens', () => {
  const body = toGeminiRequest({
    model: 'gemini-2.5-flash',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 256 });
});

test('empty params do not throw', () => {
  assert.doesNotThrow(() => toGeminiRequest({}));
  assert.deepEqual(toGeminiRequest({}).contents, []);
});

/* ---------------- response translation ---------------- */

test('a text response becomes a text content block', () => {
  const message = fromGeminiResponse(
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hello there.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
      modelVersion: 'gemini-2.5-flash',
    },
    'gemini-2.5-flash',
  );

  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello there.' }]);
  assert.equal(message.usage?.input_tokens, 30);
  assert.equal(message.usage?.output_tokens, 5);
});

test('a functionCall response becomes tool_use with a synthesized id and stop_reason tool_use', () => {
  const message = fromGeminiResponse(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'search_docs', args: { query: 'auth' } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    },
    'gemini-2.5-flash',
  );

  assert.equal(message.stop_reason, 'tool_use');
  const block = (message.content as Array<Record<string, unknown>>)[0]!;
  assert.equal(block.type, 'tool_use');
  assert.equal(block.name, 'search_docs');
  assert.deepEqual(block.input, { query: 'auth' });
  // Gemini returns no call id; one is synthesized so the agent loop can pair
  // the eventual result back to this call.
  assert.ok(typeof block.id === 'string' && block.id.length > 0);
});

test('a response with no candidates does not throw', () => {
  assert.doesNotThrow(() => fromGeminiResponse({}, 'gemini-2.5-flash'));
  assert.deepEqual(fromGeminiResponse({}, 'gemini-2.5-flash').content, []);
});

/* ---------------- usage mapping — the risky part ---------------- */

test('cachedContentTokenCount is subtracted out of promptTokenCount, not added', () => {
  // Same relationship as OpenAI, opposite of Anthropic: the cached count is a
  // SUBSET of the prompt count.
  const tokens = tokensFromGeminiUsage({
    promptTokenCount: 5000,
    cachedContentTokenCount: 4000,
    candidatesTokenCount: 100,
  });

  assert.equal(tokens.input, 1000, 'fresh input excludes the cached portion');
  assert.equal(tokens.cacheRead, 4000);
  assert.equal(tokens.input + tokens.cacheRead, 5000);
});

test('Gemini never reports a cache WRITE count — that is accurate, not unknown', () => {
  const tokens = tokensFromGeminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 50 });
  // Explicit caching bills storage per hour instead of per written token, so
  // there is genuinely no write-token figure to report.
  assert.equal(tokens.cacheWrite, 0);
});

test('thoughtsTokenCount is recorded but never inflates output', () => {
  const tokens = tokensFromGeminiUsage({
    promptTokenCount: 10,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 120,
  });
  assert.equal(tokens.output, 200);
  assert.equal(tokens.thinking, 120);
});

test('inconsistent provider numbers clamp at zero', () => {
  const tokens = tokensFromGeminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 900 });
  assert.equal(tokens.input, 0);
});

test('a missing usageMetadata does not throw', () => {
  assert.deepEqual(tokensFromGeminiUsage(undefined), {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test('the real captured cache-hit response from gemini-3.7-flash maps correctly', () => {
  // Not a synthetic fixture: these are the exact numbers a live
  // gemini-3.7-flash call returned when implicit caching engaged on the
  // second of three identical-system-prompt requests. This is the only place
  // the cache subtraction has been checked against a provider that really
  // cached something, so it is pinned here verbatim.
  const tokens = tokensFromGeminiUsage({
    promptTokenCount: 8653,
    cachedContentTokenCount: 4076,
    candidatesTokenCount: 18,
  });

  assert.equal(tokens.input, 4577, '8653 prompt - 4076 cached');
  assert.equal(tokens.cacheRead, 4076);
  assert.equal(tokens.cacheWrite, 0);
  assert.equal(tokens.input + tokens.cacheRead, 8653, 'parts still sum to what Gemini billed');
});

test('implicit caching below the model threshold reports zero — also captured from the real API', () => {
  // First attempt against the same live model used a ~3,582-token prompt and
  // got cachedContentTokenCount absent on every call: gemini-3.7-flash needs
  // >=4,096 prompt tokens before implicit caching engages at all. A zero here
  // is the model declining to cache, not a mapping bug.
  const tokens = tokensFromGeminiUsage({ promptTokenCount: 3582, candidatesTokenCount: 17 });
  assert.equal(tokens.input, 3582);
  assert.equal(tokens.cacheRead, 0);
});

/* ---------------- client ---------------- */

test('the client posts to :generateContent with the API key header', async (t) => {
  let capturedUrl = '';
  let capturedKey = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedKey = (init.headers as Record<string, string>)['x-goog-api-key'] ?? '';
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 2048, cachedContentTokenCount: 2000, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const client = createGeminiClient({ apiKey: 'gem-key' });
  const response = await client.messages.create({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.match(capturedUrl, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(capturedKey, 'gem-key');
  assert.equal(response.usage?.input_tokens, 48, '2048 prompt - 2000 cached');
  assert.equal(response.usage?.cache_read_input_tokens, 2000);
});

test('a "models/" prefix on the model id is stripped from the REST path', async (t) => {
  let capturedUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
  });

  const client = createGeminiClient({ apiKey: 'k' });
  await client.messages.create({ model: 'models/gemini-2.5-pro', messages: [] });
  assert.match(capturedUrl, /\/models\/gemini-2\.5-pro:generateContent$/);
  assert.doesNotMatch(capturedUrl, /models\/models/);
});

test('countTokens exists and sends the full generateContentRequest, so system and tools are counted', async (t) => {
  let capturedBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ totalTokens: 1234 }), { status: 200 });
  });

  const client = createGeminiClient({ apiKey: 'k' });
  const result = await client.messages.countTokens!({
    model: 'gemini-2.5-flash',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.input_tokens, 1234);
  // Bare `contents` would omit the system instruction from the count; the
  // wrapper form includes it.
  const inner = capturedBody.generateContentRequest as Record<string, unknown>;
  assert.ok(inner, 'must use the generateContentRequest wrapper form');
  assert.ok(inner.systemInstruction, 'system instruction must reach the counter');
});

test('a non-2xx response becomes a clear thrown Error', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('bad key', { status: 403, statusText: 'Forbidden' }),
  );
  const client = createGeminiClient({ apiKey: 'k' });
  await assert.rejects(
    client.messages.create({ model: 'gemini-2.5-flash', messages: [] }),
    /403.*bad key/,
  );
});

test('a connection failure names the endpoint it could not reach', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  const client = createGeminiClient({ apiKey: 'k', baseUrl: 'https://example.invalid/v1beta' });
  await assert.rejects(
    client.messages.create({ model: 'gemini-2.5-flash', messages: [] }),
    /Could not reach Gemini at https:\/\/example\.invalid\/v1beta/,
  );
});
