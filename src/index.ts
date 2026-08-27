/**
 * fyren — public surface.
 *
 * Data collection, plus all three analyses: cost breakdown, waste detection
 * (all three patterns), and version diff. Four provider adapters, all
 * translating into the same `AnthropicLike` shape so nothing downstream has
 * to know which one produced a call.
 *
 * The local web UI is NOT re-exported here — it is reachable as the
 * `fyren-ai/web` subpath. Keeping it out means importing this library never
 * pulls `node:http` into a consumer's bundle for a server they did not ask
 * for.
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
  fyrenMiddleware,
  tokensFromAiSdkUsage,
  analyzeAiSdkComposition,
  extractAiSdkSegments,
  conventionFor,
} from './providers/ai-sdk.ts';
export type {
  FyrenMiddleware,
  AiSdkMiddlewareOptions,
  AiSdkCallOptions,
  AiSdkModelLike,
  AiSdkNestedUsage,
  AiSdkFlatUsage,
  CachedTokenConvention,
  UsageMappingOptions,
} from './providers/ai-sdk.ts';

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
  // All three members of the WasteFinding union, so a consumer narrowing on
  // `finding.type` can name the branch they narrowed to.
  StaticContentWasteFinding,
  OrphanedToolCallFinding,
  RetriedCallFinding,
  AggregateWasteFinding,
} from './analysis/waste-detection.ts';

export { diffVersions, formatVersionDiff } from './analysis/version-diff.ts';
export type { VersionDiffResult, SegmentDelta, ToolCallFrequencyDelta } from './analysis/version-diff.ts';

export { Storage } from './storage.ts';
export type { ListRunsOptions, RunNameSummary } from './storage.ts';
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
