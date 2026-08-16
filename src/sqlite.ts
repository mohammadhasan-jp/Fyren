/**
 * Loading `node:sqlite` without shouting at the user.
 *
 * Verified behaviour (not guessed — both were run):
 *
 *   Node 22.13 → Stability 1.1, "Active development". Importing the module
 *                emits, once, on stderr:
 *                  ExperimentalWarning: SQLite is an experimental feature and
 *                  might change at any time
 *   Node 24.18 → Stability 1.2, "Release candidate". No warning at all.
 *
 * A profiler printing a scary warning into somebody else's agent logs is
 * unacceptable, and `--no-warnings` is too blunt — it hides the user's own
 * warnings too. So we swap `process.emitWarning` for exactly the duration of
 * the module load, drop that one message, and put the original back.
 *
 * Set FYREN_NODE_WARNINGS=1 to see it.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';

const SQLITE_WARNING = 'SQLite is an experimental feature';

export type DatabaseSyncCtor = new (path: string, options?: unknown) => DatabaseSyncInstance;

function load(): DatabaseSyncCtor {
  const suppress = process.env.FYREN_NODE_WARNINGS !== '1';
  const original = process.emitWarning;

  if (suppress) {
    process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
      const message =
        typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
      if (typeof message === 'string' && message.includes(SQLITE_WARNING)) return;
      return (original as (...a: unknown[]) => void).apply(process, [warning, ...rest]);
    } as typeof process.emitWarning;
  }

  try {
    // A static `import` cannot be wrapped like this, so we go through require.
    const req = createRequire(import.meta.url);
    return (req('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  } finally {
    if (suppress) process.emitWarning = original;
  }
}

export const DatabaseSync: DatabaseSyncCtor = load();
export type Database = DatabaseSyncInstance;
