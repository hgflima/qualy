/**
 * Ignore-manifest → oxlint preset compiler (lint-ignore SPEC §2.3, PLAN T2.2).
 *
 * Phase 2 (this file): only path-only entries (`rule === null`) — projected
 * into `ignorePatterns[]` between the `_qualy:start_`/`_qualy:end_` sentinels.
 * Phase 3 will extend the same module with `overrides[]` for `rule !== null`
 * entries plus `category:*` expansion.
 *
 * Determinism guarantees:
 *   - Entries are sorted by `id` (which is itself a deterministic
 *     sha256-derived hash of `(glob, rule)` — see `ignore-manifest.ts`).
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
 *     managed block is appended to the end of `ignorePatterns[]`. P3 import
 *     will eventually move pre-existing patterns into the manifest, but P2
 *     keeps them in place.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type SafeIO,
  type SafeResult,
  safeWriteFile,
} from "./fs-safe.ts";
import { parseDefensive, stringifyPretty } from "./json.ts";
import { type IgnoreManifest } from "./ignore-manifest.ts";
import {
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "./paths.ts";

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

/** Build the `ignorePatterns[]` array for a preset given the manifest.
 *  Path-only (`rule === null`) entries only — per-rule entries are deferred
 *  to Phase 3. */
export function compileToPreset(
  current: PresetShape,
  manifest: IgnoreManifest,
): CompileResult | CompileError {
  // Sort path-only entries by id for deterministic output.
  const pathOnlyGlobs = manifest.entries
    .filter((e) => e.rule === null)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((e) => e.glob);

  const before = Array.isArray(current.ignorePatterns)
    ? (current.ignorePatterns as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];

  const next = rebuildIgnorePatterns(before, pathOnlyGlobs);

  // Preserve every other key in original insertion order; only replace
  // `ignorePatterns`. When the original lacked the key entirely, append it.
  const proposed: PresetShape = { ...current, ignorePatterns: next };

  const changed = !arraysEqual(before, next);
  return { ok: true, proposed, changed };
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
