export interface StorageEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class KeyNotFoundError extends Error {
  constructor(key: string) {
    super(`Key not found: ${key}`);
    this.name = "KeyNotFoundError";
  }
}

export class MemoryStorage<T> {
  private readonly entries = new Map<string, StorageEntry<T>>();

  put(key: string, value: T): StorageEntry<T> {
    const now = Date.now();
    const previous = this.entries.get(key);
    const entry: StorageEntry<T> = {
      key,
      value,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(key, entry);
    return entry;
  }

  get(key: string): T {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      throw new KeyNotFoundError(key);
    }
    return entry.value;
  }

  tryGet(key: string): T | null {
    const entry = this.entries.get(key);
    return entry?.value ?? null;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  keys(): readonly string[] {
    return [...this.entries.keys()];
  }

  values(): readonly T[] {
    const out: T[] = [];
    for (const entry of this.entries.values()) {
      out.push(entry.value);
    }
    return out;
  }

  entriesList(): readonly StorageEntry<T>[] {
    return [...this.entries.values()];
  }

  filter(predicate: (value: T, key: string) => boolean): readonly T[] {
    const out: T[] = [];
    for (const entry of this.entries.values()) {
      if (predicate(entry.value, entry.key)) {
        out.push(entry.value);
      }
    }
    return out;
  }

  map<U>(transform: (value: T, key: string) => U): readonly U[] {
    const out: U[] = [];
    for (const entry of this.entries.values()) {
      out.push(transform(entry.value, entry.key));
    }
    return out;
  }

  upsert(key: string, factory: () => T, mutate: (current: T) => T): T {
    const current = this.tryGet(key);
    const next = current === null ? factory() : mutate(current);
    this.put(key, next);
    return next;
  }

  snapshot(): Record<string, T> {
    const snap: Record<string, T> = {};
    for (const [key, entry] of this.entries) {
      snap[key] = entry.value;
    }
    return snap;
  }
}
