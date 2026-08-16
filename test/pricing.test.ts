import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateCost, rateFor, isPricingKnown, effectiveRate } from '../src/pricing.ts';

/** Rates carry cache multipliers and provenance too; most tests only care about the two prices. */
function prices(model: string): { input: number; output: number } | null {
  const rate = rateFor(model);
  return rate ? { input: rate.input, output: rate.output } : null;
}

test('known models resolve to their published rate', () => {
  assert.deepEqual(prices('claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(prices('claude-haiku-4-5'), { input: 1, output: 5 });
  assert.deepEqual(prices('claude-fable-5'), { input: 10, output: 50 });
  assert.deepEqual(prices('gpt-5.6-terra'), { input: 2, output: 12 });
  assert.deepEqual(prices('gemini-2.5-flash'), { input: 0.3, output: 2.5 });
});

test('provider prefixes, fast suffixes and date suffixes still resolve', () => {
  assert.deepEqual(prices('anthropic.claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(prices('claude-opus-5-fast'), { input: 5, output: 25 });
  assert.deepEqual(prices('claude-haiku-4-5-20251001'), { input: 1, output: 5 });
  // Gemini's own API echoes the model back as "models/<id>"
  assert.deepEqual(prices('models/gemini-2.5-flash'), { input: 0.3, output: 2.5 });
  assert.deepEqual(prices('google/gemini-2.5-pro'), { input: 1.25, output: 10 });
});

test('the longest matching prefix wins', () => {
  // "claude-opus-4-8" must not be resolved by a shorter, cheaper neighbour
  assert.deepEqual(prices('claude-opus-4-8'), { input: 5, output: 25 });
});

test('unknown and empty models are reported, not guessed', () => {
  assert.equal(rateFor('totally-made-up-model'), null);
  assert.equal(rateFor(''), null);
  assert.equal(rateFor(null), null);
  assert.equal(rateFor(undefined), null);
  assert.equal(isPricingKnown('claude-opus-5'), true);
  assert.equal(isPricingKnown('totally-made-up-model'), false);
});

test('each rate carries its provider, so reports can explain the cache numbers', () => {
  assert.equal(rateFor('claude-opus-5')?.provider, 'anthropic');
  assert.equal(rateFor('gpt-5.6-sol')?.provider, 'openai');
  assert.equal(rateFor('gemini-2.5-flash')?.provider, 'gemini');
});

test('cost applies the cache multipliers, not the flat input rate', () => {
  const cost = estimateCost('claude-opus-5', {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(cost.toFixed(6), (5).toFixed(6));

  const write = estimateCost('claude-opus-5', {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000_000,
  });
  assert.equal(write.toFixed(6), (6.25).toFixed(6), 'cache writes cost 1.25x input');

  const read = estimateCost('claude-opus-5', {
    input: 0,
    output: 0,
    cacheRead: 1_000_000,
    cacheWrite: 0,
  });
  assert.equal(read.toFixed(6), (0.5).toFixed(6), 'cache reads cost 0.1x input');

  const output = estimateCost('claude-opus-5', {
    input: 0,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(output.toFixed(6), (25).toFixed(6));
});

/* ---------------- per-model cache multipliers ---------------- */

test('cache multipliers are per model, not global — OpenAI before GPT-5.6 writes to cache for free', () => {
  // GPT-5.6+ bills writes at 1.25x, exactly like Anthropic.
  const newer = estimateCost('gpt-5.6-terra', {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000_000,
  });
  assert.equal(newer.toFixed(6), (2 * 1.25).toFixed(6));

  // GPT-5.5 and earlier: writing to cache is free. A global 1.25x constant
  // would have overcharged this by $6.25 per million tokens.
  const older = estimateCost('gpt-5.5', {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000_000,
  });
  assert.equal(older, 0, 'cache writes are free before GPT-5.6');
});

test('GPT-4.1 discounts cache reads 0.25x, not the usual 0.1x', () => {
  const read = estimateCost('gpt-4.1', {
    input: 0,
    output: 0,
    cacheRead: 1_000_000,
    cacheWrite: 0,
  });
  // $2 input * 0.25 — a global 0.1x constant would have under-reported this.
  assert.equal(read.toFixed(6), (0.5).toFixed(6));
  assert.equal(rateFor('gpt-4.1')?.cacheReadMultiplier, 0.25);
});

test('Gemini rates record storage-per-hour, a cost this token-based model cannot bill', () => {
  const rate = rateFor('gemini-2.5-flash');
  assert.equal(rate?.storagePerHour, 1);
  assert.equal(rate?.cacheWriteMultiplier, 0, 'Gemini charges storage time, not per write');
});

/* ---------------- context-length tiers ---------------- */

test('models with a context threshold switch rates once input exceeds it', () => {
  const rate = rateFor('gemini-2.5-pro');
  assert.ok(rate);
  assert.deepEqual(effectiveRate(rate, 100_000), { input: 1.25, output: 10 });
  assert.deepEqual(effectiveRate(rate, 300_000), { input: 2.5, output: 15 }, 'above 200k costs more');
  // exactly at the threshold is still the lower tier
  assert.deepEqual(effectiveRate(rate, 200_000), { input: 1.25, output: 10 });
});

test('a model with no threshold returns the same rate at any size', () => {
  const rate = rateFor('claude-opus-5');
  assert.ok(rate);
  assert.deepEqual(effectiveRate(rate, 10), { input: 5, output: 25 });
  assert.deepEqual(effectiveRate(rate, 5_000_000), { input: 5, output: 25 });
});

test('estimateCost applies the context tier from the call total input', () => {
  // 300k input tokens on gemini-2.5-pro → above the 200k threshold → $2.50/1M
  const big = estimateCost('gemini-2.5-pro', {
    input: 300_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(big.toFixed(6), ((300_000 * 2.5) / 1_000_000).toFixed(6));

  const small = estimateCost('gemini-2.5-pro', {
    input: 100_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(small.toFixed(6), ((100_000 * 1.25) / 1_000_000).toFixed(6));
});

test('an unknown model costs zero rather than throwing', () => {
  assert.equal(
    estimateCost('totally-made-up-model', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }),
    0,
  );
});
