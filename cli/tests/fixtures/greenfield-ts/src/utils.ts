export function formatCurrency(value: number, currency: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  });
  return formatter.format(value);
}

export function parseDateOrNull(input: string): Date | null {
  const ts = Date.parse(input);
  if (Number.isNaN(ts)) {
    return null;
  }
  return new Date(ts);
}

export function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  if (size <= 0) {
    return [];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)];
}

export function groupBy<T, K extends string | number>(
  items: readonly T[],
  pick: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = pick(item);
    const bucket = out[key] ?? [];
    bucket.push(item);
    out[key] = bucket;
  }
  return out;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function once<T>(factory: () => T): () => T {
  let cached: { value: T } | null = null;
  return () => {
    if (cached === null) {
      cached = { value: factory() };
    }
    return cached.value;
  };
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    out[key] = obj[key];
  }
  return out;
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const set = new Set<keyof T>(keys);
  const out = {} as Record<keyof T, unknown>;
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (!set.has(k)) {
      out[k] = obj[k];
    }
  }
  return out as Omit<T, K>;
}
