# Decisions

Every non-obvious choice in this codebase, with the reasoning behind it. If you're reading fyren's source and find yourself asking "why is it done this way, not the simpler way" — the answer should be here.

Entries are grouped by area, not by date. Each one names the decision, the alternative it beat, and the reason.

---

## Runtime and language

### `node:sqlite`, not `better-sqlite3`

**Decision:** use Node's built-in SQLite module.

**Why:** the published package has zero native dependencies. `npx fyren` is meant to run instantly for someone trying it for the first time — a native module needing a C++ build (or a prebuilt binary matching their exact platform/Node ABI) is the single biggest source of "it didn't just work" for CLI tools like this one. `better-sqlite3` is faster and more mature, but that trade isn't worth the install friction here.

**Cost of this choice:** `node:sqlite` was Stability 1.1 ("active development") through Node 24.14 and only became a release candidate at 24.15 — an API that could still change. Accepted, because the alternative (a native dependency) is the worse failure mode for this specific tool.

### Node >= 22.18, not >= 22.13

**Decision:** the engines floor is 22.18.

**Why:** two independent features both need to be unflagged, and the higher one wins. `node:sqlite` stopped needing `--experimental-sqlite` at 22.13. But fyren ships TypeScript source with no build step — `node examples/foo.ts` relies on Node's native type-stripping, which wasn't unflagged until 22.18. Verified, not assumed: running the test suite on 22.13 discovers 0 test files (the runtime can't even parse them); on 22.18 all tests run. See `src/sqlite.ts` and the README's Requirements section.

### `process.emitWarning` is swapped, not silenced with `--no-warnings`

**Decision:** `src/sqlite.ts` temporarily replaces `process.emitWarning` for the exact duration of `require('node:sqlite')`, filters out only the one known SQLite experimental-feature warning, then restores the original.

**Why:** on Node 22 (pre-24.15), importing `node:sqlite` unconditionally prints `ExperimentalWarning: SQLite is an experimental feature...` to stderr. A profiler has no business injecting warnings into somebody else's agent logs. But `--no-warnings` (or `NODE_NO_WARNINGS=1`) is too blunt — it would silently eat the *user's own* warnings too, which is a worse failure mode than the one being fixed. A scoped, temporary swap fixes exactly the one message and nothing else. `FYREN_NODE_WARNINGS=1` disables the swap for anyone who wants to see it.

### No runtime dependencies in `src/`

**Decision:** the core library imports nothing beyond Node's own built-ins. `@anthropic-ai/sdk` is a devDependency, used only inside `examples/`, never inside `src/`.

**Why:** the Anthropic wrapper (`src/providers/anthropic.ts`) is typed against a hand-written **structural** interface (`AnthropicLike`), not against the SDK's actual types. This is what makes it possible to (a) develop and test the whole library against a mock with zero network calls or API cost, and (b) support a second provider (Ollama) by writing an adapter that produces the same shape, instead of depending on two different providers' SDK packages. The trade-off: passing a real `Anthropic` client into `wrapAnthropic` needs an explicit `as unknown as AnthropicLike` cast at the call site (see `examples/run-real-agent.ts`), because the real SDK's `messages.create` is a stricter, overloaded type than the loose structural interface. That cast is documented in place as safe (every call site always supplies `max_tokens`), not swept under the rug.

---

## Storage

### The tree, not a flat table

**Decision:** every recorded thing — a run, a step, an LLM call, a tool call — is a node with `parent_id` and `root_id`, in one `nodes` table.

**Why:** an agent run is fundamentally a tree (run → steps → tool/LLM calls → nested calls), and the entire point of this product is analysis that walks that structure (which step's LLM call burned the most tokens, which tool call's output was too big). Flattening at write time and trying to reconstruct structure later is the kind of decision that's cheap to make wrong early and very expensive to fix once there's real data in the table. Decided before writing a single query.

**`root_id` is redundant, on purpose.** It's derivable by walking `parent_id` up to the root, but storing it directly turns "give me this whole run" into one indexed query (`WHERE root_id = ?`) instead of a recursive walk. Denormalization traded for a much simpler, much faster read path — the write cost of one extra column is negligible.

### Nodes store only their own tokens; totals are computed, not accumulated

**Decision:** a node never stores "my subtree's total tokens" — only its own. Run-level and step-level totals are always computed fresh by querying and summing the tree.

**Why:** the alternative — updating a parent's running total every time a child finishes — has a real failure mode: a child that finishes late, or a child added after the parent was thought to be done, silently leaves the parent's cached total stale. Computing from the tree on every read is slightly more work per query, but it is impossible for the number to be wrong in a way that persists.

### Every node is written twice (insert, then finish)

**Decision:** starting a node writes it immediately with `status: 'running'`; ending it updates the same row.

**Why:** if the process crashes mid-run — an unhandled exception, a killed process, the native crash this project actually hit once (see "Shutdown discipline" below) — the tree in SQLite still shows exactly how far execution got, with the last node visibly `running` (never finished) rather than not existing at all. A profiler that only writes on success is useless for debugging the run that failed.

### Schema migrations are hand-rolled with `PRAGMA table_info`, not a migration framework

**Decision:** `Storage`'s constructor checks `PRAGMA table_info(nodes)` for columns added after the initial release (currently: `cache_supported`) and runs a plain `ALTER TABLE ... ADD COLUMN` only if missing.

**Why:** `node:sqlite`'s bundled SQLite version does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (added in SQLite 3.35) — confirmed by trying it, not assumed. For a single additive column, a bundled migration framework would be a large dependency for a small problem; a guarded `ALTER TABLE` is three lines and was verified against a hand-built pre-migration database file to prove old `.db` files open cleanly and default the new column correctly.

---

## Data model

### `thinking` tokens exist as a field but are never added to totals

**Decision:** `TokenBreakdown.thinking` is tracked separately and explicitly excluded from `input + output` roll-ups.

**Why:** Anthropic bills thinking tokens as part of `output_tokens` and does not report them as a separate billable quantity. Adding `thinking` into the total would double-count. The field exists anyway because a future provider that *does* report thinking separately from output shouldn't need a schema change — and because "what share of output was thinking" is a real question worth being able to answer even though it isn't a real *cost* question today.

### Five segments, deliberately disjoint and exhaustive

**Decision:** every character of a request's input is attributed to exactly one of `toolDefs`, `system`, `history`, `toolResults`, `latest` — never zero, never two.

**Why:** a percentage breakdown that doesn't sum to 100% isn't a breakdown, it's a source of doubt. `toolResults` is deliberately carved *out* of `messages[]` rather than left inside `history`/`latest`, specifically so a tool's output and the surrounding conversation never overlap.

**The `latest` vs `toolResults` boundary is a fixed function of two facts, never of block content:** is this block inside the *last* message (→ `latest`, else `history`), and is this block a `tool_result` (→ `toolResults`, unconditionally, regardless of position). The two checks run independently, so a last message that mixes a tool result with plain text splits correctly into both. This was chosen specifically to avoid a heuristic that could quietly stop working on some future content shape — a position-and-type function can't drift the way a "does this look like tool output" guess could.

### Input composition is measured in characters by default, tokens only in `precise` mode

**Decision:** every `llm_call` node records character counts per segment (`InputComposition.chars`) for free, on every call. Real per-segment token counts (`InputComposition.tokens`) are only measured when the caller opts into `precise: true`.

**Why:** getting an exact token count per segment would mean calling `messages.count_tokens` up to 5 extra times per real API call — real added latency and real added request volume on every single call, which conflicts directly with the "must not slow the user's program down" requirement. Characters are a free, always-available proxy. `precise` mode exists for when the proxy isn't good enough (see next entry), and runs *after* the response is already back in the caller's hands, so it costs zero added latency even when it does add network calls.

### Why the character proxy isn't just "close enough" — `precise` mode exists because the ratio isn't constant

**Decision:** ship the character-based estimate as the default, but build a real, opt-in exact-measurement path rather than declaring the estimate good enough.

**Why:** characters-per-token is not a constant. Dense, punctuation-heavy JSON (raw tool output) tokenizes far less efficiently than fluent English prose, so a character-proportional split systematically **under-weights** tool results relative to prose segments like the system prompt. Since the entire product's value proposition rests on this one number ("what % of your tokens went where"), shipping only the biased estimate would have undermined the thing being sold. `precise: true` measures `system` and `toolDefs` *exactly* (sent through the real fields they occupy, baseline-subtracted); the three message segments (interleaved inside `messages[]`, not independently addressable via the API) are measured as standalone text — very close, but a proxy of a different kind, documented as such.

**If `count_tokens` fails or rate-limits mid-call, the update is dropped as one atomic unit.** The node keeps whichever estimate it already had — never a node that's `count_tokens`-measured for one segment and character-estimated for another. `onPreciseError` is called so the failure is observable; nothing throws into the caller's code; the run's reported precision degrades honestly (`estimated` or `mixed`), never silently keeps a stale `measured` label.

### Cache is attributed by prefix order, not smeared evenly across segments

**Decision:** when a call reports `cache_read`/`cache_write` tokens, those tokens are allocated to segments in Anthropic's known render order (`tools` → `system` → `messages`) — front of the prefix first — not spread proportionally across every segment.

**Why:** the prompt cache is fundamentally a prefix match, and a naive "smear the discount evenly" model would misreport which part of a request is actually benefiting from caching. If a run cached 3,000 tokens and `toolDefs + system` total 2,800, those two are (almost) entirely cache hits and everything after pays full price — exactly the finding a developer needs to see, and exactly what an even smear would hide. `history` and `toolResults` are interleaved inside `messages[]` and can't be ordered against each other, so within that one zone the cache is split proportionally — the one place a proxy is used instead of a hard rule, and it's documented as such.

**The `cacheBoundaryUncertain` sentinel exists because this algorithm can't fail loudly on its own.** Given any `(composition, cacheRead, cacheWrite)`, the prefix-fill arithmetic always produces *some* split — it has no way to detect that its own render-order assumption didn't hold for a particular call (an unusual `cache_control` placement, a retried request, a future provider change). One cheap, real check exists: the prompt's *last* segment should never legitimately be a cache hit (that would require the exact same newest message to have been sent before). If the fill has to reach that far, the run is flagged `cacheBoundaryUncertain` — numbers still shown, not hidden, but flagged as resting on an assumption that didn't hold.

### `cacheSupported: false` is a different claim than "cache read/write = 0"

**Decision:** every node carries a `cacheSupported: boolean` (default `true`), independent of the actual cache token counts.

**Why:** Ollama (and most local runtimes) has no prompt-caching concept whatsoever. Reporting `cacheRead: 0, cacheWrite: 0` for such a call would be indistinguishable, in the output, from "this provider supports caching and this particular call happened to miss" — a real, actionable finding for Anthropic and a nonsense one for Ollama. Cost Breakdown reports `cacheSupport: 'yes' | 'no' | 'mixed'` per run, and `formatCostBreakdown` doesn't just zero the cache columns when it's `'no'` — it **drops them from the table entirely** and prints an explicit note, so a reader can't mistake "not applicable" for "tried and failed."

### Waste Detection compares recurrence on *characters*, reports the finding in *tokens*

**Decision:** `detectStaticContentForSegment` decides "is this call's system prompt the same as before" using the raw character-weight (`compositionWeights`), but reports `baselineTokens`/`wastedTokens`/`avoidableCostUsd` using the properly-scaled per-call token estimate (`attributeCall(...).tokens[segment]`) — two different units for two different jobs, in the same function.

**Why:** a call's token estimate for a segment is that segment's *proportional share* of the call's real token total. As a conversation's `history` grows call over call, a genuinely-static `system` segment's share of the growing total shrinks — same content, bigger denominator — so its token estimate silently drifts down even though the system prompt itself never changed. Comparing on that drifting number would make the detector stop recognizing an unchanged system prompt after a few turns of real conversation. Character size doesn't have this problem — it only moves when the segment's own content actually changes.

**This shipped wrong once, in the first version of the file.** `baselineTokens` was assigned directly from the character count instead of being run through `attributeCall`, which reported a number roughly 4x too large, mislabeled as tokens, inconsistent with `wastedTokens` (which was always correctly scaled). Caught by comparing real output against hand-checked expected numbers, not by code review alone. `test/waste-detection.test.ts` now has a dedicated regression test — a static `system` segment next to artificially-grown `history`, with hand-computed expected values — that fails immediately if the units get conflated again. See the README's "Two units, on purpose" section for the developer-facing version of this explanation.

### Pattern #2 ("unused tool output") is redefined as a structural check, not a semantic one

**Decision:** rather than trying to detect "the model didn't use this tool's result" (which would need to understand the CONTENT of the result — something fyren deliberately never stores, see the entry above), the check is: a `tool_call` in a FINISHED run such that no `llm_call` anywhere later in the run ever started. The tool's output was fetched; nothing afterward ever had the chance to read it.

**Why this definition and not a narrower one:** the check runs across the *whole run*, not just the tool call's immediate step. An agent can legitimately end a step right after a tool call and pick up the result in the next step — scoping the check to "the same step" would have false-positived on that entirely normal pattern. "Nothing, anywhere in the rest of the run, ever called the model again" is the narrowest claim that's still unambiguous.

**Why a `running` run is never flagged:** a run still in progress simply hasn't reached its next model call yet. Checking status first, before looking at ordering, is what keeps an in-flight run from reading as a false positive.

**What gets priced, and why it usually won't be much:** not the parent `llm_call`'s tokens — deciding to call the tool was legitimate work, already counted in Cost Breakdown. Only LLM cost the tool call incurred *on its own*, via a nested `llm_call` (a tool that summarizes its own output before returning, as in `examples/doc-qa-agent.ts`'s search tool). A pure-function tool with no nested cost is still flagged, at `$0` — the finding is about wasted *work*, not only wasted dollars, and silently dropping a $0 finding would hide a real, fixable bug (a wasted API round trip and, on a rate-limited tool, a wasted quota unit) behind an empty report.

**Verified against real data, not just constructed fixtures.** It fired on the very first live run after being built — one of three real Ollama sessions in the example script flagged `get_related_topics` as orphaned. The small local model called the tool; the session ended before any later model call could use the result. Not staged, not a synthetic test tree — the first real run this ran against.

### Pattern #3 ("retries and their cost") is also a structural check, keyed on `status: 'error'`

**Decision:** a retry is an `llm_call` or `tool_call` that ended with `status: 'error'`, followed by a later call of the SAME type and name under the SAME parent, started after the failed one ended. The failed call's full cost (its own tokens plus any nested `llm_call` cost — a tool that calls a model before failing) counts as avoidable, unlike patterns #1/#2 where only part of the cost is waste: nothing about a failed attempt was usable, so none of its cost is legitimate spend.

**Why this definition and not "any two same-name calls under one parent":** without stored content, two calls to the same tool or model can be entirely legitimate — `search` called twice with two different queries is normal multi-step tool use, not a retry, and there is no way to tell the difference from sizes/tokens/timing alone. `status: 'error'` is the one signal that is not a guess: the caller reported it explicitly. A failed call with no later same-name successor is not flagged either — the caller simply gave up, and nothing was duplicated, so there is nothing to charge as "wasted redo."

**Why a still-`running` run needs no special case, unlike pattern #2:** pattern #2 had to explicitly skip an in-flight run, because its trailing tool call genuinely hasn't had its "chance" yet. Here, the finding only fires once a successor call actually EXISTS in the tree — a run that hasn't retried yet simply produces no successor to find, so the same "nothing to compare against" logic that makes pattern #1 safe on a first call makes this safe on an in-flight run too, with no extra status check needed.

**Verified against a real transient failure and retry, not just constructed fixtures.** Pointed a wrapped Ollama client at an unreachable port for one call (a genuine connection failure, not a mock), then retried the same model against the real local server and got a real response — `detectRetries` flagged the failed attempt correctly. Turned into a permanent regression test afterward (`test/waste-detection.test.ts`).

### Hypothetical pricing (`priceAs`) is never allowed to look like real spend

**Decision:** `costBreakdown`/`detectWaste` accept an optional `priceAs: <model id>` that re-prices a run's *real* recorded token counts under a different model's rate — for a free/local run with no real price, or for "what would this have cost on Sonnet instead of Opus." The result is always double-labeled: a dedicated `⚠⚠ HYPOTHETICAL COST` banner line, *and* an inline `(HYPOTHETICAL, priced as X)` tag on the total itself, so scrolling past one still leaves the other visible.

**Why:** a run on a provider with no real price reports every dollar figure as `$0.000000` — technically correct and functionally inert; percentages alone don't land the way a dollar figure does. But a hypothetical number that could be mistaken for a real one is worse than no number at all, given this tool's whole purpose is helping someone reason accurately about spend. Aggregating runs priced under *different* bases (some actual, some hypothetical, or hypothetical under different models) is flagged `pricingMode: 'mixed'` and prints a loud warning instead of silently summing incompatible dollar figures — the same discipline applied one level up.

### Version Diff groups "before"/"after" by caller-supplied selector, not a first-class `version` field

**Decision:** `Profiler.versionDiff({ before, after })` takes two `{name, limit}` selectors — the exact shape `costBreakdownRecent` already accepts — not a new `version` column, migration, or `StartOptions.version`/`ListRunsOptions.version` filter.

**Why:** PROJECT_CONTEXT.md's own data-model section only ever described "prompt version" as an example value INSIDE `metadata` (free-form, caller-owned), never as a field fyren itself understands or indexes — `metadata` is stored as an unindexed JSON blob (see `storage.ts`), so querying it efficiently would need real schema work. A first-class field is a real, walkable-back-from-never-again commitment once callers start writing to it; a caller-supplied selector costs nothing to add later if it turns out to be needed, and today's obvious workaround — give each version its own run `name` — already works with zero new code. Consistent with this project's standing bias against building a capability before a concrete need has actually shown up.

**Why "behavior changed" means tool-call frequency, and only that, in v1:** the same "never store raw content" constraint that forced Waste Detection patterns #2/#3 into structural definitions applies here — fyren cannot compare what two prompt versions *said*, only what they *did*, measurably. Of the structural candidates (tool-call frequency by name, llm_call/round-trip count per run, error rate, run duration), tool-call frequency by name was chosen as the sole v1 signal: it most directly answers the question a prompt edit is usually trying to answer ("did the model reach for this tool more, less, or differently now"), and — like every candidate — needs no new instrumentation, since `tool_call` nodes already carry everything required. The other three are real, cheap v2 additions, deliberately left out to keep the first cut small rather than guessing at which ones earn their place.

---

## Providers

### `wrapAnthropic` is structurally generic despite its name — Ollama reuses it

**Decision:** the Anthropic instrumentation function (`wrapAnthropic`) takes `provider` and `cacheSupported` options, and is reused as-is to instrument the Ollama client, rather than writing a second, parallel `wrapOllama`.

**Why:** `wrapAnthropic` was already structurally generic — it only depends on the client matching the `AnthropicLike` shape (`messages.create` in, content blocks + usage out), never on anything literally Anthropic-specific. The only things that were Anthropic-specific were three hardcoded `provider: 'anthropic'` string literals, which became a configurable option. This meant adding a second provider cost one new file (`src/providers/ollama.ts`) and zero duplicated instrumentation logic, instead of ~150 duplicated lines of node bookkeeping, segmentation, and error handling.

### Ollama's client translates wire format at the boundary; the agent code never sees it

**Decision:** `createOllamaClient` presents an `AnthropicLike` interface — the caller always speaks `AnthropicCreateParams` in, `AnthropicMessageLike` out — while internally translating to and from Ollama's real OpenAI-compatible `/v1/chat/completions` wire format (system-as-first-message, function-wrapped tool defs, `tool_calls`/`role: "tool"` messages with string-encoded arguments).

**Why:** this is what lets `examples/doc-qa-agent.ts` — the actual agent logic, the tool-calling loop — be written exactly once and driven against either provider unchanged. Only `src/providers/ollama.ts` knows Ollama's wire format exists. The request/response translation functions (`toOllamaRequest`, `fromOllamaResponse`) are pinned in `test/ollama.test.ts` against real JSON captured from a live local Ollama server, not against a guess at the OpenAI-compat spec.

**No `countTokens` on the Ollama client.** Ollama has no token-counting endpoint. Rather than stub one out or throw, the property is simply absent — `wrapAnthropic`'s precise-mode code already checks `typeof messages.countTokens === 'function'` and no-ops gracefully when it's missing, so "provider doesn't support this feature" and "provider's count_tokens call failed" both degrade the same safe way, without new code.

### Cache multipliers moved from module constants into per-model pricing data

**Decision:** `cacheReadMultiplier` and `cacheWriteMultiplier` are fields on every `ModelRate` row in `src/pricing.ts`, not the two shared constants they used to be.

**Why:** with Anthropic as the only priced provider, `1.25x write / 0.1x read` was true everywhere and a constant was honest. Adding OpenAI made it wrong in three different directions at once, all verified against OpenAI's own docs:

| | cache write | cache read |
|---|---|---|
| Anthropic | 1.25× | 0.1× |
| OpenAI GPT-5.6+ | 1.25× | 0.1× |
| OpenAI GPT-5.5 and earlier | **free** | 0.1× |
| OpenAI GPT-4.1 family | free | **0.25×** |
| Gemini | free (storage-billed instead) | 0.1× |

A global `1.25` would have invented a cache-write charge that GPT-5.5 does not bill; a global `0.1` would have under-reported GPT-4.1's cost by 2.5×. Neither would have failed loudly — they'd have quietly produced plausible-looking wrong dollar figures, which is the worst failure mode for a tool whose entire value is accurate cost attribution. Two dedicated tests pin the divergent cases.

**Two related things also became per-model data:** `storagePerHour` (Gemini bills explicit-cache *storage by time*, a cost this token-based model structurally cannot represent — recorded so a report can say the number is incomplete rather than silently omitting it) and `contextThreshold` (Gemini Pro charges a higher rate above 200k prompt tokens, resolved per call by `effectiveRate`).

### Cached tokens are a SUBSET of the prompt count on OpenAI and Gemini, but additive on Anthropic

**Decision:** each provider's usage mapping does its own arithmetic; the "fresh input" figure is computed differently per provider rather than through one shared formula.

**Why:** this is the single easiest place to introduce a silent 2× error.

- **Anthropic** reports `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` as *disjoint* quantities. Total input is their sum.
- **OpenAI** reports `usage.prompt_tokens` as the total, with `prompt_tokens_details.cached_tokens` (and `cache_write_tokens` on GPT-5.6+) as *portions already inside it*. Fresh input is `prompt_tokens − cached − written`.
- **Gemini** does the same as OpenAI: `cachedContentTokenCount` is inside `promptTokenCount`.

Treating OpenAI's numbers additively would count every cached token twice — inflating both the token total and the cost, in a way that looks entirely plausible on inspection. Both mappings clamp at zero so an inconsistent provider response can never yield negative tokens, and both are tested with an explicit "the parts still sum to what the provider billed" assertion.

**Verified against a real cache hit, not just fixtures.** A live `gemini-3.7-flash` call returned `promptTokenCount: 8653, cachedContentTokenCount: 4076`; fyren recorded `input=4577, cacheRead=4076`. Those exact numbers are now a regression test in `test/gemini.test.ts`. The same run also confirmed the documented implicit-caching threshold empirically: an earlier attempt at ~3,582 prompt tokens got zero cache hits on every call, because `gemini-3.7-flash` requires ≥4,096 before implicit caching engages at all.

### The OpenAI-compatible wire format is shared between OpenAI and Ollama; the usage mapping is not

**Decision:** `src/providers/openai-compat.ts` holds the request/response translation both providers use. Each provider file keeps its own base URL, auth, and — critically — its own `usage` → `TokenBreakdown` mapping.

**Why:** Ollama exposes an OpenAI-compatible endpoint, so the *translation* really is identical and duplicating it would just let two copies drift. But the caching behaviour behind that identical format is completely different: Ollama has no cache concept at all and reports no cache fields, while OpenAI caches automatically and reports cached tokens as a subset that must be subtracted back out (see above). Sharing the part that's genuinely the same while keeping the part that differs separate is what makes it safe — a single shared `usage` mapper would have been the bug.

### Gemini gets its own translation from scratch — it is not OpenAI-compatible

**Decision:** `src/providers/gemini.ts` shares nothing with `openai-compat.ts`.

**Why:** Gemini's format differs on every axis that matters — `contents[]` with role `"model"` instead of `"assistant"`, `parts[].text` instead of content strings or block arrays, a top-level `systemInstruction` instead of a system message, `functionDeclarations` grouped under a single `tools` entry, and `functionCall.args` as a *real object* where OpenAI uses a JSON-encoded string. Two further mismatches needed explicit handling rather than a lossy cast: Gemini keys tool results by tool **name** with no call-id concept (so fyren's internal `tool_use_id` is dropped outbound and a synthetic id is generated inbound, keeping the agent loop's call/result pairing working), and `functionResponse.response` must be a JSON object (so a bare string tool result is wrapped rather than sent raw and rejected).

**Gemini does have `countTokens`**, unlike Ollama and unlike this OpenAI client — so precise mode genuinely works there. It is called with the `generateContentRequest` wrapper form rather than bare `contents`, because only the wrapper form includes system instructions and tool declarations in the count; the bare form would silently under-count exactly the segments fyren cares most about.

---

## Reliability and shutdown

### The profiler is built to never break the program it's profiling — tested at every layer

**Decision:** `enqueue()` never blocks (it pushes to an in-memory array; SQLite writes happen later on an unref'd timer). A failed write is dropped and reported through `onError`, never thrown. Errors from a wrapped client are recorded on the node and then re-thrown **unchanged** — verified by asserting the exact same `Error` instance comes back to the caller, not just an error with the same message.

**Why:** a profiler that can slow down or crash the thing it's profiling has failed at its one job, regardless of how good its analysis is.

### `Storage.close()` is idempotent

**Decision:** calling `close()` a second time is a silent no-op instead of throwing.

**Why:** verified empirically that `node:sqlite`'s `DatabaseSync.close()` throws `"database is not open"` on a second call. Real error-handling code legitimately closes from more than one place — a `finally` block *and* a top-level `.catch()` — and the second call must not turn "we're already handling one failure" into "now handling a second, unrelated one."

### `process.exitCode`, not `process.exit()`, after async work has started

**Decision:** both example driver scripts set `process.exitCode = 1` on failure and let the process exit naturally, rather than calling `process.exit(1)`.

**Why:** a real run of `run-real-agent.ts` hit a real Anthropic 401, and the script's error handler called `process.exit(1)` *without ever calling `profiler.close()`* — the SQLite handle was still open, mid-write, when the process was forcibly killed, and the process then crashed with a native libuv assertion on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) instead of exiting cleanly. The fix has two parts: `profiler.close()` now runs in a `finally`, so whatever was already recorded survives to disk regardless of how the run ends; and the script stops force-killing the process afterward, letting Node drain its own handles instead. Verified against two independent real failures (a real Anthropic 401, a real Ollama 404) — both now exit clean, no crash, and the data recorded before the failure is readable after reopening the file fresh. `test/failure.test.ts` locks in the three guarantees this rests on.

---

## Tooling

### `tsconfig.json` must include `test/`, or "typecheck clean" is a lie

**Decision:** `test/**/*.ts` is listed in `tsconfig.json`'s `include`, alongside `src/` and `examples/`.

**Why:** it was missing for most of this project's early development. `npx tsc --noEmit` reported zero errors the entire time — not because the tests were well-typed, but because `tsc` was never looking at them at all. `node --test` running the tests successfully proved they *ran*, never that their types were sound. Once `test/` was added to `include`, three real missing-field errors surfaced immediately. The lesson generalizes: a "typecheck passes" claim is only as trustworthy as the `include` list backing it — worth checking explicitly, not assumed from a green exit code.

### The CLI (`bin/fyren.ts`) is one command, no subcommands, in v1

**Decision:** `fyren` takes flags (`--db`, `--limit`, `--name`, `--help`) but no subcommands. It always prints the same three things — a runs table, a cost trend, an aggregate cost breakdown — and exits. No `fyren cost <id>`, no `fyren waste`, no `--json`.

**Why:** PRD.md explicitly names CLI/UI scope creep as the biggest process risk this project faces — the predecessor project ("JP") stalled on exactly this kind of open-ended feature. The CLI's own scope was deliberately narrowed to what was explicitly decided (run list + cost breakdown + trend) rather than everything the library could technically expose. Waste Detection output and a per-run drill-down are natural v2 additions, not omissions to apologize for.

### `formatCostTrend()` lives in `cost-breakdown.ts`, not in the CLI or a new file

**Decision:** the cost-trend sparkline formatter is exported from `src/analysis/cost-breakdown.ts`, alongside `formatCostBreakdown`/`formatAggregateCostBreakdown`, not written inline in `bin/fyren.ts`.

**Why:** it is a pure, testable presentation function over `RunCostBreakdown[]` — the same category of code as the other three formatters in that file, and it reuses their private `pad`/`usd` helpers directly without exporting them. Keeping it there also keeps `bin/fyren.ts` a thin wiring layer (parse args → call `Profiler` → call formatters → print), consistent with every other formatter already being public API.

### The runs table reads from `costBreakdownRecent()`, not `listRuns()`'s raw fields

**Decision:** the CLI's runs table gets its per-run tokens and cost from `RunCostBreakdown` (`totalInputTokens`, `totalOutputTokens`, `totalCostUsd`), never from a `RunNode`'s own `tokens`/`costUsd` fields.

**Why:** caught during a real end-to-end smoke test (per AGENT.md rule #2 — test against real behavior, not just types), not by inspection. A `RunNode` returned by `listRuns()` is the run's *root* node, and per profiler.ts's own design a node stores only its OWN tokens — a run node has none of its own; only its descendant `llm_call` nodes do. Reading `run.tokens`/`run.costUsd` directly therefore always printed `0`/`$0.000000`, silently, right next to a correct nonzero trend line computed from the same data via `costBreakdownRecent()`. The fix: derive the whole table from the already-computed breakdown array instead of the cheaper-looking root fields.

### The web UI has no framework — plain `node:http`, verified against current sources, not assumed

**Decision:** `web/server.ts` is built on `node:http`/`node:fs` directly. No Express, Fastify, or Hono.

**Why:** PRD.md required this to get the same "verify, don't guess" treatment the provider work got, so it was researched rather than assumed from habit. Current sources confirm a zero-dependency `http`+`fs` static/JSON server is still the standard pattern, and nothing a framework adds (routing sugar, middleware) is worth a new dependency in a project whose entire identity is zero runtime deps and zero native modules. The same research confirmed the `open` npm package is itself just `child_process.execFile` with a platform command (`start`/`open`/`xdg-open`) — trivial to inline in `web/open-browser.ts` instead of depending on it.

### Static assets are three hardcoded routes, not a generic file server

**Decision:** `web/server.ts` maps exactly `/`, `/app.js`, `/style.css` to their files by hand. There is no `serveStatic(dir)`-style handler that resolves an arbitrary request path under `web/public/`.

**Why:** a generic static-file handler has to defend against path traversal (`..` segments, symlink escapes, URL-encoding tricks) for a benefit this project doesn't need — there are only ever three files. Hardcoding the map removes that entire attack surface instead of defending it, and is less code than a correct generic version would be. `test/web-ui.test.ts` has a regression test for exactly this (`../../../etc/passwd` 404s).

### `--ui` is a flag on `fyren`, not a new subcommand or a second bin entry

**Decision:** the web UI starts via `fyren --ui`, not `fyren ui` or a separate `fyren-ui` bin entry.

**Why:** "The CLI is one command, no subcommands" was decided and documented above for the terminal report; introducing a subcommand for the web UI would quietly reopen that decision. A boolean mode flag doesn't — it's the same one command, one entry point, doing one of two things depending on a flag, the same category of choice as `--help`. `--port` and `--no-open` follow the same flag-based shape rather than becoming `fyren ui --port` sub-flags.

---

## Packaging and distribution

*Added for the 0.1.0 release — the first version meant to be installed by someone other than its author. Three of these reverse or widen an earlier decision; each says so explicitly rather than quietly overwriting it.*

### The repo stays build-free; the published artifact is compiled

**Decision:** development still runs `.ts` sources directly via Node's type stripping, with explicit `.ts` extensions on every relative import. `npm publish` ships compiled JavaScript plus `.d.ts` declarations in `dist/`, built by `scripts/build.mjs`. `package.json`'s `main`/`types`/`exports`/`bin` all point into `dist/`.

**Why:** "no build step" was always a decision about *developer experience*, and it still holds there — no watch process, no codegen, no stale-output class of bug. But it was silently also acting as a decision about the *published artifact*, and there it was wrong. A package of raw `.ts` only works for a consumer who is on Node >= 22.18 **and** is not using a bundler **and** whose TypeScript tolerates `.ts` import specifiers coming out of `node_modules`. That is a small fraction of the people this tool is for, and every one of the others would hit an error that looks like fyren is broken. `tsconfig.json` had anticipated this from early on — `rewriteRelativeImportExtensions` was already switched on, with a comment reading "if we ever add a build step" — so this is the change that was planned for, not a reversal of a considered position.

**The non-obvious part:** `rewriteRelativeImportExtensions` rewrites `./foo.ts` into `./foo.js` in emitted *JavaScript* but **not** in emitted *declaration files*, which keep saying `from './profiler.ts'`. Current TypeScript resolves that — verified, a consumer typechecks clean against it even with `skipLibCheck: false` — but no other package on npm looks like that, and older TypeScript and some bundlers do not handle it. So `scripts/build.mjs` rewrites the declaration files itself as a third step, then asserts that no `.ts` specifier survives anywhere in `dist/`.

**Cost of this choice:** two source layouts to keep straight, and a build that can drift from the sources. Both are covered by making the build self-verifying (shebang intact, entry points present, assets copied, no `.ts` specifiers left) and by a CI job that installs the packed tarball into a clean project, runs the CLI, exercises the library, and typechecks a consumer against the published declarations with `skipLibCheck: false`.

### `web/` moved into `src/web/`, and the CLI's logic into `src/cli/`

**Decision:** every shipped source file now lives under `src/`. `bin/fyren.ts` remains, as a three-line shim that imports `src/cli/bin.ts`.

**Why:** two concrete reasons, neither cosmetic.

First, with `rootDir: "src"` the published tree is `dist/index.js` rather than `dist/src/index.js` — the layout someone expects when they open `node_modules/fyren-ai` to see what they installed. With `web/` and `bin/` outside `src/`, `rootDir` has to be the repo root and that extra path segment is unavoidable.

Second, the CLI's logic living inside a `bin` entry point meant the only way to test it was to spawn a process. Moving it to `src/cli/` and leaving `bin.ts` as nothing but "call `runCli`, set an exit code" means the commands are tested by calling a function with captured output — which is why `test/cli.test.ts` can assert on exactly what was printed, and on every argument-validation failure path, without paying process startup per assertion.

### The CLI has subcommands after all

**Decision:** `fyren` now takes `runs`, `breakdown`, `waste`, `diff`, `ui`, and `doctor` alongside the bare summary command. This reverses "The CLI (`bin/fyren.ts`) is one command, no subcommands, in v1" and widens "`--ui` is a flag on `fyren`, not a new subcommand", both recorded above.

**Why:** the original decision was a guard against a specific process risk — PRD.md names CLI/UI scope creep as the thing that stalled the predecessor project — and it was right at the time, while the analysis engine was still being built. It stopped being right once the engine was complete: the library could compute a waste report, a per-run drill-down, and a version diff that the CLI had no way to display. The tool looked less finished than it was, and the single most valuable thing it produces (`fyren waste`) was unreachable without writing code against the library.

The guard against the original risk is kept structurally rather than by refusing the feature: **every subcommand is a thin printer over an analysis function that already existed and was already tested.** No command computes anything of its own, and the per-run modes reuse the same `formatX` functions the library already exported. If a proposed command needs new analysis, that analysis gets scoped and built first, on its own.

**What did not change:** bare `fyren` prints exactly what it always printed, and `--ui` still works. Both shipped in a released CLI, and breaking a working invocation to tidy up the surface would cost a real user more than the inconsistency does.

### An ambiguous run-id prefix is reported, never resolved

**Decision:** `Storage.resolveRunId` returns `'ok'`, `'none'`, or `'ambiguous'`. Every surface taking a run argument (`fyren breakdown <run>`, `fyren waste <run>`, `GET /api/runs/<id>`) surfaces the ambiguity and asks for more characters. An exact full-id match wins even when that id also prefixes others.

**Why:** prefixes have to be accepted at all, because every listing prints an 8-character prefix, and demanding the full uuid back would make the tool's own output useless as input to its next command. Given that, "just pick the most recent match" is the obvious shortcut — and it is the wrong one for this project specifically. It prints a real, plausible, correctly formatted cost breakdown *for a different run than the one the user asked about*, with nothing on screen indicating that happened. That is precisely the failure mode — being wrong in a way that looks right — that hypothetical-pricing labels, three-way `cacheSupported` reporting, and the estimated-vs-measured distinction all exist to prevent. A lookup helper does not get an exemption from the rule the rest of the codebase follows.

### ANSI colour is hand-rolled, not `chalk`/`picocolors`

**Decision:** `src/cli/colors.ts` emits escape codes directly, and `src/cli/format.ts` measures column widths with a `visibleLength` that strips them.

**Why:** zero runtime dependencies is the constraint that makes `npx fyren-ai` install instantly, and colour is about forty lines of escape codes — a dependency for it would be the one thing making the install slower than it needs to be, for no capability gained. Colour stays off unless it is confident it will render: `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, `--no-color`, and whether stdout is a TTY are all honoured.

**The part with teeth** is not the colour, it is the padding. Cells arrive already coloured, so any alignment that measures `String.length` counts invisible escape bytes as columns, producing a table that looks correct in a captured string and ragged in an actual terminal. `test/cli-format.test.ts` asserts alignment on genuinely coloured cells, for both alignments, rather than on plain strings that would pass either way.

### The web UI's cost-trend bars are drawn against zero, not against the cheapest run

**Decision:** each bar's height is `cost / max`, not `(cost - min) / (max - min)`.

**Why:** min-max scaling is the standard way to make a sparkline use its full height, and on this data it lies. Three runs costing $0.014250, $0.014253 and $0.014255 — i.e. effectively identical — render as an empty bar, a half bar, and a full bar, which reads as wild cost variance. For a chart whose entire job is answering "is this getting more expensive?", exaggerating a rounding difference into an apparent tripling is worse than a flat, boring row of equal bars. Zero-based is the honest baseline for a magnitude comparison.
