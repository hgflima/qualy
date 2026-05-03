/**
 * Comment-preserving editor for `vitest.config.ts` (and other TS config files
 * that follow the `export default {...}` or `export default defineConfig({...})`
 * convention).
 *
 * PLAN §Critical files notes that ts-morph is the only reliable path for
 * editing TS configs without trashing comments. This module is the seam
 * `install-coverage` (and any future TS-config edit) goes through.
 *
 * Design:
 *   - Parsing happens in an in-memory ts-morph project (no FS access here —
 *     callers feed source text and receive new text). This keeps the lib
 *     pure and makes it trivial to compose with `safeWriteFile`.
 *   - Public API is intentionally narrow: locate the default-exported object
 *     literal, read a nested property path as a JS value, and set a nested
 *     property path from a JS value. High-level helpers `readVitestThresholds`
 *     and `applyVitestCoverage` compose these for the install-coverage flow.
 *   - All AST mutations go through ts-morph's `addPropertyAssignment` /
 *     `setInitializer`, which preserve trivia (comments, blank lines) on
 *     surrounding tokens.
 *
 * Non-goals:
 *   - Editing JSON (Jest config) — that path uses plain `parseDefensive` +
 *     `stringifyPretty` from `json.ts`.
 *   - Creating a fresh `vitest.config.ts` from nothing — `install-coverage`
 *     handles that case by emitting a static template, not by editing.
 */
import {
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  SourceFile,
  SyntaxKind,
} from "ts-morph";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface VitestThresholds {
  lines?: number;
  functions?: number;
  branches?: number;
  statements?: number;
}

export interface VitestCoveragePatch {
  provider?: string;
  reporter?: readonly string[];
  thresholds?: VitestThresholds;
}

export const VITEST_THRESHOLD_KEYS = [
  "lines",
  "functions",
  "branches",
  "statements",
] as const;

const VIRTUAL_FILENAME = "vitest.config.ts";

/**
 * Parses TS source text into an in-memory ts-morph project. Never throws;
 * malformed source surfaces as `{ ok: false }`.
 */
export function parseConfigSource(
  text: string,
): Result<{ project: Project; sourceFile: SourceFile }> {
  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true, strict: false },
    });
    const sourceFile = project.createSourceFile(VIRTUAL_FILENAME, text, {
      overwrite: true,
    });
    return { ok: true, value: { project, sourceFile } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Locates the object literal carried by `export default …`. Supports two
 * common shapes:
 *   - `export default { … }`
 *   - `export default defineConfig({ … })` (any function call whose first
 *     argument is an object literal)
 *
 * Returns `null` when there is no default export, when the default is not
 * an object literal (or call carrying one), or when the source has multiple
 * default exports (TS forbids this, but we still defend).
 */
export function findDefaultExportObject(
  sourceFile: SourceFile,
): ObjectLiteralExpression | null {
  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isExportAssignment(stmt)) continue;
    if (stmt.isExportEquals()) continue;
    const obj = unwrapToObjectLiteral(stmt.getExpression());
    if (obj) return obj;
  }
  return null;
}

function unwrapToObjectLiteral(node: Node): ObjectLiteralExpression | null {
  if (Node.isObjectLiteralExpression(node)) return node;
  if (Node.isCallExpression(node)) {
    const args = node.getArguments();
    if (args.length > 0) {
      const first = args[0];
      if (first && Node.isObjectLiteralExpression(first)) return first;
    }
    return null;
  }
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  if (Node.isParenthesizedExpression(node)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  return null;
}

/**
 * Reads a nested property path as a plain JS value (string, number, boolean,
 * null, array, object). Returns `undefined` when:
 *   - any segment is missing,
 *   - any segment is not a `PropertyAssignment` (e.g. shorthand, spread,
 *     method, computed name we cannot evaluate statically),
 *   - any non-leaf segment's value is not an object literal,
 *   - the leaf value is a non-literal expression (identifier, function call,
 *     template with substitutions, etc.).
 *
 * Path is left-to-right (`["test", "coverage", "thresholds", "lines"]`).
 */
export function readObjectPath(
  obj: ObjectLiteralExpression,
  path: readonly string[],
): unknown {
  if (path.length === 0) return literalValueOf(obj);
  const [head, ...rest] = path;
  if (head === undefined) return undefined;
  const prop = obj.getProperty(head);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  const init = prop.getInitializer();
  if (!init) return undefined;
  if (rest.length === 0) return literalValueOf(init);
  if (Node.isObjectLiteralExpression(init)) return readObjectPath(init, rest);
  return undefined;
}

function literalValueOf(node: Node): unknown {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isNumericLiteral(node)) {
    return Number(node.getLiteralText());
  }
  const kind = node.getKind();
  if (kind === SyntaxKind.TrueKeyword) return true;
  if (kind === SyntaxKind.FalseKeyword) return false;
  if (kind === SyntaxKind.NullKeyword) return null;
  if (Node.isPrefixUnaryExpression(node)) {
    const op = node.getOperatorToken();
    const operand = node.getOperand();
    if (op === SyntaxKind.MinusToken && Node.isNumericLiteral(operand)) {
      return -Number(operand.getLiteralText());
    }
    return undefined;
  }
  if (Node.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.getElements()) {
      const v = literalValueOf(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (Node.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.getProperties()) {
      if (!Node.isPropertyAssignment(p)) continue;
      const v = literalValueOf(p.getInitializerOrThrow());
      if (v === undefined) continue;
      out[p.getName()] = v;
    }
    return out;
  }
  return undefined;
}

/**
 * Sets a nested property path. When intermediate segments are missing they
 * are created as empty object literals; existing intermediate segments must
 * already be object literals (a function call, identifier, etc. is a hard
 * error — we cannot safely merge into them).
 *
 * The leaf is written by emitting `valueText` verbatim as the initializer,
 * so callers must pass valid TS expression text. Use `serializeValue` to
 * derive that from a JS value.
 *
 * Existing leaf values are replaced (preserves surrounding comments).
 */
export function setObjectPath(
  obj: ObjectLiteralExpression,
  path: readonly string[],
  valueText: string,
): Result<{ replaced: boolean }> {
  if (path.length === 0) return { ok: false, error: "path must not be empty" };
  const [head, ...rest] = path;
  if (head === undefined) {
    return { ok: false, error: "path segment is undefined" };
  }
  if (rest.length === 0) {
    const existing = obj.getProperty(head);
    if (existing) {
      if (!Node.isPropertyAssignment(existing)) {
        return {
          ok: false,
          error: `cannot replace non-PropertyAssignment property: ${head}`,
        };
      }
      existing.setInitializer(valueText);
      return { ok: true, value: { replaced: true } };
    }
    obj.addPropertyAssignment({ name: head, initializer: valueText });
    return { ok: true, value: { replaced: false } };
  }

  const intermediate = ensureIntermediateObject(obj, head);
  if (!intermediate.ok) return intermediate;
  return setObjectPath(intermediate.value, rest, valueText);
}

function ensureIntermediateObject(
  obj: ObjectLiteralExpression,
  name: string,
): Result<ObjectLiteralExpression> {
  const existing = obj.getProperty(name);
  if (existing) {
    if (!Node.isPropertyAssignment(existing)) {
      return {
        ok: false,
        error: `intermediate ${name} is not a PropertyAssignment`,
      };
    }
    const init = existing.getInitializer();
    if (!init) return { ok: false, error: `${name} has no initializer` };
    if (!Node.isObjectLiteralExpression(init)) {
      return { ok: false, error: `${name} is not an object literal` };
    }
    return { ok: true, value: init };
  }
  const added = obj.addPropertyAssignment({
    name,
    initializer: "{}",
  }) as PropertyAssignment;
  const init = added.getInitializer();
  if (!init || !Node.isObjectLiteralExpression(init)) {
    return { ok: false, error: `failed to create intermediate ${name}` };
  }
  return { ok: true, value: init };
}

/**
 * Serializes a JS value as a TS expression string. Object keys that are
 * valid identifiers are emitted unquoted; everything else falls back to
 * a JSON-style string key. Numbers must be finite; functions, symbols,
 * undefined, etc. throw — caller bug.
 */
export function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot serialize non-finite number: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map(serializeValue).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, v]) => `${quoteKeyIfNeeded(k)}: ${serializeValue(v)}`)
      .join(", ");
    return `{ ${body} }`;
  }
  throw new Error(`cannot serialize value of type ${typeof value}`);
}

function quoteKeyIfNeeded(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

/**
 * Reads `test.coverage.thresholds.{lines,functions,branches,statements}` from
 * a vitest config source. Returns `null` when the config has no default-
 * exported object literal, no `test.coverage.thresholds`, or none of the four
 * known keys carry numeric values. Otherwise returns the subset that did.
 */
export function readVitestThresholds(text: string): VitestThresholds | null {
  const parsed = parseConfigSource(text);
  if (!parsed.ok) return null;
  const obj = findDefaultExportObject(parsed.value.sourceFile);
  if (!obj) return null;
  const raw = readObjectPath(obj, ["test", "coverage", "thresholds"]);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: VitestThresholds = {};
  let any = false;
  for (const k of VITEST_THRESHOLD_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Merges a coverage patch into the vitest config under `test.coverage`.
 *
 * Semantics:
 *   - `provider`, `reporter`, `thresholds.<key>` are merged independently
 *     — only the leaves declared on `patch` are touched, others are left
 *     untouched (preserves user's custom keys like `coverage.exclude`).
 *   - When a leaf already carries the exact desired value, it is left
 *     alone (no rewrite, `changed` stays false).
 *   - `reporter` arrays are compared element-wise; any difference triggers
 *     a full replacement.
 *
 * Returns the new source text. Caller is responsible for writing it via
 * `safeWriteFile`.
 */
export function applyVitestCoverage(
  text: string,
  patch: VitestCoveragePatch,
): Result<{ content: string; changed: boolean }> {
  const parsed = parseConfigSource(text);
  if (!parsed.ok) return parsed;
  const obj = findDefaultExportObject(parsed.value.sourceFile);
  if (!obj) {
    return {
      ok: false,
      error: "no default-exported object literal found in vitest config",
    };
  }

  let changed = false;
  const setLeaf = (path: readonly string[], value: unknown): Result<void> => {
    const before = readObjectPath(obj, path);
    if (deepEqual(before, value)) return { ok: true, value: undefined };
    let serialized: string;
    try {
      serialized = serializeValue(value);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const r = setObjectPath(obj, path, serialized);
    if (!r.ok) return r;
    changed = true;
    return { ok: true, value: undefined };
  };

  if (patch.provider !== undefined) {
    const r = setLeaf(["test", "coverage", "provider"], patch.provider);
    if (!r.ok) return r;
  }
  if (patch.reporter !== undefined) {
    const r = setLeaf(["test", "coverage", "reporter"], [...patch.reporter]);
    if (!r.ok) return r;
  }
  if (patch.thresholds !== undefined) {
    for (const k of VITEST_THRESHOLD_KEYS) {
      const v = patch.thresholds[k];
      if (v === undefined) continue;
      const r = setLeaf(["test", "coverage", "thresholds", k], v);
      if (!r.ok) return r;
    }
  }

  return {
    ok: true,
    value: { content: parsed.value.sourceFile.getFullText(), changed },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    if (ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}
