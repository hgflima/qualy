/**
 * Brownfield import — pre-existing user-authored `ignorePatterns[]` outside
 * the qualy markers (lint-ignore SPEC §2.4, PLAN T3.4).
 *
 * On the first qualy ignore mutation (i.e. when the manifest at
 * `.harn/qualy/ignore.json` is empty or absent), inspect both presets
 * (`oxlint.fast.json`, `oxlint.deep.json`) for `ignorePatterns[]` entries
 * sitting OUTSIDE the `_qualy:start_`/`_qualy:end_` slice. Each unique
 * pattern becomes an `IgnoreEntry` with:
 *
 *   - `createdBy: "imported"`
 *   - `reason: IMPORT_REASON` (constant — `qualy ignore-list` recognises it)
 *   - `expires: null`
 *   - `id` derived deterministically from `(glob, null)` (path-only).
 *
 * After a successful import, the caller (`commands/ignore/add.ts`) strips the
 * imported patterns from the OUTSIDE of the markers via `applyImportToPresets`
 * so the subsequent `compileToBothPresets` lands them inside the managed
 * marker block instead of leaving duplicates in two places.
 *
 * Skipped (no-op) when:
 *   - the manifest already has any entries (only the very first mutation
 *     imports — subsequent invocations leave the manifest alone).
 *   - both presets are missing or have no non-marker patterns.
 *   - a preset is malformed JSON (left to `compileToBothPresets` to surface
 *     with the proper `preset_malformed` exit code).
 *
 * Determinism: patterns are deduplicated across fast+deep, preserving
 * first-encounter order (fast first, then deep). Same input → same
 * imported entries in the same order, so unit tests can pin without sort.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type SafeIO, safeWriteFile } from "./fs-safe.ts";
import { type PresetShape } from "./ignore-compile.ts";
import {
  generateEntryId,
  IGNORE_MANIFEST_VERSION,
  type IgnoreEntry,
  type IgnoreManifest,
} from "./ignore-manifest.ts";
import { parseDefensive, stringifyPretty } from "./json.ts";
import {
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "./paths.ts";

/** Stable text used both as the entry `reason` and as a recognition signal in
 *  `qualy ignore-list` output. SPEC §2.4. */
export const IMPORT_REASON =
  "Imported from oxlint preset on first qualy ignore mutation";

export interface ImportedPattern {
  readonly glob: string;
  readonly id: string;
}

export interface ImportOk {
  readonly ok: true;
  readonly manifest: IgnoreManifest;
  readonly imported: readonly ImportedPattern[];
}

export type ImportResult = ImportOk;

/** Pure helper: extract the user-authored slice of `preset.ignorePatterns[]`
 *  — everything outside the `_qualy:start_`/`_qualy:end_` markers, in
 *  encounter order, with the marker strings themselves filtered out. When the
 *  markers are absent (or out of order), every pattern is treated as
 *  user-authored. */
export function extractNonMarkerPatterns(
  preset: PresetShape,
): readonly string[] {
  const raw = Array.isArray(preset.ignorePatterns)
    ? (preset.ignorePatterns as readonly unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const startIdx = raw.indexOf(IGNORE_MARKER_START);
  const endIdx = raw.indexOf(IGNORE_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return raw.filter(
      (p) => p !== IGNORE_MARKER_START && p !== IGNORE_MARKER_END,
    );
  }
  return [...raw.slice(0, startIdx), ...raw.slice(endIdx + 1)];
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Detect non-marker patterns in fast+deep, return a manifest pre-populated
 *  with imported entries. When the manifest already has entries OR no
 *  patterns are detected, returns the input manifest unchanged with
 *  `imported: []`. */
export function importBrownfieldIgnores(
  cwd: string,
  manifest: IgnoreManifest,
  now: Date,
  io: SafeIO = {},
): ImportResult {
  if (manifest.entries.length > 0) {
    return { ok: true, manifest, imported: [] };
  }

  const readFileFn = io.readFileFn ?? defaultRead;
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const tier of ["fast", "deep"] as const) {
    const abs = join(cwd, PRESET_PATHS[tier]);
    const raw = readFileFn(abs);
    if (raw === null) continue;
    const parsed = parseDefensive<PresetShape>(raw);
    if (
      !parsed.ok ||
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      // Malformed presets are not fatal here — `compileToBothPresets`
      // surfaces them downstream with `preset_malformed`.
      continue;
    }
    const patterns = extractNonMarkerPatterns(parsed.value);
    for (const p of patterns) {
      if (seen.has(p)) continue;
      seen.add(p);
      ordered.push(p);
    }
  }

  if (ordered.length === 0) {
    return { ok: true, manifest, imported: [] };
  }

  const createdAt = now.toISOString();
  const newEntries: IgnoreEntry[] = [];
  const imported: ImportedPattern[] = [];
  for (const glob of ordered) {
    const id = generateEntryId(glob, null);
    imported.push({ glob, id });
    newEntries.push({
      id,
      glob,
      rule: null,
      reason: IMPORT_REASON,
      expires: null,
      createdAt,
      createdBy: "imported",
    });
  }

  return {
    ok: true,
    manifest: {
      version: IGNORE_MANIFEST_VERSION,
      entries: [...manifest.entries, ...newEntries],
    },
    imported,
  };
}

/** Pure helper: return a clone of `preset` with each pattern in `imported`
 *  removed from `ignorePatterns[]`. Markers and unrelated patterns are
 *  preserved untouched. The shape is otherwise byte-for-byte identical to
 *  the input. */
export function stripImportedFromPreset(
  preset: PresetShape,
  imported: readonly string[],
): { readonly preset: PresetShape; readonly changed: boolean } {
  if (imported.length === 0) return { preset, changed: false };
  const before = Array.isArray(preset.ignorePatterns)
    ? (preset.ignorePatterns as readonly unknown[])
    : null;
  if (before === null) return { preset, changed: false };
  const toRemove = new Set(imported);
  const next = before.filter(
    (v) => !(typeof v === "string" && toRemove.has(v)),
  );
  if (next.length === before.length) return { preset, changed: false };
  return { preset: { ...preset, ignorePatterns: next }, changed: true };
}

export interface ApplyImportOk {
  readonly ok: true;
  readonly files_changed: readonly string[];
}

export interface ApplyImportErr {
  readonly ok: false;
  readonly error: string;
  readonly reason: string;
}

/** Strip the imported patterns from BOTH presets so `compileToBothPresets`
 *  can re-emit them inside the managed marker block without leaving
 *  duplicates outside. Each preset is read, parsed, stripped, and written
 *  back via `safeWriteFile` (kind `"preset"`, merged) — same path the
 *  compile pipeline uses, so manifest entries stay consistent. */
export function applyImportToPresets(
  cwd: string,
  imported: readonly string[],
  io: SafeIO = {},
): ApplyImportOk | ApplyImportErr {
  if (imported.length === 0) return { ok: true, files_changed: [] };
  const readFileFn = io.readFileFn ?? defaultRead;
  const filesChanged: string[] = [];

  for (const tier of ["fast", "deep"] as const) {
    const rel = PRESET_PATHS[tier];
    const abs = join(cwd, rel);
    const raw = readFileFn(abs);
    if (raw === null) continue;
    const parsed = parseDefensive<PresetShape>(raw);
    if (
      !parsed.ok ||
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      // Same lenient policy as `importBrownfieldIgnores` — malformed presets
      // are surfaced later by `compileToBothPresets`.
      continue;
    }
    const stripped = stripImportedFromPreset(parsed.value, imported);
    if (!stripped.changed) continue;

    const next = stringifyPretty(stripped.preset);
    if (next === raw) continue;
    const write = safeWriteFile(
      cwd,
      rel,
      next,
      { kind: "preset", merged: true },
      io,
    );
    if (!write.ok) {
      return {
        ok: false,
        error: "import_strip_write_failed",
        reason: `${rel}: ${write.error}`,
      };
    }
    filesChanged.push(rel);
  }

  return { ok: true, files_changed: filesChanged };
}
