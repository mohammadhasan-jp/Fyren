/**
 * Model pricing, USD per 1M tokens.
 *
 * Kept as plain data so it is trivial to update — pricing changes more often
 * than code does.
 *
 * ── Why cache multipliers live PER MODEL, not as module constants ──────────
 *
 * They used to be two constants (1.25x write, 0.1x read) because Anthropic was
 * the only provider. That is wrong the moment a second provider exists:
 *
 *   Anthropic                  write 1.25x   read 0.1x
 *   OpenAI GPT-5.6 and later   write 1.25x   read 0.1x
 *   OpenAI GPT-5.5 and earlier write FREE    read 0.1x
 *   OpenAI GPT-4.1 family      write FREE    read 0.25x
 *   Gemini                     write FREE*   read 0.1x
 *
 * (*Gemini explicit `cachedContents` bills storage per hour of TTL instead of
 * a per-write token charge — a time-based cost this token-based model cannot
 * represent, so it is not counted here. See `storagePerHour` below.)
 *
 * Verified against provider docs 2026-08. A wrong multiplier silently
 * misreports every cost figure downstream, so these are data, not assumptions.
 *
 * `thinking` tokens are deliberately absent: on Anthropic they are billed as
 * part of `output`, so they are already covered by the output rate.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /**
   * Multiplier on `input` for a token served FROM cache. Provider-specific —
   * 0.1 (90% off) on most current models, 0.25 on OpenAI's GPT-4.1 family.
   */
  cacheReadMultiplier: number;
  /**
   * Multiplier on `input` for a token WRITTEN to cache. `0` means writing to
   * cache is free on this model — true for every OpenAI model before GPT-5.6,
   * and for Gemini (which charges storage-time instead).
   */
  cacheWriteMultiplier: number;
  /**
   * Which provider's pricing this row describes. Informational — used by
   * reports to explain *why* a cache figure looks the way it does.
   */
  provider: 'anthropic' | 'openai' | 'gemini';
  /**
   * USD per 1M cached tokens per hour of retention, for providers that bill
   * cache STORAGE by time rather than by write (Gemini explicit caching).
   * Absent everywhere else. Not included in `estimateCost` — it needs a
   * duration this library does not track — but recorded so a report can say
   * the number is incomplete rather than silently omitting a real cost.
   */
  storagePerHour?: number;
  /**
   * Some models price differently above a context-length threshold (Gemini
   * Pro: one rate at <=200k prompt tokens, a higher one above). When present,
   * `estimateCost` switches to `aboveThreshold` once total input exceeds it.
   */
  contextThreshold?: {
    tokens: number;
    aboveThreshold: Pick<ModelRate, 'input' | 'output'>;
  };
}

/** Anthropic and OpenAI GPT-5.6+ share this shape; declared once to keep the table readable. */
const ANTHROPIC_CACHE = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 } as const;
/** OpenAI before GPT-5.6, and Gemini: reads discounted, writes free. */
const FREE_WRITE_CACHE = { cacheReadMultiplier: 0.1, cacheWriteMultiplier: 0 } as const;

export const PRICING: Record<string, ModelRate> = {
  /* ---- Anthropic — verified 2026-08 ---- */
  'claude-fable-5': { input: 10, output: 50, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-mythos-5': { input: 10, output: 50, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-opus-5': { input: 5, output: 25, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-opus-4-8': { input: 5, output: 25, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-opus-4-7': { input: 5, output: 25, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-opus-4-6': { input: 5, output: 25, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-opus-4-5': { input: 5, output: 25, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-sonnet-5': { input: 3, output: 15, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-sonnet-4-6': { input: 3, output: 15, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-sonnet-4-5': { input: 3, output: 15, provider: 'anthropic', ...ANTHROPIC_CACHE },
  'claude-haiku-4-5': { input: 1, output: 5, provider: 'anthropic', ...ANTHROPIC_CACHE },

  /* ---- OpenAI — verified 2026-08. Note the multiplier split at GPT-5.6. ---- */
  'gpt-5.6-sol': { input: 5, output: 30, provider: 'openai', ...ANTHROPIC_CACHE },
  'gpt-5.6-terra': { input: 2, output: 12, provider: 'openai', ...ANTHROPIC_CACHE },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, provider: 'openai', ...ANTHROPIC_CACHE },
  'gpt-5.5': { input: 5, output: 30, provider: 'openai', ...FREE_WRITE_CACHE },
  'gpt-5.4': { input: 2.5, output: 15, provider: 'openai', ...FREE_WRITE_CACHE },
  'gpt-5': { input: 1.25, output: 10, provider: 'openai', ...FREE_WRITE_CACHE },
  // GPT-4.1's cache read discount is 0.25x, not 0.1x — the one real outlier.
  'gpt-4.1': { input: 2, output: 8, provider: 'openai', cacheReadMultiplier: 0.25, cacheWriteMultiplier: 0 },

  /* ---- Google Gemini — verified 2026-08 ---- */
  'gemini-3.7-flash': {
    input: 0.75,
    output: 3.75,
    provider: 'gemini',
    ...FREE_WRITE_CACHE,
    storagePerHour: 0.5,
  },
  'gemini-3.1-pro-preview': {
    input: 2,
    output: 12,
    provider: 'gemini',
    ...FREE_WRITE_CACHE,
    storagePerHour: 4.5,
    contextThreshold: { tokens: 200_000, aboveThreshold: { input: 4, output: 18 } },
  },
  'gemini-2.5-flash': {
    input: 0.3,
    output: 2.5,
    provider: 'gemini',
    ...FREE_WRITE_CACHE,
    storagePerHour: 1,
  },
  'gemini-2.5-pro': {
    input: 1.25,
    output: 10,
    provider: 'gemini',
    ...FREE_WRITE_CACHE,
    contextThreshold: { tokens: 200_000, aboveThreshold: { input: 2.5, output: 15 } },
  },
};

/**
 * Resolve a model id to a rate.
 *
 * Model ids arrive with provider prefixes (Bedrock `anthropic.`, Vertex
 * `google/`), date suffixes (`claude-haiku-4-5-20251001`), or `models/`
 * prefixes (Gemini's own API returns `models/gemini-2.5-flash`), so we
 * normalize before looking up, then fall back to the longest matching prefix.
 */
export function rateFor(model: string | null | undefined): ModelRate | null {
  if (!model) return null;

  const normalized = model
    .replace(/^anthropic\./, '')
    .replace(/^models\//, '')
    .replace(/^google\//, '')
    .replace(/^openai\//, '')
    .replace(/-fast$/, '');

  const exact = PRICING[normalized];
  if (exact) return exact;

  let best: { key: string; rate: ModelRate } | null = null;
  for (const [key, rate] of Object.entries(PRICING)) {
    if (normalized.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best ? best.rate : null;
}

export interface CostInput {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The input/output rates that actually apply to a call, after resolving any
 * context-length tier. Exported because the analysis layer prices per segment
 * and must use the same tier the run as a whole fell into.
 */
export function effectiveRate(rate: ModelRate, totalInputTokens: number): Pick<ModelRate, 'input' | 'output'> {
  const tier = rate.contextThreshold;
  if (tier && totalInputTokens > tier.tokens) return tier.aboveThreshold;
  return { input: rate.input, output: rate.output };
}

/** Estimated cost in USD. Returns 0 for unknown models rather than throwing. */
export function estimateCost(model: string | null | undefined, tokens: CostInput): number {
  const rate = rateFor(model);
  if (!rate) return 0;

  const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const { input, output } = effectiveRate(rate, totalInput);

  const usd =
    (tokens.input * input +
      tokens.output * output +
      tokens.cacheWrite * input * rate.cacheWriteMultiplier +
      tokens.cacheRead * input * rate.cacheReadMultiplier) /
    1_000_000;

  return usd;
}

/** True when we have no price for this model, so callers can flag "cost unknown". */
export function isPricingKnown(model: string | null | undefined): boolean {
  return rateFor(model) !== null;
}
