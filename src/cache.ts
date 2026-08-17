interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LruTtlCache {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, CacheEntry<unknown>>();

  public constructor(maxEntries = 1_000) {
    this.#maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  public get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value as T;
  }

  public set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  public delete(key: string): void {
    this.#entries.delete(key);
  }

  public clear(): void {
    this.#entries.clear();
  }

  public get size(): number {
    return this.#entries.size;
  }
}
