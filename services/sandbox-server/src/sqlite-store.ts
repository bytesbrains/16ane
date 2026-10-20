import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { KeyValueStore } from "../../../packages/sdk-ts/src/index.ts";

// SQLite-backed KeyValueStore for the hosted server (ADR-0016, #75): one file on the Fly.io volume, so
// idempotency records, consumed payment proofs, receipts, cooldowns, claims and quotas survive restarts.
// Uses Node's built-in node:sqlite (no npm dependency). Node still labels it experimental; the Docker
// image pins the exact Node version, and the store sits behind KeyValueStore so it can be swapped.
export class SqliteKeyValueStore implements KeyValueStore {
  readonly #db: DatabaseSync;
  readonly #get: StatementSync;
  readonly #set: StatementSync;
  readonly #has: StatementSync;
  readonly #values: StatementSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // WAL for concurrent readers; FULL so a recorded idempotency entry or consumed proof survives a crash.
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, " +
        "updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) WITHOUT ROWID",
    );
    this.#get = this.#db.prepare("SELECT value FROM kv WHERE ns = ? AND key = ?");
    this.#set = this.#db.prepare(
      "INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    this.#has = this.#db.prepare("SELECT 1 FROM kv WHERE ns = ? AND key = ?");
    this.#values = this.#db.prepare("SELECT value FROM kv WHERE ns = ? ORDER BY updated_at, key");
  }

  get<T>(namespace: string, key: string): T | undefined {
    const row = this.#get.get(namespace, key) as { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  set(namespace: string, key: string, value: unknown): void {
    this.#set.run(namespace, key, JSON.stringify(value), Date.now());
  }

  has(namespace: string, key: string): boolean {
    return this.#has.get(namespace, key) !== undefined;
  }

  values<T>(namespace: string): T[] {
    return (this.#values.all(namespace) as { value: string }[]).map((row) => JSON.parse(row.value) as T);
  }

  close(): void {
    this.#db.close();
  }
}
