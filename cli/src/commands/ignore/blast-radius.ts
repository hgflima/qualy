/**
 * `ignore-blast-radius` — read-only count + sample of files matching a glob,
 * used by `/lint:ignore:add` and `/lint:ignore:remove` slash commands to show
 * the blast radius of an ignore mutation before confirming with the user
 * (lint-ignore SPEC §4 + §10 #5/#11, PLAN T4.3).
 *
 * Why a dedicated subcommand:
 *   - `/lint:ignore:remove` needs a real file count when warning the user that
 *     removing an ignore exposes those paths to the lint again.
 *   - `/lint:ignore:add` benefits from the same number ("you're about to
 *     silence rules across N files") for its blast-radius confirmation.
 *   Both flows must avoid bundling glob-matching logic into markdown — this
 *   subcommand exposes a deterministic CLI surface, mirroring the rationale
 *   used by `ignore-import-preview` (T3.4b) and `category-info` (T3.5).
 *
 * Behaviour:
 *   - Resolves <glob> against the working tree using fast-glob.
 *   - Excludes a fixed set of build/cache directories: node_modules, .git,
 *     dist, .harn, .lint-audit, .lint-backup. The list is hardcoded — the
 *     point of this preview is "files the user can edit", not every match.
 *   - Returns `files_in_glob` (total count) and `sample` (first 10 paths
 *     in fast-glob's natural order, stable for a given filesystem snapshot).
 *
 * Side effects: none.
 *
 * Exit codes:
 *   - OK                — preview computed (count may be 0).
 *   - RECOVERABLE_ERROR — empty glob (validation; SPEC §6 — invalid input).
 *   - USAGE_ERROR       — missing positional / unknown flag.
 */
import fastGlob from "fast-glob";
import { resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { logger, output } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Hardcoded exclusion list — these paths are never useful blast-radius
 *  output for an ignore mutation. Kept as a `readonly` tuple so tests can
 *  introspect the contract. */
export const BLAST_RADIUS_EXCLUDES: readonly string[] = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/.harn/**",
  "**/.lint-audit/**",
  "**/.lint-backup/**",
] as const;

/** Sample size for the `sample` field. Slash commands surface up to this
 *  many paths in their confirmation text — keep it small enough to fit in a
 *  single AskUserQuestion option label. */
export const BLAST_RADIUS_SAMPLE_LIMIT = 10;

export interface IgnoreBlastRadiusOptions {
  readonly cwd: string;
  readonly glob: string;
  /** Override the sample size (defaults to BLAST_RADIUS_SAMPLE_LIMIT).
   *  Negative or zero values fall back to the default to keep the contract
   *  predictable for shell-shaped callers. */
  readonly sampleLimit?: number;
}

export interface IgnoreBlastRadiusOk {
  readonly ok: true;
  readonly cwd: string;
  readonly glob: string;
  readonly files_in_glob: number;
  readonly sample: readonly string[];
  readonly exitCode: ExitCode;
}

export interface IgnoreBlastRadiusErr {
  readonly ok: false;
  readonly error: "invalid_glob" | string;
  readonly reason: string;
  readonly exitCode: ExitCode;
}

export type IgnoreBlastRadiusResult =
  | IgnoreBlastRadiusOk
  | IgnoreBlastRadiusErr;

/** Glob driver. Defaults to fast-glob's sync API. Tests inject a deterministic
 *  fake to avoid touching the real filesystem (mirrors the `runFn` seam in
 *  `recs/blast-radius.ts`). */
export type GlobFn = (
  glob: string,
  opts: { cwd: string; ignore: readonly string[] },
) => readonly string[];

export interface IgnoreBlastRadiusDeps {
  readonly globFn?: GlobFn;
}

// ---------------------------------------------------------------------------
// Default IO seam
// ---------------------------------------------------------------------------

const defaultGlob: GlobFn = (glob, opts) =>
  fastGlob.sync(glob, {
    cwd: opts.cwd,
    ignore: [...opts.ignore],
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
  });

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export function ignoreBlastRadius(
  opts: IgnoreBlastRadiusOptions,
  deps: IgnoreBlastRadiusDeps = {},
): IgnoreBlastRadiusResult {
  const glob = opts.glob.trim();
  if (glob.length === 0) {
    return {
      ok: false,
      error: "invalid_glob",
      reason: "glob must be a non-empty string",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const limit =
    typeof opts.sampleLimit === "number" && opts.sampleLimit > 0
      ? Math.floor(opts.sampleLimit)
      : BLAST_RADIUS_SAMPLE_LIMIT;

  const globFn = deps.globFn ?? defaultGlob;
  const matches = globFn(glob, {
    cwd: opts.cwd,
    ignore: BLAST_RADIUS_EXCLUDES,
  });

  // Defensive: fast-glob always returns an array, but tests injecting fakes
  // could return a non-array. Coerce to an empty list so the contract holds.
  const list: readonly string[] = Array.isArray(matches) ? matches : [];
  const sample = list.slice(0, limit);

  return {
    ok: true,
    cwd: opts.cwd,
    glob,
    files_in_glob: list.length,
    sample,
    exitCode: EXIT_CODES.OK,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly glob: string;
  readonly sampleLimit?: number;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreBlastRadiusArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let glob: string | null = null;
  let positional: string | null = null;
  let sampleLimit: number | undefined;

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
    if (arg === "--glob") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --glob" };
      }
      glob = value;
      i++;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --limit" };
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          ok: false,
          error: `--limit must be a positive integer (got '${value}')`,
        };
      }
      sampleLimit = n;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    if (typeof arg === "string" && !arg.startsWith("-") && positional === null) {
      positional = arg;
      continue;
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }

  const resolvedGlob = glob ?? positional;
  if (resolvedGlob === null) {
    return {
      ok: false,
      error: "missing glob (use --glob <pattern> or pass as positional)",
    };
  }
  return {
    ok: true,
    value: {
      cwd,
      glob: resolvedGlob,
      ...(sampleLimit !== undefined ? { sampleLimit } : {}),
    },
  };
}

export function runIgnoreBlastRadius(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreBlastRadiusArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-blast-radius <glob> [--cwd <path>] [--limit <N>]\n" +
          "\n" +
          "Read-only count + sample of files matching <glob> in the working\n" +
          "tree (excludes node_modules, .git, dist, .harn, .lint-audit,\n" +
          ".lint-backup). Used by /lint:ignore:add and /lint:ignore:remove\n" +
          "to show blast radius before confirming a mutation.\n" +
          "\n" +
          "Output JSON: { ok, cwd, glob, files_in_glob, sample }\n" +
          `(sample capped at ${String(BLAST_RADIUS_SAMPLE_LIMIT)} paths by default;\n` +
          " override with --limit <N>).\n" +
          "\n" +
          "Exit codes: 0 ok, 1 invalid_glob, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "ignore-blast-radius",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreBlastRadius({
    cwd: parsed.value.cwd,
    glob: parsed.value.glob,
    ...(parsed.value.sampleLimit !== undefined
      ? { sampleLimit: parsed.value.sampleLimit }
      : {}),
  });
  if (!result.ok) {
    logger.error("ignore_blast_radius_failed", {
      reason: result.reason ?? result.error,
    });
    output({ ok: false, error: result.error, reason: result.reason });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    glob: result.glob,
    files_in_glob: result.files_in_glob,
    sample: result.sample,
  });
  logger.info("ignore_blast_radius_ok", {
    glob: result.glob,
    files_in_glob: result.files_in_glob,
    sample_size: result.sample.length,
  });
  return result.exitCode;
}
