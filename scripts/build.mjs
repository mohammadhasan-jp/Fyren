/**
 * The publish build.
 *
 * fyren develops with no build step — Node runs the `.ts` sources directly via
 * type stripping, which is why every relative import carries an explicit `.ts`
 * extension. That is great for working on it and wrong for shipping it: a
 * published package of raw `.ts` only works for consumers on Node >= 22.18 who
 * are not using a bundler, which is a small fraction of the people this tool is
 * for. So the repo stays build-free and the *artifact* is compiled.
 *
 * Three steps, and the third is the non-obvious one:
 *
 *   1. tsc emits JS + .d.ts into dist/. `rewriteRelativeImportExtensions`
 *      (already on in tsconfig.json) turns `./foo.ts` into `./foo.js` in the
 *      emitted JavaScript.
 *   2. The web UI's static assets are copied — tsc only knows about TypeScript.
 *   3. That rewrite does NOT apply to declaration files, so the emitted .d.ts
 *      still says `from './profiler.ts'`. Current TypeScript resolves that, but
 *      it is not the convention any other package follows, and older
 *      TypeScript and some bundlers choke on it. Rewriting them here means the
 *      published types look like everyone else's.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

function run(label, args) {
  process.stdout.write(`${label}… `);
  // `node <path-to-tsc>` rather than `npx tsc`: npx needs a shell on Windows,
  // and spawning with `shell: true` plus an args array concatenates them
  // unescaped (Node DEP0190). Resolving the compiler's entry point keeps this
  // shell-free and identical on every platform.
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stdout.write('failed\n');
    process.stderr.write(result.stdout?.toString() ?? '');
    process.stderr.write(result.stderr?.toString() ?? '');
    process.exit(result.status ?? 1);
  }
  process.stdout.write('ok\n');
}

/* 1 — compile ------------------------------------------------------------ */

rmSync(dist, { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
run('compiling', [tsc, '-p', 'tsconfig.build.json']);

/* 2 — static assets ------------------------------------------------------ */

const publicSrc = join(root, 'src', 'web', 'public');
const publicDest = join(dist, 'web', 'public');
mkdirSync(publicDest, { recursive: true });
cpSync(publicSrc, publicDest, { recursive: true });
console.log(`copied web assets    ${readdirSync(publicDest).join(', ')}`);

/* 3 — make the declaration files conventional ---------------------------- */

// Only relative specifiers. A bare package name ending in ".ts" would be an
// odd thing to depend on, but rewriting one would be a real bug.
const SPECIFIER = /(from\s*|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

let rewritten = 0;
for (const file of walk(dist)) {
  if (!file.endsWith('.d.ts')) continue;
  const before = readFileSync(file, 'utf-8');
  const after = before.replace(SPECIFIER, '$1$2$3.js$2');
  if (after !== before) {
    writeFileSync(file, after);
    rewritten += 1;
  }
}
console.log(`rewrote .d.ts paths  ${rewritten} file(s)`);

/* 4 — assert the artifact is actually usable ----------------------------- */

const problems = [];

const binPath = join(dist, 'cli', 'bin.js');
if (!existsSync(binPath)) {
  problems.push('dist/cli/bin.js is missing — package.json "bin" would point at nothing.');
} else if (!readFileSync(binPath, 'utf-8').startsWith('#!/usr/bin/env node')) {
  // tsc preserves a shebang, but silently losing it produces a package whose
  // CLI installs fine and then fails to execute — worth failing the build over.
  problems.push('dist/cli/bin.js lost its shebang, so the installed `fyren` command would not run.');
}

for (const required of ['index.js', 'index.d.ts', join('web', 'public', 'index.html')]) {
  if (!existsSync(join(dist, required))) problems.push(`dist/${required} is missing.`);
}

for (const file of walk(dist)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf-8');
  if (SPECIFIER.test(text)) {
    problems.push(`${file.slice(root.length + 1)} still imports a .ts path.`);
  }
  SPECIFIER.lastIndex = 0;
}

if (problems.length > 0) {
  console.error('\nbuild produced a broken artifact:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('build ok');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
