// Synchronous key-value storage for state that must survive restarts on a hosted server (ADR-0016, #75):
// x402 idempotency records, consumed payment proofs, receipts, trial quotas. Values are JSON-serialisable.
// The SDK defaults to memory; the reference server passes a SQLite-backed store.
export interface KeyValueStore {
  get<T>(namespace: string, key: string): T | undefined;
  set(namespace: string, key: string, value: unknown): void;
  has(namespace: string, key: string): boolean;
  values<T>(namespace: string): T[];
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly #data = new Map<string, Map<string, string>>();

  #ns(namespace: string): Map<string, string> {
    let ns = this.#data.get(namespace);
    if (!ns) {
      ns = new Map();
      this.#data.set(namespace, ns);
    }
    return ns;
  }

  // Values are stored as JSON, as a persistent store would, so callers can't depend on object identity.
  get<T>(namespace: string, key: string): T | undefined {
    const raw = this.#data.get(namespace)?.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  set(namespace: string, key: string, value: unknown): void {
    this.#ns(namespace).set(key, JSON.stringify(value));
  }

  has(namespace: string, key: string): boolean {
    return this.#data.get(namespace)?.has(key) ?? false;
  }

  values<T>(namespace: string): T[] {
    return Array.from(this.#data.get(namespace)?.values() ?? [], (raw) => JSON.parse(raw) as T);
  }
}
