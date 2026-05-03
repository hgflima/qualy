/**
 * Defensive JSON helpers.
 *
 * The CLI parses untrusted JSON in many places (existing `package.json`,
 * `.lint-audit/*.json`, hook input, oxlint output). A single uncaught throw
 * inside a command leaks a stack trace to stderr and breaks the harness's
 * stdout-as-JSON contract (logger.ts §Conventions). These helpers normalize
 * failures into return values and never throw.
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Parses JSON without ever throwing. Returns a discriminated result so callers
 * are forced to handle the failure path explicitly.
 *
 * Generic parameter is a convenience cast — no runtime validation. Wrap with
 * a schema (zod, audit-schema.ts) when the shape matters.
 */
export function parseDefensive<T = unknown>(input: string): ParseResult<T> {
  if (typeof input !== "string") {
    return { ok: false, error: `expected string, got ${typeof input}` };
  }
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stringifies any value with 2-space indentation and a trailing newline.
 *
 * Tolerates inputs that `JSON.stringify` rejects: cycles become `"[Circular]"`,
 * BigInt becomes its decimal string, and `undefined` at the top level becomes
 * the literal string `"undefined"`. Output always ends with `\n` so files
 * written via this helper are POSIX-friendly.
 */
export function stringifyPretty(value: unknown): string {
  if (value === undefined) return "undefined\n";
  const seen = new WeakSet<object>();
  const text = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    },
    2,
  );
  return (text ?? "null") + "\n";
}
