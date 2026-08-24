# Contributing to fyren

Thanks for looking. This file covers the practical bits; the reasoning behind how the project is
built lives in [DECISIONS.md](./DECISIONS.md), and what it is for lives in [PRD.md](./PRD.md).
If you are an AI agent working in this repo, read [AGENT.md](./AGENT.md) first.

## Getting set up

```bash
git clone https://github.com/mohammadhasan-jp/Fyren.git
cd Fyren
npm install
npm run check
```

That is the whole setup. There is **no build step for development** — Node runs the TypeScript
sources directly via native type stripping, which is why every relative import carries an explicit
`.ts` extension. You need **Node ≥ 22.18**; see [DECISIONS.md](./DECISIONS.md) for why that floor
is real and not a guess.

`npm run build` exists only to produce the published artifact.

## Commands

```bash
npm run check          # typecheck + full test suite — the bar for "done"
npm run typecheck      # tsc --noEmit alone
npm test               # node --test alone
npm run build          # compile dist/ (only needed when packaging)

npm run fyren -- --help    # the CLI, from source
npm run example            # mock agent — no network, no cost
npm run example:ollama     # REAL local agent — free, needs Ollama running
npm run example:real       # REAL hosted agent — needs ANTHROPIC_API_KEY, costs cents
```

## House rules

These are not style preferences; each one exists because of something that went wrong.

**Comments explain *why*, never *what*.** A comment restating what a well-named function does is
noise. A comment earns its place when it records a non-obvious constraint, a bug that shipped
once, or a decision a reader would otherwise want to undo.

**Zero runtime dependencies in `src/`.** The core imports nothing but Node built-ins. Provider
SDKs are devDependencies used only in `examples/`. This is what makes the mock-based test suite
possible and keeps `npx fyren-ai` free of native-module install friction.

**No premature abstraction.** Three similar lines beat a speculative helper. Nothing is built for
a hypothetical future provider or feature.

**Strict TypeScript**, with `noUncheckedIndexedAccess` and `erasableSyntaxOnly` on. No enums, no
parameter properties, nothing that needs a compiler rather than type-stripping.

**A profiler failure must never break or slow the program being profiled.** Anything touching the
write path (`queue.ts`, `storage.ts`) has to keep that guarantee. `test/failure.test.ts` exists to
enforce it — extend it, don't relax it.

**Never be wrong in a way that looks right.** This is the big one. Every non-obvious computation
(cache attribution, per-model pricing, hypothetical pricing) either labels itself honestly or
fails loudly. A cost figure that is silently inflated, deflated, or presented as real spend when
it is a hypothetical is worse than no figure at all. If you are adding output, ask what it claims
and whether the data supports that claim.

## Testing

- `npm run check` must pass before a change is done. Don't trust a green typecheck without
  checking what it covered — `tsconfig.json`'s `include` list has silently missed a whole source
  directory twice, and `tsc` reports success for files it never looked at.
- New behavior gets a test in the same change, not "added later."
- **Prefer real over mocked.** Provider translation is pinned against real captured JSON wherever
  a real server was reachable (`test/ollama.test.ts`, `test/gemini.test.ts`), and the web UI tests
  run an actual server on an actual port. This project has caught real bugs that way which
  fixture-only tests missed.
- When you fix a bug, check whether the same *class* of bug exists elsewhere before closing it
  out.

## Adding a provider

A provider is a translation layer, not a special case. `AnthropicLike` (system/tools/messages in,
content blocks + usage out) is the shared internal shape; each adapter translates its real wire
format into and out of it. Adding one should mean **one new file in `src/providers/`** plus a
pricing entry — if you find yourself editing `cost-breakdown.ts` or `waste-detection.ts` to
support it, something is being modelled in the wrong place.

Two things to get right, both of which have caused real bugs:

- **Cached tokens are additive on Anthropic but a subset of the prompt count on OpenAI and
  Gemini.** Treating the latter as additive double-counts every cached token.
- **Set `cacheSupported: false`** if the provider has no caching concept at all (Ollama). That is
  a different claim from "caching was available and missed", and the analysis layer reports them
  differently on purpose.

Verify field names and pricing against **current provider documentation**, not recall. Wrong
values here produce plausible-looking wrong numbers, which is the worst failure mode this project
has.

## Pull requests

- One concern per PR.
- Say what you verified, and how. "Tests pass" and "I ran it against a live Ollama server and the
  finding fired" are different levels of evidence, and the second is worth stating.
- If you made a choice a reader might reasonably ask "why not the simpler way?" about, add an
  entry to [DECISIONS.md](./DECISIONS.md). That file is why a fresh contributor doesn't
  accidentally re-break something that was decided deliberately.
