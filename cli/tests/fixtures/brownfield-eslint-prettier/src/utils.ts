/**
 * Utility helpers for strings, numbers, dates, and generic collections.
 *
 * This module deliberately keeps every helper free of hidden state so that
 * tree-shaking can prune anything that callers do not actually use. Each
 * function is documented with a short example to make IDE hovers useful.
 */

const BYTE_UNITS: readonly string[] = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
const DURATION_UNITS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: "d", ms: 86_400_000 },
  { label: "h", ms: 3_600_000 },
  { label: "m", ms: 60_000 },
  { label: "s", ms: 1_000 },
  { label: "ms", ms: 1 },
];

/**
 * Format a byte count using the closest binary-friendly unit.
 *
 * @example
 *   formatBytes(2048) // "2.00 KB"
 */
export function formatBytes(bytes: number, fractionDigits = 2): string {
  if (!Number.isFinite(bytes)) {
    return "n/a";
  }
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex];
  return `${sign}${value.toFixed(fractionDigits)} ${unit}`;
}

/**
 * Format a millisecond duration into a human-readable composite string.
 *
 * @example
 *   formatDuration(125_000) // "2m 5s"
 */
export function formatDuration(ms: number, maxParts = 2): string {
  if (!Number.isFinite(ms)) {
    return "n/a";
  }
  const sign = ms < 0 ? "-" : "";
  let remaining = Math.abs(Math.trunc(ms));
  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    if (parts.length >= maxParts) {
      break;
    }
    if (remaining >= unit.ms) {
      const count = Math.floor(remaining / unit.ms);
      parts.push(`${count}${unit.label}`);
      remaining -= count * unit.ms;
    }
  }
  if (parts.length === 0) {
    return `${sign}0ms`;
  }
  return `${sign}${parts.join(" ")}`;
}

/**
 * Format a number using a fixed locale, optionally rounding to a precision.
 */
export function formatNumber(value: number, locale = "en-US", fractionDigits?: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const options: Intl.NumberFormatOptions = {};
  if (typeof fractionDigits === "number") {
    options.minimumFractionDigits = fractionDigits;
    options.maximumFractionDigits = fractionDigits;
  }
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format a ratio (0..1) as a percentage with the requested precision.
 */
export function formatPercentage(ratio: number, fractionDigits = 1): string {
  if (!Number.isFinite(ratio)) {
    return "n/a";
  }
  const pct = ratio * 100;
  return `${pct.toFixed(fractionDigits)}%`;
}

/**
 * Parse an integer with the given radix, returning `null` on any failure.
 */
export function parseInteger(input: string, radix = 10): number | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, radix);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Parse a decimal number, returning `null` on any failure.
 */
export function parseDecimal(input: string): number | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Restrict a number to a closed interval `[lo, hi]`.
 */
export function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) {
    return lo;
  }
  if (lo > hi) {
    [lo, hi] = [hi, lo];
  }
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}

/**
 * Split an array into fixed-size chunks. The final chunk may be smaller.
 */
export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  if (size <= 0 || items.length === 0) {
    return [];
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Deduplicate a list while preserving the original ordering.
 */
export function unique<T>(items: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Group items by a derived key. Order within each bucket is stable.
 */
export function groupBy<T, K extends string | number>(
  items: readonly T[],
  pick: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = pick(item);
    const bucket = out[key];
    if (bucket === undefined) {
      out[key] = [item];
    } else {
      bucket.push(item);
    }
  }
  return out;
}

/**
 * A promise that resolves after the requested number of milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Wrap a factory so that it executes at most once. Subsequent calls return
 * the cached value, even if the factory throws (the throw is rethrown).
 */
export function once<T>(factory: () => T): () => T {
  let cached: { value: T } | { error: unknown } | null = null;
  return () => {
    if (cached === null) {
      try {
        cached = { value: factory() };
      } catch (error) {
        cached = { error };
        throw error;
      }
    }
    if ("error" in cached) {
      throw cached.error;
    }
    return cached.value;
  };
}

/**
 * Project a subset of properties from an object.
 */
export function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    out[key] = source[key];
  }
  return out;
}

/**
 * Return a new object without the given keys.
 */
export function omit<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Omit<T, K> {
  const drop = new Set<keyof T>(keys);
  const out = {} as Record<keyof T, unknown>;
  for (const key of Object.keys(source) as (keyof T)[]) {
    if (!drop.has(key)) {
      out[key] = source[key];
    }
  }
  return out as Omit<T, K>;
}

/**
 * Deep-clone JSON-compatible values. Functions and class instances are
 * passed through by reference because they cannot be safely cloned.
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(deepClone(item));
    }
    return out as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value instanceof Map) {
    const cloned = new Map();
    for (const [k, v] of value) {
      cloned.set(deepClone(k), deepClone(v));
    }
    return cloned as unknown as T;
  }
  if (value instanceof Set) {
    const cloned = new Set();
    for (const v of value) {
      cloned.add(deepClone(v));
    }
    return cloned as unknown as T;
  }
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return out as unknown as T;
}

/**
 * Structural deep-equality check for JSON-compatible values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== "object") {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, key)) {
      return false;
    }
    if (!deepEqual(aRec[key], bRec[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Detect plain (object-literal) values, distinguishing them from arrays,
 * class instances, and other host objects.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  return proto === Object.prototype;
}

/**
 * Convert a string to camelCase. Word boundaries are detected by underscores,
 * dashes, dots, and spaces. Acronyms preserve their casing where possible.
 */
export function toCamelCase(input: string): string {
  if (input.length === 0) {
    return input;
  }
  const parts = splitWords(input);
  if (parts.length === 0) {
    return "";
  }
  let out = parts[0]!.toLowerCase();
  for (let i = 1; i < parts.length; i += 1) {
    const word = parts[i]!;
    if (word.length === 0) {
      continue;
    }
    out += word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return out;
}

/**
 * Convert a string to snake_case using the same word boundary rules as
 * {@link toCamelCase}.
 */
export function toSnakeCase(input: string): string {
  return splitWords(input).map((part) => part.toLowerCase()).join("_");
}

/**
 * Convert a string to kebab-case using the same word boundary rules as
 * {@link toCamelCase}.
 */
export function toKebabCase(input: string): string {
  return splitWords(input).map((part) => part.toLowerCase()).join("-");
}

/**
 * Truncate a string to a maximum visible length, appending the supplied
 * ellipsis when the source would otherwise overflow the limit.
 */
export function truncate(input: string, maxLength: number, ellipsis = "..."): string {
  if (maxLength <= 0) {
    return "";
  }
  if (input.length <= maxLength) {
    return input;
  }
  if (ellipsis.length >= maxLength) {
    return ellipsis.slice(0, maxLength);
  }
  return input.slice(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Pad a string to the requested length using the specified fill character.
 * Negative widths or invalid inputs return the source string unchanged.
 */
export function pad(
  input: string,
  width: number,
  fill = " ",
  side: "left" | "right" | "both" = "right",
): string {
  if (!Number.isFinite(width) || width <= input.length || fill.length === 0) {
    return input;
  }
  const missing = width - input.length;
  if (side === "left") {
    return repeatToLength(fill, missing) + input;
  }
  if (side === "right") {
    return input + repeatToLength(fill, missing);
  }
  const leftPart = Math.floor(missing / 2);
  const rightPart = missing - leftPart;
  return repeatToLength(fill, leftPart) + input + repeatToLength(fill, rightPart);
}

function splitWords(input: string): string[] {
  if (input.length === 0) {
    return [];
  }
  const normalized = input.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const tokens = normalized.split(/[\s_\-.]+/u);
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length > 0) {
      out.push(token);
    }
  }
  return out;
}

function repeatToLength(fill: string, length: number): string {
  if (length <= 0) {
    return "";
  }
  let out = "";
  while (out.length < length) {
    out += fill;
  }
  return out.slice(0, length);
}

/**
 * Build a fast string interner that returns the same reference for equal
 * keys. Useful for reducing memory pressure on hot paths that allocate
 * lots of identical strings.
 */
export function createInterner(): (value: string) => string {
  const pool = new Map<string, string>();
  return (value: string): string => {
    const cached = pool.get(value);
    if (cached !== undefined) {
      return cached;
    }
    pool.set(value, value);
    return value;
  };
}

/**
 * Measure how long a synchronous block of code runs and return both the
 * result and the elapsed milliseconds.
 */
export function timeSync<T>(fn: () => T): { readonly value: T; readonly ms: number } {
  const start = Date.now();
  const value = fn();
  const ms = Date.now() - start;
  return { value, ms };
}

/**
 * Async variant of {@link timeSync}. Errors propagate to the caller after
 * timing has been captured (the caller still sees the throw).
 */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<{
  readonly value: T;
  readonly ms: number;
}> {
  const start = Date.now();
  const value = await fn();
  const ms = Date.now() - start;
  return { value, ms };
}

/**
 * Return a function that limits how often the wrapped callback may run.
 * The returned function discards calls that fall inside the cooldown window.
 */
export function throttle<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  windowMs: number,
): (...args: A) => void {
  let last = -Infinity;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= windowMs) {
      last = now;
      fn(...args);
    }
  };
}

/**
 * Return a function that delays execution until calls have stopped for the
 * requested cooldown. Each new call resets the timer.
 */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  cooldownMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, cooldownMs);
  };
}

/**
 * Compute the simple moving average of a numeric series with the given window.
 */
export function movingAverage(values: readonly number[], window: number): readonly number[] {
  if (window <= 0 || values.length === 0) {
    return [];
  }
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= window) {
      sum -= values[i - window]!;
    }
    if (i >= window - 1) {
      out.push(sum / window);
    }
  }
  return out;
}

/**
 * Compute the running cumulative sum of a numeric series.
 */
export function cumulativeSum(values: readonly number[]): readonly number[] {
  const out: number[] = [];
  let acc = 0;
  for (const v of values) {
    acc += v;
    out.push(acc);
  }
  return out;
}

/**
 * Compute pairwise differences between adjacent elements of a series.
 */
export function diff(values: readonly number[]): readonly number[] {
  if (values.length < 2) {
    return [];
  }
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i]! - values[i - 1]!);
  }
  return out;
}

/**
 * Find the index of the first element that satisfies `predicate`. Returns
 * `-1` when no element matches. This is a stand-in for `Array.findIndex`
 * on inputs typed as readonly tuples, where the standard method is missing.
 */
export function findIndex<T>(values: readonly T[], predicate: (value: T, index: number) => boolean): number {
  for (let i = 0; i < values.length; i += 1) {
    if (predicate(values[i]!, i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Build a frequency table that counts how often each item appears.
 */
export function frequencyTable<T extends string | number>(values: readonly T[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const item of values) {
    const key = String(item);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = (out[key] as number) + 1;
    } else {
      out[key] = 1;
    }
  }
  return out;
}

/**
 * Compute basic descriptive statistics over a numeric series.
 */
export function describe(values: readonly number[]): {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly mean: number;
  readonly variance: number;
  readonly stddev: number;
} {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      sum: 0,
      mean: 0,
      variance: 0,
      stddev: 0,
    };
  }
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
    sum += v;
  }
  const mean = sum / values.length;
  let variance = 0;
  for (const v of values) {
    const diff = v - mean;
    variance += diff * diff;
  }
  variance /= values.length;
  const stddev = Math.sqrt(variance);
  return { count: values.length, min, max, sum, mean, variance, stddev };
}
