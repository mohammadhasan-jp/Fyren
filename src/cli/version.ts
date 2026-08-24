/**
 * The package version, read at runtime from package.json.
 *
 * Not a hardcoded constant: a version string that has to be edited in two
 * places is a version string that will eventually disagree with itself, and
 * `fyren --version` reporting a number the published package doesn't have is
 * a small lie that is hard to notice and annoying to debug.
 *
 * The directory depth differs between running from source (`src/cli/`) and
 * running the built package (`dist/cli/`), so this walks up rather than
 * assuming a fixed number of `..` segments.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNKNOWN = '0.0.0-unknown';

let cached: string | null = null;

export function packageVersion(): string {
  if (cached !== null) return cached;
  cached = findVersion() ?? UNKNOWN;
  return cached;
}

function findVersion(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);

  while (true) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      // Guard against picking up a nested package.json that isn't ours.
      if (parsed.name === 'fyren-ai' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      /* keep walking — a missing or malformed package.json here is not fatal */
    }

    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
