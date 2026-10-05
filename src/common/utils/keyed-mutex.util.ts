/**
 * Minimal FIFO async mutex, keyed by an arbitrary string.
 *
 * Why this exists: the session lifecycle has check-then-act sequences that span `await`
 * points (`if (engines.has(id)) throw ...` ... `await engine.initialize(...)`). Two
 * concurrent `POST /sessions/:id/start` calls both pass the check before either reaches
 * the `engines.set`, so both proceed and the second silently overwrites the first — the
 * first Chromium process is then unreachable and can never be cleaned up.
 *
 * `withLock` serialises those critical sections per key while still allowing different
 * sessions to make progress in parallel.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn` once all previously queued operations for `key` have settled.
   * The lock is always released, including when `fn` throws.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    // Chain onto the previous holder. `catch` keeps one failed operation from
    // poisoning the queue for every later one.
    const chained = previous.then(
      () => gate,
      () => gate,
    );
    this.tails.set(key, chained);

    // Wait for our turn. `previous` is already settled-or-settled-again by the `catch` above.
    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();
      // Drop the entry once we are the last in line, so the map cannot grow forever.
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * Waits for all in-flight operations to finish. Used on shutdown so a teardown never
   * races an in-flight `start()` that is still creating an engine.
   */
  async drain(): Promise<void> {
    // Snapshot: entries can be deleted as operations complete.
    const pending = Array.from(this.tails.values());
    await Promise.all(pending.map(p => Promise.resolve(p).catch(() => undefined)));
  }

  /** Number of keys with queued or running operations. Exposed for tests/metrics. */
  get size(): number {
    return this.tails.size;
  }
}
