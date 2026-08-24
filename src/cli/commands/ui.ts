/**
 * `fyren ui` (and the older `fyren --ui`) — start the local web UI.
 *
 * This command does not return until the process is interrupted; that is the
 * point of it. The signal handlers set `process.exitCode` and let the runtime
 * unwind rather than calling `process.exit()`, so the profiler's write queue
 * gets flushed on the way out — see DECISIONS.md.
 */

import type { CliContext } from '../index.ts';
import { startWebUi } from '../../web/server.ts';
import { openBrowser } from '../../web/open-browser.ts';

export async function uiCommand(ctx: CliContext): Promise<number> {
  const ui = await startWebUi({
    dbPath: ctx.dbPath,
    port: ctx.port,
    ...(ctx.name !== undefined ? { name: ctx.name } : {}),
    ...(ctx.priceAs !== undefined ? { priceAs: ctx.priceAs } : {}),
  });

  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    ui.close();
  };

  const { palette } = ctx;
  ctx.out(`${palette.bold('fyren')} — web UI running at ${palette.cyan(ui.url)}`);
  ctx.out(palette.dim(`reading ${ctx.dbPath} · press Ctrl+C to stop`));

  if (ctx.openBrowser) openBrowser(ui.url);

  return await new Promise<number>((resolve) => {
    const stop = (): void => {
      shutdown();
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
