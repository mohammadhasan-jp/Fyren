#!/usr/bin/env node
/**
 * The installed `fyren` executable. Argument parsing and every command live in
 * `./index.ts`; this file exists only to be the thing package.json's `bin`
 * points at, so that the CLI's logic stays importable and testable without
 * spawning a process.
 */

import { runCli } from './index.ts';

// `process.exitCode`, never `process.exit()` — the web UI command has async
// work and open handles, and exit() would cut them off mid-flush. See
// DECISIONS.md § "process.exitCode, not process.exit()".
runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`fyren: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
