/**
 * Ignore-manifest → oxlint preset compiler (lint-ignore SPEC §2.3, PLAN T2.2/T3.2).
 *
 * Two parallel projections, both bounded by `_qualy:start_`/`_qualy:end_`
 * sentinels so user-authored entries OUTSIDE the markers stay byte-a-byte
 * untouched:
 *
 *   - Path-only entries (`rule === null`) → `ignorePatterns[]`.
 *   - Per-rule entries (`rule !== null`) → `overrides[]`. Marker blocks here
 *     are special override objects of the shape
 *     `{ files: [], rules: { "_qualy:start_": "off" } }` (and `_qualy:end_`).
 *     `category:*` rules expand via `category-catalog`; multiple rule entries
 *     sharing one glob collapse into a single override block with a merged,
 *     alphabetically-sorted `rules` object.
 *
 * Asymmetry to be aware of: `ignorePatterns` always emits the marker pair so
 * the qualy-managed slice is unambiguous. `overrides` only emits markers when
 * (a) the manifest contributes per-rule entries OR (b) markers already exist
 * in the preset. This avoids gratuitously inflating brownfield presets that
 * never used per-rule ignores.
 *
 * Determinism guarantees:
 *   - Entries are sorted by `id` (which is itself a deterministic
 *     sha256-derived hash of `(glob, rule)` — see `ignore-manifest.ts`).
 *   - Per-rule entries are grouped by glob in id-sorted encounter order; rules
 *     within each block are alphabetically sorted.
 *   - The compiler is a pure function of `(currentPreset, manifest)`; it
 *     never reads from disk and never mutates inputs.
 *   - `changed` flips off when re-compiling produces the same JSON output as
 *     the input — this is what enables the on-drift safety net (`qualy lint`
 *     compares mtimes; if presets are already in sync, we skip the write).
 *
 * Marker discipline (SPEC §2.3):
 *   - User patterns OUTSIDE the markers are preserved byte-a-byte. We only
 *     own the slice between `_qualy:start_` and `_qualy:end_`.
 *   - When markers are absent (greenfield or pre-managed brownfield), the
 *     managed block is appended to the end. P3 import will eventually move
 *     pre-existing patterns into the manifest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type SafeIO,
  type SafeResult,
  safeWriteFile,
} from "./fs-safe.ts";
import { parseDefensive, stringifyPretty } from "./json.ts";
import { type IgnoreEntry, type IgnoreManifest } from "./ignore-manifest.ts";
import {
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "./paths.ts";
import { getCategoryRules, isKnownCategory } from "./category-catalog.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loose preset shape — we only touch `ignorePatterns`; everything else is
 *  preserved by-key. */
export interface PresetShape {
  ignorePatterns?: unknown;
  [key: string]: unknown;
}

export interface CompileResult {
  readonly ok: true;
  readonly proposed: PresetShape;
  readonly changed: boolean;
}

export interface CompileError {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Pure compile
// ---------------------------------------------------------------------------

/** Compile the manifest into a preset. Path-only entries land in
 *  `ignorePatterns[]`; per-rule entries (including expanded `category:*`)
 *  land in `overrides[]`. Markers preserve user-authored slices verbatim. */
export function compileToPreset(
  current: PresetShape,
  manifest: IgnoreManifest,
): CompileResult | CompileError {
  // ---- ignorePatterns (path-only) -----------------------------------------
  const pathOnlyGlobs = manifest.entries
    .filter((e) => e.rule === null)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((e) => e.glob);

  const beforePatterns = Array.isArray(current.ignorePatterns)
    ? (current.ignorePatterns as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];

  const nextPatterns = rebuildIgnorePatterns(beforePatterns, pathOnlyGlobs);

  // ---- overrides (per-rule + category expansion) --------------------------
  const perRuleEntries = manifest.entries.filter((e) => e.rule !== null);
  const managedOverrides = buildManagedOverrides(perRuleEntries);

  const beforeOverrides = Array.isArray(current.overrides)
    ? (current.overrides as readonly unknown[])
    : [];
  const nextOverrides = rebuildOverrides(
    beforeOverrides,
    managedOverrides,
    perRuleEntries.length > 0,
  );

  // ---- assemble proposed --------------------------------------------------
  const proposed: PresetShape = { ...current, ignorePatterns: nextPatterns };
  if (nextOverrides !== null) {
    proposed.overrides = nextOverrides;
  }

  const patternsChanged = !arraysEqual(beforePatterns, nextPatterns);
  const overridesChanged =
    nextOverrides !== null &&
    JSON.stringify(beforeOverrides) !== JSON.stringify(nextOverrides);

  return { ok: true, proposed, changed: patternsChanged || overridesChanged };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Replace the `[start, …, end]` slice with the new managed block. When
 *  markers are absent, append the block to the end of the array. */
function rebuildIgnorePatterns(
  before: readonly string[],
  managed: readonly string[],
): string[] {
  const startIdx = before.indexOf(IGNORE_MARKER_START);
  const endIdx = before.indexOf(IGNORE_MARKER_END);

  const managedBlock = [IGNORE_MARKER_START, ...managed, IGNORE_MARKER_END];

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    return [
      ...before.slice(0, startIdx),
      ...managedBlock,
      ...before.slice(endIdx + 1),
    ];
  }
  return [...before, ...managedBlock];
}

// ---------------------------------------------------------------------------
// Per-rule entries → overrides[] (Phase 3, T3.2)
// ---------------------------------------------------------------------------

/** A single oxlint override block. Key set is open-ended (oxlint allows
 *  `files`, `excludedFiles`, `rules`, `extends`, …); we only ever read/write
 *  `files` and `rules` — every other key on user-authored blocks is preserved
 *  by `rebuildOverrides` because it slices the array, never the object. */
interface OverrideBlock {
  readonly files?: readonly string[];
  readonly rules?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

const START_OVERRIDE_BLOCK: OverrideBlock = Object.freeze({
  files: Object.freeze([]) as readonly string[],
  rules: Object.freeze({ [IGNORE_MARKER_START]: "off" }),
});

const END_OVERRIDE_BLOCK: OverrideBlock = Object.freeze({
  files: Object.freeze([]) as readonly string[],
  rules: Object.freeze({ [IGNORE_MARKER_END]: "off" }),
});

/** Resolve a manifest `rule` value to one or more concrete oxlint rule names.
 *  `category:<name>` expands via the static catalog when known; unknown
 *  categories fall through opaque so oxlint can either accept them later or
 *  surface its own error. */
function expandRule(rule: string): readonly string[] {
  const CATEGORY_PREFIX = "category:";
  if (rule.startsWith(CATEGORY_PREFIX)) {
    const name = rule.slice(CATEGORY_PREFIX.length);
    if (isKnownCategory(name)) return getCategoryRules(name);
  }
  return [rule];
}

/** Build the managed override blocks for the given per-rule manifest entries.
 *  Iteration is id-sorted; entries sharing one glob collapse into a single
 *  block whose `rules` object is alphabetically sorted. */
function buildManagedOverrides(
  perRule: readonly IgnoreEntry[],
): readonly OverrideBlock[] {
  const sorted = [...perRule].sort((a, b) => a.id.localeCompare(b.id));
  const grouped = new Map<string, Set<string>>();
  for (const entry of sorted) {
    if (entry.rule === null) continue;
    let bucket = grouped.get(entry.glob);
    if (!bucket) {
      bucket = new Set<string>();
      grouped.set(entry.glob, bucket);
    }
    for (const r of expandRule(entry.rule)) bucket.add(r);
  }

  const blocks: OverrideBlock[] = [];
  for (const [glob, ruleSet] of grouped) {
    const rules: Record<string, "off"> = {};
    for (const r of [...ruleSet].sort()) rules[r] = "off";
    blocks.push({ files: [glob], rules });
  }
  return blocks;
}

function isStartOverrideMarker(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const rules = (block as { rules?: unknown }).rules;
  return (
    typeof rules === "object" &&
    rules !== null &&
    Object.prototype.hasOwnProperty.call(rules, IGNORE_MARKER_START)
  );
}

function isEndOverrideMarker(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const rules = (block as { rules?: unknown }).rules;
  return (
    typeof rules === "object" &&
    rules !== null &&
    Object.prototype.hasOwnProperty.call(rules, IGNORE_MARKER_END)
  );
}

/** Splice the qualy-managed slice into `overrides[]`. Returns `null` when
 *  there is nothing to manage AND no pre-existing markers — leaving the user
 *  preset's `overrides` key untouched (or absent). */
function rebuildOverrides(
  before: readonly unknown[],
  managed: readonly OverrideBlock[],
  hasPerRule: boolean,
): readonly unknown[] | null {
  const startIdx = before.findIndex(isStartOverrideMarker);
  const endIdx = before.findIndex(isEndOverrideMarker);
  const hasMarkers = startIdx !== -1 && endIdx !== -1 && startIdx < endIdx;

  if (!hasPerRule && !hasMarkers) return null;

  const managedSlice = [START_OVERRIDE_BLOCK, ...managed, END_OVERRIDE_BLOCK];
  if (hasMarkers) {
    return [
      ...before.slice(0, startIdx),
      ...managedSlice,
      ...before.slice(endIdx + 1),
    ];
  }
  return [...before, ...managedSlice];
}

// ---------------------------------------------------------------------------
// FS orchestration: compile + write fast + deep
// ---------------------------------------------------------------------------

export interface CompileBothResult {
  readonly ok: true;
  readonly files_changed: readonly string[];
}

export interface CompileBothError {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

/** Read both presets, compile against `manifest`, write the ones that changed.
 *  Each write goes through `safeWriteFile` so the lint-manifest registers it
 *  with `kind: "preset"` (and `merged: true` since presets pre-exist). */
export function compileToBothPresets(
  cwd: string,
  manifest: IgnoreManifest,
  io: SafeIO = {},
): CompileBothResult | CompileBothError {
  const filesChanged: string[] = [];

  for (const tier of ["fast", "deep"] as const) {
    const rel = PRESET_PATHS[tier];
    const abs = join(cwd, rel);
    const readFileFn = io.readFileFn ?? defaultRead;
    const raw = readFileFn(abs);
    if (raw === null) {
      return {
        ok: false,
        error: "preset_missing",
        reason: `${rel} not found under ${cwd} — run /lint:setup first`,
      };
    }
    const parsed = parseDefensive<PresetShape>(raw);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
      return {
        ok: false,
        error: "preset_malformed",
        reason: `${rel}: ${parsed.ok ? "not an object" : parsed.error}`,
      };
    }
    const compiled = compileToPreset(parsed.value, manifest);
    if (!compiled.ok) {
      return { ok: false, error: compiled.error, ...(compiled.reason ? { reason: compiled.reason } : {}) };
    }
    if (!compiled.changed) continue;

    const next = stringifyPretty(compiled.proposed);
    if (next === raw) continue;
    const write: SafeResult<{ readonly path: string }> = safeWriteFile(
      cwd,
      rel,
      next,
      { kind: "preset", merged: true },
      io,
    );
    if (!write.ok) {
      return {
        ok: false,
        error: "write_failed",
        reason: `${rel}: ${write.error}`,
      };
    }
    filesChanged.push(rel);
  }

  return { ok: true, files_changed: filesChanged };
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
