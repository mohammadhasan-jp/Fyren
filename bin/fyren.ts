#!/usr/bin/env node
/**
 * Placeholder CLI entry point for `npx fyren` / a global install.
 *
 * There is no CLI yet — per PROJECT_CONTEXT.md, the CLI + local web UI are
 * the last unbuilt piece (see the README's Status table). This file exists
 * so package.json's `bin` field points at something real and runnable now,
 * rather than breaking `npx fyren` before the CLI is built.
 */

console.log(
  [
    'fyren — the CLI is not built yet.',
    '',
    "For now, use it as a library — see this package's README.md and the examples/ directory:",
    '  examples/basic-run.ts        — record a run, no network',
    '  examples/run-ollama-agent.ts — a real local agent, free',
    '  examples/run-real-agent.ts   — a real hosted agent (Anthropic API key required)',
  ].join('\n'),
);
