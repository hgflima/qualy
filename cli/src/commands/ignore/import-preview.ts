/**
 * `ignore-import-preview` — read-only preview of patterns that would be
 * brownfield-imported on the next mutating `qualy ignore-*` call (lint-ignore
 * SPEC §2.4, PLAN T3.4b).
 *
 * Why a dedicated subcommand:
 *   The slash command `/lint:ignore:add` (T3.5) needs to decide whether to
 *   surface an `AskUserQuestion` confirmation flow before invoking
 *   `qualy ignore-add` (threshold ≥5 patterns). Without this preview, the
 *   slash command would have to (a) duplicate the marker-aware detection
 *   logic in markdown, or (b) inspect the raw preset with Bash. Both
 *   fragilize the contract — the slash command driver should rely on a
 *   deterministic CLI surface.
 *
 * Behaviour:
 *   - Reads `.harn/qualy/ignore.json` and both presets.
 *   - When the manifest is non-empty (or absent-but-presets-have-no-non-marker-
 *     patterns), reports `count: 0` and an empty `would_import`.
 *   - Otherwise lists every pattern outside the qualy markers in encounter
 *     order (fast first, then deep), tagged with the tier where it was first
 *     encountered. Patterns shared between fast+deep land once with
 *     `tier: "fast"` (matches `importBrownfieldIgnores` dedup order).
 *
 * Side effects: none. The manifest, presets, and decision log are all left
 * untouched. Mutating callers (`qualy ignore-add`) re-do the import via
 * `importBrownfieldIgnores` when they actually run.
 *
 * Exit codes:
 *   - OK              — preview computed (regardless of count).
 *   - INTERNAL_ERROR  — manifest corrupt / unsupported version (SPEC §3.1
 *                       fatal-state path; mirrors `ignore-compile`/`ignore-add`).
 *   - USAGE_ERROR     — flag parser failure.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO } from "../../lib/fs-safe.ts";
import { type PresetShape } from "../../lib/ignore-compile.ts";
import { extractNonMarkerPatterns } from "../../lib/ignore-import.ts";
import { loadIgnoreManifest } from "../../lib/ignore-manifest.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";
import { PRESET_PATHS } from "../../lib/paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImportPreviewTier = "fast" | "deep";

export interface ImportPreviewPattern {
  readonly glob: string;
  readonly tier: ImportPreviewTier;
}

export interface ImportPreviewOptions {
  readonly cwd: string;
}

export interface ImportPreviewOk {
  readonly ok: true;
  readonly cwd: string;
  readonly manifest_empty: boolean;
  readonly would_import: readonly ImportPreviewPattern[];
  readonly count: number;
  readonly exitCode: ExitCode;
}

export interface ImportPreviewErr {
  readonly ok: false;
  readonly error: "manifest_corrupt" | "manifest_unsupported_version" | string;
  readonly reason?: string;
  readonly exitCode: ExitCode;
}

export type ImportPreviewResult = ImportPreviewOk | ImportPreviewErr;

export interface ImportPreviewDeps {
  readonly safeIO?: SafeIO;
  readonly readFileFn?: (p: string) => string | null;
}

// ---------------------------------------------------------------------------
// IO defaults
// ---------------------------------------------------------------------------

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export function ignoreImportPreview(
  opts: ImportPreviewOptions,
  deps: ImportPreviewDeps = {},
): ImportPreviewResult {
  const loaded = loadIgnoreManifest(opts.cwd, deps.safeIO);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }

  // Non-empty manifest → only the very first mutation imports, so any
  // subsequent invocation must report 0. Mirrors `importBrownfieldIgnores`.
  const manifestEmpty =
    loaded.manifest === null || loaded.manifest.entries.length === 0;
  if (!manifestEmpty) {
    return {
      ok: true,
      cwd: opts.cwd,
      manifest_empty: false,
      would_import: [],
      count: 0,
      exitCode: EXIT_CODES.OK,
    };
  }

  const readFileFn =
    deps.readFileFn ?? deps.safeIO?.readFileFn ?? defaultRead;
  const seen = new Set<string>();
  const ordered: ImportPreviewPattern[] = [];

  for (const tier of ["fast", "deep"] as const) {
    const abs = join(opts.cwd, PRESET_PATHS[tier]);
    const raw = readFileFn(abs);
    if (raw === null) continue;
    const parsed = parseDefensive<PresetShape>(raw);
    if (
      !parsed.ok ||
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      // Malformed presets are not fatal — `compileToBothPresets` surfaces
      // them downstream when the user actually mutates. Preview stays lenient.
      continue;
    }
    const patterns = extractNonMarkerPatterns(parsed.value);
    for (const p of patterns) {
      if (seen.has(p)) continue;
      seen.add(p);
      ordered.push({ glob: p, tier });
    }
  }

  return {
    ok: true,
    cwd: opts.cwd,
    manifest_empty: true,
    would_import: ordered,
    count: ordered.length,
    exitCode: EXIT_CODES.OK,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreImportPreviewArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;

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
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd } };
}

export function runIgnoreImportPreview(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreImportPreviewArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-import-preview [--cwd <path>]\n" +
          "\n" +
          "Read-only preview of brownfield patterns that would be imported on\n" +
          "the next mutating ignore-* call. Reports `count` and `would_import`\n" +
          "(each entry tagged with the tier where it was first encountered).\n" +
          "Used by /lint:ignore:add to gate the AskUserQuestion threshold.\n" +
          "\n" +
          "Exit codes: 0 ok, 4 usage, 70 manifest corrupt/unsupported version.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "ignore-import-preview",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreImportPreview({ cwd: parsed.value.cwd });
  if (!result.ok) {
    logger.error("ignore_import_preview_failed", {
      reason: result.reason ?? result.error,
    });
    output({
      ok: false,
      error: result.error,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    manifest_empty: result.manifest_empty,
    would_import: result.would_import,
    count: result.count,
  });
  logger.info("ignore_import_preview_ok", {
    manifest_empty: result.manifest_empty,
    count: result.count,
  });
  return result.exitCode;
}
