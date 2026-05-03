/**
 * `install-coverage` — write the runner-appropriate coverage thresholds into
 * the target project's test config.
 *
 * SPEC §3 (Estratégia de coverage) drives the runner branch:
 *   - vitest → edit `vitest.config.{ts,mts,cts,js,mjs,cjs}` via ts-morph
 *     (`applyVitestCoverage`), writing `test.coverage.{provider,reporter,
 *     thresholds}`. When no vitest config exists, a minimal
 *     `vitest.config.ts` is generated from a static template.
 *   - jest   → edit `jest.config.json` (when JSON), or merge into
 *     `package.json#jest` (when only that or no jest config exists). JS/TS
 *     jest configs are read-only here — we never overwrite a `module.exports`
 *     file blindly; the harness must surface the user's existing config so
 *     they can apply the patch manually.
 *   - none   → no-op (action: "noop"). The harness asks the user whether to
 *     adopt vitest before invoking this command (SPEC §3 — "pergunta ao
 *     usuário se quer adotar Vitest").
 *
 * Stage → preset filename mapping: `detect-stage` reports
 *   {greenfield, brownfield-moderate, legacy} but the bundled preset files use
 *   {greenfield, brownfield, legacy} on disk. The mapping happens here so
 *   stage names stay consistent across the rest of the CLI.
 *
 * Thresholds resolution order (highest precedence first):
 *   1. `--thresholds <json>`  — caller-composed override (PLAN §Contratos CLI:
 *      "respeita thresholds passados via --thresholds").
 *   2. Bundled preset for the resolved stage —
 *      `cli/src/presets/coverage/jest.<stage>.json#coverageThreshold.global`
 *      is the single numeric source of truth (vitest preset .ts files are
 *      locked to identical values by `presets-coverage.test.ts`).
 *
 * Output (PLAN §Contratos CLI):
 *   {
 *     ok, cwd, runner, stage, stageSource: "explicit"|"detected",
 *     thresholdsSource: "explicit"|"preset",
 *     thresholds: { lines, functions, branches, statements },
 *     warnOnly: boolean,                 // true on legacy stage
 *     written: { path, bytes, recorded, merged, changed } | null,
 *     action: "updated" | "noop" | "created"
 *   }
 *
 * Exit codes:
 *   - OK                — config edited, created, or already at target values.
 *   - USAGE_ERROR       — unknown flag, malformed `--thresholds` / `--runner` /
 *                         `--stage`.
 *   - RECOVERABLE_ERROR — detection failed, preset missing, config parse
 *                         failed, write failed, JS/TS jest config blocks edit.
 *   - DIRTY_TREE        — `--strict` set and working tree dirty.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";
import {
  type VitestThresholds,
  applyVitestCoverage,
} from "../../lib/ts-config-edit.ts";
import { type Stage, detectStage } from "../detect-stage.ts";
import { type RunnerName, detectTestRunner } from "../detect-test-runner.ts";

export type Runner = "vitest" | "jest" | "none";

const RUNNERS: readonly Runner[] = ["vitest", "jest", "none"];
const STAGES: readonly Stage[] = ["greenfield", "brownfield-moderate", "legacy"];
const THRESHOLD_KEYS = ["lines", "functions", "branches", "statements"] as const;
type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

const VITEST_CONFIG_CANDIDATES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
] as const;

const JEST_JSON_CONFIG = "jest.config.json";
const JEST_JS_CONFIG_CANDIDATES = [
  "jest.config.ts",
  "jest.config.mts",
  "jest.config.cts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
] as const;

const PACKAGE_JSON_REL = "package.json";

const PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "presets",
  "coverage",
);

const REPORTERS = ["text", "json", "json-summary", "html"] as const;
const PROVIDER = "v8";

/**
 * Skeleton written when a vitest project has no config file at all. Kept
 * intentionally minimal — `applyVitestCoverage` then layers thresholds in.
 */
const VITEST_CONFIG_SKELETON = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {},
});
`;

interface JestPresetShape {
  readonly coverageThreshold?: {
    readonly global?: Record<string, unknown>;
  };
  readonly _warnOnly?: boolean;
}

export interface CoverageThresholds {
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
  readonly statements: number;
}

export interface InstallCoverageOptions {
  readonly cwd: string;
  /** Explicit runner. When omitted, `detect-test-runner` runs. */
  readonly runner?: Runner;
  /** Explicit stage. When omitted, `detect-stage` runs. */
  readonly stage?: Stage;
  /** Explicit threshold override; falls back to the stage's preset when omitted. */
  readonly thresholds?: CoverageThresholds;
  readonly strict?: boolean;
}

export interface InstallCoverageWritten {
  readonly path: string;
  readonly bytes: number;
  readonly recorded: boolean;
  readonly merged: boolean;
  readonly changed: boolean;
}

export interface InstallCoverageOk {
  readonly ok: true;
  readonly cwd: string;
  readonly runner: Runner;
  readonly stage: Stage | null;
  readonly stageSource: "explicit" | "detected" | "n/a";
  readonly thresholds: CoverageThresholds | null;
  readonly thresholdsSource: "explicit" | "preset" | "n/a";
  readonly warnOnly: boolean;
  readonly written: InstallCoverageWritten | null;
  readonly action: "updated" | "noop" | "created";
}

export interface InstallCoverageErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallCoverageResult = InstallCoverageOk | InstallCoverageErr;

export interface InstallCoverageDeps {
  readonly presetsDir?: string;
  readonly readFileFn?: (path: string) => string | null;
  readonly existsFn?: (path: string) => boolean;
  readonly safeIO?: SafeIO;
  readonly detectStageFn?: typeof detectStage;
  readonly detectRunnerFn?: typeof detectTestRunner;
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

/** Maps the `detect-stage` name onto the on-disk preset filename slug. */
function presetStageSlug(stage: Stage): "greenfield" | "brownfield" | "legacy" {
  if (stage === "brownfield-moderate") return "brownfield";
  return stage;
}

function readPresetThresholds(
  presetsDir: string,
  stage: Stage,
  readFileFn: (p: string) => string | null,
): { thresholds: CoverageThresholds; warnOnly: boolean } | { error: string } {
  const slug = presetStageSlug(stage);
  const path = join(presetsDir, `jest.${slug}.json`);
  const raw = readFileFn(path);
  if (raw === null) return { error: `preset_read_failed: ${path}` };
  const parsed = parseDefensive<JestPresetShape>(raw);
  if (!parsed.ok) return { error: `preset_malformed: ${parsed.error}` };
  const global = parsed.value.coverageThreshold?.global;
  if (!global || typeof global !== "object") {
    return { error: "preset_malformed: missing coverageThreshold.global" };
  }
  const out: Partial<Record<ThresholdKey, number>> = {};
  for (const k of THRESHOLD_KEYS) {
    const v = (global as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { error: `preset_malformed: ${k} is not a finite number` };
    }
    out[k] = v;
  }
  return {
    thresholds: out as CoverageThresholds,
    warnOnly: parsed.value._warnOnly === true,
  };
}

interface ResolvedRunner {
  readonly runner: Runner;
}

function resolveRunner(
  opts: InstallCoverageOptions,
  detectRunnerFn: typeof detectTestRunner,
):
  | { ok: true; value: ResolvedRunner }
  | { ok: false; error: string; reason: string } {
  if (opts.runner !== undefined) return { ok: true, value: { runner: opts.runner } };
  const detect = detectRunnerFn({ cwd: opts.cwd });
  const r: RunnerName = detect.runner;
  return { ok: true, value: { runner: r } };
}

function resolveStage(
  opts: InstallCoverageOptions,
  detectStageFn: typeof detectStage,
):
  | { ok: true; stage: Stage; source: "explicit" | "detected" }
  | { ok: false; error: string; reason: string } {
  if (opts.stage !== undefined) {
    return { ok: true, stage: opts.stage, source: "explicit" };
  }
  const r = detectStageFn({ cwd: opts.cwd });
  if (!r.ok) {
    return { ok: false, error: "stage_detection_failed", reason: r.error };
  }
  return { ok: true, stage: r.stage, source: "detected" };
}

function findExistingFile(
  cwd: string,
  candidates: readonly string[],
  existsFn: (p: string) => boolean,
): string | null {
  for (const file of candidates) {
    if (existsFn(join(cwd, file))) return file;
  }
  return null;
}

function vitestPatchFromThresholds(t: CoverageThresholds): {
  provider: string;
  reporter: readonly string[];
  thresholds: VitestThresholds;
} {
  return {
    provider: PROVIDER,
    reporter: REPORTERS,
    thresholds: { ...t },
  };
}

function applyVitest(
  opts: InstallCoverageOptions,
  thresholds: CoverageThresholds,
  deps: InstallCoverageDeps,
): InstallCoverageResult {
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const existing = findExistingFile(opts.cwd, VITEST_CONFIG_CANDIDATES, existsFn);
  const patch = vitestPatchFromThresholds(thresholds);

  const targetRel = existing ?? "vitest.config.ts";
  const baseSource = existing
    ? readFileFn(join(opts.cwd, existing))
    : VITEST_CONFIG_SKELETON;
  if (baseSource === null) {
    return {
      ok: false,
      error: "config_read_failed",
      reason: `cannot read ${existing ?? "vitest.config.ts"}`,
    };
  }

  const applied = applyVitestCoverage(baseSource, patch);
  if (!applied.ok) {
    return { ok: false, error: "config_edit_failed", reason: applied.error };
  }

  const created = existing === null;
  const noop = !created && !applied.value.changed;

  if (noop) {
    return baseOk({
      cwd: opts.cwd,
      runner: "vitest",
      stage: opts.stage ?? null,
      stageSource: opts.stage !== undefined ? "explicit" : "detected",
      thresholds,
      thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
      warnOnly: false,
      written: null,
      action: "noop",
    });
  }

  const writeRes = safeWriteFile(
    opts.cwd,
    targetRel,
    applied.value.content,
    {
      kind: "coverage",
      merged: !created,
      strict: opts.strict ?? false,
    },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return {
      ok: false,
      error: "write_failed",
      reason: `${targetRel}: ${writeRes.error}`,
    };
  }

  return baseOk({
    cwd: opts.cwd,
    runner: "vitest",
    stage: opts.stage ?? null,
    stageSource: opts.stage !== undefined ? "explicit" : "detected",
    thresholds,
    thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
    warnOnly: false,
    written: {
      path: writeRes.value.path,
      bytes: writeRes.value.bytes,
      recorded: writeRes.value.recorded,
      merged: !created,
      changed: applied.value.changed,
    },
    action: created ? "created" : "updated",
  });
}

function buildJestGlobalBlock(t: CoverageThresholds): Record<string, unknown> {
  return {
    collectCoverage: true,
    coverageProvider: PROVIDER,
    coverageReporters: [...REPORTERS],
    coverageThreshold: {
      global: { ...t },
    },
  };
}

interface JestMergeOutcome {
  readonly content: Record<string, unknown>;
  readonly changed: boolean;
}

/**
 * Merges the desired coverage block onto an existing jest-shaped config.
 * Per-key comparisons keep `changed` false when every leaf already matches.
 * Sibling keys (e.g. `testMatch`, `transform`) are left untouched.
 */
function mergeIntoJest(
  existing: Record<string, unknown> | null,
  thresholds: CoverageThresholds,
): JestMergeOutcome {
  const base: Record<string, unknown> = existing ? { ...existing } : {};
  const desired = buildJestGlobalBlock(thresholds);
  let changed = false;

  if (base["collectCoverage"] !== desired["collectCoverage"]) {
    base["collectCoverage"] = desired["collectCoverage"];
    changed = true;
  }
  if (base["coverageProvider"] !== desired["coverageProvider"]) {
    base["coverageProvider"] = desired["coverageProvider"];
    changed = true;
  }
  if (
    !arrayEqual(
      base["coverageReporters"],
      desired["coverageReporters"] as readonly string[],
    )
  ) {
    base["coverageReporters"] = [...REPORTERS];
    changed = true;
  }

  const ct = isObject(base["coverageThreshold"])
    ? { ...(base["coverageThreshold"] as Record<string, unknown>) }
    : {};
  const global = isObject(ct["global"])
    ? { ...(ct["global"] as Record<string, unknown>) }
    : {};
  for (const k of THRESHOLD_KEYS) {
    if (global[k] !== thresholds[k]) {
      global[k] = thresholds[k];
      changed = true;
    }
  }
  ct["global"] = global;
  base["coverageThreshold"] = ct;

  return { content: base, changed };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrayEqual(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function applyJest(
  opts: InstallCoverageOptions,
  thresholds: CoverageThresholds,
  deps: InstallCoverageDeps,
): InstallCoverageResult {
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const jsonAbs = join(opts.cwd, JEST_JSON_CONFIG);
  const jsonExists = existsFn(jsonAbs);
  const jsConfig = findExistingFile(opts.cwd, JEST_JS_CONFIG_CANDIDATES, existsFn);

  if (jsonExists) {
    return applyJestJson(opts, thresholds, deps, readFileFn);
  }
  if (jsConfig !== null) {
    return {
      ok: false,
      error: "jest_js_config_unsupported",
      reason: `jest config at ${jsConfig} is JS/TS — install-coverage cannot edit it safely. Apply the coverage block manually or migrate to ${JEST_JSON_CONFIG}.`,
    };
  }
  return applyJestPackageJson(opts, thresholds, deps, existsFn, readFileFn);
}

function applyJestJson(
  opts: InstallCoverageOptions,
  thresholds: CoverageThresholds,
  deps: InstallCoverageDeps,
  readFileFn: (p: string) => string | null,
): InstallCoverageResult {
  const abs = join(opts.cwd, JEST_JSON_CONFIG);
  const raw = readFileFn(abs);
  if (raw === null) {
    return {
      ok: false,
      error: "config_read_failed",
      reason: `cannot read ${JEST_JSON_CONFIG}`,
    };
  }
  const parsed = parseDefensive<unknown>(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "config_malformed",
      reason: `${JEST_JSON_CONFIG}: ${parsed.error}`,
    };
  }
  if (!isObject(parsed.value)) {
    return {
      ok: false,
      error: "config_malformed",
      reason: `${JEST_JSON_CONFIG}: root is not a JSON object`,
    };
  }

  const merged = mergeIntoJest(parsed.value, thresholds);
  if (!merged.changed) {
    return baseOk({
      cwd: opts.cwd,
      runner: "jest",
      stage: opts.stage ?? null,
      stageSource: opts.stage !== undefined ? "explicit" : "detected",
      thresholds,
      thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
      warnOnly: false,
      written: null,
      action: "noop",
    });
  }

  const writeRes = safeWriteFile(
    opts.cwd,
    JEST_JSON_CONFIG,
    stringifyPretty(merged.content),
    { kind: "coverage", merged: true, strict: opts.strict ?? false },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return {
      ok: false,
      error: "write_failed",
      reason: `${JEST_JSON_CONFIG}: ${writeRes.error}`,
    };
  }
  return baseOk({
    cwd: opts.cwd,
    runner: "jest",
    stage: opts.stage ?? null,
    stageSource: opts.stage !== undefined ? "explicit" : "detected",
    thresholds,
    thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
    warnOnly: false,
    written: {
      path: writeRes.value.path,
      bytes: writeRes.value.bytes,
      recorded: writeRes.value.recorded,
      merged: true,
      changed: true,
    },
    action: "updated",
  });
}

function applyJestPackageJson(
  opts: InstallCoverageOptions,
  thresholds: CoverageThresholds,
  deps: InstallCoverageDeps,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): InstallCoverageResult {
  const pkgAbs = join(opts.cwd, PACKAGE_JSON_REL);
  if (!existsFn(pkgAbs)) {
    return {
      ok: false,
      error: "package_json_missing",
      reason: `no package.json at ${opts.cwd}`,
    };
  }
  const raw = readFileFn(pkgAbs);
  if (raw === null) {
    return {
      ok: false,
      error: "config_read_failed",
      reason: `cannot read ${PACKAGE_JSON_REL}`,
    };
  }
  const parsed = parseDefensive<unknown>(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "package_json_malformed",
      reason: parsed.error,
    };
  }
  if (!isObject(parsed.value)) {
    return {
      ok: false,
      error: "package_json_malformed",
      reason: "root is not a JSON object",
    };
  }

  const root: Record<string, unknown> = { ...parsed.value };
  const existingJest = isObject(root["jest"])
    ? (root["jest"] as Record<string, unknown>)
    : null;
  const merged = mergeIntoJest(existingJest, thresholds);
  if (!merged.changed) {
    return baseOk({
      cwd: opts.cwd,
      runner: "jest",
      stage: opts.stage ?? null,
      stageSource: opts.stage !== undefined ? "explicit" : "detected",
      thresholds,
      thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
      warnOnly: false,
      written: null,
      action: "noop",
    });
  }
  root["jest"] = merged.content;

  const writeRes = safeWriteFile(
    opts.cwd,
    PACKAGE_JSON_REL,
    stringifyPretty(root),
    { kind: "coverage", merged: true, strict: opts.strict ?? false },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return {
      ok: false,
      error: "write_failed",
      reason: `${PACKAGE_JSON_REL}: ${writeRes.error}`,
    };
  }
  return baseOk({
    cwd: opts.cwd,
    runner: "jest",
    stage: opts.stage ?? null,
    stageSource: opts.stage !== undefined ? "explicit" : "detected",
    thresholds,
    thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
    warnOnly: false,
    written: {
      path: writeRes.value.path,
      bytes: writeRes.value.bytes,
      recorded: writeRes.value.recorded,
      merged: true,
      changed: true,
    },
    action: "updated",
  });
}

function baseOk(o: Omit<InstallCoverageOk, "ok">): InstallCoverageOk {
  return { ok: true, ...o };
}

export function installCoverage(
  opts: InstallCoverageOptions,
  deps: InstallCoverageDeps = {},
): InstallCoverageResult {
  const presetsDir = deps.presetsDir ?? PRESETS_DIR;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const detectStageFn = deps.detectStageFn ?? detectStage;
  const detectRunnerFn = deps.detectRunnerFn ?? detectTestRunner;

  const runnerR = resolveRunner(opts, detectRunnerFn);
  if (!runnerR.ok) {
    return { ok: false, error: runnerR.error, reason: runnerR.reason };
  }
  const runner = runnerR.value.runner;

  if (runner === "none") {
    return baseOk({
      cwd: opts.cwd,
      runner: "none",
      stage: opts.stage ?? null,
      stageSource: opts.stage !== undefined ? "explicit" : "n/a",
      thresholds: opts.thresholds ?? null,
      thresholdsSource: opts.thresholds !== undefined ? "explicit" : "n/a",
      warnOnly: false,
      written: null,
      action: "noop",
    });
  }

  // Determine effective thresholds: explicit override → preset (requires stage).
  let thresholds: CoverageThresholds;
  let warnOnly = false;
  let stage: Stage | null = opts.stage ?? null;
  let stageSource: "explicit" | "detected" = "detected";

  if (opts.thresholds !== undefined) {
    thresholds = opts.thresholds;
    if (opts.stage !== undefined) {
      stage = opts.stage;
      stageSource = "explicit";
      // We still consult the preset purely to know if the stage is warn-only.
      const meta = readPresetThresholds(presetsDir, opts.stage, readFileFn);
      if ("error" in meta) {
        return { ok: false, error: "preset_read_failed", reason: meta.error };
      }
      warnOnly = meta.warnOnly;
    }
  } else {
    const stageR = resolveStage(opts, detectStageFn);
    if (!stageR.ok) {
      return { ok: false, error: stageR.error, reason: stageR.reason };
    }
    stage = stageR.stage;
    stageSource = stageR.source;
    const meta = readPresetThresholds(presetsDir, stage, readFileFn);
    if ("error" in meta) {
      return { ok: false, error: "preset_read_failed", reason: meta.error };
    }
    thresholds = meta.thresholds;
    warnOnly = meta.warnOnly;
  }

  const enrichedOpts: InstallCoverageOptions = {
    ...opts,
    stage: stage ?? undefined,
    thresholds,
  };

  let result: InstallCoverageResult;
  if (runner === "vitest") {
    result = applyVitest(enrichedOpts, thresholds, deps);
  } else {
    result = applyJest(enrichedOpts, thresholds, deps);
  }

  if (!result.ok) return result;
  return {
    ...result,
    stage,
    stageSource,
    thresholdsSource: opts.thresholds !== undefined ? "explicit" : "preset",
    warnOnly,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly runner?: Runner;
  readonly stage?: Stage;
  readonly thresholds?: CoverageThresholds;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

function isRunner(s: string): s is Runner {
  return (RUNNERS as readonly string[]).includes(s);
}

function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

function parseThresholdsArg(value: string): CoverageThresholds | { error: string } {
  const parsed = parseDefensive<unknown>(value);
  if (!parsed.ok) return { error: `invalid --thresholds JSON: ${parsed.error}` };
  if (!isObject(parsed.value)) {
    return { error: "--thresholds must be a JSON object" };
  }
  const out: Partial<Record<ThresholdKey, number>> = {};
  for (const k of THRESHOLD_KEYS) {
    const v = (parsed.value as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { error: `--thresholds.${k} must be a finite number` };
    }
    out[k] = v;
  }
  return out as CoverageThresholds;
}

export function parseInstallCoverageArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let runner: Runner | undefined;
  let stage: Stage | undefined;
  let thresholds: CoverageThresholds | undefined;
  let strict = false;
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
    if (arg === "--runner") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --runner" };
      }
      if (!isRunner(value)) {
        return {
          ok: false,
          error: `invalid runner: ${value} (expected: ${RUNNERS.join("|")})`,
        };
      }
      runner = value;
      i++;
      continue;
    }
    if (arg === "--stage") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --stage" };
      }
      if (!isStage(value)) {
        return {
          ok: false,
          error: `invalid stage: ${value} (expected: ${STAGES.join("|")})`,
        };
      }
      stage = value;
      i++;
      continue;
    }
    if (arg === "--thresholds") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --thresholds" };
      }
      const parsed = parseThresholdsArg(value);
      if ("error" in parsed) return { ok: false, error: parsed.error };
      thresholds = parsed;
      i++;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return {
    ok: true,
    value: {
      cwd,
      ...(runner !== undefined ? { runner } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(thresholds !== undefined ? { thresholds } : {}),
      strict,
    },
  };
}

export function runInstallCoverage(argv: readonly string[]): ExitCode {
  const parsed = parseInstallCoverageArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-coverage [--cwd <path>] [--runner <vitest|jest|none>] " +
          "[--stage <name>] [--thresholds <json>] [--strict]\n" +
          "\n" +
          "Writes coverage thresholds + provider/reporter into the test runner\n" +
          "config. Vitest configs are edited via ts-morph; jest configs are edited\n" +
          "as JSON or merged into package.json#jest. JS/TS jest configs are not\n" +
          "edited (returns error). Runner and stage are detected when omitted.\n" +
          "Stages: greenfield | brownfield-moderate | legacy.\n" +
          '--thresholds expects {"lines":N,"functions":N,"branches":N,"statements":N}.\n' +
          "Exit codes: 0 ok, 1 detection/edit/write failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-coverage", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installCoverage(parsed.value);
  if (!result.ok) {
    logger.error("install_coverage_failed", { reason: result.reason ?? result.error });
    output(result);
    if (
      result.error === "write_failed" &&
      typeof result.reason === "string" &&
      result.reason.includes("working tree is dirty")
    ) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_coverage_ok", {
    runner: result.runner,
    stage: result.stage,
    action: result.action,
    warnOnly: result.warnOnly,
  });
  return EXIT_CODES.OK;
}
