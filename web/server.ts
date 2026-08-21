/**
 * The local web UI's server. Zero dependencies on purpose — see DECISIONS.md
 * ("no framework"): this is the standard zero-dependency `node:http` pattern,
 * not a shortcut. Serves exactly three static files (hardcoded routes, not a
 * generic file server — there is nothing to path-traverse) plus one JSON
 * endpoint that reuses the same `Profiler` calls the CLI already makes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createProfiler, type ListRunsOptions } from '../src/index.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC_ROUTES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', contentType: 'text/css; charset=utf-8' },
};

export interface WebUiOptions {
  dbPath?: string;
  /** 0 (default) asks the OS for a free port — there is never a "port already in use" failure to handle. */
  port?: number;
  name?: string;
}

export interface WebUi {
  url: string;
  close(): void;
}

export async function startWebUi(options: WebUiOptions = {}): Promise<WebUi> {
  const profiler = createProfiler({ dbPath: options.dbPath ?? '.fyren/runs.db' });
  const listOptions: ListRunsOptions = options.name ? { name: options.name } : {};

  const server = createServer((req, res) => {
    handleRequest(req, res, profiler, listOptions).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`fyren: internal error — ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port ?? 0;
  const url = `http://localhost:${port}/`;

  return {
    url,
    close(): void {
      server.close();
      profiler.close();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  profiler: ReturnType<typeof createProfiler>,
  listOptions: ListRunsOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/summary') {
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : 10;
    const options: ListRunsOptions = { ...listOptions, limit: Number.isInteger(limit) && limit > 0 ? limit : 10 };

    const breakdowns = profiler.costBreakdownRecent(options);
    const aggregate = profiler.aggregateCostBreakdown(options);

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ breakdowns, aggregate }));
    return;
  }

  const route = STATIC_ROUTES[url.pathname];
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fyren: not found');
    return;
  }

  const body = await readFile(path.join(PUBLIC_DIR, route.file), 'utf-8');
  res.writeHead(200, { 'content-type': route.contentType });
  res.end(body);
}
