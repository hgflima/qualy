/**
 * Chainable validators for runtime data shape checking.
 *
 * The interface is loosely modelled after small-footprint libraries like
 * Joi or Zod, but written from scratch to avoid any external dependency.
 * Validators return a structured {@link ValidationResult} so callers can
 * assemble user-facing error reports without throwing exceptions.
 */

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
  readonly value: unknown;
}

export interface ValidationContext {
  readonly path: readonly (string | number)[];
  readonly issues: ValidationIssue[];
}

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value: T | null;
  readonly issues: readonly ValidationIssue[];
}

export interface Validator<T> {
  parse(input: unknown): ValidationResult<T>;
  parseStrict(input: unknown): T;
  optional(): Validator<T | undefined>;
  nullable(): Validator<T | null>;
  default(value: T): Validator<T>;
  refine(check: (value: T) => boolean, message: string, code?: string): Validator<T>;
  transform<U>(fn: (value: T) => U): Validator<U>;
  describe(): string;
}

interface InternalValidator<T> extends Validator<T> {
  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE;
}

const FAILURE = Symbol("validation-failure");

abstract class BaseValidator<T> implements InternalValidator<T> {
  abstract validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE;
  abstract describe(): string;

  parse(input: unknown): ValidationResult<T> {
    const ctx: ValidationContext = { path: [], issues: [] };
    const value = this.validate(input, ctx);
    if (value === FAILURE) {
      return { ok: false, value: null, issues: [...ctx.issues] };
    }
    if (ctx.issues.length > 0) {
      return { ok: false, value: null, issues: [...ctx.issues] };
    }
    return { ok: true, value, issues: [] };
  }

  parseStrict(input: unknown): T {
    const result = this.parse(input);
    if (!result.ok || result.value === null) {
      const summary = result.issues.map((issue) => issue.message).join("; ");
      throw new Error(`Validation failed: ${summary}`);
    }
    return result.value as T;
  }

  optional(): Validator<T | undefined> {
    return new OptionalValidator(this);
  }

  nullable(): Validator<T | null> {
    return new NullableValidator(this);
  }

  default(value: T): Validator<T> {
    return new DefaultValidator(this, value);
  }

  refine(check: (value: T) => boolean, message: string, code = "refine"): Validator<T> {
    return new RefineValidator(this, check, message, code);
  }

  transform<U>(fn: (value: T) => U): Validator<U> {
    return new TransformValidator(this, fn);
  }
}

function recordIssue(
  ctx: ValidationContext,
  code: string,
  message: string,
  value: unknown,
): void {
  ctx.issues.push({
    path: [...ctx.path],
    code,
    message,
    value,
  });
}

function withPath<T>(
  ctx: ValidationContext,
  segment: string | number,
  fn: (next: ValidationContext) => T,
): T {
  const next: ValidationContext = {
    path: [...ctx.path, segment],
    issues: ctx.issues,
  };
  return fn(next);
}

class StringValidator extends BaseValidator<string> {
  private minLengthValue: number | null;
  private maxLengthValue: number | null;
  private patternValue: RegExp | null;
  private trimEnabled: boolean;

  constructor() {
    super();
    this.minLengthValue = null;
    this.maxLengthValue = null;
    this.patternValue = null;
    this.trimEnabled = false;
  }

  min(length: number): this {
    this.minLengthValue = length;
    return this;
  }

  max(length: number): this {
    this.maxLengthValue = length;
    return this;
  }

  pattern(regex: RegExp): this {
    this.patternValue = regex;
    return this;
  }

  trim(): this {
    this.trimEnabled = true;
    return this;
  }

  email(): this {
    this.patternValue = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
    return this;
  }

  url(): this {
    this.patternValue = /^https?:\/\/[^\s]+$/u;
    return this;
  }

  uuid(): this {
    this.patternValue =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    return this;
  }

  validate(value: unknown, ctx: ValidationContext): string | typeof FAILURE {
    if (typeof value !== "string") {
      recordIssue(ctx, "type", "Expected a string.", value);
      return FAILURE;
    }
    let candidate = value;
    if (this.trimEnabled) {
      candidate = candidate.trim();
    }
    if (this.minLengthValue !== null && candidate.length < this.minLengthValue) {
      recordIssue(ctx, "string.min", `Must be at least ${this.minLengthValue} characters.`, value);
      return FAILURE;
    }
    if (this.maxLengthValue !== null && candidate.length > this.maxLengthValue) {
      recordIssue(ctx, "string.max", `Must be at most ${this.maxLengthValue} characters.`, value);
      return FAILURE;
    }
    if (this.patternValue !== null && !this.patternValue.test(candidate)) {
      recordIssue(ctx, "string.pattern", "Does not match the required pattern.", value);
      return FAILURE;
    }
    return candidate;
  }

  describe(): string {
    const constraints: string[] = [];
    if (this.minLengthValue !== null) {
      constraints.push(`min=${this.minLengthValue}`);
    }
    if (this.maxLengthValue !== null) {
      constraints.push(`max=${this.maxLengthValue}`);
    }
    if (this.patternValue !== null) {
      constraints.push(`pattern=${this.patternValue.source}`);
    }
    if (constraints.length === 0) {
      return "string";
    }
    return `string(${constraints.join(", ")})`;
  }
}

class NumberValidator extends BaseValidator<number> {
  private minValue: number | null;
  private maxValue: number | null;
  private integerOnly: boolean;
  private finiteOnly: boolean;
  private positiveOnly: boolean;

  constructor() {
    super();
    this.minValue = null;
    this.maxValue = null;
    this.integerOnly = false;
    this.finiteOnly = true;
    this.positiveOnly = false;
  }

  min(value: number): this {
    this.minValue = value;
    return this;
  }

  max(value: number): this {
    this.maxValue = value;
    return this;
  }

  integer(): this {
    this.integerOnly = true;
    return this;
  }

  positive(): this {
    this.positiveOnly = true;
    return this;
  }

  allowInfinite(): this {
    this.finiteOnly = false;
    return this;
  }

  validate(value: unknown, ctx: ValidationContext): number | typeof FAILURE {
    if (typeof value !== "number") {
      recordIssue(ctx, "type", "Expected a number.", value);
      return FAILURE;
    }
    if (Number.isNaN(value)) {
      recordIssue(ctx, "number.nan", "Value must not be NaN.", value);
      return FAILURE;
    }
    if (this.finiteOnly && !Number.isFinite(value)) {
      recordIssue(ctx, "number.finite", "Value must be finite.", value);
      return FAILURE;
    }
    if (this.integerOnly && !Number.isInteger(value)) {
      recordIssue(ctx, "number.integer", "Value must be an integer.", value);
      return FAILURE;
    }
    if (this.positiveOnly && value <= 0) {
      recordIssue(ctx, "number.positive", "Value must be positive.", value);
      return FAILURE;
    }
    if (this.minValue !== null && value < this.minValue) {
      recordIssue(ctx, "number.min", `Value must be >= ${this.minValue}.`, value);
      return FAILURE;
    }
    if (this.maxValue !== null && value > this.maxValue) {
      recordIssue(ctx, "number.max", `Value must be <= ${this.maxValue}.`, value);
      return FAILURE;
    }
    return value;
  }

  describe(): string {
    const constraints: string[] = [];
    if (this.minValue !== null) {
      constraints.push(`min=${this.minValue}`);
    }
    if (this.maxValue !== null) {
      constraints.push(`max=${this.maxValue}`);
    }
    if (this.integerOnly) {
      constraints.push("integer");
    }
    if (this.positiveOnly) {
      constraints.push("positive");
    }
    if (constraints.length === 0) {
      return "number";
    }
    return `number(${constraints.join(", ")})`;
  }
}

class BooleanValidator extends BaseValidator<boolean> {
  validate(value: unknown, ctx: ValidationContext): boolean | typeof FAILURE {
    if (typeof value !== "boolean") {
      recordIssue(ctx, "type", "Expected a boolean.", value);
      return FAILURE;
    }
    return value;
  }

  describe(): string {
    return "boolean";
  }
}

class ArrayValidator<T> extends BaseValidator<T[]> {
  private readonly itemValidator: InternalValidator<T>;
  private minLengthValue: number | null;
  private maxLengthValue: number | null;
  private uniqueItems: boolean;

  constructor(itemValidator: Validator<T>) {
    super();
    this.itemValidator = itemValidator as InternalValidator<T>;
    this.minLengthValue = null;
    this.maxLengthValue = null;
    this.uniqueItems = false;
  }

  min(length: number): this {
    this.minLengthValue = length;
    return this;
  }

  max(length: number): this {
    this.maxLengthValue = length;
    return this;
  }

  unique(): this {
    this.uniqueItems = true;
    return this;
  }

  validate(value: unknown, ctx: ValidationContext): T[] | typeof FAILURE {
    if (!Array.isArray(value)) {
      recordIssue(ctx, "type", "Expected an array.", value);
      return FAILURE;
    }
    if (this.minLengthValue !== null && value.length < this.minLengthValue) {
      recordIssue(ctx, "array.min", `Must contain at least ${this.minLengthValue} items.`, value);
      return FAILURE;
    }
    if (this.maxLengthValue !== null && value.length > this.maxLengthValue) {
      recordIssue(ctx, "array.max", `Must contain at most ${this.maxLengthValue} items.`, value);
      return FAILURE;
    }
    const out: T[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      const validated = withPath(ctx, i, (next) => this.itemValidator.validate(item, next));
      if (validated !== FAILURE) {
        out.push(validated);
      }
    }
    if (this.uniqueItems) {
      const seen = new Set<unknown>();
      for (const item of out) {
        if (seen.has(item)) {
          recordIssue(ctx, "array.unique", "Items must be unique.", value);
          return FAILURE;
        }
        seen.add(item);
      }
    }
    return out;
  }

  describe(): string {
    return `array<${this.itemValidator.describe()}>`;
  }
}

class ObjectValidator<S extends Record<string, Validator<unknown>>>
  extends BaseValidator<{ [K in keyof S]: ReturnType<S[K]["parseStrict"]> }>
{
  private readonly shape: S;
  private allowUnknownKeys: boolean;

  constructor(shape: S) {
    super();
    this.shape = shape;
    this.allowUnknownKeys = false;
  }

  passthrough(): this {
    this.allowUnknownKeys = true;
    return this;
  }

  strip(): this {
    this.allowUnknownKeys = false;
    return this;
  }

  validate(
    value: unknown,
    ctx: ValidationContext,
  ): { [K in keyof S]: ReturnType<S[K]["parseStrict"]> } | typeof FAILURE {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      recordIssue(ctx, "type", "Expected an object.", value);
      return FAILURE;
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let hadFailure = false;
    for (const key of Object.keys(this.shape)) {
      const childValidator = this.shape[key]! as InternalValidator<unknown>;
      const incoming = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
      const result = withPath(ctx, key, (next) => childValidator.validate(incoming, next));
      if (result === FAILURE) {
        hadFailure = true;
        continue;
      }
      if (result !== undefined) {
        out[key] = result;
      }
    }
    if (this.allowUnknownKeys) {
      for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(this.shape, key)) {
          out[key] = source[key];
        }
      }
    } else {
      for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(this.shape, key)) {
          withPath(ctx, key, (next) => {
            recordIssue(next, "object.unknown_key", `Unknown key '${key}'.`, source[key]);
          });
          hadFailure = true;
        }
      }
    }
    if (hadFailure) {
      return FAILURE;
    }
    return out as { [K in keyof S]: ReturnType<S[K]["parseStrict"]> };
  }

  describe(): string {
    const parts: string[] = [];
    for (const key of Object.keys(this.shape)) {
      parts.push(`${key}: ${(this.shape[key]! as InternalValidator<unknown>).describe()}`);
    }
    return `object{${parts.join(", ")}}`;
  }
}

class OptionalValidator<T> extends BaseValidator<T | undefined> {
  private readonly inner: InternalValidator<T>;

  constructor(inner: Validator<T>) {
    super();
    this.inner = inner as InternalValidator<T>;
  }

  validate(value: unknown, ctx: ValidationContext): T | undefined | typeof FAILURE {
    if (value === undefined) {
      return undefined;
    }
    return this.inner.validate(value, ctx);
  }

  describe(): string {
    return `${this.inner.describe()}?`;
  }
}

class NullableValidator<T> extends BaseValidator<T | null> {
  private readonly inner: InternalValidator<T>;

  constructor(inner: Validator<T>) {
    super();
    this.inner = inner as InternalValidator<T>;
  }

  validate(value: unknown, ctx: ValidationContext): T | null | typeof FAILURE {
    if (value === null) {
      return null;
    }
    return this.inner.validate(value, ctx);
  }

  describe(): string {
    return `${this.inner.describe()}|null`;
  }
}

class DefaultValidator<T> extends BaseValidator<T> {
  private readonly inner: InternalValidator<T>;
  private readonly fallback: T;

  constructor(inner: Validator<T>, fallback: T) {
    super();
    this.inner = inner as InternalValidator<T>;
    this.fallback = fallback;
  }

  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE {
    if (value === undefined) {
      return this.fallback;
    }
    return this.inner.validate(value, ctx);
  }

  describe(): string {
    return `${this.inner.describe()} (default ${JSON.stringify(this.fallback)})`;
  }
}

class RefineValidator<T> extends BaseValidator<T> {
  private readonly inner: InternalValidator<T>;
  private readonly check: (value: T) => boolean;
  private readonly message: string;
  private readonly code: string;

  constructor(inner: Validator<T>, check: (value: T) => boolean, message: string, code: string) {
    super();
    this.inner = inner as InternalValidator<T>;
    this.check = check;
    this.message = message;
    this.code = code;
  }

  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE {
    const result = this.inner.validate(value, ctx);
    if (result === FAILURE) {
      return FAILURE;
    }
    if (!this.check(result)) {
      recordIssue(ctx, this.code, this.message, value);
      return FAILURE;
    }
    return result;
  }

  describe(): string {
    return `${this.inner.describe()} where ${this.code}`;
  }
}

class TransformValidator<I, O> extends BaseValidator<O> {
  private readonly inner: InternalValidator<I>;
  private readonly fn: (value: I) => O;

  constructor(inner: Validator<I>, fn: (value: I) => O) {
    super();
    this.inner = inner as InternalValidator<I>;
    this.fn = fn;
  }

  validate(value: unknown, ctx: ValidationContext): O | typeof FAILURE {
    const result = this.inner.validate(value, ctx);
    if (result === FAILURE) {
      return FAILURE;
    }
    return this.fn(result);
  }

  describe(): string {
    return `${this.inner.describe()} -> transformed`;
  }
}

class LiteralValidator<T extends string | number | boolean> extends BaseValidator<T> {
  private readonly literal: T;

  constructor(literal: T) {
    super();
    this.literal = literal;
  }

  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE {
    if (value !== this.literal) {
      recordIssue(ctx, "literal", `Expected literal ${JSON.stringify(this.literal)}.`, value);
      return FAILURE;
    }
    return this.literal;
  }

  describe(): string {
    return `literal(${JSON.stringify(this.literal)})`;
  }
}

class UnionValidator<T> extends BaseValidator<T> {
  private readonly options: readonly InternalValidator<T>[];

  constructor(options: readonly Validator<T>[]) {
    super();
    this.options = options.map((option) => option as InternalValidator<T>);
  }

  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE {
    const accumulated: ValidationIssue[] = [];
    for (const option of this.options) {
      const localCtx: ValidationContext = { path: ctx.path, issues: [] };
      const result = option.validate(value, localCtx);
      if (result !== FAILURE && localCtx.issues.length === 0) {
        return result;
      }
      for (const issue of localCtx.issues) {
        accumulated.push(issue);
      }
    }
    recordIssue(ctx, "union", "Value did not match any of the union options.", value);
    for (const issue of accumulated) {
      ctx.issues.push(issue);
    }
    return FAILURE;
  }

  describe(): string {
    return this.options.map((option) => option.describe()).join(" | ");
  }
}

class TupleValidator<T extends readonly unknown[]> extends BaseValidator<T> {
  private readonly slots: readonly InternalValidator<unknown>[];

  constructor(slots: readonly Validator<unknown>[]) {
    super();
    this.slots = slots.map((slot) => slot as InternalValidator<unknown>);
  }

  validate(value: unknown, ctx: ValidationContext): T | typeof FAILURE {
    if (!Array.isArray(value)) {
      recordIssue(ctx, "type", "Expected a tuple (array).", value);
      return FAILURE;
    }
    if (value.length !== this.slots.length) {
      recordIssue(ctx, "tuple.length", `Expected exactly ${this.slots.length} elements.`, value);
      return FAILURE;
    }
    const out: unknown[] = [];
    let hadFailure = false;
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i]!;
      const item = value[i];
      const result = withPath(ctx, i, (next) => slot.validate(item, next));
      if (result === FAILURE) {
        hadFailure = true;
        continue;
      }
      out.push(result);
    }
    if (hadFailure) {
      return FAILURE;
    }
    return out as unknown as T;
  }

  describe(): string {
    return `tuple[${this.slots.map((slot) => slot.describe()).join(", ")}]`;
  }
}

class RecordValidator<V> extends BaseValidator<Record<string, V>> {
  private readonly value: InternalValidator<V>;
  private readonly keyPattern: RegExp | null;

  constructor(value: Validator<V>, keyPattern: RegExp | null = null) {
    super();
    this.value = value as InternalValidator<V>;
    this.keyPattern = keyPattern;
  }

  validate(value: unknown, ctx: ValidationContext): Record<string, V> | typeof FAILURE {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      recordIssue(ctx, "type", "Expected a record.", value);
      return FAILURE;
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, V> = {};
    let hadFailure = false;
    for (const key of Object.keys(source)) {
      if (this.keyPattern !== null && !this.keyPattern.test(key)) {
        withPath(ctx, key, (next) => {
          recordIssue(next, "record.key", "Key does not match the required pattern.", key);
        });
        hadFailure = true;
        continue;
      }
      const validated = withPath(ctx, key, (next) => this.value.validate(source[key], next));
      if (validated === FAILURE) {
        hadFailure = true;
        continue;
      }
      out[key] = validated;
    }
    if (hadFailure) {
      return FAILURE;
    }
    return out;
  }

  describe(): string {
    return `record<${this.value.describe()}>`;
  }
}

/**
 * Build a string validator with chainable constraints.
 */
export function string(): StringValidator {
  return new StringValidator();
}

/**
 * Build a number validator with chainable constraints.
 */
export function number(): NumberValidator {
  return new NumberValidator();
}

/**
 * Build a boolean validator.
 */
export function boolean(): BooleanValidator {
  return new BooleanValidator();
}

/**
 * Build an array validator that applies `item` to every element.
 */
export function array<T>(item: Validator<T>): ArrayValidator<T> {
  return new ArrayValidator(item);
}

/**
 * Build an object validator from a shape description.
 */
export function object<S extends Record<string, Validator<unknown>>>(shape: S): ObjectValidator<S> {
  return new ObjectValidator(shape);
}

/**
 * Wrap an inner validator to allow `undefined`.
 */
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return inner.optional();
}

/**
 * Wrap an inner validator to allow `null`.
 */
export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return inner.nullable();
}

/**
 * Build a literal validator that only accepts a single specific value.
 */
export function literal<T extends string | number | boolean>(value: T): Validator<T> {
  return new LiteralValidator(value);
}

/**
 * Build a union validator that accepts any of the supplied options.
 */
export function union<T>(options: readonly Validator<T>[]): Validator<T> {
  if (options.length === 0) {
    throw new Error("union() requires at least one option.");
  }
  return new UnionValidator(options);
}

/**
 * Build a tuple validator that accepts a fixed-length, fixed-shape array.
 */
export function tuple<T extends readonly unknown[]>(slots: {
  readonly [K in keyof T]: Validator<T[K]>;
}): Validator<T> {
  return new TupleValidator<T>(slots as unknown as readonly Validator<unknown>[]);
}

/**
 * Build a record validator that accepts a string-keyed map.
 */
export function record<V>(value: Validator<V>, keyPattern: RegExp | null = null): Validator<Record<string, V>> {
  return new RecordValidator(value, keyPattern);
}

/**
 * Compose two validators sequentially: the second runs on the output of the
 * first. This is sometimes more readable than calling `.transform()` chains.
 */
export function pipe<A, B>(first: Validator<A>, second: Validator<B>): Validator<B> {
  return first.transform((value) => second.parseStrict(value));
}

/**
 * Build a deterministic, human-readable description of a validator's shape.
 * Useful for embedding into error messages, status surfaces, and tests.
 */
export function describe<T>(validator: Validator<T>): string {
  return validator.describe();
}

/**
 * Format a list of validation issues as a multi-line string.
 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const issue of issues) {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    lines.push(`- [${issue.code}] ${path}: ${issue.message}`);
  }
  return lines.join("\n");
}

/**
 * Return only the human-readable messages from a list of issues, sorted
 * alphabetically for stable test output.
 */
export function sortedMessages(issues: readonly ValidationIssue[]): readonly string[] {
  return [...issues.map((issue) => issue.message)].sort();
}
