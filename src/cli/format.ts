/**
 * Shared presentation helpers for the CLI's command modules.
 *
 * Deliberately NOT in `src/analysis/*` — the formatters that live there
 * (`formatCostBreakdown`, `formatAggregateWasteReport`, …) are part of the
 * public library surface and are plain, colourless, stable strings. These are
 * the CLI's own chrome: colour, column alignment, relative timestamps. Keeping
 * them apart is what lets the library's formatters stay dependency-free of any
 * terminal concept while the CLI still gets to look like a real tool.
 */

import { visibleLength, type Palette } from './colors.ts';
import type { NodeStatus } from '../types.ts';

export function usd(n: number): string {
  // Six decimals because a single cheap local call can genuinely cost
  // $0.000004 — rounding to cents would print "$0.00" for the whole point of
  // the tool. The trade is ugly-but-honest over pretty-but-useless.
  return `$${n.toFixed(6)}`;
}

export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.round((now - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function colorStatus(status: NodeStatus, palette: Palette): string {
  if (status === 'ok') return palette.green(status);
  if (status === 'error') return palette.red(status);
  return palette.yellow(status);
}

export type Align = 'left' | 'right';

export interface Column {
  header: string;
  align?: Align;
}

/**
 * Render an aligned table.
 *
 * Widths are measured with `visibleLength`, not `String.length` — cells arrive
 * already coloured, and counting escape bytes as columns is what turns a
 * coloured table into a ragged one.
 */
export function table(columns: readonly Column[], rows: readonly string[][], palette: Palette): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...rows.map((row) => visibleLength(row[i] ?? ''))),
  );

  const renderRow = (cells: readonly string[]): string =>
    columns
      .map((col, i) => {
        const cell = cells[i] ?? '';
        const width = widths[i] ?? 0;
        const padding = ' '.repeat(Math.max(0, width - visibleLength(cell)));
        return col.align === 'right' ? padding + cell : cell + padding;
      })
      .join('  ')
      .trimEnd();

  const header = palette.dim(renderRow(columns.map((col) => col.header)));
  return [header, ...rows.map(renderRow)].join('\n');
}

const BAR_FULL = '#';
const BAR_EMPTY = '.';

/** A fixed-width proportion bar. ASCII on purpose — Windows terminals still mangle block glyphs. */
export function bar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
}

export function indent(text: string, spaces = 2): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

export function heading(text: string, palette: Palette): string {
  return palette.bold(text);
}

/** A boxed callout for the loud warnings (hypothetical pricing, mixed bases). */
export function warnBanner(lines: readonly string[], palette: Palette): string {
  return lines.map((line) => palette.yellow(`! ${line}`)).join('\n');
}
