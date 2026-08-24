/**
 * The CLI's own presentation layer: colour selection and column alignment.
 *
 * Alignment is the one that has teeth. Cells arrive already coloured, so any
 * padding that measures `String.length` counts invisible escape bytes as
 * columns and produces a table that looks fine in a test snapshot and ragged
 * in a terminal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paletteFor, visibleLength, NO_COLOR_PALETTE } from '../src/cli/colors.ts';
import { bar, duration, int, pct, relativeTime, table, usd } from '../src/cli/format.ts';

const ESC = String.fromCharCode(27);

test('colour is off unless we are confident it renders', () => {
  assert.equal(paletteFor({ env: {}, isTty: false }).enabled, false, 'piped output');
  assert.equal(paletteFor({ env: {}, isTty: true }).enabled, true, 'a tty');
  assert.equal(paletteFor({ noColorFlag: true, env: {}, isTty: true }).enabled, false, '--no-color');
  assert.equal(paletteFor({ env: { TERM: 'dumb' }, isTty: true }).enabled, false, 'dumb terminal');
});

test('NO_COLOR follows the convention: presence disables, even when the value is "0"', () => {
  assert.equal(paletteFor({ env: { NO_COLOR: '1' }, isTty: true }).enabled, false);
  assert.equal(paletteFor({ env: { NO_COLOR: '0' }, isTty: true }).enabled, false);
  // Empty means unset, per the same convention.
  assert.equal(paletteFor({ env: { NO_COLOR: '' }, isTty: true }).enabled, true);
});

test('FORCE_COLOR turns colour on for a pipe, which is how CI logs get it', () => {
  assert.equal(paletteFor({ env: { FORCE_COLOR: '1' }, isTty: false }).enabled, true);
  assert.equal(paletteFor({ env: { FORCE_COLOR: '0' }, isTty: false }).enabled, false);
  // An explicit --no-color beats it: the flag is the more specific instruction.
  assert.equal(paletteFor({ noColorFlag: true, env: { FORCE_COLOR: '1' }, isTty: false }).enabled, false);
});

test('visibleLength ignores escape codes', () => {
  const palette = paletteFor({ env: { FORCE_COLOR: '1' }, isTty: true });
  const coloured = palette.green('ok');
  assert.ok(coloured.length > 2, 'fixture must actually contain escape codes');
  assert.equal(visibleLength(coloured), 2);
  assert.equal(visibleLength('plain'), 5);
});

const strip = (line: string): string => line.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

test('a left-aligned column starts at the same offset even when cells are coloured', () => {
  const palette = paletteFor({ env: { FORCE_COLOR: '1' }, isTty: true });
  const rendered = table(
    [{ header: 'name' }, { header: 'cost' }],
    [
      [palette.cyan('short'), palette.green('$1.00')],
      ['a-much-longer-name', '$12.00'],
    ],
    palette,
  );

  const [, first = '', second = ''] = rendered.split('\n');
  assert.ok(first.length > strip(first).length, 'fixture must actually be coloured');

  const offsets = [first, second].map((line) => strip(line).indexOf('$'));
  assert.equal(offsets[0], offsets[1], `columns misaligned: ${JSON.stringify([strip(first), strip(second)])}`);
});

test('a right-aligned column aligns its right edge, not its first character', () => {
  const palette = paletteFor({ env: { FORCE_COLOR: '1' }, isTty: true });
  const rendered = table(
    [{ header: 'name' }, { header: 'cost', align: 'right' }],
    [
      [palette.cyan('short'), palette.green('$1.00')],
      ['a-much-longer-name', '$12.00'],
    ],
    palette,
  );

  const [, first = '', second = ''] = rendered.split('\n');
  const widths = [first, second].map((line) => strip(line).length);
  assert.equal(widths[0], widths[1], `right edges misaligned: ${JSON.stringify([strip(first), strip(second)])}`);
  // The shorter value is the one that gets padded, on its left.
  assert.match(strip(first), / {2}\$1\.00$/);
});

test('a right-aligned column pads on the left', () => {
  const rendered = table(
    [{ header: 'n', align: 'right' }],
    [['1'], ['1000']],
    NO_COLOR_PALETTE,
  );
  const lines = rendered.split('\n');
  assert.equal(lines[1], '   1');
  assert.equal(lines[2], '1000');
});

test('number and time formatting', () => {
  assert.equal(usd(0.5), '$0.500000');
  assert.equal(pct(0.1234), '12.3%');
  assert.equal(int(1234.6), '1,235');

  assert.equal(duration(null), '—');
  assert.equal(duration(450), '450ms');
  assert.equal(duration(1500), '1.5s');
  assert.equal(duration(90_000), '1m30s');

  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  assert.equal(relativeTime(now - 5_000, now), '5s ago');
  assert.equal(relativeTime(now - 300_000, now), '5m ago');
  assert.equal(relativeTime(now - 7_200_000, now), '2h ago');
  assert.equal(relativeTime(now - 172_800_000, now), '2d ago');
  // A clock skew that puts a run in the future must not render as negative.
  assert.equal(relativeTime(now + 10_000, now), '0s ago');
});

test('bar clamps rather than overflowing its width on out-of-range input', () => {
  assert.equal(bar(0, 4), '....');
  assert.equal(bar(1, 4), '####');
  assert.equal(bar(0.5, 4), '##..');
  assert.equal(bar(2, 4), '####', 'over 100%');
  assert.equal(bar(-1, 4), '....', 'negative');
  assert.equal(bar(Number.NaN, 4), '....', 'NaN from a 0/0 share');
});
