/**
 * `ignore-compile` — recompile `.harn/qualy/ignore.json` → `oxlint.{fast,deep}.json`
 * (lint-ignore SPEC §3.5, PLAN T2.3).
 *
 * Two modes:
 *   - default: writes any preset whose on-disk content drifts from the
 *     compiled output. `applied: string[]` lists the preset rel-paths
 *     that were rewritten.
 *   - `--check`: read-only drift detector. `in_sync: bool` plus
 *     `drifted: string[]` for the failing presets. Exits `1` when
 *     drift is present so CI / pre-commit hooks can gate on it.
 *
 * Not exposed as a slash command — it is an implementation detail
 * invoked by `qualy ignore-add|remove` and by the on-drift safety net
 * in `qualy lint`/`audit` (T4.1).
 */
import { resolve } from "node:path";

import {
  type CompileBothError,
  compileToBothPresets,
  compileToPreset,
} from "../../lib/ignore-compile.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO } from "../../lib/fs-safe.ts";
import {
  type IgnoreManifest,
  loadIgnoreManifest,
} from "../../lib/ignore-manifest.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";
import { PRESET_PATHS } from "../../lib/paths.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IgnoreCompileOptions {
  readonly cwd: string;
  readonly check: boolean;
}

export interface IgnoreCompileWriteOk {
  readonly ok: true;
  readonly cwd: string;
  readonly applied: readonly string[];
  readonly exitCode: ExitCode;
}

export interface IgnoreCompileCheckOk {
  readonly ok: true;
  readonly cwd: string;
  readonly in_sync: boolean;
  readonly drifted: readonly string[];
  readonly exitCode: ExitCode;
}

export interface IgnoreCompileErr {
  readonly ok: false;
  readonly error:
    | "manifest_corrupt"
    | "manifest_unsupported_version"
    | string;
  readonly reason?: string;
  readonly exitCode: ExitCode;
}

export type IgnoreCompileResult =
  | IgnoreCompileWriteOk
  | IgnoreCompileCheckOk
  | IgnoreCompileErr;

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export function ignoreCompile(
  opts: IgnoreCompileOptions,
  io: SafeIO = {},
): IgnoreCompileResult {
  // Load classifies missing/corrupt/unsupported-version separately so a
  // mangled `ignore.json` cannot be silently treated as "no manifest yet"
  // (SPEC §3.1 — fatal exit when manifest is corrupt).
  const loaded = loadIgnoreManifest(opts.cwd, io);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }
  const manifest = loaded.manifest;
  // Absent manifest → nothing to compile. No-op (in sync, no writes).
  // SPEC §6 drift safety: only manage the manifest's lifecycle, never create
  // marker pairs in presets when the user hasn't authored any ignore.
  if (manifest === null) {
    if (opts.check) {
      return {
        ok: true,
        cwd: opts.cwd,
        in_sync: true,
        drifted: [],
        exitCode: EXIT_CODES.OK,
      };
    }
    return {
      ok: true,
      cwd: opts.cwd,
      applied: [],
      exitCode: EXIT_CODES.OK,
    };
  }

  if (opts.check) {
    return runCheckMode(opts.cwd, manifest, io);
  }
  return runWriteMode(opts.cwd, manifest, io);
}

function runWriteMode(
  cwd: string,
  manifest: IgnoreManifest,
  io: SafeIO,
): IgnoreCompileWriteOk | IgnoreCompileErr {
  const r = compileToBothPresets(cwd, manifest, io);
  if (!r.ok) return errFrom(r);
  return {
    ok: true,
    cwd,
    applied: r.files_changed,
    exitCode: EXIT_CODES.OK,
  };
}

function runCheckMode(
  cwd: string,
  manifest: IgnoreManifest,
  io: SafeIO,
): IgnoreCompileCheckOk | IgnoreCompileErr {
  const drifted: string[] = [];
  for (const tier of ["fast", "deep"] as const) {
    const rel = PRESET_PATHS[tier];
    const abs = join(cwd, rel);
    const readFileFn = io.readFileFn ?? defaultRead;
    const raw = readFileFn(abs);
    if (raw === null) {
      // Missing presets count as drifted (anything would change).
      drifted.push(rel);
      continue;
    }
    const parsed = parseDefensive<Record<string, unknown>>(raw);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
      drifted.push(rel);
      continue;
    }
    const compiled = compileToPreset(parsed.value, manifest);
    if (!compiled.ok) {
      return errFrom({
        ok: false,
        error: compiled.error,
        ...(compiled.reason ? { reason: compiled.reason } : {}),
      });
    }
    if (compiled.changed) {
      drifted.push(rel);
      continue;
    }
    // Even when ignorePatterns matches, the JSON serialization may differ.
    if (stringifyPretty(compiled.proposed) !== raw) drifted.push(rel);
  }

  const inSync = drifted.length === 0;
  return {
    ok: true,
    cwd,
    in_sync: inSync,
    drifted,
    exitCode: inSync ? EXIT_CODES.OK : EXIT_CODES.RECOVERABLE_ERROR,
  };
}

function errFrom(e: CompileBothError): IgnoreCompileErr {
  return {
    ok: false,
    error: e.error,
    ...(e.reason ? { reason: e.reason } : {}),
    exitCode: EXIT_CODES.RECOVERABLE_ERROR,
  };
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly check: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreCompileArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let check = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
      cwd = resolve(defaultCwd, value);
      i++;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, check } };
}

export function runIgnoreCompile(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreCompileArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-compile [--check] [--cwd <path>]\n" +
          "\n" +
          "Recompile .harn/qualy/ignore.json → oxlint.{fast,deep}.json.\n" +
          "Without --check, writes any preset whose content drifts from the\n" +
          "compiled output. With --check, reports drift without writing\n" +
          "(exit 1 when drifted, 0 when in sync).\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "ignore-compile", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreCompile(parsed.value);
  if (!result.ok) {
    logger.error("ignore_compile_failed", { reason: result.reason ?? result.error });
    output({ ok: false, error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
    return result.exitCode;
  }

  if ("applied" in result) {
    output({ ok: true, cwd: result.cwd, applied: result.applied });
    logger.info("ignore_compile_ok", { applied: result.applied.length });
  } else {
    output({
      ok: true,
      cwd: result.cwd,
      in_sync: result.in_sync,
      drifted: result.drifted,
    });
    if (!result.in_sync) {
      logger.warn("ignore_compile_drift", { drifted: result.drifted });
    } else {
      logger.info("ignore_compile_in_sync", {});
    }
  }
  return result.exitCode;
}
