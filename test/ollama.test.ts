/**
 * The Ollama provider's request/response translation and HTTP client.
 *
 * No network here — `npm test` must stay offline and fast. The fixtures
 * below are not invented: they are the exact JSON bodies exchanged with a
 * real local Ollama instance (qwen2.5:0.5b) while building this file —
 * a plain reply, a tool_use turn, and the tool_result round trip — captured
 * so the translation is pinned against real behavior, not a guess at the
 * OpenAI-compat spec.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toOllamaRequest,
  fromOllamaResponse,
  createOllamaClient,
  type OllamaChatResponse,
} from '../src/providers/ollama.ts';
import type { AnthropicCreateParams } from '../src/providers/anthropic.ts';

/* ------------------------------------------------------------------ *
 * Request translation                                                 *
 * ------------------------------------------------------------------ */

test('system + plain user message becomes system/user OpenAI messages', () => {
  const body = toOllamaRequest({
    model: 'qwen2.5:0.5b',
    max_tokens: 60,
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'What is the capital of France? Answer in 3 words or less.' }],
  });

  assert.deepEqual(body, {
    model: 'qwen2.5:0.5b',
    max_tokens: 60,
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'What is the capital of France? Answer in 3 words or less.' },
    ],
    stream: false,
  });
});

test('a request with no system prompt omits the system message entirely', () => {
  const body = toOllamaRequest({ model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.messages[0]!.role, 'user');
});

test('Anthropic flat tool defs become OpenAI function-wrapped tools', () => {
  const body = toOllamaRequest({
    model: 'qwen2.5:0.5b',
    system: 'You must use the search_docs tool before answering any factual question.',
    messages: [{ role: 'user', content: 'What is the rate limit for the Widget API?' }],
    tools: [
      {
        name: 'search_docs',
        description: 'Search the documentation for a query.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  });

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: {
        name: 'search_docs',
        description: 'Search the documentation for a query.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
  ]);
});

test('no tools on the request means no `tools` field at all, not an empty array', () => {
  const body = toOllamaRequest({ model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('tools' in body, false);
});

test('an assistant tool_use block becomes an OpenAI tool_calls entry with stringified arguments', () => {
  const body = toOllamaRequest({
    model: 'qwen2.5:0.5b',
    messages: [
      { role: 'user', content: 'What is the rate limit for the Widget API?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_taxdo7qp', name: 'search_docs', input: { query: 'Widget API rate limit' } },
        ],
      },
    ],
  });

  const assistantMessage = body.messages[1]!;
  assert.equal(assistantMessage.role, 'assistant');
  assert.equal(assistantMessage.content, null, 'no text alongside the tool call, matching what Ollama itself sends');
  assert.deepEqual(assistantMessage.tool_calls, [
    {
      id: 'call_taxdo7qp',
      type: 'function',
      function: { name: 'search_docs', arguments: '{"query":"Widget API rate limit"}' },
    },
  ]);
});

test('a user tool_result block becomes its own role:"tool" message with tool_call_id', () => {
  const body = toOllamaRequest({
    model: 'qwen2.5:0.5b',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_taxdo7qp',
            content: 'Rate limit: 100 requests per minute per API key.',
          },
        ],
      },
    ],
  });

  assert.deepEqual(body.messages, [
    {
      role: 'tool',
      tool_call_id: 'call_taxdo7qp',
      content: 'Rate limit: 100 requests per minute per API key.',
    },
  ]);
});

test('a mixed last message (tool_result + plain text) expands into two OpenAI messages', () => {
  const body = toOllamaRequest({
    model: 'qwen2.5:0.5b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'RESULT' },
          { type: 'text', text: 'and also, thanks' },
        ],
      },
    ],
  });

  assert.deepEqual(body.messages, [
    { role: 'tool', tool_call_id: 'call_1', content: 'RESULT' },
    { role: 'user', content: 'and also, thanks' },
  ]);
});

test('the full request/response/result round trip matches the exact body a real Ollama server accepted', () => {
  // This is byte-for-byte the request that produced a real 200 response
  // during development — see the file header.
  const params: AnthropicCreateParams = {
    model: 'qwen2.5:0.5b',
    max_tokens: 150,
    system: 'Answer using only the tool result.',
    messages: [
      { role: 'user', content: 'What is the rate limit for the Widget API?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_taxdo7qp', name: 'search_docs', input: { query: 'Widget API rate limit' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_taxdo7qp',
            content: 'Rate limit: 100 requests per minute per API key.',
          },
        ],
      },
    ],
  };

  const body = toOllamaRequest(params);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Answer using only the tool result.' },
    { role: 'user', content: 'What is the rate limit for the Widget API?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_taxdo7qp',
          type: 'function',
          function: { name: 'search_docs', arguments: '{"query":"Widget API rate limit"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_taxdo7qp', content: 'Rate limit: 100 requests per minute per API key.' },
  ]);
});

/* ------------------------------------------------------------------ *
 * Response translation — fixtures captured from the real server        *
 * ------------------------------------------------------------------ */

test('a plain-text reply translates to a single text content block', () => {
  // Real response body from `POST /v1/chat/completions` against qwen2.5:0.5b.
  const raw: OllamaChatResponse = {
    id: 'chatcmpl-559',
    object: 'chat.completion',
    created: 1786839815,
    model: 'qwen2.5:0.5b',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hello! How can I help you today?' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 31, completion_tokens: 10, total_tokens: 41 },
  } as unknown as OllamaChatResponse;

  const message = fromOllamaResponse(raw, 'qwen2.5:0.5b');
  assert.equal(message.model, 'qwen2.5:0.5b');
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello! How can I help you today?' }]);
  assert.deepEqual(message.usage, { input_tokens: 31, output_tokens: 10 });
});

test('a tool_calls reply translates to tool_use blocks with parsed input, and stop_reason "tool_use"', () => {
  // Real response body for a request that triggered the search_docs tool.
  const raw: OllamaChatResponse = {
    id: 'chatcmpl-222',
    object: 'chat.completion',
    created: 1786839837,
    model: 'qwen2.5:0.5b',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_taxdo7qp',
              index: 0,
              type: 'function',
              function: { name: 'search_docs', arguments: '{"query":"Widget API rate limit"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 152, completion_tokens: 23, total_tokens: 175 },
  } as unknown as OllamaChatResponse;

  const message = fromOllamaResponse(raw, 'qwen2.5:0.5b');
  assert.equal(message.stop_reason, 'tool_use');
  // Empty-string content from Ollama must not become a spurious empty text block.
  assert.deepEqual(message.content, [
    { type: 'tool_use', id: 'call_taxdo7qp', name: 'search_docs', input: { query: 'Widget API rate limit' } },
  ]);
  assert.deepEqual(message.usage, { input_tokens: 152, output_tokens: 23 });
});

test('usage never carries cache fields — Ollama has no caching concept to report', () => {
  const message = fromOllamaResponse(
    { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    'qwen2.5:0.5b',
  );
  const usage = message.usage as Record<string, unknown>;
  assert.equal('cache_read_input_tokens' in usage, false);
  assert.equal('cache_creation_input_tokens' in usage, false);
});

test('malformed tool_call arguments degrade to an empty input object instead of throwing', () => {
  const raw: OllamaChatResponse = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'x', type: 'function', function: { name: 'search_docs', arguments: 'not json{' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const message = fromOllamaResponse(raw, 'qwen2.5:0.5b');
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'x', name: 'search_docs', input: {} }]);
});

test('a response with no choices at all does not throw', () => {
  assert.doesNotThrow(() => fromOllamaResponse({}, 'qwen2.5:0.5b'));
  const message = fromOllamaResponse({}, 'qwen2.5:0.5b');
  assert.equal(message.model, 'qwen2.5:0.5b');
  assert.deepEqual(message.content, []);
});

/* ------------------------------------------------------------------ *
 * HTTP client — fetch stubbed, no real network                        *
 * ------------------------------------------------------------------ */

test('the client POSTs to /v1/chat/completions with the translated body', async (t) => {
  let capturedUrl = '';
  let capturedBody: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ model: 'qwen2.5:0.5b', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  const client = createOllamaClient({ baseUrl: 'http://localhost:11434' });
  const response = await client.messages.create({ model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(capturedUrl, 'http://localhost:11434/v1/chat/completions');
  assert.equal((capturedBody as { model: string }).model, 'qwen2.5:0.5b');
  assert.equal(response.model, 'qwen2.5:0.5b');
});

test('a non-2xx response becomes a clear thrown Error, not a silent bad response', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('model not found', { status: 404, statusText: 'Not Found' }));

  const client = createOllamaClient();
  await assert.rejects(
    client.messages.create({ model: 'nonexistent', messages: [] }),
    /404.*model not found/,
  );
});

test('a connection failure produces a clear "is Ollama running" message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });

  const client = createOllamaClient({ baseUrl: 'http://localhost:11434' });
  await assert.rejects(client.messages.create({ model: 'x', messages: [] }), /ollama serve/i);
});

test('the client has no countTokens — precise mode has something to detect and skip', () => {
  const client = createOllamaClient();
  assert.equal('countTokens' in client.messages, false);
});
