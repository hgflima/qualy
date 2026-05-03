export type Operation = "add" | "subtract" | "multiply" | "divide";

export interface CalculationRecord {
  readonly op: Operation;
  readonly a: number;
  readonly b: number;
  readonly result: number;
  readonly at: number;
}

export class DivisionByZeroError extends Error {
  constructor() {
    super("Division by zero is not allowed.");
    this.name = "DivisionByZeroError";
  }
}

export class Calculator {
  private history: CalculationRecord[] = [];

  add(a: number, b: number): number {
    return this.record("add", a, b, a + b);
  }

  subtract(a: number, b: number): number {
    return this.record("subtract", a, b, a - b);
  }

  multiply(a: number, b: number): number {
    return this.record("multiply", a, b, a * b);
  }

  divide(a: number, b: number): number {
    if (b === 0) {
      throw new DivisionByZeroError();
    }
    return this.record("divide", a, b, a / b);
  }

  sum(values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
      total = this.add(total, value);
    }
    return total;
  }

  average(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return this.divide(this.sum(values), values.length);
  }

  min(values: readonly number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    let m = values[0]!;
    for (const value of values) {
      if (value < m) {
        m = value;
      }
    }
    return m;
  }

  max(values: readonly number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    let m = values[0]!;
    for (const value of values) {
      if (value > m) {
        m = value;
      }
    }
    return m;
  }

  range(values: readonly number[]): number {
    const lo = this.min(values);
    const hi = this.max(values);
    if (lo === null || hi === null) {
      return 0;
    }
    return this.subtract(hi, lo);
  }

  recent(limit = 10): readonly CalculationRecord[] {
    if (limit <= 0) {
      return [];
    }
    return this.history.slice(-limit);
  }

  reset(): void {
    this.history = [];
  }

  size(): number {
    return this.history.length;
  }

  private record(op: Operation, a: number, b: number, result: number): number {
    this.history.push({ op, a, b, result, at: Date.now() });
    return result;
  }
}
