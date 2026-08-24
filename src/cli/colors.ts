/**
 * ANSI colour, hand-rolled rather than depending on `chalk`/`picocolors`.
 *
 * The whole package has zero runtime dependencies (see DECISIONS.md) and this
 * is ~40 lines of escape codes — taking a dependency for it would be the one
 * thing making `npx fyren-ai` slower to install than it needs to be.
 *
 * Colour is OFF unless we are confident it will render: a redirected stdout, a
 * dumb terminal, `NO_COLOR`, or `--no-color` all disable it. `FORCE_COLOR`
 * overrides in the other direction, for CI logs that do render ANSI.
 */

const ESC = String.fromCharCode(27);

export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
  /** True when this palette actually emits escape codes. */
  enabled: boolean;
}

const plain: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  blue: (t) => t,
  cyan: (t) => t,
  magenta: (t) => t,
  enabled: false,
};

function wrap(open: number, close: number): (text: string) => string {
  const prefix = `${ESC}[${open}m`;
  const suffix = `${ESC}[${close}m`;
  return (text) => prefix + text + suffix;
}

const coloured: Palette = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  enabled: true,
};

export interface ColorContext {
  /** The `--no-color` flag. */
  noColorFlag?: boolean;
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
}

export function paletteFor(context: ColorContext = {}): Palette {
  const env = context.env ?? process.env;
  const isTty = context.isTty ?? Boolean(process.stdout.isTTY);

  if (context.noColorFlag) return plain;
  // The NO_COLOR convention is presence, not truthiness — any non-empty value
  // means "off", including "0". https://no-color.org
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return plain;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return coloured;
  }
  if (env.TERM === 'dumb') return plain;
  return isTty ? coloured : plain;
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Length ignoring escape codes — column padding must not count invisible bytes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

export const NO_COLOR_PALETTE: Palette = plain;
