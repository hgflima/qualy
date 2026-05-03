/**
 * In-memory key-value store with TTL expiration and pluggable eviction.
 *
 * The store keeps every entry in a plain `Map`, but layers on a doubly-linked
 * list to support O(1) least-recently-used (LRU) eviction. A periodic sweep
 * is responsible for reaping expired entries; callers can also invoke the
 * sweep manually from inside their own scheduling primitives.
 */

export type EvictionStrategy = "lru" | "fifo" | "none";

export interface StoreOptions {
  readonly maxEntries: number;
  readonly defaultTtlMs: number | null;
  readonly evictionStrategy: EvictionStrategy;
  readonly sweepIntervalMs: number;
  readonly clock: () => number;
}

const DEFAULT_OPTIONS: StoreOptions = {
  maxEntries: 1024,
  defaultTtlMs: null,
  evictionStrategy: "lru",
  sweepIntervalMs: 60_000,
  clock: () => Date.now(),
};

export interface StorageEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly expiresAt: number | null;
  readonly hits: number;
}

export interface EvictionEvent<T> {
  readonly reason: "expired" | "capacity" | "manual";
  readonly entry: StorageEntry<T>;
}

export type EvictionListener<T> = (event: EvictionEvent<T>) => void;

export class KeyNotFoundError extends Error {
  constructor(key: string) {
    super(`Key not found in store: ${key}`);
    this.name = "KeyNotFoundError";
  }
}

export class StoreClosedError extends Error {
  constructor() {
    super("Store has been closed and cannot be used.");
    this.name = "StoreClosedError";
  }
}

export class TtlExpiredError extends Error {
  constructor(key: string) {
    super(`Key ${key} has an expired TTL.`);
    this.name = "TtlExpiredError";
  }
}

interface InternalEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;
  expiresAt: number | null;
  hits: number;
  prev: InternalEntry<T> | null;
  next: InternalEntry<T> | null;
}

export class InMemoryStore<T> {
  private readonly options: StoreOptions;
  private readonly entries: Map<string, InternalEntry<T>>;
  private readonly listeners: Set<EvictionListener<T>>;
  private head: InternalEntry<T> | null;
  private tail: InternalEntry<T> | null;
  private closed: boolean;
  private sweepHandle: ReturnType<typeof setInterval> | null;
  private hitCount: number;
  private missCount: number;
  private writeCount: number;
  private evictionCount: number;

  constructor(options: Partial<StoreOptions> = {}) {
    this.options = {
      maxEntries: options.maxEntries ?? DEFAULT_OPTIONS.maxEntries,
      defaultTtlMs: options.defaultTtlMs ?? DEFAULT_OPTIONS.defaultTtlMs,
      evictionStrategy: options.evictionStrategy ?? DEFAULT_OPTIONS.evictionStrategy,
      sweepIntervalMs: options.sweepIntervalMs ?? DEFAULT_OPTIONS.sweepIntervalMs,
      clock: options.clock ?? DEFAULT_OPTIONS.clock,
    };
    if (this.options.maxEntries <= 0) {
      throw new Error("maxEntries must be greater than zero.");
    }
    this.entries = new Map();
    this.listeners = new Set();
    this.head = null;
    this.tail = null;
    this.closed = false;
    this.sweepHandle = null;
    this.hitCount = 0;
    this.missCount = 0;
    this.writeCount = 0;
    this.evictionCount = 0;
  }

  /**
   * Begin the periodic sweep that removes expired entries. Safe to call
   * multiple times; subsequent calls are no-ops.
   */
  startSweeping(): void {
    this.assertOpen();
    if (this.sweepHandle !== null) {
      return;
    }
    if (this.options.sweepIntervalMs <= 0) {
      return;
    }
    this.sweepHandle = setInterval(() => {
      this.sweepExpired();
    }, this.options.sweepIntervalMs);
    if (typeof (this.sweepHandle as { unref?: () => void }).unref === "function") {
      (this.sweepHandle as { unref: () => void }).unref();
    }
  }

  /**
   * Stop the periodic sweep without otherwise affecting the store contents.
   */
  stopSweeping(): void {
    if (this.sweepHandle !== null) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /**
   * Subscribe to eviction events. Returns an unsubscribe function.
   */
  onEviction(listener: EvictionListener<T>): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Insert or update an entry. The optional TTL overrides the store default.
   */
  put(key: string, value: T, ttlMs: number | null = null): StorageEntry<T> {
    this.assertOpen();
    const now = this.options.clock();
    const existing = this.entries.get(key);
    const effectiveTtl = ttlMs ?? this.options.defaultTtlMs;
    const expiresAt = effectiveTtl === null ? null : now + effectiveTtl;
    if (existing !== undefined) {
      existing.value = value;
      existing.updatedAt = now;
      existing.accessedAt = now;
      existing.expiresAt = expiresAt;
      this.touch(existing);
      this.writeCount += 1;
      return this.toExternal(existing);
    }
    const entry: InternalEntry<T> = {
      key,
      value,
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
      expiresAt,
      hits: 0,
      prev: null,
      next: null,
    };
    this.entries.set(key, entry);
    this.appendToList(entry);
    this.writeCount += 1;
    if (this.entries.size > this.options.maxEntries) {
      this.evictOne("capacity");
    }
    return this.toExternal(entry);
  }

  /**
   * Retrieve a value, throwing when the key is missing or expired.
   */
  get(key: string): T {
    this.assertOpen();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      throw new KeyNotFoundError(key);
    }
    if (this.isExpired(entry)) {
      this.removeEntry(entry, "expired");
      this.missCount += 1;
      throw new TtlExpiredError(key);
    }
    this.recordHit(entry);
    return entry.value;
  }

  /**
   * Retrieve a value, or `null` when the key is missing or expired.
   */
  tryGet(key: string): T | null {
    if (this.closed) {
      return null;
    }
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return null;
    }
    if (this.isExpired(entry)) {
      this.removeEntry(entry, "expired");
      this.missCount += 1;
      return null;
    }
    this.recordHit(entry);
    return entry.value;
  }

  /**
   * Read the metadata associated with a key without bumping the LRU position.
   */
  peek(key: string): StorageEntry<T> | null {
    if (this.closed) {
      return null;
    }
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.isExpired(entry)) {
      return null;
    }
    return this.toExternal(entry);
  }

  /**
   * Whether the store currently contains a fresh entry for the key.
   */
  has(key: string): boolean {
    if (this.closed) {
      return false;
    }
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.removeEntry(entry, "expired");
      return false;
    }
    return true;
  }

  /**
   * Remove a single entry and emit a manual eviction event.
   */
  delete(key: string): boolean {
    this.assertOpen();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.removeEntry(entry, "manual");
    return true;
  }

  /**
   * Remove every entry and emit manual eviction events for each one.
   */
  clear(): void {
    this.assertOpen();
    for (const entry of [...this.entries.values()]) {
      this.removeEntry(entry, "manual");
    }
  }

  /**
   * Number of currently stored entries (including any that have expired but
   * have not yet been swept).
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Snapshot of every key currently in the store, in insertion order.
   */
  keys(): readonly string[] {
    if (this.closed) {
      return [];
    }
    const out: string[] = [];
    let cursor = this.head;
    while (cursor !== null) {
      out.push(cursor.key);
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Snapshot of every value currently in the store.
   */
  values(): readonly T[] {
    if (this.closed) {
      return [];
    }
    const out: T[] = [];
    let cursor = this.head;
    while (cursor !== null) {
      out.push(cursor.value);
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Snapshot of every entry's metadata view.
   */
  entriesList(): readonly StorageEntry<T>[] {
    if (this.closed) {
      return [];
    }
    const out: StorageEntry<T>[] = [];
    let cursor = this.head;
    while (cursor !== null) {
      out.push(this.toExternal(cursor));
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Filter entries by predicate, returning matching values.
   */
  filter(predicate: (value: T, key: string) => boolean): readonly T[] {
    if (this.closed) {
      return [];
    }
    const out: T[] = [];
    let cursor = this.head;
    while (cursor !== null) {
      if (!this.isExpired(cursor) && predicate(cursor.value, cursor.key)) {
        out.push(cursor.value);
      }
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Map entries, skipping any that are currently expired.
   */
  map<U>(transform: (value: T, key: string) => U): readonly U[] {
    if (this.closed) {
      return [];
    }
    const out: U[] = [];
    let cursor = this.head;
    while (cursor !== null) {
      if (!this.isExpired(cursor)) {
        out.push(transform(cursor.value, cursor.key));
      }
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Insert when missing, mutate when present. Returns the resulting value.
   */
  upsert(key: string, factory: () => T, mutate: (current: T) => T, ttlMs: number | null = null): T {
    this.assertOpen();
    const current = this.tryGet(key);
    const next = current === null ? factory() : mutate(current);
    this.put(key, next, ttlMs);
    return next;
  }

  /**
   * Increment a numeric counter stored under `key`, creating it when missing.
   */
  increment(key: string, delta = 1): number {
    return (this.upsert(
      key,
      () => 0 as unknown as T,
      (current) => ((current as unknown as number) + delta) as unknown as T,
    ) as unknown) as number;
  }

  /**
   * Reset hit/miss counters. Useful for periodic reporting.
   */
  resetMetrics(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.writeCount = 0;
    this.evictionCount = 0;
  }

  /**
   * Read accumulated counters since the last reset.
   */
  metrics(): {
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
    readonly evictions: number;
    readonly hitRatio: number;
  } {
    const total = this.hitCount + this.missCount;
    const hitRatio = total === 0 ? 0 : this.hitCount / total;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      writes: this.writeCount,
      evictions: this.evictionCount,
      hitRatio,
    };
  }

  /**
   * Sweep through the store and remove every entry that is past its TTL.
   * Returns the number of entries reaped.
   */
  sweepExpired(): number {
    if (this.closed) {
      return 0;
    }
    let reaped = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.isExpired(entry)) {
        this.removeEntry(entry, "expired");
        reaped += 1;
      }
    }
    return reaped;
  }

  /**
   * Build a plain object snapshot of `key -> value`. Expired entries are
   * skipped but not reaped.
   */
  snapshot(): Record<string, T> {
    if (this.closed) {
      return {};
    }
    const out: Record<string, T> = {};
    let cursor = this.head;
    while (cursor !== null) {
      if (!this.isExpired(cursor)) {
        out[cursor.key] = cursor.value;
      }
      cursor = cursor.next;
    }
    return out;
  }

  /**
   * Replace the store contents with the contents of a plain object. Existing
   * entries are removed via manual eviction events.
   */
  restore(snapshot: Record<string, T>, ttlMs: number | null = null): void {
    this.assertOpen();
    this.clear();
    for (const key of Object.keys(snapshot)) {
      this.put(key, snapshot[key]!, ttlMs);
    }
  }

  /**
   * Close the store. Future operations will throw {@link StoreClosedError}.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.stopSweeping();
    this.closed = true;
    this.entries.clear();
    this.listeners.clear();
    this.head = null;
    this.tail = null;
  }

  /**
   * Whether the store has been closed.
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Read-only access to the merged options object.
   */
  getOptions(): StoreOptions {
    return { ...this.options };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StoreClosedError();
    }
  }

  private isExpired(entry: InternalEntry<T>): boolean {
    if (entry.expiresAt === null) {
      return false;
    }
    return this.options.clock() >= entry.expiresAt;
  }

  private recordHit(entry: InternalEntry<T>): void {
    entry.hits += 1;
    entry.accessedAt = this.options.clock();
    this.hitCount += 1;
    this.touch(entry);
  }

  private touch(entry: InternalEntry<T>): void {
    if (this.options.evictionStrategy !== "lru") {
      return;
    }
    if (this.tail === entry) {
      return;
    }
    this.detach(entry);
    this.appendToList(entry);
  }

  private appendToList(entry: InternalEntry<T>): void {
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail !== null) {
      this.tail.next = entry;
    }
    this.tail = entry;
    if (this.head === null) {
      this.head = entry;
    }
  }

  private detach(entry: InternalEntry<T>): void {
    const prev = entry.prev;
    const next = entry.next;
    if (prev !== null) {
      prev.next = next;
    } else {
      this.head = next;
    }
    if (next !== null) {
      next.prev = prev;
    } else {
      this.tail = prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  private removeEntry(entry: InternalEntry<T>, reason: EvictionEvent<T>["reason"]): void {
    this.entries.delete(entry.key);
    this.detach(entry);
    if (reason !== "manual") {
      this.evictionCount += 1;
    }
    const event: EvictionEvent<T> = {
      reason,
      entry: this.toExternal(entry),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.handleListenerError(error);
      }
    }
  }

  private evictOne(reason: EvictionEvent<T>["reason"]): void {
    if (this.options.evictionStrategy === "none") {
      return;
    }
    let victim: InternalEntry<T> | null;
    if (this.options.evictionStrategy === "fifo") {
      victim = this.head;
    } else {
      victim = this.head;
    }
    if (victim === null) {
      return;
    }
    this.removeEntry(victim, reason);
  }

  private handleListenerError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(`Eviction listener failed: ${message}`);
    }
  }

  private toExternal(entry: InternalEntry<T>): StorageEntry<T> {
    return {
      key: entry.key,
      value: entry.value,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      accessedAt: entry.accessedAt,
      expiresAt: entry.expiresAt,
      hits: entry.hits,
    };
  }
}

/**
 * Convenience factory that creates a store with sensible defaults for
 * short-lived caches (60 second TTL, LRU eviction, 256 entries).
 */
export function createCache<T>(): InMemoryStore<T> {
  return new InMemoryStore<T>({
    maxEntries: 256,
    defaultTtlMs: 60_000,
    evictionStrategy: "lru",
    sweepIntervalMs: 30_000,
  });
}

/**
 * Convenience factory for an unbounded session store with no TTL.
 */
export function createSessionStore<T>(): InMemoryStore<T> {
  return new InMemoryStore<T>({
    maxEntries: 10_000,
    defaultTtlMs: null,
    evictionStrategy: "lru",
    sweepIntervalMs: 0,
  });
}

/**
 * Bulk import key-value pairs into an existing store.
 */
export function bulkImport<T>(
  store: InMemoryStore<T>,
  pairs: readonly (readonly [string, T])[],
  ttlMs: number | null = null,
): number {
  let count = 0;
  for (const [key, value] of pairs) {
    store.put(key, value, ttlMs);
    count += 1;
  }
  return count;
}

/**
 * Compute a coarse usage report for diagnostic dashboards.
 */
export function describeStore<T>(store: InMemoryStore<T>): {
  readonly size: number;
  readonly metrics: ReturnType<InMemoryStore<T>["metrics"]>;
  readonly options: StoreOptions;
} {
  return {
    size: store.size(),
    metrics: store.metrics(),
    options: store.getOptions(),
  };
}
