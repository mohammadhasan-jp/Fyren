/**
 * fyren — public surface.
 *
 * Step 1: data collection.  Step 2: cost breakdown (analysis #1 of 3).
 * Step 3: waste detection (analysis #2 of 3, pattern #1 of 3 — uncached
 * static content).
 */

export { createProfiler, Profiler, NodeHandle } from './profiler.ts';
export type {
  ProfilerOptions,
  StartOptions,
  EndOptions,
  CostBreakdownRecentOptions,
} from './profiler.ts';

export {
  wrapAnthropic,
  tokensFromUsage,
  analyzeComposition,
  extractSegments,
  measureComposition,
} from './providers/anthropic.ts';
export type { AnthropicLike, WrapOptions } from './providers/anthropic.ts';

export { createOllamaClient, toOllamaRequest, fromOllamaResponse } from './providers/ollama.ts';
export type { OllamaClientOptions, OllamaChatRequest, OllamaChatResponse } from './providers/ollama.ts';

export {
  createOpenAiClient,
  tokensFromOpenAiUsage,
  OPENAI_MIN_CACHEABLE_TOKENS,
} from './providers/openai.ts';
export type { OpenAiClientOptions, OpenAiUsage } from './providers/openai.ts';

export { toOpenAiCompatRequest, fromOpenAiCompatResponse } from './providers/openai-compat.ts';
export type { OpenAiCompatRequest, OpenAiCompatResponse } from './providers/openai-compat.ts';

export {
  createGeminiClient,
  toGeminiRequest,
  fromGeminiResponse,
  tokensFromGeminiUsage,
} from './providers/gemini.ts';
export type {
  GeminiClientOptions,
  GeminiRequest,
  GeminiResponse,
  GeminiUsageMetadata,
} from './providers/gemini.ts';

export {
  costBreakdown,
  aggregateCostBreakdown,
  formatCostBreakdown,
  formatAggregateCostBreakdown,
  formatCostTrend,
} from './analysis/cost-breakdown.ts';
export type {
  RunCostBreakdown,
  AggregateCostBreakdown,
  SegmentCost,
  AggregateSegmentCost,
  Precision,
  PricingMode,
  AggregatePricingMode,
  CostBreakdownOptions,
  AttributedCall,
} from './analysis/cost-breakdown.ts';

export {
  detectWaste,
  aggregateWaste,
  formatWasteReport,
  formatAggregateWasteReport,
} from './analysis/waste-detection.ts';
export type {
  RunWasteReport,
  AggregateWasteReport,
  WasteFinding,
  StaticContentWasteFinding,
  AggregateWasteFinding,
} from './analysis/waste-detection.ts';

export { diffVersions, formatVersionDiff } from './analysis/version-diff.ts';
export type { VersionDiffResult, SegmentDelta, ToolCallFrequencyDelta } from './analysis/version-diff.ts';

export { Storage } from './storage.ts';
export type { ListRunsOptions } from './storage.ts';
export { WriteQueue } from './queue.ts';
export type { QueueOptions } from './queue.ts';

export { estimateCost, rateFor, effectiveRate, isPricingKnown, PRICING } from './pricing.ts';
export type { ModelRate } from './pricing.ts';

export {
  emptyTokens,
  emptyComposition,
  emptySegmentSizes,
  addTokens,
  sumSegments,
  compositionWeights,
  SEGMENT_ORDER,
  SEGMENT_LABELS,
} from './types.ts';
export type {
  RunNode,
  NodeType,
  NodeStatus,
  TokenBreakdown,
  InputComposition,
  InputSegment,
  SegmentSizes,
  WriteOp,
} from './types.ts';
