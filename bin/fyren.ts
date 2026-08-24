#!/usr/bin/env node
/**
 * Development entry point: `node bin/fyren.ts`.
 *
 * The published executable is `dist/cli/bin.js` (built from `src/cli/bin.ts`)
 * — package.json's `bin` points there, not here. This shim exists so the repo
 * keeps its documented `node bin/fyren.ts` invocation working from source,
 * without a second copy of the CLI's logic.
 */

import '../src/cli/bin.ts';
