# fyren — Product Requirements Document

Status: living document. Supersedes [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) as the source of truth for scope and priorities — that file is kept as historical record of the original planning session, in Persian, and should not be edited going forward. This document is the one to update when scope changes. Every *why* behind a technical choice lives in [DECISIONS.md](./DECISIONS.md), not here — this document says *what* and *for whom*, DECISIONS.md says *why it's built that way*.

Last synced to actual code state: 2026-08-24.

---

## 1. Problem statement

A developer building an LLM agent can see total token usage — every provider's dashboard shows that. What no tool shows is **why**: how much of a request is fixed overhead (system prompt, tool definitions) versus the user's actual question, whether a defined tool is quietly costing tokens on every call whether or not it ever fires, or whether prompt caching was simply never turned on for content that never changes.

Existing tools (Langfuse, Helicone, and similar) are **log dashboards** — they show what happened. They do not compute *where the tokens went* or *which of them were avoidable*. That gap — analysis, not logging — is fyren's entire reason to exist. A version of fyren that becomes "yet another log viewer" has failed at its actual purpose, regardless of how polished it looks.

## 2. Target user

A solo or small-team developer building agents, integrating multiple LLM providers, with:
- No budget for a hosted observability product
- No dedicated server to run one on
- Skepticism toward tools that phone data to a third party
- Enough technical depth to read source, but not necessarily deep LLM/ML background

This shapes real requirements, not just preferences: **local-first, zero-account, zero-server, npm-installable with zero native dependencies** are constraints, not nice-to-haves. A design that requires a Postgres instance or a signup flow is out of scope by definition, not by oversight.

## 3. Goals

- Show a developer, for one agent run or across many, **where their input tokens actually went** — broken into system prompt, tool definitions, conversation history, tool results, and the latest message — with real dollar costs.
- Surface **specific, named waste patterns** with a concrete avoidable-dollar figure, not just "your bill is high."
- Work identically across the major hosted providers (Anthropic, OpenAI, Gemini) and free local runtimes (Ollama), so a developer isn't locked into analyzing only one provider's traffic.
- Never be wrong in a way that looks right. A profiler whose numbers are silently inflated or deflated is worse than no profiler — every non-obvious computation (cache attribution, per-model pricing, hypothetical pricing) is built to fail loudly or label itself honestly rather than guess quietly.
- Never slow down or break the program being profiled.

## 4. Non-goals (v1)

Explicitly out of scope, from the original plan — revisit only with a deliberate scope decision, not by drift:

- Authentication, user accounts, multi-tenancy
- Hosted/cloud mode — this is a local tool
- Output-quality evaluation (a plausible v2, not v1)
- A provider integration beyond Anthropic, OpenAI, Gemini, Ollama, unless a specific user need justifies it
- A full observability suite (tracing, alerting, dashboards-as-a-service) — that is what Langfuse/Helicone already do; fyren's differentiation is analysis depth, not breadth of logging features

## 5. Core model (what every feature is built on)

- **Everything is a node in a tree**: `run → step → llm_call / tool_call → nested calls`. This is the foundational data-model decision — see DECISIONS.md's "Storage" section for why flat storage was rejected up front.
- **Five input segments, disjoint and exhaustive**: `toolDefs`, `system`, `history`, `toolResults`, `latest`. Every character of a request's input lands in exactly one. The `latest`/`toolResults` boundary is a fixed function of block position and type, never a content heuristic.
- **A provider is a translation layer**, not a special case baked into the core. `AnthropicLike` (system/tools/messages in, content blocks + usage out) is the shared internal shape; every provider adapter translates its real wire format into and out of that shape. Adding a fifth provider should mean one new file, not touching `cost-breakdown.ts` or `waste-detection.ts`.
- **Never store raw prompt or tool-result text** — only sizes (`InputComposition`, characters/tokens per segment). This is a firm boundary, not a v1 shortcut: it bounds what "content-aware" analysis can ever claim to detect (see Waste Detection pattern #2 below, which had to be redesigned around this constraint rather than against it).

## 6. Feature requirements

Each item: status, and — for "planned" items — the acceptance bar for calling it done.

### 6.1 Data collection — **done**

- Wrap a provider client; record every LLM/tool call as a tree node, non-blocking, crash-safe (a node is written on start AND on finish, so a killed process still leaves a legible partial tree).
- A profiling failure (storage error, malformed response) must never throw into the caller's code and must never meaningfully slow the caller's hot path.

### 6.2 Analysis #1 — Cost Breakdown — **done**

- Per-run and aggregate (across N runs) breakdown of input tokens by the five segments, in tokens, %, and USD.
- Cache-aware: tokens billed at fresh/cache-read/cache-write rates are attributed correctly, not smeared evenly across segments.
- `priceAs` — hypothetical re-pricing of a run's real token counts under a different model, double-labeled so it can never be mistaken for real spend. (Exists specifically because a free-provider run reports `$0` everywhere, which is technically correct and completely unpersuasive — see DECISIONS.md.)

### 6.3 Analysis #2 — Waste Detection

Three planned patterns, per the original scope:

1. **Uncached static content** — **done**. A `system`/`toolDefs` segment resent unchanged across calls without a cache hit. Reports avoidable tokens and dollars; correctly labels the finding as "potential" rather than "bug" on a provider with no caching concept at all (Ollama).
2. **Orphaned tool calls** ("tool output that was never used") — **done**. Redefined as a structural check (a tool call with no later `llm_call` anywhere in the finished run) rather than a semantic one, because of the "never store raw text" constraint in §5. Verified against real data — fired on the very first live run it was tested against.
3. **Retries and their cost** — **done**. Redefined the same way pattern #2 was, for the same reason: an `llm_call`/`tool_call` that ended in `status: 'error'`, superseded by a later call of the same type and name under the same parent, is a retry — status is an explicit signal, content-based "same intent" is not available. The full cost of every superseded failed attempt counts as avoidable (not a partial amount, unlike patterns #1/#2 — nothing about a failed attempt was usable). Verified against a real transient failure and retry on a live local Ollama server, in addition to the permanent unit tests.

### 6.4 Analysis #3 — Version Diff — **done**

Original scope (PROJECT_CONTEXT.md §4c): given two versions of a prompt/agent, show how token usage and behavior changed. Scoped as follows, and built exactly to that scope:

- **Grouping "before" vs "after" is entirely the caller's job — no schema change.** `Profiler.versionDiff({ before: ListRunsOptions, after: ListRunsOptions })`, i.e. two `{name, limit}` selectors, the same shape `costBreakdownRecent` already takes. PROJECT_CONTEXT.md's own data-model section (§4b) always described "prompt version" as a `metadata` example, never a first-class field — a real `version` column + migration + `StartOptions.version`/`ListRunsOptions.version` filter was considered and explicitly rejected for v1 as a bigger commitment than the feature has earned yet. The natural way to use this today: give each prompt version its own run `name` (e.g. `docs-qa-v1` vs `docs-qa-v2`), or point `--db` at two different files. Explicit `runId[]` selection instead of `{name, limit}` is a cheap, natural v2 widening if it turns out to be needed — not built now.
- **Usage diff — reuses Cost Breakdown entirely, nothing new to design.** `aggregateCostBreakdown()` computed once per side; the diff is a per-segment delta (tokens, cost, share, before vs after) plus an overall total-cost delta. No new token math.
- **Behavior diff, v1 scope: tool-call frequency by name only.** Since fyren never stores raw prompt/response content (the same constraint that shaped Waste Detection patterns #2/#3), "behavior changed" can only mean something structurally observable — and of the candidates (tool-call frequency, llm_call/round-trip count, error rate, duration), tool-call frequency was picked as the one v1 signal: how many times each named tool was called, per run, before vs after. Directly answers "did the new prompt make the model reach for a tool more or less often" without needing any new instrumentation — every candidate signal already exists on `RunNode` today, so this is a scope choice, not a capability gap. Round-trip count, error rate, and duration are natural v2 additions.
- **Not in v1:** CLI/web UI integration (this scopes the analysis function only, same as Cost Breakdown and Waste Detection were built before their CLI/UI surfaces existed), a first-class version field, explicit runId-list selection.

Acceptance bar for calling it "done": `Profiler.versionDiff()` + a pure `diffVersions()` function (mirroring `costBreakdown()`/`detectWaste()`'s tree-in, result-out shape) in a new `src/analysis/version-diff.ts`, a `formatVersionDiff()` terminal formatter, tests, and — per this project's established practice — verified against a real two-version scenario before being trusted, not just synthetic fixtures. **Met:** two real Ollama sessions (`qwen2.5:7b`) of the docs Q&A agent, same questions, one with `SYSTEM_PROMPT` unmodified and one with its `get_related_topics` instruction deliberately changed from "only when explicitly asked" to "always, after every answer" — `versionDiff` correctly reported `get_related_topics` frequency going from 0.0 to 1.0 avg/run, plus the resulting real token-count shift in `conversation history` and `tool results` from the extra tool round-trip. Not kept as a permanent example script (unlike Cost Breakdown/Waste Detection's `run-ollama-agent.ts`) — the one-off verification run was enough to trust the numbers; `doc-qa-agent.ts` gained an optional `systemPrompt` override (default: `SYSTEM_PROMPT`) so a future session can reproduce it without duplicating the agent loop.

### 6.5 Providers — **done** (4 of 4 planned for v1)

| Provider | Status | Verified against real API |
|---|---|---|
| Anthropic | done | mock only — **no funded key available** |
| OpenAI | done | mock only — **no funded key available** |
| Gemini | done | **yes** — real cache hit captured and pinned as a regression test |
| Ollama | done | **yes** — repeatedly, local |

**Known gap, highest priority to close:** Anthropic's cache-attribution logic (`attributeCall`, the prefix-fill algorithm, `cacheBoundaryUncertain`) is the algorithm the entire Cost Breakdown and Waste Detection analysis is built around — and it has never been run against a real Anthropic cache hit. It has been validated structurally (via Gemini, which shares the "cached tokens as an additive/subset quantity" question) but not against Anthropic itself. Closing this requires a funded `ANTHROPIC_API_KEY`; the project does not have one and has not attempted to acquire one (see AGENT.md's rules on credentials).

### 6.6 CLI + local web UI — **done**, widened past the original v1 scope

Both shipped first at a deliberately narrow scope (run list + cost trend + aggregate breakdown, nothing else), and both were then widened once the analysis engine was complete. The widening was a deliberate scope decision, recorded in DECISIONS.md § "The CLI has subcommands after all" — not drift. The reason: the library could compute a waste report, a per-run drill-down and a version diff that neither surface could display, so the single most valuable output the product makes (`fyren waste`) was unreachable without writing code against the library.

**The guard against the scope-creep risk in §8 is kept structurally rather than by refusing features: every command and every view is a thin printer over an analysis function that already existed and was already tested.** Nothing in `src/cli/` or `src/web/` computes a number of its own. A proposed feature that needs new analysis means that analysis gets scoped and built first, as its own piece of work.

**CLI — done.** `fyren` (from the `fyren-ai` package) with seven commands: `summary` — the default, printing exactly what the original released CLI printed — plus `runs`, `breakdown [run]`, `waste [run]`, `diff`, `ui`, and `doctor`. Global flags `--db`, `--limit`, `--name`, `--price-as`, `--json`, `--no-color`, plus `$FYREN_DB`. The `[run]` argument accepts a run id or any unique prefix of one; an ambiguous prefix is reported rather than resolved to an arbitrary match (DECISIONS.md). `--ui` still works as a flag, for back-compatibility with the released version. `doctor` checks the four ways this tool goes quietly wrong: Node version, `node:sqlite`, runs with no composition data, and models with no pricing entry.

**Web UI — done.** `fyren ui` starts the same zero-dependency `node:http` server (no framework — researched and confirmed, see DECISIONS.md) and opens a browser. Three tabs: Overview (totals, a stacked composition bar, the per-segment table, cost per run over time), Runs (clickable, opening a per-run panel with that run's breakdown, its waste findings, and its full call tree), and Waste (findings ranked by dollar impact). Live controls for name, limit and `priceAs`; optional auto-refresh for watching an agent as it runs. Endpoints: `GET /api/meta`, `GET /api/summary`, `GET /api/runs/<id-or-prefix>`. Still plain HTML/CSS/vanilla JS, no build step, and **no CDN or external request of any kind** — a hand-rolled inline SVG chart rather than a charting library, so "no data leaves the machine" holds without exception.

### 6.7 Distribution — **done**

Not in the original plan, and a v1 blocker in practice: a profiler nobody can install is not a profiler anyone will use.

- Compiled artifact (`dist/` — JavaScript plus `.d.ts`) published as `fyren-ai`, while development stays build-free. See DECISIONS.md for why shipping raw `.ts` was wrong even though developing against it is right.
- `fyren-ai/web` subpath export for the UI server, kept out of the main entry so importing the library never pulls `node:http` into a consumer's bundle.
- `LICENSE` (MIT — the manifest had claimed MIT with no file present), `CHANGELOG.md`, `CONTRIBUTING.md`.
- **CI**, closing an open risk from §8: typecheck and tests on Node 22.18 and 24 on Linux plus Node 24 on Windows; a step asserting `tsconfig.json`'s `include` covers every source directory, because a green typecheck cannot; and a job that packs the tarball, installs it into a clean project, runs the CLI, exercises the library, and typechecks a consumer against the published declarations with `skipLibCheck: false`.

**Not done: the publish itself.** Everything is built, packed and install-verified, but `npm publish` has not been run — it is irreversible, public, and requires the maintainer's own npm credentials.

## 7. Success criteria for a v1 release

- A developer can run `npx fyren-ai` (or clone + `npm install`) and get from zero to seeing a real cost breakdown and waste report on their own agent, for at least one of the four supported providers, without creating an account or sending data anywhere.
- All four providers behave identically from the calling code's perspective (the `AnthropicLike` contract holds).
- The numbers are either real (verified against the provider) or explicitly labeled as an estimate/hypothetical — no unlabeled guess ever reaches the user.
- `npm run check` (typecheck + full test suite) passes with zero failures at every commit that claims to be "done."

## 8. Open risks

- **Untested Anthropic/OpenAI cache paths** (§6.5) — the single biggest correctness risk in the project today.
- **Scope creep on CLI/UI** — this is explicitly the kind of large, ambiguous feature that caused the predecessor project ("JP") to stall, per the original planning notes. Both were scoped in writing before building (see the plans referenced in DECISIONS.md) and shipped at that scope, not beyond it.
- ~~**No CI yet.**~~ Closed — see §6.7. GitHub Actions runs typecheck and tests on two Node versions and two platforms, and separately verifies that the packed tarball installs and works.
