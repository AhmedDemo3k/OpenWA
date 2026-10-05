import type { DataSourceOptions } from 'typeorm';

/**
 * Options every SQLite connection in this project must use.
 *
 * TypeORM's SqliteDriver already issues `PRAGMA foreign_keys = ON` unconditionally, but it
 * leaves WAL and the busy timeout opt-in. Both matter a great deal for a long-running
 * WhatsApp gateway:
 *
 *  - Without WAL, SQLite uses a rollback journal, so a reader blocks the writer. Paging
 *    through contacts/groups (hundreds of chats) would stall `lastActiveAt` writes, which
 *    fire on *every* inbound message. Under WAL readers and the writer run concurrently.
 *  - Without `busy_timeout`, a write that collides with another write fails *immediately*
 *    with SQLITE_BUSY instead of waiting. Since Node aborts the process on an unhandled
 *    rejection, a routine write collision would otherwise take the whole gateway down.
 *  - `synchronous = NORMAL` is the recommended durability level under WAL: still crash-safe
 *    against application crashes, without an fsync per commit.
 *
 * `busyTimeout` is expressed in milliseconds and is passed straight through to
 * `PRAGMA busy_timeout`.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 10_000;

export const SQLITE_BASE_OPTIONS = {
  enableWAL: true,
  busyTimeout: SQLITE_BUSY_TIMEOUT_MS,
} as const;

/**
 * Merges the mandatory SQLite pragmas into a TypeORM connection config, keeping whatever
 * entity/migration/synchronize settings the caller provided.
 */
export function withSqlitePragmas<T extends DataSourceOptions>(config: T): T & typeof SQLITE_BASE_OPTIONS {
  return { ...config, ...SQLITE_BASE_OPTIONS };
}
