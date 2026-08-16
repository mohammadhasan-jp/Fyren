/**
 * The buffer that sits between the user's code and SQLite.
 *
 * Two hard requirements from the spec, both enforced here:
 *
 *   1. NON-BLOCKING — `enqueue()` only pushes onto an array and returns.
 *      The actual SQLite write happens later, on a timer, off the caller's
 *      await path.
 *
 *   2. NEVER BREAK THE USER'S PROGRAM — if writing fails (disk full, locked
 *      db, corrupt file), we report it through `onError` and drop the batch.
 *      A profiler that crashes the thing it is profiling is worse than no
 *      profiler.
 */

import type { WriteOp } from './types.ts';
import type { Storage } from './storage.ts';

export interface QueueOptions {
  /** Flush at most this often, in ms. */
  flushIntervalMs?: number;
  /** Flush immediately once the buffer reaches this many ops. */
  maxBufferSize?: number;
  /** Called on write failure. Defaults to a one-line warning on stderr. */
  onError?: (err: unknown) => void;
}

export class WriteQueue {
  #storage: Storage;
  #buffer: WriteOp[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  #flushIntervalMs: number;
  #maxBufferSize: number;
  #onError: (err: unknown) => void;

  constructor(storage: Storage, options: QueueOptions = {}) {
    this.#storage = storage;
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#maxBufferSize = options.maxBufferSize ?? 200;
    this.#onError =
      options.onError ??
      ((err) => {
        console.warn('[fyren] failed to write events:', err);
      });
  }

  enqueue(op: WriteOp): void {
    if (this.#closed) return;

    this.#buffer.push(op);

    if (this.#buffer.length >= this.#maxBufferSize) {
      this.flush();
      return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== null) return;

    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#flushIntervalMs);

    // unref so a pending flush never keeps the user's process alive.
    this.#timer.unref?.();
  }

  /** Drain the buffer now. Safe to call at any time; never throws. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#buffer.length === 0) return;

    const batch = this.#buffer;
    this.#buffer = [];

    try {
      this.#storage.applyBatch(batch);
    } catch (err) {
      this.#onError(err);
    }
  }

  /** Final flush; further enqueues are ignored. */
  close(): void {
    this.flush();
    this.#closed = true;
  }

  /** Ops waiting to be written. Exposed for tests. */
  get pending(): number {
    return this.#buffer.length;
  }
}
