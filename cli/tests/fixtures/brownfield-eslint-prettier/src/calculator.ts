/**
 * A history-aware numerical calculator with optional precision controls.
 *
 * The {@link Calculator} class is intentionally synchronous and side-effect
 * free aside from the rolling history buffer. It is used as a stand-in for
 * a small computation engine in fixture tests.
 */

export type Operation =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "modulo"
  | "power"
  | "sqrt"
  | "negate"
  | "abs";

export interface CalculatorConfig {
  readonly maxHistory: number;
  readonly precision: number;
  readonly overflowGuard: number;
}

const DEFAULT_CONFIG: CalculatorConfig = {
  maxHistory: 256,
  precision: 12,
  overflowGuard: Number.MAX_SAFE_INTEGER / 2,
};

export interface CalculationRecord {
  readonly op: Operation;
  readonly inputs: readonly number[];
  readonly result: number;
  readonly at: number;
  readonly tag: string | null;
}

export interface CalculatorSnapshot {
  readonly history: readonly CalculationRecord[];
  readonly memory: number;
  readonly running: boolean;
  readonly tally: Readonly<Record<Operation, number>>;
}

export class DivisionByZeroError extends Error {
  constructor() {
    super("Division by zero is not permitted by this calculator.");
    this.name = "DivisionByZeroError";
  }
}

export class OverflowError extends Error {
  constructor(value: number) {
    super(`Result ${value} exceeds the configured overflow guard.`);
    this.name = "OverflowError";
  }
}

export class PrecisionError extends Error {
  constructor(precision: number) {
    super(`Precision must be between 0 and 20, received ${precision}.`);
    this.name = "PrecisionError";
  }
}

export class Calculator {
  private readonly config: CalculatorConfig;
  private history: CalculationRecord[];
  private memory: number;
  private running: boolean;
  private readonly tally: Record<Operation, number>;

  constructor(config: Partial<CalculatorConfig> = {}) {
    const merged: CalculatorConfig = {
      maxHistory: config.maxHistory ?? DEFAULT_CONFIG.maxHistory,
      precision: config.precision ?? DEFAULT_CONFIG.precision,
      overflowGuard: config.overflowGuard ?? DEFAULT_CONFIG.overflowGuard,
    };
    if (merged.precision < 0 || merged.precision > 20) {
      throw new PrecisionError(merged.precision);
    }
    this.config = merged;
    this.history = [];
    this.memory = 0;
    this.running = false;
    this.tally = {
      add: 0,
      subtract: 0,
      multiply: 0,
      divide: 0,
      modulo: 0,
      power: 0,
      sqrt: 0,
      negate: 0,
      abs: 0,
    };
  }

  /**
   * Add two numbers and record the operation in history.
   */
  add(a: number, b: number, tag: string | null = null): number {
    return this.record("add", [a, b], a + b, tag);
  }

  /**
   * Subtract `b` from `a` and record the operation.
   */
  subtract(a: number, b: number, tag: string | null = null): number {
    return this.record("subtract", [a, b], a - b, tag);
  }

  /**
   * Multiply two numbers and record the operation.
   */
  multiply(a: number, b: number, tag: string | null = null): number {
    return this.record("multiply", [a, b], a * b, tag);
  }

  /**
   * Divide `a` by `b`, raising {@link DivisionByZeroError} when `b` is zero.
   */
  divide(a: number, b: number, tag: string | null = null): number {
    if (b === 0) {
      throw new DivisionByZeroError();
    }
    return this.record("divide", [a, b], a / b, tag);
  }

  /**
   * Compute `a mod b`, raising {@link DivisionByZeroError} when `b` is zero.
   */
  modulo(a: number, b: number, tag: string | null = null): number {
    if (b === 0) {
      throw new DivisionByZeroError();
    }
    return this.record("modulo", [a, b], a % b, tag);
  }

  /**
   * Compute `a` raised to the `b` exponent.
   */
  power(a: number, b: number, tag: string | null = null): number {
    return this.record("power", [a, b], a ** b, tag);
  }

  /**
   * Square root for non-negative values. Negative inputs throw.
   */
  sqrt(value: number, tag: string | null = null): number {
    if (value < 0) {
      throw new RangeError(`sqrt requires non-negative input, received ${value}`);
    }
    return this.record("sqrt", [value], Math.sqrt(value), tag);
  }

  /**
   * Negate a value (multiply by -1) and record the operation.
   */
  negate(value: number, tag: string | null = null): number {
    return this.record("negate", [value], -value, tag);
  }

  /**
   * Absolute value of a number.
   */
  abs(value: number, tag: string | null = null): number {
    return this.record("abs", [value], Math.abs(value), tag);
  }

  /**
   * Sum a list of numbers using the recorded `add` operation. Useful for
   * pipelines that want every intermediate step preserved.
   */
  sum(values: readonly number[], tag: string | null = null): number {
    let total = 0;
    for (const v of values) {
      total = this.add(total, v, tag);
    }
    return total;
  }

  /**
   * Arithmetic mean of a list. Empty input returns zero.
   */
  average(values: readonly number[], tag: string | null = null): number {
    if (values.length === 0) {
      return 0;
    }
    const total = this.sum(values, tag);
    return this.divide(total, values.length, tag);
  }

  /**
   * Population variance computed via the textbook two-pass algorithm.
   */
  variance(values: readonly number[], tag: string | null = null): number {
    if (values.length === 0) {
      return 0;
    }
    const mean = this.average(values, tag);
    let acc = 0;
    for (const v of values) {
      const diff = this.subtract(v, mean, tag);
      acc = this.add(acc, this.multiply(diff, diff, tag), tag);
    }
    return this.divide(acc, values.length, tag);
  }

  /**
   * Population standard deviation.
   */
  stddev(values: readonly number[], tag: string | null = null): number {
    return this.sqrt(this.variance(values, tag), tag);
  }

  /**
   * Smallest value in the input. Empty input returns null.
   */
  min(values: readonly number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    let m = values[0]!;
    for (const v of values) {
      if (v < m) {
        m = v;
      }
    }
    return m;
  }

  /**
   * Largest value in the input. Empty input returns null.
   */
  max(values: readonly number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    let m = values[0]!;
    for (const v of values) {
      if (v > m) {
        m = v;
      }
    }
    return m;
  }

  /**
   * Difference between max and min, recorded as a single subtraction.
   */
  range(values: readonly number[], tag: string | null = null): number {
    const lo = this.min(values);
    const hi = this.max(values);
    if (lo === null || hi === null) {
      return 0;
    }
    return this.subtract(hi, lo, tag);
  }

  /**
   * Median value. For an even count, returns the mean of the two middles.
   */
  median(values: readonly number[], tag: string | null = null): number {
    if (values.length === 0) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[mid]!;
    }
    return this.average([sorted[mid - 1]!, sorted[mid]!], tag);
  }

  /**
   * Add the current accumulator to the persistent memory cell.
   */
  memoryAdd(value: number): number {
    this.memory = this.add(this.memory, value);
    return this.memory;
  }

  /**
   * Subtract the supplied value from the persistent memory cell.
   */
  memorySubtract(value: number): number {
    this.memory = this.subtract(this.memory, value);
    return this.memory;
  }

  /**
   * Read the persistent memory cell.
   */
  memoryRecall(): number {
    return this.memory;
  }

  /**
   * Reset the persistent memory cell to zero.
   */
  memoryClear(): void {
    this.memory = 0;
  }

  /**
   * Round a value using the calculator's configured precision.
   */
  roundToPrecision(value: number): number {
    const factor = 10 ** this.config.precision;
    return Math.round(value * factor) / factor;
  }

  /**
   * Return up to the last `limit` history entries, newest last.
   */
  recent(limit = 16): readonly CalculationRecord[] {
    if (limit <= 0) {
      return [];
    }
    if (limit >= this.history.length) {
      return [...this.history];
    }
    return this.history.slice(-limit);
  }

  /**
   * Search the history for entries that match a tag substring.
   */
  findByTag(tag: string): readonly CalculationRecord[] {
    if (tag.length === 0) {
      return [];
    }
    const out: CalculationRecord[] = [];
    for (const entry of this.history) {
      if (entry.tag !== null && entry.tag.includes(tag)) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Filter history entries by operation kind.
   */
  findByOperation(op: Operation): readonly CalculationRecord[] {
    const out: CalculationRecord[] = [];
    for (const entry of this.history) {
      if (entry.op === op) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Filter history entries that occurred within a closed time window.
   */
  findByTimeRange(fromMs: number, toMs: number): readonly CalculationRecord[] {
    const out: CalculationRecord[] = [];
    for (const entry of this.history) {
      if (entry.at >= fromMs && entry.at <= toMs) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Reset history and counters but keep the memory cell intact.
   */
  resetHistory(): void {
    this.history = [];
    for (const op of Object.keys(this.tally) as Operation[]) {
      this.tally[op] = 0;
    }
  }

  /**
   * Reset everything: history, memory, and counters.
   */
  reset(): void {
    this.resetHistory();
    this.memory = 0;
    this.running = false;
  }

  /**
   * Export an immutable snapshot of the current state.
   */
  snapshot(): CalculatorSnapshot {
    return {
      history: [...this.history],
      memory: this.memory,
      running: this.running,
      tally: { ...this.tally },
    };
  }

  /**
   * Restore from a previously captured snapshot.
   */
  restore(snapshot: CalculatorSnapshot): void {
    this.history = [...snapshot.history];
    this.memory = snapshot.memory;
    this.running = snapshot.running;
    for (const op of Object.keys(this.tally) as Operation[]) {
      this.tally[op] = snapshot.tally[op] ?? 0;
    }
  }

  /**
   * Mark the calculator as running; useful for callers that drive a UI.
   */
  start(): void {
    this.running = true;
  }

  /**
   * Mark the calculator as paused.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Whether the calculator is currently in a running state.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Number of recorded history entries.
   */
  size(): number {
    return this.history.length;
  }

  /**
   * Read-only access to the current configuration.
   */
  getConfig(): CalculatorConfig {
    return { ...this.config };
  }

  /**
   * Number of times each operation has been used since the last reset.
   */
  getTally(): Readonly<Record<Operation, number>> {
    return { ...this.tally };
  }

  private record(op: Operation, inputs: readonly number[], result: number, tag: string | null): number {
    if (!Number.isFinite(result)) {
      throw new OverflowError(result);
    }
    if (Math.abs(result) > this.config.overflowGuard) {
      throw new OverflowError(result);
    }
    const rounded = this.roundToPrecision(result);
    const entry: CalculationRecord = {
      op,
      inputs: [...inputs],
      result: rounded,
      at: Date.now(),
      tag,
    };
    this.history.push(entry);
    if (this.history.length > this.config.maxHistory) {
      this.history.splice(0, this.history.length - this.config.maxHistory);
    }
    this.tally[op] += 1;
    return rounded;
  }
}

/**
 * Build a calculator pre-loaded with a tiny demo history. Used by smoke
 * tests and documentation snippets.
 */
export function createDemoCalculator(): Calculator {
  const calc = new Calculator({ maxHistory: 32, precision: 6 });
  calc.add(2, 3, "demo");
  calc.subtract(10, 4, "demo");
  calc.multiply(6, 7, "demo");
  calc.divide(20, 4, "demo");
  calc.power(2, 8, "demo");
  return calc;
}

/**
 * Apply a calculator operation generically. Useful when an operation is
 * driven by external configuration or a serialized payload.
 */
export function applyOperation(
  calc: Calculator,
  op: Operation,
  inputs: readonly number[],
  tag: string | null = null,
): number {
  switch (op) {
    case "add":
      return calc.add(inputs[0] ?? 0, inputs[1] ?? 0, tag);
    case "subtract":
      return calc.subtract(inputs[0] ?? 0, inputs[1] ?? 0, tag);
    case "multiply":
      return calc.multiply(inputs[0] ?? 0, inputs[1] ?? 0, tag);
    case "divide":
      return calc.divide(inputs[0] ?? 0, inputs[1] ?? 1, tag);
    case "modulo":
      return calc.modulo(inputs[0] ?? 0, inputs[1] ?? 1, tag);
    case "power":
      return calc.power(inputs[0] ?? 0, inputs[1] ?? 1, tag);
    case "sqrt":
      return calc.sqrt(inputs[0] ?? 0, tag);
    case "negate":
      return calc.negate(inputs[0] ?? 0, tag);
    case "abs":
      return calc.abs(inputs[0] ?? 0, tag);
    default: {
      const exhaustiveCheck: never = op;
      throw new Error(`Unknown operation: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Replay a sequence of {@link CalculationRecord} entries onto a fresh
 * calculator. The resulting calculator has the same final state but with
 * a contiguous, deterministic timestamp range.
 */
export function replay(records: readonly CalculationRecord[]): Calculator {
  const calc = new Calculator();
  for (const record of records) {
    applyOperation(calc, record.op, record.inputs, record.tag);
  }
  return calc;
}

/**
 * Compare two calculators for state equality. The comparison ignores
 * recorded timestamps because those depend on wall-clock time.
 */
export function equivalent(a: Calculator, b: Calculator): boolean {
  const sa = a.snapshot();
  const sb = b.snapshot();
  if (sa.memory !== sb.memory) {
    return false;
  }
  if (sa.history.length !== sb.history.length) {
    return false;
  }
  for (let i = 0; i < sa.history.length; i += 1) {
    const ea = sa.history[i]!;
    const eb = sb.history[i]!;
    if (ea.op !== eb.op) {
      return false;
    }
    if (ea.result !== eb.result) {
      return false;
    }
    if (ea.tag !== eb.tag) {
      return false;
    }
    if (ea.inputs.length !== eb.inputs.length) {
      return false;
    }
    for (let j = 0; j < ea.inputs.length; j += 1) {
      if (ea.inputs[j] !== eb.inputs[j]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Produce a human-readable transcript of a calculator's history.
 */
export function transcribe(calc: Calculator): string {
  const lines: string[] = [];
  for (const entry of calc.recent(Number.MAX_SAFE_INTEGER)) {
    const parts = entry.inputs.map((n) => n.toString()).join(", ");
    const tagLabel = entry.tag !== null ? ` [${entry.tag}]` : "";
    lines.push(`${entry.op}(${parts}) = ${entry.result}${tagLabel}`);
  }
  return lines.join("\n");
}

/**
 * Build a tiny scoreboard mapping operation names to usage counts.
 * Used by status surfaces that want to call out hot operations.
 */
export function scoreboard(calc: Calculator): readonly { readonly op: Operation; readonly count: number }[] {
  const tally = calc.getTally();
  const entries: { op: Operation; count: number }[] = [];
  for (const op of Object.keys(tally) as Operation[]) {
    entries.push({ op, count: tally[op] });
  }
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

/**
 * Serialize a calculator history as a JSON-compatible array. Useful for
 * persistence layers that want to round-trip a session.
 */
export function serialize(calc: Calculator): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of calc.recent(Number.MAX_SAFE_INTEGER)) {
    out.push({
      op: entry.op,
      inputs: [...entry.inputs],
      result: entry.result,
      at: entry.at,
      tag: entry.tag,
    });
  }
  return out;
}

/**
 * Inverse of {@link serialize}. Rebuilds a calculator from a JSON payload.
 * Unknown entries are silently skipped to keep the importer forgiving.
 */
export function deserialize(records: readonly Record<string, unknown>[]): Calculator {
  const calc = new Calculator();
  for (const record of records) {
    const op = record["op"];
    const inputs = record["inputs"];
    const tag = record["tag"];
    if (typeof op !== "string" || !Array.isArray(inputs)) {
      continue;
    }
    const numericInputs: number[] = [];
    let valid = true;
    for (const input of inputs) {
      if (typeof input !== "number") {
        valid = false;
        break;
      }
      numericInputs.push(input);
    }
    if (!valid) {
      continue;
    }
    try {
      applyOperation(calc, op as Operation, numericInputs, typeof tag === "string" ? tag : null);
    } catch {
      continue;
    }
  }
  return calc;
}

/**
 * Aggregate every numeric result from a calculator's history. The aggregate
 * is computed without using calculator operations to avoid recursive history
 * pollution.
 */
export function aggregateResults(calc: Calculator): {
  readonly count: number;
  readonly sum: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
} {
  const history = calc.recent(Number.MAX_SAFE_INTEGER);
  if (history.length === 0) {
    return { count: 0, sum: 0, mean: 0, min: 0, max: 0 };
  }
  let sum = 0;
  let min = history[0]!.result;
  let max = history[0]!.result;
  for (const entry of history) {
    sum += entry.result;
    if (entry.result < min) {
      min = entry.result;
    }
    if (entry.result > max) {
      max = entry.result;
    }
  }
  return {
    count: history.length,
    sum,
    mean: sum / history.length,
    min,
    max,
  };
}
