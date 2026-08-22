# fyren

*Pronounced "FY-ren" — rhymes with "siren".*

A **profiler** for developers building with LLMs and agents — not another log dashboard.

> The npm package name is [`fyren-ai`](https://www.npmjs.com/package/fyren-ai) — `fyren` itself was blocked by npm's anti-typosquatting check (too similar to an existing unrelated package, `hygen`), and `fyren-ai` was the fastest clean alternative. The product, the CLI command, and everything else is still called `fyren`.

## The problem

If you're building an agent, you can see your total token usage — the provider's dashboard tells you that much. What it doesn't tell you is *why*: how much of every request is your system prompt versus the user's actual question, whether your tool definitions are quietly costing you on every single call whether or not the tool ever fires, or whether you forgot to enable prompt caching on content that never changes. Existing observability tools (Langfuse, Helicone, and similar) log requests and responses — useful, but they stop at "here's what happened." fyren exists to answer "where did the tokens go, and which of them didn't need to be spent."

It runs entirely on your machine: no account, no server, no data leaving your computer unless you point it at a hosted model yourself.

## What it actually shows you

Real output, from a small local agent answering a documentation question (full walkthrough in [Real agents](#real-agents)):

```
input breakdown (ESTIMATED from character counts):
  segment               share    tokens
  tool definitions      33.5%    418
  system prompt         60.2%    751
  conversation history  4.6%     57
  latest message        1.7%     21     ← this is the user's actual question
```

93.7% of every request is fixed overhead resent unchanged on every call; the user's real question is 1.7%. fyren's second analysis, [Waste Detection](#analysis-2--waste-detection), turns that into a concrete number: if this run had been on a provider that supports prompt caching and the system prompt weren't being resent uncached, that's real, avoidable dollars — shown as such, never guessed at.

## Quick start

```bash
# the npm name is reserved (fyren-ai@0.0.1) but the real package isn't published
# yet — clone this repo locally, then:
npm install

npm run example        # records a fake agent run and reads it back — no network, no cost
npm run example:cost   # the cost breakdown, on that same mock run
npm run check          # typecheck + 181 tests

npm run example:ollama                              # the real thing — free, local, no key needed
ANTHROPIC_API_KEY=sk-ant-... npm run example:real    # the real thing — hosted, a few cents

node bin/fyren.ts             # terminal summary: recent runs, cost trend, cost breakdown
node bin/fyren.ts --ui        # same content, in a browser — starts a local server, opens it for you
node bin/fyren.ts --help      # --db / --limit / --name / --ui / --port / --no-open
```

Full explanation of the two real (non-mock) runs in [Real agents](#real-agents).

---

## Status

| Step | State |
|---|---|
| 1 — data collection | done |
| 2 — analysis #1, cost breakdown (+ hypothetical pricing) | done |
| 3 — analysis #2, waste detection — all 3 patterns | done |
| Providers: Anthropic, OpenAI, Gemini, Ollama | done |
| Analysis #3 (version diff) | done |
| CLI (`bin/fyren.ts`) | done |
| Web UI (`fyren --ui`) | done |

| Piece | File |
|---|---|
| Data model (the run **tree**) | `src/types.ts` |
| SQLite storage (+ schema migration) | `src/storage.ts` |
| Non-blocking write buffer | `src/queue.ts` |
| Tree bookkeeping + public API | `src/profiler.ts` |
| SQLite loader (unflagged-warning handling) | `src/sqlite.ts` |
| Anthropic wrapper (+ precise mode) | `src/providers/anthropic.ts` |
| **OpenAI wrapper** | `src/providers/openai.ts` |
| **Gemini wrapper** | `src/providers/gemini.ts` |
| Ollama wrapper | `src/providers/ollama.ts` |
| Shared OpenAI-compatible translation | `src/providers/openai-compat.ts` |
| Pricing table / cost estimate (per-model cache multipliers) | `src/pricing.ts` |
| **Cost breakdown** (+ `priceAs` hypothetical pricing) | `src/analysis/cost-breakdown.ts` |
| **Waste detection** | `src/analysis/waste-detection.ts` |
| **Version diff** | `src/analysis/version-diff.ts` |
| Real doc Q&A agent (provider-agnostic) | `examples/doc-qa-agent.ts` |
| Driver — real Anthropic API | `examples/run-real-agent.ts` |
| Driver — real local Ollama | `examples/run-ollama-agent.ts` |
| **CLI** (runs table, cost trend, cost breakdown) | `bin/fyren.ts` |
| **Web UI** server (zero-dependency `node:http`) | `web/server.ts` |
| Web UI static frontend (vanilla HTML/CSS/JS, no build step) | `web/public/` |
| Cross-platform browser auto-open | `web/open-browser.ts` |

## Requirements

Node **>= 22.18**. No runtime dependencies for the core library — `@anthropic-ai/sdk` is a devDependency used only by `examples/run-real-agent.ts`, never imported from `src/`.

Two floors, and the higher one wins:

- `node:sqlite` is unflagged from **22.13**
- native TypeScript execution (type stripping) is unflagged from **22.18**

Since fyren ships TypeScript source with no build step, 22.18 is the real floor. Verified by running the suite on both: 22.13 discovers 0 test files, 22.18 runs all 181.

**About the SQLite experimental warning.** `node:sqlite` is Stability 1.1 ("active development") on Node 22 and 1.2 ("release candidate") on Node 24.15+. On Node 22 it prints, once:

```
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

A profiler has no business printing that into somebody else's agent logs, and `--no-warnings` is too blunt — it would hide the user's own warnings too. So `src/sqlite.ts` swaps `process.emitWarning` for exactly the duration of the module load, drops that one message, and restores the original. Node 24 never emits it in the first place. Set `FYREN_NODE_WARNINGS=1` to see it.

## Usage

```ts
import { createProfiler, wrapAnthropic, formatCostBreakdown } from 'fyren-ai'; // npm package name — see note above
import Anthropic from '@anthropic-ai/sdk';

const profiler = createProfiler({ dbPath: '.fyren/runs.db' });
const anthropic = new Anthropic();

const runId = await profiler.run('my-agent', async (run) => {
  await run.step('plan', async (step) => {
    const client = wrapAnthropic(anthropic, step);
    await client.messages.create({ model: 'claude-opus-5', max_tokens: 1024, messages });
  });

  const tool = run.startToolCall('search', { metadata: { query } });
  // ... run the tool ...
  tool.end();

  return run.rootId;
});

console.log(formatCostBreakdown(profiler.costBreakdown(runId)));
profiler.close();
```

`wrapAnthropic` returns a Proxy, so every SDK method you do not touch keeps working. `messages.create` and `messages.stream` are instrumented.

## Providers

Four today, all going through the same instrumentation (`wrapAnthropic` — see [Design notes](#design-notes) for why one function covers all of them):

| | Anthropic | OpenAI | Gemini | Ollama |
|---|---|---|---|---|
| File | `providers/anthropic.ts` | `providers/openai.ts` | `providers/gemini.ts` | `providers/ollama.ts` |
| Transport | SDK client you bring | HTTP, `/v1/chat/completions` | HTTP, `:generateContent` | HTTP, `/v1/chat/completions` |
| Cost | metered | metered | metered | $0 — runs on your machine |
| Prompt caching | opt-in `cache_control` breakpoints | automatic, ≥1,024 tok | implicit, ≥2–4k tok | none — see below |
| Cached tokens are… | **additive** to input | a **subset** of input | a **subset** of input | n/a |
| Cache write billed? | 1.25× | 1.25× on GPT-5.6+, else free | free (storage-billed) | n/a |
| Precise measurement | `messages.count_tokens` | no endpoint for this format | `:countTokens` | none |

```ts
import { wrapAnthropic, createOpenAiClient, createGeminiClient, createOllamaClient } from 'fyren-ai';

const openai = createOpenAiClient({ apiKey: process.env.OPENAI_API_KEY! });
const gemini = createGeminiClient({ apiKey: process.env.GEMINI_API_KEY! });
const ollama = createOllamaClient({ baseUrl: 'http://localhost:11434' });

wrapAnthropic(openai, step, { provider: 'openai' });
wrapAnthropic(gemini, step, { provider: 'gemini' });
wrapAnthropic(ollama, step, { provider: 'ollama', cacheSupported: false });
```

Every client translates in both directions, so your agent code always talks `AnthropicCreateParams` in / `AnthropicMessageLike` out and never learns which provider it's on. OpenAI and Ollama share their translation (`providers/openai-compat.ts`) because they genuinely speak the same wire format; Gemini's is written from scratch because it isn't remotely compatible — `contents[]` with role `"model"`, top-level `systemInstruction`, `functionCall.args` as a real object rather than a JSON string, and tool results keyed by name with no call-id concept.

**The one thing that is deliberately *not* shared is the usage mapping**, and it's the highest-risk code in the provider layer. Anthropic reports cached tokens as *separate additive* fields; OpenAI and Gemini report them as a *subset already inside* the prompt count. Treating the latter additively double-counts every cached token — inflating both tokens and cost, in a way that looks perfectly plausible on inspection. Each provider does its own arithmetic, each clamps at zero, and each is tested with an explicit "the parts still sum to what the provider billed" assertion.

### Verified against a real cache hit

The cache path isn't just fixture-tested. A live `gemini-3.7-flash` run sent the same large system prompt three times:

```
call 1:  promptTokenCount 8652, cachedContentTokenCount 0      → input=8652  cacheRead=0
call 2:  promptTokenCount 8653, cachedContentTokenCount 4076   → input=4577  cacheRead=4076
call 3:  promptTokenCount 8651, cachedContentTokenCount 0      → input=8651  cacheRead=0
```

The subtraction is right (8653 − 4076 = 4577), and the prefix-fill attribution put the cached tokens where they belong — at the *front* of the prompt (`system` 4,038 + `toolDefs` 38), not smeared across every segment. Those exact numbers are pinned in `test/gemini.test.ts`.

Two real findings came out of that run, both now documented in code:
- **Implicit caching is best-effort.** Calls 1 and 3 got nothing despite identical prompts. A cache miss is not a bug.
- **The documented minimum threshold is real.** An earlier attempt at ~3,582 prompt tokens got zero cache hits on *every* call — `gemini-3.7-flash` needs ≥4,096 before implicit caching engages at all. On OpenAI the equivalent floor is 1,024 (`OPENAI_MIN_CACHEABLE_TOKENS`), which matters for reading a waste report: uncached content below the floor is not a missing-breakpoint bug the way it would be on Anthropic.

### `cacheSupported` — "not applicable" is a different finding than "zero"

Ollama has no prompt cache. Reporting `cacheRead: 0, cacheWrite: 0` for every call would look *exactly* like "this provider supports caching and every call missed" — which is a real, actionable finding for Anthropic and a nonsense one for Ollama. So every node carries `cacheSupported: boolean` (default `true`), and Cost Breakdown reports `cacheSupport: 'yes' | 'no' | 'mixed'` per run and in aggregate. When it's `'no'`, `formatCostBreakdown` doesn't just zero the fresh/cache-rd/cache-wr columns — it **drops them from the table** and prints an explicit note instead:

```
cache: not applicable — every call's provider has no prompt-caching concept (2 call(s)). The tokens above are the full cost, not a cache miss.
```

A `'mixed'` run (one step called Anthropic, another called a local model) keeps the columns — some calls' numbers still mean something — with a note pointing at which calls don't apply.

## Analysis #1 — cost breakdown

Of everything a run sent to the model, what share was the system prompt, the tool definitions, the conversation history, the tool results, and the actual new message — in tokens, in percent, and in dollars.

```
run "research-agent"  ok  124ms  def11a35-…
  4 llm calls  ·  input 3,722 tok  ·  output 171 tok  ·  total $0.014253
  input breakdown (ESTIMATED from character counts):
    segment               share    tokens     fresh     cache rd  cache wr  cost
    tool definitions      3.3%     125        0         66        59        $0.000401
    system prompt         18.1%    674        66        300       307       $0.002323
    conversation history  1.5%     58         58        0         0         $0.000288
    tool results          39.7%    1,477      1,477     0         0         $0.007383
    latest message        37.3%    1,389      1,389     0         0         $0.001463
```

Across runs:

```ts
profiler.aggregateCostBreakdown({ name: 'research-agent', limit: 20 });
```

```
last 20 runs of "research-agent"  ·  80 llm calls
    segment               avg/run   pooled    tokens      cost
    tool results          39.8%     39.8%     8,878       $0.044389
    latest message        37.3%     37.3%     8,338       $0.008777
    system prompt         17.9%     17.9%     4,002       $0.005320
```

Two share numbers, because they answer different questions. **avg/run** counts every run equally — that is the number behind *"on average 62% of input went to the system prompt"*. **pooled** is the share of all tokens, so long runs count more — that is the number that matches the invoice. They diverge when run sizes vary, and hiding either one would be misleading.

### Hypothetical pricing (`priceAs`) — for when the real cost is $0

A run on a provider with no real price (a local Ollama model, an unreleased model) reports every dollar figure as `$0.000000`. That's correct — and it makes the report emotionally inert: percentages alone don't land the way a dollar figure does. Real example, an Ollama run where 85% of input is fixed system-prompt-plus-tool-defs overhead and only 1.4% is the user's actual question — genuinely striking, but every cost column reads `$0.00`:

```ts
profiler.costBreakdown(runId, { priceAs: 'claude-haiku-4-5' });
```

```
run "docs-qa-agent-ollama"  ok  8465ms  9ef596ec-…
  ⚠⚠ HYPOTHETICAL COST — priced as claude-haiku-4-5, NOT real spend ⚠⚠
  2 llm calls  ·  input 1,246 tok  ·  output 73 tok  ·  total $0.001611 (HYPOTHETICAL, priced as claude-haiku-4-5)
  input breakdown (ESTIMATED from character counts):
    segment               share    tokens     cost
    tool definitions      33.5%    418        $0.000418
    system prompt         60.2%    751        $0.000751
    conversation history  4.6%     57         $0.000057
    latest message        1.7%     21         $0.000021
```

Every call's REAL recorded token counts (input, output, and real cache read/write, still discounted at the usual multipliers) get priced under `priceAs`'s rate instead of the call's own model. Two real uses: giving a free/local run a comparable dollar figure (above), and a genuine "what would this run have cost on `claude-sonnet-5` instead of `claude-opus-5`" comparison — just point `priceAs` at the other model.

**This can never be mistaken for real spend.** `pricingMode`/`pricedAsModel` on the result say which mode produced the numbers, and the banner above appears in two places at once — a dedicated `⚠⚠ HYPOTHETICAL COST` line, and inline on the total itself (`$0.001611 (HYPOTHETICAL, priced as claude-haiku-4-5)`) — so scrolling past one still leaves the other. If `priceAs` itself has no entry in the pricing table, every call reads `$0` again, but the note says exactly why (`"priceAs" model "X" has no price on file`) instead of leaving an unexplained zero. Works the same way through `aggregateCostBreakdown`, with one more check: mixing runs priced under different bases (some actual, some hypothetical, or hypothetical under different models) reports `pricingMode: 'mixed'` and prints a loud `MIXED PRICING BASES` warning instead of silently summing incompatible dollar figures.

### Cache is not smeared

A naive breakdown multiplies each segment's share by one price. That is wrong: the same token costs three different amounts depending on how it was billed — fresh input (1×), cache write (1.25×), cache read (0.1×).

fyren does better, because the prompt cache is a **prefix** match and the render order is known (`tools` → `system` → `messages`). Cached tokens are allocated from the front of that order. If a run cached 3,000 tokens and tool definitions plus system prompt come to 2,800, those two are almost entirely cache hits while the history pays full price — which is exactly what a developer needs to see. `history` and `toolResults` are interleaved inside `messages[]` and cannot be ordered against each other, so within that zone the cache is split proportionally.

Two invariants are tested: segment shares sum to 100%, and segment costs sum to the run's real input cost.

**Where that trust breaks down.** The prefix-fill algorithm is arithmetic, not verification — given any (composition, cacheRead, cacheWrite) it produces *some* split, even if the assumed render order doesn't hold for that particular call (an unusual `cache_control` placement, a retried request, a future provider change). It never fails outright, so a wrong number would otherwise look identical to a right one.

One cheap, real sentinel exists: the prompt's **last** segment (`latest message`) should never legitimately be a cache hit — that would require the exact same newest message to have been sent before. If the fill algorithm has to reach that far to place all the cached tokens, `cacheBoundaryUncertain` is set on the breakdown (and `uncertainCacheCallCount` says how many calls triggered it). The numbers are still shown — this isn't a silent failure — but `formatCostBreakdown` prints an explicit `⚠` warning, and the aggregate view reports how many runs were flagged. Four tests cover this: a clean prefix stays unflagged, an all-in-`latest` cache is flagged, one uncertain call doesn't contaminate the invariants (shares still sum to 1) or other calls in the same run, and the printed warning appears only when warranted.

### Estimated vs measured

By default, segment weights come from **character counts** — no extra API calls, no added latency.

But the characters-per-token ratio is not constant: raw JSON tool output tokenizes far less efficiently than fluent prose, so a character-proportional split systematically under-weights tool results. Since the whole product rests on this number, there is an opt-in:

```ts
wrapAnthropic(anthropic, step, { precise: true });
```

- measures each segment with `messages.count_tokens` instead of estimating
- `system` and `toolDefs` are measured **exactly** (sent through the fields they really occupy, baseline subtracted); the three message segments are interleaved and so are measured as standalone text — very close, but a proxy
- costs up to 5 extra count_tokens requests per call, plus one baseline per model per process. That endpoint is [free of token charges](https://platform.claude.com/docs/en/build-with-claude/token-counting) but has its own rate limit
- **costs you no latency**: counting runs *after* your response has been handed back, and the node is updated later
- off by default; not available at all for a provider with no counting endpoint (Ollama) — `wrapAnthropic` detects the missing method and silently keeps the character estimate rather than erroring

Every output labels which one produced the numbers — `measured via count_tokens`, `ESTIMATED from character counts`, or `MIXED`. An estimate is never presented as a measurement.

**If `count_tokens` fails or rate-limits mid-call**, the update to that node is dropped as one unit — the node keeps whatever it already had (the character estimate written when the call finished), never a half-measured mix of two sources for the same node. `onPreciseError` is called so you can log it; nothing throws into your code, and the run's precision degrades honestly to `estimated` or `mixed` rather than silently keeping stale-looking `measured` data. Tested by simulating a `count_tokens` call that succeeds twice, then rate-limits.

### Where the segment boundary comes from

`latest` vs `toolResults` is a fixed function of two facts about each content block, never of its text — so there's no heuristic to get wrong:

- is this block inside the **last** message of `messages[]`? → `latest`, else `history`
- is this block a `tool_result`? → `toolResults`, always, regardless of position

`tool_result` is checked independently of the position rule, so a last message that mixes a tool result with plain text (a result plus a comment in the same turn) splits correctly — the result half goes to `toolResults`, the text half to `latest`.

## Analysis #2 — waste detection

Per PROJECT_CONTEXT.md §4c, three patterns are planned. All three are done:

1. **Uncached static content** — done (below)
2. **Tool output that was never used** — done (below)
3. **Retries and their cost** — done (below)

### Pattern #1 — uncached static content

`system` and tool definitions are the two segments an agent almost never changes mid-session — by construction they're meant to be identical call after call. If a run sends the SAME system prompt (or the same tool defs) on call 2, 3, 4… and none of those later calls shows a cache read for it, every one of those resends is paying full price for something a `cache_control` breakpoint would have made ~90% cheaper.

```ts
profiler.wasteReport(runId);
```

Real output, from the Ollama example (both of its own waste patterns — a long uncached `SYSTEM_PROMPT` and constant `TOOLS` defs — are exactly what this was built to catch), priced hypothetically since the real cost is $0:

```
run "docs-qa-agent-ollama"  2 llm calls  e80e589c-…
  ⚠⚠ HYPOTHETICAL COST — priced as claude-haiku-4-5, NOT real spend ⚠⚠
  ⚠ uncached static content — "tool definitions" (209 tok) was resent 1 time(s) after the first send; 1 of those still billed some of it as fresh input rather than a cache read. 209 avoidable tokens, $0.000188 (hypothetical).
  ⚠ uncached static content — "system prompt" (376 tok) was resent 1 time(s) after the first send; 1 of those still billed some of it as fresh input rather than a cache read. 376 avoidable tokens, $0.000338 (hypothetical).
  note: this provider has no caching concept at all — these figures show the POTENTIAL savings on a caching-capable provider, not a fixable bug in your code as written.
  total avoidable: $0.000526  (HYPOTHETICAL, priced as claude-haiku-4-5)
```

On Ollama that's structural — no caching lever exists on that provider at all — but the same finding on Anthropic would mean exactly one missing `cache_control` breakpoint away from that $0.000526 disappearing for real. `aggregateWasteReport` rolls this up across runs the same way `aggregateCostBreakdown` does, ranked by dollar impact.

**How "the same content" is detected without ever storing prompt text.** fyren only ever stores segment SIZES (`InputComposition`), never the actual text — so identity is inferred: the first call with a segment non-empty sets a baseline size; a later call whose size matches exactly counts as a recurrence, and a size mismatch resets the baseline rather than being flagged (a legitimately-edited prompt mid-session must not read as "waste"). Two real limitations follow from this, both accepted rather than solved by storing raw text: content that changes size while remaining wasteful in some other way would be missed, and (much rarer) a genuine edit that happens to land on the exact same character count would be misread as unchanged.

Reuses `attributeCall` (exported from `cost-breakdown.ts` for this) for the per-call fresh/cache split, so the prefix-fill cache logic has exactly one definition across both analyses — and the same `priceAs` option, with the same `HYPOTHETICAL` labeling discipline.

### Pattern #2 — orphaned tool calls

"Tool output that was never used" can't mean "the model ignored the content" — fyren never stores tool result *text* (same reason as above: only sizes), so there's no content to check semantic use against. What *is* fully detectable from the tree alone: a `tool_call` whose result was fetched but the run **finished** without any `llm_call` anywhere afterward ever running again. The tool got its answer; nothing ever read it.

Real cause this catches: hitting a tool-loop iteration cap while the model still wanted to call more tools — `examples/doc-qa-agent.ts`'s `MAX_TOOL_ITERATIONS` is exactly this shape, left in on purpose. Also catches an early-exit or crash path that drops the accumulated result.

This fired on real data without me trying to force it — one of the three live Ollama sessions in the README's own example run:

```
⚠ "get_related_topics" orphaned in 1 of 3 run(s), 1 occurrence(s) total.
```

The small local model called `get_related_topics`, and that session ended before any later model call ever saw the result.

**Cost is not the parent call's tokens** — deciding to call the tool was legitimate work. It's any LLM cost the tool *itself* incurred: a nested `llm_call` under the `tool_call`, for a tool that summarizes its own output (see the search tool in `examples/doc-qa-agent.ts`). A pure-function tool with no nested cost is still flagged — the finding is about wasted *work*, not only wasted dollars — just at `$0`.

The check runs across the **whole run**, not just the tool call's immediate step: an agent might legitimately end a step right after a tool call and use the result in the next one. Only "nothing, anywhere in the rest of the run, ever called the model again" is unambiguous enough to flag.

### Pattern #3 — retried calls

Same content-blindness as pattern #2, so the same fix: fyren can't tell whether two same-named calls carried the same request, so "the caller asked twice" isn't a signal by itself — calling `search` twice with two different queries is normal multi-step tool use, not a retry. The one signal that *is* reliable without content: an explicit `status: 'error'`, reported by the caller. A retry is an `llm_call` or `tool_call` that ended in error, followed by a later call of the SAME type and name under the SAME parent — the later call's mere existence proves the failed one's cost was thrown away and redone.

```ts
profiler.wasteReport(runId);
```

Verified against a real transient failure: pointed a wrapped Ollama client at an unreachable port for one call (a genuine connection error), then retried the same model against the real local server and got a real response:

```
run "retry-verification"  2 llm calls  f49385f9-…
  ⚠ retried model call — "qwen2.5:7b" failed 1 time(s) and was superseded by a later attempt under the same step (status: error, followed by another same-name call).
  note: this provider has no caching concept at all — these figures show the POTENTIAL savings on a caching-capable provider, not a fixable bug in your code as written.
  total avoidable: $0.000000
```

`$0.000000` here because Ollama is free and nothing was billed before the connection failed — on a hosted provider, or a failure after partial output, `avoidableCostUsd` would be nonzero. Unlike patterns #1/#2, the wasted cost is the **full** cost of every flagged failed attempt (its own tokens, plus any nested `llm_call` cost) — nothing about a failed attempt produced anything usable, so none of its cost is legitimate spend. A failed call with no later same-name successor is never flagged: the caller just gave up, and nothing was duplicated.

### Two units, on purpose: characters decide, tokens get reported

This one is easy to misread as a bug, so it gets its own heading. `detectStaticContentForSegment` uses **two different units for two different jobs**, in the same function, on the same segment:

- **Characters** (`compositionWeights(composition)`, which is `chars` unless precise mode is on) decide whether a later call is "the same content as before". This is the *matching* job.
- **Tokens** (`attributeCall(call, …).tokens[segment]`, the properly-scaled per-call estimate `costBreakdown` also uses) are what gets *reported and priced* — `baselineTokens`, `wastedTokens`, `avoidableCostUsd` are all real token figures.

Why not just one unit everywhere: a call's token estimate for a segment is that segment's **proportional share** of the call's real total (`weights[segment] / weightSum * totalInputTokens`). As a conversation's `history` grows call over call, a genuinely-static `system` segment's share of the growing total *shrinks* — same content, bigger denominator — so its token estimate silently drifts down even though nothing about the system prompt itself changed. Comparing on that drifting number would make the matcher stop recognizing an unchanged system prompt after a few turns of conversation. Character size doesn't have this problem: it only moves when the segment's own content actually changes, regardless of what grows around it — so that's the signal matching is built on. The token figure shown to the user still comes from the correctly-scaled per-call estimate; it's just not what decides *whether two occurrences match*.

**This shipped wrong once**, in the first version of this file: `baselineTokens` was assigned straight from the character count instead of running it through `attributeCall` — reporting a number ~4x too large, in the wrong unit, inconsistent with `wastedTokens` (which was always correctly token-scaled). `test/waste-detection.test.ts` has a dedicated regression test — a static `system` segment alongside artificially-grown `history`, with hand-computed expected numbers — that fails immediately if this regresses. See [DECISIONS.md](./DECISIONS.md) for the full write-up.

## Design notes

**Everything is a node in a tree.** Each row has `parent_id` and `root_id`. `root_id` is redundant, but it turns "fetch this whole run" into one indexed query instead of a recursive walk. Flat storage would have made this unfixable later, which is why it is decided up front.

**Nodes store only their own tokens.** Run totals are computed by querying the tree, never by mutating parents — so a late child can't leave a stale total behind.

**Nodes are written twice** (start, then end), and a third time if precise counting lands. A process that dies mid-run leaves a visible half-finished tree instead of nothing.

**`thinking` is not added to totals.** Anthropic bills thinking tokens as part of `output_tokens` and does not report them separately, so counting them again would double-count. The field exists for providers that do split it out.

**The five input segments are disjoint and exhaustive.** `toolResults` is carved *out* of the messages, so it does not overlap `history` or `latest`. A breakdown whose parts don't sum to the whole is not a breakdown.

**Waste Detection compares on characters but reports in tokens — deliberately two units, not a bug.** See [Two units, on purpose](#two-units-on-purpose-characters-decide-tokens-get-reported) under Waste Detection — it shipped wrong once (character count reported as if it were a token count) before landing on this split.

**The profiler cannot break your program.** Guarantees, all tested:
- `enqueue()` only pushes to an array; SQLite writes happen later on an unref'd timer, off your await path.
- If a write fails, the batch is dropped and reported through `onError`. It never throws into your code.
- Errors from the wrapped client are recorded on the node and then **re-thrown unchanged** — the test asserts the identical `Error` instance comes back.
- `Storage.close()` (and therefore `Profiler.close()`) is **idempotent** — `node:sqlite` throws `"database is not open"` on a second `close()`, verified empirically, so error-handling code that closes from more than one place (a `finally` *and* a top-level catch) can't turn "handling one failure" into "throwing a second one."

**Shutdown discipline in the examples, not just the library.** A real run of `run-real-agent.ts` hit an Anthropic 401 and the process then crashed with a native libuv assertion on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) instead of exiting cleanly — the script's error handler called `process.exit(1)` without ever calling `profiler.close()`, so the SQLite handle was still open, mid-write, when the process was force-killed. Both example drivers now: run `profiler.close()` in a `finally` so whatever was recorded before a mid-run failure survives to disk, and use `process.exitCode = 1` instead of `process.exit()` so Node drains its own handles rather than being killed out from under them. Verified twice against real failures, not just mocks: a real Anthropic 401 (invalid key) and a real Ollama 404 (model not found) and connection-refused — all exit cleanly, no crash, and the run up to the failure point is still on disk after reopening the file fresh. `test/failure.test.ts` covers the three guarantees this rests on: `close()` survives being called twice, data written before a failure is readable from a brand-new `Storage` instance pointed at the same file, and the failure never becomes an `unhandledRejection`.

**The provider is isolated, and the "Anthropic" name in the instrumentation is structural, not literal.** `wrapAnthropic` only relies on the `AnthropicLike` shape (`messages.create` in, content blocks + usage out) — it takes a `provider` and `cacheSupported` option specifically so a second provider can reuse the exact same node bookkeeping, segmentation, and error handling instead of duplicating ~150 lines. `src/providers/ollama.ts` is the one file that knows Ollama's real wire format exists; it translates into the shared shape and hands the result to `wrapAnthropic` like anything else would.

## Real agents

Two drivers, same underlying agent (`examples/doc-qa-agent.ts` — provider-agnostic, written once against `AnthropicCreateParams`/`AnthropicMessageLike`), same three deliberate waste patterns, same sample docs corpus ([examples/data/sample-docs.md](examples/data/sample-docs.md)):

1. **`SYSTEM_PROMPT` is long and never carries `cache_control`** — full price, every single call, even resent verbatim across turns of the same session. This is exactly [Waste Detection pattern #1](#pattern-1--uncached-static-content), and both drivers print that report now.
2. **`get_related_topics` is a fully-schema'd tool that almost never fires** — defined (and paid for) on every call; its description is written so the model only reaches for it when a user explicitly asks for further reading.
3. **`conversation` is never pruned between turns** — it grows linearly for the length of the session.

### `npm run example:ollama` — free, local, verified end-to-end

```bash
npm run example:ollama
```

No key, no network egress, no cost. Requires a local [Ollama](https://ollama.com) with a tool-capable model pulled — default `qwen2.5:3b` (`ollama pull qwen2.5:3b`), override with `OLLAMA_MODEL=<name>`.

I have Ollama on this machine and ran this for real — not a mock, not a dry run. A genuine finding came out of it worth keeping: **tool-calling reliability scales hard with model size on this agent.** Tested at four sizes, same system prompt throughout:

| Model | Called a tool? |
|---|---|
| `qwen2.5:0.5b` (397 MB) | never — answered every question from general knowledge |
| `qwen2.5:1.5b` | never |
| `qwen2.5:3b` (default) | only the narrowly-triggered `get_related_topics`, never `search_docs` on an ordinary question |
| `qwen2.5:7b` | both — including `search_docs` on a plain factual question, producing a real nonzero `tool_results` segment |

`3b` is the default because it's the smallest size that reliably calls a tool *at all*; `OLLAMA_MODEL=qwen2.5:7b npm run example:ollama` gets you the fuller picture (slower — CPU inference, no GPU here). Real output at the default size:

```
run "docs-qa-agent-ollama"  ok  8465ms  9ef596ec-…
  2 llm calls  ·  input 1,246 tok  ·  output 73 tok  ·  total $0.000000
  input breakdown (ESTIMATED from character counts):
    segment               share    tokens     cost
    tool definitions      33.5%    418        $0.000000
    system prompt         60.2%    751        $0.000000
    conversation history  4.6%     57         $0.000000
    latest message        1.7%     21         $0.000000
  note: 2 call(s) used a model with no price on file
  cache: not applicable — every call's provider has no prompt-caching concept (2 call(s)). The tokens above are the full cost, not a cache miss.
```

The script also prints the same run [priced hypothetically](#hypothetical-pricing-priceas--for-when-the-real-cost-is-0) as `claude-haiku-4-5` (override with `FYREN_PRICE_AS`) — real $0 is technically correct but doesn't land; a labeled hypothetical `$0.001611` does:

```
  ⚠⚠ HYPOTHETICAL COST — priced as claude-haiku-4-5, NOT real spend ⚠⚠
  2 llm calls  ·  input 1,246 tok  ·  output 73 tok  ·  total $0.001611 (HYPOTHETICAL, priced as claude-haiku-4-5)
```

And, right after, the [Waste Detection](#analysis-2--waste-detection) report for the same run — the sample output shown there is from this exact script.

Both real-failure modes verified clean too (see the shutdown note above): a nonexistent model name and a wrong port both exit with a clear bilingual message, exit code 1, no crash, and the data recorded before the failure survives on disk.

### `npm run example:real` — hosted, Claude Haiku 4.5, a few cents

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run example:real
```

`FYREN_PRECISE=0` skips `count_tokens` measurement and uses the character estimate only.

I do not have a funded `ANTHROPIC_API_KEY` in this environment — the one real attempt returned an *insufficient credit* error, which the script now turns into a clear message rather than a crash (that failure is exactly what surfaced the shutdown bug above, and is now a regression test). I have **not** and will not try to obtain Anthropic credentials on my own — creating an account or entering payment details anywhere, even to unblock a demo, is outside what I'll do without you doing it yourself. This script is built, typechecked against the real SDK's types, and its tool-calling loop was dry-run against a mock that emits real `tool_use`/`tool_result`-shaped turns (tree shape, precise mode, aggregation — all clean) — but I have not personally seen its report on genuine Claude output. Run it with your own key and it's yours to compare against the Ollama report above.

## Tests

`npm test` — 181 tests, no network, no API key, run with Node's built-in runner.

| File | Covers |
|---|---|
| `test/tree.test.ts` | parent/root wiring at depth, run isolation, running→ok/error, idempotent `end()`, auto-close on throw, late `setComposition`, name filtering, `enabled:false` |
| `test/failure.test.ts` | original error re-thrown by identity, failed calls still recorded, storage failure swallowed, enqueue is non-blocking, stream rejection, precise-mode failure isolation and atomicity, `close()` survives a second call, data survives a mid-run failure + close on a real file, no `unhandledRejection` leaks |
| `test/composition.test.ts` | disjoint buckets, tool_result carve-out (including mixed tool_result + text in the last message), precise measurement, baseline caching |
| `test/cost-breakdown.test.ts` | shares sum to 1, costs sum to real input cost, prefix cache attribution, interleaved zone, unattributed calls, aggregation, cache-boundary-uncertain detection, `cacheSupport` yes/no/mixed reporting, `priceAs` re-pricing (tokens/shares untouched, real cache multipliers still applied, unknown-model handling), the `HYPOTHETICAL` banner, aggregate `pricingMode` yes/no/mixed, end-to-end through a real `Profiler` |
| `test/pricing.test.ts` | model-id/provider-prefix normalization, unknown models, **per-model cache multipliers (OpenAI's free-write vs 1.25x, GPT-4.1's 0.25x read discount), Gemini's storage-per-hour field, context-length tiers switching rate mid-calculation** |
| `test/ollama.test.ts` | request/response translation pinned against real captured Ollama JSON, the tool_result round trip, HTTP client (stubbed `fetch`, no real network) |
| **`test/openai.test.ts`** | cached tokens subtracted out of `prompt_tokens` (not added), `cache_write_tokens` on GPT-5.6+, Responses-API field aliases, reasoning tokens never inflating output, clamping on inconsistent provider numbers, `prompt_cache_key`, auth/error paths |
| **`test/gemini.test.ts`** | the non-OpenAI-compatible translation (role `"model"`, `systemInstruction`, `functionDeclarations`, object-valued `args`, name-keyed `functionResponse`), synthesized call ids, the `countTokens` wrapper form, **and the real captured cache-hit response from a live `gemini-3.7-flash` call** |
| `test/waste-detection.test.ts` | pattern #1 (single-call runs produce nothing, legitimate size changes don't false-positive, only `system`/`toolDefs` are checked, genuine caching suppresses the finding fully and partially, the character-vs-drifting-token-estimate regression, `cacheSupport: 'no'`); **pattern #2 (a later `llm_call` anywhere in the run un-orphans a tool call, a still-`running` run is never flagged, cross-step usage counts, nested LLM cost on an orphaned call is priced, a pure-function tool is still flagged at $0, grouping by tool name)**; `priceAs` on both patterns, aggregation ranked by dollar impact, end-to-end through a real `Profiler` including a real hit-iteration-cap scenario |

## Next

Waste Detection patterns #1 and #2 are done, both verified against real data. Remaining: pattern #3 (retries and their cost), analysis #3 (Version Diff), and the CLI + local web UI — full scope and acceptance criteria in [PRD.md](./PRD.md), not repeated here.

## More docs

- [PRD.md](./PRD.md) — product scope, requirements, and status, kept current. The source of truth for "what's built and what's planned."
- [DECISIONS.md](./DECISIONS.md) — every non-obvious technical decision, with why.
- [AGENT.md](./AGENT.md) — orientation for AI agents (or anyone) picking up this codebase cold.
- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) — the original planning session (Persian). Historical; PRD.md has superseded it.
