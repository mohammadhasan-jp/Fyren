# fyren — Product Requirements Document

Status: living document. Supersedes [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) as the source of truth for scope and priorities — that file is kept as historical record of the original planning session, in Persian, and should not be edited going forward. This document is the one to update when scope changes. Every *why* behind a technical choice lives in [DECISIONS.md](./DECISIONS.md), not here — this document says *what* and *for whom*, DECISIONS.md says *why it's built that way*.

Last synced to actual code state: 2026-08-16.

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
3. **Retries and their cost** — **not started**. Acceptance bar: detect a repeated call (same step, same intent) that failed or was superseded, and report the tokens/dollars spent on the attempt(s) that didn't produce the used result. Needs a definition of "retry" that's detectable from the tree alone, in the same spirit as pattern #2's redesign — do not assume this maps cleanly onto existing fields without checking first.

### 6.4 Analysis #3 — Version Diff — **not started**

Original scope: given two versions of a prompt/agent, show how token usage and behavior changed. No design work has been done yet. Needs its own scoping pass before implementation — do not start coding from a guess at what "diff" should mean here.

### 6.5 Providers — **done** (4 of 4 planned for v1)

| Provider | Status | Verified against real API |
|---|---|---|
| Anthropic | done | mock only — **no funded key available** |
| OpenAI | done | mock only — **no funded key available** |
| Gemini | done | **yes** — real cache hit captured and pinned as a regression test |
| Ollama | done | **yes** — repeatedly, local |

**Known gap, highest priority to close:** Anthropic's cache-attribution logic (`attributeCall`, the prefix-fill algorithm, `cacheBoundaryUncertain`) is the algorithm the entire Cost Breakdown and Waste Detection analysis is built around — and it has never been run against a real Anthropic cache hit. It has been validated structurally (via Gemini, which shares the "cached tokens as an additive/subset quantity" question) but not against Anthropic itself. Closing this requires a funded `ANTHROPIC_API_KEY`; the project does not have one and has not attempted to acquire one (see AGENT.md's rules on credentials).

### 6.6 CLI + local web UI — **not started**

Target experience, from the original plan: `npx fyren` (or `npx fyren-ai` — package-name reality, see the naming note in README.md) starts a local server and opens a browser, no account, no signup, no data leaving the machine. Plus a terminal summary table (recent runs, usage, estimated cost) for anyone who doesn't want to leave the terminal.

This is the largest remaining unit of work and has not been scoped yet. Before writing code: decide (a) whether a minimal CLI with a nicer terminal report is a worthwhile intermediate milestone before a full web UI, (b) what the web UI's first screen actually needs to show (the tree view? the cost breakdown? both?), (c) what local server framework/approach fits the zero-dependency, zero-native-module constraint that shaped every other part of this project. Do not assume a framework choice; it should get the same "verify, don't guess" treatment as the provider work did.

## 7. Success criteria for a v1 release

- A developer can run `npx fyren-ai` (or clone + `npm install`) and get from zero to seeing a real cost breakdown and waste report on their own agent, for at least one of the four supported providers, without creating an account or sending data anywhere.
- All four providers behave identically from the calling code's perspective (the `AnthropicLike` contract holds).
- The numbers are either real (verified against the provider) or explicitly labeled as an estimate/hypothetical — no unlabeled guess ever reaches the user.
- `npm run check` (typecheck + full test suite) passes with zero failures at every commit that claims to be "done."

## 8. Open risks

- **Untested Anthropic/OpenAI cache paths** (§6.5) — the single biggest correctness risk in the project today.
- **Scope creep on CLI/UI** — this is explicitly the kind of large, ambiguous feature that caused the predecessor project ("JP") to stall, per the original planning notes. Scope it in writing before building.
- **No CI yet.** `npm run check` is manual. Worth automating once the project has a stable enough shape that CI wouldn't just be chasing a moving target.
