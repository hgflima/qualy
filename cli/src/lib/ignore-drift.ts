/**
 * On-drift recompile safety net (lint-ignore SPEC §2.3, PLAN T4.1).
 *
 * `qualy audit` invokes this BEFORE shelling out to oxlint. The check exists so
 * a user who edits `.harn/qualy/ignore.json` by hand (or pulls a teammate's
 * change) does not run a stale preset — the next audit recompiles
 * automatically.
 *
 * Strategy (cheap path / hot path):
 *   1. Stat the ignore manifest. Absent → no-op (`manifest_absent`).
 *   2. Stat both presets. If neither exists → no-op (`preset_missing`); the
 *      audit pipeline already surfaces a clearer `preset_missing` error.
 *   3. Compare `mtime(manifest)` vs `min(mtime(preset_*))`. If the manifest
 *      is older than (or equal to) every preset, presets are already in sync
 *      → no-op (`presets_fresh`).
 *   4. Otherwise load + compile via `compileToBothPresets`. Even if the
 *      compilation produces zero file changes (idempotent), the call is still
 *      reported as `recompiled: true` so the caller can log the event.
 *
 * Failure modes propagate to the caller:
 *   - `manifest_corrupt` / `manifest_unsupported_version` — reuse the same
 *     errors `loadIgnoreManifest` returns. Audit treats them as fatal.
 *   - `preset_malformed` / `write_failed` — bubble up from
 *     `compileToBothPresets`.
 *
 * Determinism + idempotence: when the manifest is older than the preset, this
 * helper is a pure stat+compare with zero side effects. The drift gate keeps
 * the audit fast-path under the SPEC §10 50ms budget.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { type SafeIO } from "./fs-safe.ts";
import {
  type CompileBothError,
  compileToBothPresets,
} from "./ignore-compile.ts";
import {
  type LoadIgnoreManifestError,
  loadIgnoreManifest,
} from "./ignore-manifest.ts";
import {
  IGNORE_MANIFEST_PATH,
  PRESET_PATHS,
} from "./paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftSkippedReason =
  | "manifest_absent"
  | "preset_missing"
  | "presets_fresh";

export interface DriftSkipped {
  readonly ok: true;
  readonly recompiled: false;
  readonly reason: DriftSkippedReason;
  readonly files_changed: readonly [];
}

export interface DriftRecompiled {
  readonly ok: true;
  readonly recompiled: true;
  readonly files_changed: readonly string[];
}

export type DriftErrorCode =
  | LoadIgnoreManifestError
  | "preset_malformed"
  | "write_failed"
  | string;

export interface DriftErr {
  readonly ok: false;
  readonly error: DriftErrorCode;
  readonly reason?: string;
}

export type DriftCheckResult = DriftSkipped | DriftRecompiled | DriftErr;

export interface StatLike {
  readonly mtimeMs: number;
}

export type StatFn = (path: string) => StatLike | null;

export interface DriftCheckDeps {
  readonly statFn?: StatFn;
  readonly safeIO?: SafeIO;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function checkDriftAndRecompile(
  cwd: string,
  deps: DriftCheckDeps = {},
): DriftCheckResult {
  const statFn = deps.statFn ?? defaultStat;

  const manifestStat = statFn(join(cwd, IGNORE_MANIFEST_PATH));
  if (manifestStat === null) {
    return {
      ok: true,
      recompiled: false,
      reason: "manifest_absent",
      files_changed: [],
    };
  }

  // Compare against the OLDEST preset mtime. If any tracked preset is older
  // than the manifest, drift exists. Missing presets are a separate concern —
  // when both are missing we pass through (audit raises `preset_missing` on
  // its own); when only one is missing we still recompile to give
  // `compileToBothPresets` a chance to surface the proper error.
  const presetMtimes: number[] = [];
  let presetsExisting = 0;
  for (const tier of ["fast", "deep"] as const) {
    const s = statFn(join(cwd, PRESET_PATHS[tier]));
    if (s === null) continue;
    presetsExisting++;
    presetMtimes.push(s.mtimeMs);
  }

  if (presetsExisting === 0) {
    return {
      ok: true,
      recompiled: false,
      reason: "preset_missing",
      files_changed: [],
    };
  }

  if (presetsExisting === 2) {
    const minPresetMtime = Math.min(...presetMtimes);
    if (manifestStat.mtimeMs <= minPresetMtime) {
      return {
        ok: true,
        recompiled: false,
        reason: "presets_fresh",
        files_changed: [],
      };
    }
  }

  const loaded = loadIgnoreManifest(cwd, deps.safeIO ?? {});
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, reason: loaded.reason };
  }
  if (loaded.manifest === null) {
    // TOCTOU: stat saw the file, load found nothing. Treat as absent.
    return {
      ok: true,
      recompiled: false,
      reason: "manifest_absent",
      files_changed: [],
    };
  }

  const compiled = compileToBothPresets(cwd, loaded.manifest, deps.safeIO ?? {});
  if (!compiled.ok) return errFromCompile(compiled);

  return {
    ok: true,
    recompiled: true,
    files_changed: compiled.files_changed,
  };
}

function errFromCompile(e: CompileBothError): DriftErr {
  return {
    ok: false,
    error: e.error,
    ...(e.reason ? { reason: e.reason } : {}),
  };
}

function defaultStat(p: string): StatLike | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
