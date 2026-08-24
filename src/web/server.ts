/**
 * The local web UI's server. Zero dependencies on purpose — see DECISIONS.md
 * ("no framework"): this is the standard zero-dependency `node:http` pattern,
 * not a shortcut.
 *
 * Static assets stay a hardcoded route map rather than a generic file server,
 * for the reason recorded in DECISIONS.md: there is nothing to path-traverse
 * if no request path is ever turned into a filesystem path. Adding files to
 * the UI means adding entries here, which is the intended friction.
 *
 * Every endpoint is a thin projection of a `Profiler` call the CLI also makes.
 * The UI computes nothing the library doesn't — same numbers, same labels,
 * same honesty about hypothetical pricing, whichever surface you look at.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createProfiler, type Profiler } from '../profiler.ts';
import type { CostBreakdownRecentOptions } from '../profiler.ts';
import { packageVersion } from '../cli/version.ts';
import { PRICING } from '../pricing.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const STATIC_ROUTES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', contentType: 'text/css; charset=utf-8' },
};

const DEFAULT_LIMIT = 10;
/** A browser asking for 100k runs should not be able to stall the process. */
const MAX_LIMIT = 500;

export interface WebUiOptions {
  dbPath?: string;
  /** 0 (default) asks the OS for a free port — there is never a "port already in use" failure to handle. */
  port?: number;
  /** Default run-name filter. The UI can override it per request. */
  name?: string;
  /** Default hypothetical-pricing model. The UI can override it per request. */
  priceAs?: string;
}

export interface WebUi {
  url: string;
  port: number;
  close(): void;
}

export async function startWebUi(options: WebUiOptions = {}): Promise<WebUi> {
  const dbPath = options.dbPath ?? '.fyren/runs.db';
  const profiler = createProfiler({ dbPath });

  const defaults = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.priceAs !== undefined ? { priceAs: options.priceAs } : {}),
  };

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, profiler, defaults).catch((err: unknown) => {
      // The UI is a read-only view of a local file; there is no request whose
      // failure should take the server down with it.
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);

  let closed = false;
  return {
    url: `http://localhost:${port}/`,
    port,
    close(): void {
      // Same idempotence rule as Storage.close(): shutdown legitimately gets
      // called from both a signal handler and a `finally`.
      if (closed) return;
      closed = true;
      server.close();
      profiler.close();
    },
  };
}

interface RequestDefaults {
  name?: string;
  priceAs?: string;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  profiler: Profiler,
  defaults: RequestDefaults,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    handleApi(url, res, profiler, defaults);
    return;
  }

  const route = STATIC_ROUTES[url.pathname];
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fyren: not found');
    return;
  }

  const body = await readFile(path.join(PUBLIC_DIR, route.file), 'utf-8');
  res.writeHead(200, {
    'content-type': route.contentType,
    // The data changes every time an agent runs; a cached shell showing last
    // week's numbers is worse than a re-fetch on a localhost server.
    'cache-control': 'no-store',
  });
  res.end(body);
}

function handleApi(url: URL, res: ServerResponse, profiler: Profiler, defaults: RequestDefaults): void {
  const selector = selectorFromQuery(url, defaults);

  if (url.pathname === '/api/meta') {
    sendJson(res, 200, {
      version: packageVersion(),
      dbPath: profiler.dbPath,
      runNames: profiler.listRunNames(),
      // Offered as autocomplete for the "price as" box. Every id here has a
      // real rate, so picking one can never produce a silent $0 report.
      pricedModels: Object.keys(PRICING).sort(),
    });
    return;
  }

  if (url.pathname === '/api/summary') {
    sendJson(res, 200, {
      dbPath: profiler.dbPath,
      selector: { limit: selector.limit, name: selector.name ?? null, priceAs: selector.priceAs ?? null },
      breakdowns: profiler.costBreakdownRecent(selector),
      aggregate: profiler.aggregateCostBreakdown(selector),
      waste: profiler.aggregateWasteReport(selector),
    });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (runMatch) {
    const requested = decodeURIComponent(runMatch[1] ?? '');
    const resolved = profiler.resolveRunId(requested);
    if (resolved.kind === 'none') {
      sendJson(res, 404, { error: `no run matches "${requested}"` });
      return;
    }
    if (resolved.kind === 'ambiguous') {
      sendJson(res, 409, { error: `"${requested}" matches ${resolved.matches.length} runs`, matches: resolved.matches });
      return;
    }

    const costOptions = selector.priceAs !== undefined ? { priceAs: selector.priceAs } : {};
    sendJson(res, 200, {
      breakdown: profiler.costBreakdown(resolved.id, costOptions),
      waste: profiler.wasteReport(resolved.id, costOptions),
      tree: profiler.getTree(resolved.id),
    });
    return;
  }

  sendJson(res, 404, { error: 'unknown endpoint' });
}

function selectorFromQuery(url: URL, defaults: RequestDefaults): CostBreakdownRecentOptions {
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  // An empty query value means "explicitly cleared in the UI", which is not
  // the same as "absent, fall back to the flag the server was started with".
  const nameParam = url.searchParams.get('name');
  const name = nameParam === null ? defaults.name : nameParam === '' ? undefined : nameParam;

  const priceAsParam = url.searchParams.get('priceAs');
  const priceAs =
    priceAsParam === null ? defaults.priceAs : priceAsParam === '' ? undefined : priceAsParam;

  return {
    limit,
    ...(name !== undefined ? { name } : {}),
    ...(priceAs !== undefined ? { priceAs } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
