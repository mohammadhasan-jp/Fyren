# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/).

## [0.1.0] — 2026-08-24

First release intended to be installed by someone other than its author. Everything before this
lived only in the repository.

### Added

- **Published build.** The package now ships compiled JavaScript and `.d.ts` declarations in
  `dist/`, so it works on any bundler and any TypeScript version — not just Node ≥ 22.18 running
  the sources directly. Development is still build-free; only the artifact is compiled.
  (`fyren-ai/web` is a subpath export for the UI server, kept out of the main entry so importing
  the library never pulls `node:http` into a consumer's bundle.)
- **CLI subcommands.** `fyren` grew `runs`, `breakdown [run]`, `waste [run]`, `diff`, `ui`, and
  `doctor` alongside the original bare-command summary. Every one is a thin printer over an
  analysis function that already existed.
  - `breakdown <run>` and `waste <run>` take a run id **or any unique prefix** of one — the same
    8-character prefix every listing prints. An ambiguous prefix is reported, never resolved to
    an arbitrary match.
  - `diff --before <name> --after <name>` exposes Version Diff (analysis #3), which previously
    had no user-facing surface at all.
  - `doctor` checks Node version, `node:sqlite`, the database, whether runs carry composition
    data, whether sizes are measured or estimated, and whether every model seen has a pricing
    entry — the four ways this tool goes quietly wrong.
- **`--price-as <model>`** on every reporting command: re-price real token counts at another
  model's rates. Always double-labelled as hypothetical.
- **`--json`** on every reporting command, for piping into `jq` or a script.
- **ANSI colour**, hand-rolled with no dependency. Respects `NO_COLOR`, `FORCE_COLOR`,
  `TERM=dumb`, `--no-color`, and whether stdout is a TTY.
- **`$FYREN_DB`** as the default database path, overridden by `--db`.
- **Call-tree drill-down** in both the CLI (`fyren breakdown <run>`) and the web UI: the run's
  full `run → step → llm_call / tool_call` tree with per-node tokens, cache split, cost and
  duration.
- **Rebuilt web UI.** Tabs for Overview / Runs / Waste; KPI row; a stacked composition bar; a
  cost-per-run chart; clickable runs with a per-run detail panel; live filters for agent name,
  run count and hypothetical pricing; and an optional 4-second auto-refresh for watching an
  agent as it runs.
- **New API endpoints** behind the UI: `GET /api/meta`, `GET /api/runs/<id-or-prefix>`, and
  query-parameter overrides (`limit`, `name`, `priceAs`) on `GET /api/summary`.
- `Profiler.listRunNames()`, `Profiler.resolveRunId()`, and a readable `Profiler.dbPath`.
- `LICENSE` (MIT — the manifest had claimed MIT with no file present), `CONTRIBUTING.md`, this
  changelog, and a GitHub Actions CI workflow running typecheck + tests on Node 22.18 and 24.

### Changed

- **Repository layout.** `web/` moved to `src/web/`, and the CLI's implementation moved from
  `bin/fyren.ts` into `src/cli/`. This makes `dist/` a conventional `dist/index.js` tree and lets
  the CLI be tested by calling `runCli()` rather than spawning a process. `node bin/fyren.ts`
  still works — it is now a shim.
- **Cost-trend bars** in the web UI are drawn against zero rather than against the cheapest run.
  Scaling from the minimum made a set of near-identical runs look wildly variable.
- `fyren doctor` reports estimated (rather than measured) segment sizes as a **warning**, not an
  "ok" — a green tick next to "these are estimates" is the kind of quiet reassurance the command
  exists to prevent.
- Static assets and API responses are served `cache-control: no-store`, so a reloaded UI can
  never show a stale run.

### Notes

- The Anthropic cache-attribution path is still verified only structurally (via Gemini), never
  against a live Anthropic cache hit — see [PRD.md](./PRD.md) §6.5. This remains the project's
  single largest correctness risk and closing it needs a funded API key.

[0.1.0]: https://github.com/mohammadhasan-jp/Fyren/releases/tag/v0.1.0
