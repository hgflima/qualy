/**
 * `status` — read-only aggregator that surfaces every piece of state the
 * harness needs to render `/lint:status` (SPEC §2, §7.10). Compose-only:
 * delegates to `detectStage`, `detectTestRunner`, and `detectExistingLinter`,
 * plus a few targeted filesystem probes for the artifacts `/lint:setup` writes
 * (oxlint presets, hooks, husky, lint-staged, theme).
 *
 * Output shape (PLAN §Contratos CLI — `{ versions, presets, stage, hooks,
 * coverage, theme }`):
 *   {
 *     ok: true,
 *     cwd: string,
 *     versions: {
 *       oxlint:           string | null,   // installed version (node_modules)
 *       oxfmt:            string | null,
 *       quality_metrics:  string | null,
 *       vitest:           string | null,
 *       jest:             string | null,
 *     },
 *     presets: {
 *       oxlint_fast: string | null,        // path relative to cwd, e.g. "oxlint.fast.json"
 *       oxlint_deep: string | null,
 *     },
 *     stage: {
 *       detected: Stage | null,            // null when git/ls-files fails
 *       reasoning: string | null,
 *       signals: DetectStageSignals | null,
 *     },
 *     hooks: {
 *       claude_post_edit_script: boolean,  // .claude/hooks/post-edit.sh
 *       claude_settings_hook: boolean,     // .claude/settings.json mentions post-edit
 *       husky_pre_commit: boolean,         // .husky/pre-commit
 *       lint_staged_config: string | null, // path of detected config (or "package.json#lint-staged")
 *     },
 *     coverage: {
 *       runner: "vitest" | "jest" | "none",
 *       configured: boolean,
 *       current_thresholds: ThresholdsHit | null,
 *       source: string | null,
 *     },
 *     theme: string                        // default "linear-design-md"
 *   }
 *
 * Resilience: status is meant to be safe to call at any point — before setup,
 * mid-install, after uninstall. Every probe degrades to null/false rather than
 * erroring out. Only flag-parsing problems return USAGE_ERROR; a transient
 * `detectStage` git failure leaves `stage.detected = null` but the rest of the
 * payload is still emitted (and exit code stays OK).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";
import {
  type DetectStageSignals,
  type Stage,
  detectStage,
} from "./detect-stage.ts";
import {
  type RunnerName,
  type ThresholdsHit,
  detectTestRunner,
} from "./detect-test-runner.ts";

const DEFAULT_THEME = "linear-design-md";

/**
 * Packages whose installed versions we surface. Keys are stable JSON keys in
 * the output; values are the npm package names probed under
 * `node_modules/<name>/package.json`.
 */
const TRACKED_PACKAGES = {
  oxlint: "oxlint",
  oxfmt: "oxfmt",
  quality_metrics: "quality-metrics",
  vitest: "vitest",
  jest: "jest",
} as const;

type TrackedKey = keyof typeof TRACKED_PACKAGES;

const LINT_STAGED_CONFIG_FILES = [
  ".lintstagedrc",
  ".lintstagedrc.json",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
  ".lintstagedrc.js",
  ".lintstagedrc.cjs",
  ".lintstagedrc.mjs",
  "lint-staged.config.js",
  "lint-staged.config.cjs",
  "lint-staged.config.mjs",
] as const;

export interface StatusVersions {
  readonly oxlint: string | null;
  readonly oxfmt: string | null;
  readonly quality_metrics: string | null;
  readonly vitest: string | null;
  readonly jest: string | null;
}

export interface StatusPresets {
  readonly oxlint_fast: string | null;
  readonly oxlint_deep: string | null;
}

export interface StatusStage {
  readonly detected: Stage | null;
  readonly reasoning: string | null;
  readonly signals: DetectStageSignals | null;
}

export interface StatusHooks {
  readonly claude_post_edit_script: boolean;
  readonly claude_settings_hook: boolean;
  readonly husky_pre_commit: boolean;
  readonly lint_staged_config: string | null;
}

export interface StatusCoverage {
  readonly runner: RunnerName;
  readonly configured: boolean;
  readonly current_thresholds: ThresholdsHit | null;
  readonly source: string | null;
}

export interface StatusOk {
  readonly ok: true;
  readonly cwd: string;
  readonly versions: StatusVersions;
  readonly presets: StatusPresets;
  readonly stage: StatusStage;
  readonly hooks: StatusHooks;
  readonly coverage: StatusCoverage;
  readonly theme: string;
}

export type StatusResult = StatusOk;

export interface StatusOptions {
  readonly cwd: string;
}

export interface StatusDeps {
  readonly existsFn?: (path: string) => boolean;
  readonly readFileFn?: (path: string) => string | null;
  readonly now?: () => Date;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Reads `node_modules/<pkg>/package.json#version`. Returns `null` when the
 * package is not installed (fresh checkout, package manager not run yet),
 * the file is unreadable, or the JSON is malformed. We deliberately do NOT
 * fall back to the project's declared `package.json` range — SPEC §2 asks
 * for "versões instaladas", and a range like `^1.2.3` is not a version.
 */
function readInstalledVersion(
  cwd: string,
  pkgName: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): string | null {
  const pkgPath = join(cwd, "node_modules", pkgName, "package.json");
  if (!existsFn(pkgPath)) return null;
  const raw = readFileFn(pkgPath);
  if (raw === null) return null;
  const parsed = parseDefensive<{ version?: unknown }>(raw);
  if (!parsed.ok) return null;
  const v = parsed.value?.version;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readVersions(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): StatusVersions {
  const out = {} as Record<TrackedKey, string | null>;
  for (const key of Object.keys(TRACKED_PACKAGES) as TrackedKey[]) {
    out[key] = readInstalledVersion(cwd, TRACKED_PACKAGES[key], existsFn, readFileFn);
  }
  return out;
}

function readPresets(
  cwd: string,
  existsFn: (p: string) => boolean,
): StatusPresets {
  const fast = "oxlint.fast.json";
  const deep = "oxlint.deep.json";
  return {
    oxlint_fast: existsFn(join(cwd, fast)) ? fast : null,
    oxlint_deep: existsFn(join(cwd, deep)) ? deep : null,
  };
}

/**
 * Probe `.claude/settings.json` for any hook entry that references our
 * post-edit script. We treat a substring match against `post-edit.sh` as
 * sufficient evidence — schemas vary across Claude Code versions, and a
 * conservative substring check stays robust under reorganization (e.g. the
 * harness may rename the hook block but keep pointing at the same script).
 *
 * Returns false on missing/unreadable/malformed settings.
 */
function readClaudeSettingsHasHook(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): boolean {
  const path = join(cwd, ".claude", "settings.json");
  if (!existsFn(path)) return false;
  const raw = readFileFn(path);
  if (raw === null) return false;
  return raw.includes("post-edit.sh");
}

function readLintStagedConfig(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): string | null {
  for (const file of LINT_STAGED_CONFIG_FILES) {
    if (existsFn(join(cwd, file))) return file;
  }
  const pkgPath = join(cwd, "package.json");
  if (!existsFn(pkgPath)) return null;
  const raw = readFileFn(pkgPath);
  if (raw === null) return null;
  const parsed = parseDefensive<Record<string, unknown>>(raw);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (typeof value !== "object" || value === null) return null;
  if (Object.prototype.hasOwnProperty.call(value, "lint-staged")) {
    return "package.json#lint-staged";
  }
  return null;
}

function readHooks(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): StatusHooks {
  return {
    claude_post_edit_script: existsFn(join(cwd, ".claude", "hooks", "post-edit.sh")),
    claude_settings_hook: readClaudeSettingsHasHook(cwd, existsFn, readFileFn),
    husky_pre_commit: existsFn(join(cwd, ".husky", "pre-commit")),
    lint_staged_config: readLintStagedConfig(cwd, existsFn, readFileFn),
  };
}

/**
 * Theme resolution. Phase 6 adds full report config; until then we honor a
 * single `theme` field in `.lint-manifest.json` so an early `/lint:setup` can
 * record the user's choice without depending on Phase 6 landing.
 */
function readTheme(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): string {
  const path = join(cwd, ".lint-manifest.json");
  if (!existsFn(path)) return DEFAULT_THEME;
  const raw = readFileFn(path);
  if (raw === null) return DEFAULT_THEME;
  const parsed = parseDefensive<{ theme?: unknown }>(raw);
  if (!parsed.ok) return DEFAULT_THEME;
  const t = parsed.value?.theme;
  return typeof t === "string" && t.length > 0 ? t : DEFAULT_THEME;
}

/**
 * Pure aggregation. Inject `existsFn`/`readFileFn`/`now` for tests; production
 * uses `node:fs` and the wall clock.
 */
export function status(opts: StatusOptions, deps: StatusDeps = {}): StatusResult {
  const cwd = opts.cwd;
  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFileFn ?? defaultReadFile;

  const stageRes = detectStage({ cwd }, { existsFn, readFileFn, now: deps.now });
  const stage: StatusStage = stageRes.ok
    ? { detected: stageRes.stage, reasoning: stageRes.reasoning, signals: stageRes.signals }
    : { detected: null, reasoning: null, signals: null };

  const tr = detectTestRunner({ cwd }, { existsFn, readFileFn });
  const coverage: StatusCoverage = {
    runner: tr.runner,
    configured: tr.coverage.configured,
    current_thresholds: tr.coverage.current_thresholds,
    source: tr.coverage.source,
  };

  return {
    ok: true,
    cwd,
    versions: readVersions(cwd, existsFn, readFileFn),
    presets: readPresets(cwd, existsFn),
    stage,
    hooks: readHooks(cwd, existsFn, readFileFn),
    coverage,
    theme: readTheme(cwd, existsFn, readFileFn),
  };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseStatusArgs(
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

export function runStatus(argv: readonly string[]): ExitCode {
  const parsed = parseStatusArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy status [--cwd <path>]\n" +
          "\n" +
          "Aggregates installed versions, oxlint presets, detected stage, hooks,\n" +
          "coverage thresholds, and report theme. Read-only; always exits 0 on success.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "status", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = status(parsed.value);
  output(result);
  logger.info("status_done", {
    stage: result.stage.detected,
    runner: result.coverage.runner,
    fast_preset: result.presets.oxlint_fast !== null,
    deep_preset: result.presets.oxlint_deep !== null,
  });
  return EXIT_CODES.OK;
}
