/**
 * SQLite storage.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.18) so the published package
 * has zero native dependencies — `npx fyren` should never make a user wait for
 * a C++ build. See src/sqlite.ts for how the module is loaded.
 *
 * Every method here is SYNCHRONOUS. That is fine: nothing calls it on the
 * user's hot path. The write queue is what keeps the caller non-blocking.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DatabaseSync, type Database } from './sqlite.ts';
import type {
  RunNode,
  WriteOp,
  NodeType,
  NodeStatus,
  TokenBreakdown,
  InputComposition,
} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id                 TEXT PRIMARY KEY,
  parent_id          TEXT,
  root_id            TEXT NOT NULL,
  type               TEXT NOT NULL,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL,

  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  duration_ms        INTEGER,

  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  thinking_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,

  provider           TEXT,
  model              TEXT,
  cache_supported    INTEGER NOT NULL DEFAULT 1,
  error              TEXT,

  metadata           TEXT NOT NULL DEFAULT '{}',
  input_composition  TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_root    ON nodes(root_id, started_at);
CREATE INDEX IF NOT EXISTS idx_nodes_parent  ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_started ON nodes(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_runs    ON nodes(type, name, started_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SCHEMA_VERSION = '2';

/**
 * Columns added after the initial release, each with a plain-value default so
 * old rows read back sensibly. `node:sqlite`'s bundled SQLite predates
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (added in SQLite 3.35), so this
 * checks `PRAGMA table_info` itself rather than relying on that syntax.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'cache_supported', ddl: 'ALTER TABLE nodes ADD COLUMN cache_supported INTEGER NOT NULL DEFAULT 1' },
];

interface NodeRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  type: string;
  name: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  provider: string | null;
  model: string | null;
  cache_supported: number;
  error: string | null;
  metadata: string;
  input_composition: string | null;
}

export interface ListRunsOptions {
  limit?: number;
  /** Exact run name, e.g. only the runs of one agent. */
  name?: string;
}

/** One row of the run-name index the CLI's `--name` and the web UI's filter offer. */
export interface RunNameSummary {
  name: string;
  runCount: number;
  /** Epoch ms of the most recent run with this name. */
  lastStartedAt: number;
}

export class Storage {
  #db: Database;
  #insert;
  #finish;
  #setComposition;
  #closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.#db = new DatabaseSync(dbPath);
    // WAL keeps reads (the future web UI) from blocking writes (the running agent).
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec(SCHEMA);
    this.#migrate();
    this.#db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', SCHEMA_VERSION);

    this.#insert = this.#db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, parent_id, root_id, type, name, status,
        started_at, ended_at, duration_ms,
        input_tokens, output_tokens, thinking_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd,
        provider, model, cache_supported, error, metadata, input_composition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.#finish = this.#db.prepare(`
      UPDATE nodes SET
        status = ?, ended_at = ?, duration_ms = ? - started_at,
        input_tokens = ?, output_tokens = ?, thinking_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?,
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        cache_supported = ?,
        error = ?,
        metadata = ?,
        input_composition = COALESCE(?, input_composition)
      WHERE id = ?
    `);

    // Precise token counting lands after the node is already finished.
    this.#setComposition = this.#db.prepare(
      'UPDATE nodes SET input_composition = ? WHERE id = ?',
    );
  }

  /** Add columns introduced after the initial schema, only where missing. */
  #migrate(): void {
    const existing = new Set(
      (this.#db.prepare('PRAGMA table_info(nodes)').all() as unknown as Array<{ name: string }>).map(
        (col) => col.name,
      ),
    );
    for (const { column, ddl } of COLUMN_MIGRATIONS) {
      if (!existing.has(column)) this.#db.exec(ddl);
    }
  }

  /** Apply a batch of ops in one transaction. */
  applyBatch(ops: readonly WriteOp[]): void {
    if (ops.length === 0) return;

    this.#db.exec('BEGIN');
    try {
      for (const op of ops) {
        if (op.kind === 'insert') this.#applyInsert(op.node);
        else if (op.kind === 'finish') this.#applyFinish(op);
        else this.#setComposition.run(JSON.stringify(op.inputComposition), op.id);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore — the original error is what matters */
      }
      throw err;
    }
  }

  #applyInsert(n: RunNode): void {
    this.#insert.run(
      n.id,
      n.parentId,
      n.rootId,
      n.type,
      n.name,
      n.status,
      n.startedAt,
      n.endedAt,
      n.durationMs,
      n.tokens.input,
      n.tokens.output,
      n.tokens.thinking,
      n.tokens.cacheRead,
      n.tokens.cacheWrite,
      n.costUsd,
      n.provider,
      n.model,
      n.cacheSupported ? 1 : 0,
      n.error,
      JSON.stringify(n.metadata ?? {}),
      n.inputComposition ? JSON.stringify(n.inputComposition) : null,
    );
  }

  #applyFinish(op: Extract<WriteOp, { kind: 'finish' }>): void {
    this.#finish.run(
      op.status,
      op.endedAt,
      op.endedAt,
      op.tokens.input,
      op.tokens.output,
      op.tokens.thinking,
      op.tokens.cacheRead,
      op.tokens.cacheWrite,
      op.costUsd,
      op.provider,
      op.model,
      op.cacheSupported ? 1 : 0,
      op.error,
      JSON.stringify(op.metadata ?? {}),
      op.inputComposition ? JSON.stringify(op.inputComposition) : null,
      op.id,
    );
  }

  /** Every node of one run tree, oldest first. */
  getTree(rootId: string): RunNode[] {
    const rows = this.#db
      .prepare('SELECT * FROM nodes WHERE root_id = ? ORDER BY started_at ASC')
      .all(rootId) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  /** Several trees at once, keyed by rootId. One query, not N. */
  getTrees(rootIds: readonly string[]): Map<string, RunNode[]> {
    const result = new Map<string, RunNode[]>();
    if (rootIds.length === 0) return result;

    const placeholders = rootIds.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(
        `SELECT * FROM nodes WHERE root_id IN (${placeholders}) ORDER BY started_at ASC`,
      )
      .all(...rootIds) as unknown as NodeRow[];

    for (const id of rootIds) result.set(id, []);
    for (const row of rows) {
      const list = result.get(row.root_id);
      if (list) list.push(rowToNode(row));
    }
    return result;
  }

  /** The N most recent runs (root nodes only), newest first. */
  listRuns(options: ListRunsOptions = {}): RunNode[] {
    const limit = options.limit ?? 10;
    const rows = (
      options.name === undefined
        ? this.#db
            .prepare("SELECT * FROM nodes WHERE type = 'run' ORDER BY started_at DESC LIMIT ?")
            .all(limit)
        : this.#db
            .prepare(
              "SELECT * FROM nodes WHERE type = 'run' AND name = ? ORDER BY started_at DESC LIMIT ?",
            )
            .all(options.name, limit)
    ) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  /** Distinct run names, most recently used first — the `--name` / filter dropdown index. */
  listRunNames(): RunNameSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT name, COUNT(*) AS run_count, MAX(started_at) AS last_started_at
           FROM nodes WHERE type = 'run'
          GROUP BY name
          ORDER BY last_started_at DESC`,
      )
      .all() as unknown as Array<{ name: string; run_count: number; last_started_at: number }>;
    return rows.map((r) => ({ name: r.name, runCount: r.run_count, lastStartedAt: r.last_started_at }));
  }

  /**
   * Resolve a full run id, or a unique prefix of one.
   *
   * Every surface that lists runs shows an 8-character prefix, so that prefix
   * is what a user actually has to hand when they want to drill into a run —
   * demanding the full uuid back would make the listing output useless as
   * input to the next command. An ambiguous prefix reports itself as such
   * rather than silently picking one: showing the wrong run's cost is exactly
   * the class of quiet wrongness this project treats as worse than an error.
   */
  resolveRunId(
    idOrPrefix: string,
  ): { kind: 'ok'; id: string } | { kind: 'none' } | { kind: 'ambiguous'; matches: string[] } {
    const rows = this.#db
      .prepare("SELECT id FROM nodes WHERE type = 'run' AND id LIKE ? ORDER BY started_at DESC LIMIT 11")
      .all(`${idOrPrefix}%`) as unknown as Array<{ id: string }>;

    const first = rows[0];
    if (first === undefined) return { kind: 'none' };
    if (rows.length === 1) return { kind: 'ok', id: first.id };
    // An exact full-id hit is never ambiguous, even when it prefixes others.
    const exact = rows.find((r) => r.id === idOrPrefix);
    if (exact) return { kind: 'ok', id: exact.id };
    return { kind: 'ambiguous', matches: rows.map((r) => r.id) };
  }

  /**
   * Idempotent on purpose: `DatabaseSync.close()` throws "database is not
   * open" on a second call, and error-handling code legitimately calls
   * `close()` from more than one place (a `finally` block AND a top-level
   * catch, for instance) — the second call must be a no-op, not a new
   * exception thrown while already handling the first one.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

function rowToNode(r: NodeRow): RunNode {
  const tokens: TokenBreakdown = {
    input: r.input_tokens,
    output: r.output_tokens,
    thinking: r.thinking_tokens,
    cacheRead: r.cache_read_tokens,
    cacheWrite: r.cache_write_tokens,
  };

  return {
    id: r.id,
    parentId: r.parent_id,
    rootId: r.root_id,
    type: r.type as NodeType,
    name: r.name,
    status: r.status as NodeStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    tokens,
    costUsd: r.cost_usd,
    provider: r.provider,
    model: r.model,
    cacheSupported: r.cache_supported !== 0,
    error: r.error,
    metadata: safeParse<Record<string, unknown>>(r.metadata, {}),
    inputComposition: r.input_composition
      ? safeParse<InputComposition | null>(r.input_composition, null)
      : null,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
