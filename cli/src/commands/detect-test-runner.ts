/**
 * `detect-test-runner` — read-only probe for vitest / jest configuration and
 * any coverage thresholds the user already set. SPEC §3 ("estratégia de
 * coverage") requires that we *detect before propose*: if a project already
 * has thresholds the harness must surface them and ask whether to keep,
 * adopt the stage default, or define custom (SPEC §7.3 acceptance —
 * "preserva escolha do usuário").
 *
 * Output (PLAN §Contratos CLI):
 *   {
 *     runner: "vitest" | "jest" | "none",
 *     candidates: {
 *       vitest: { configs: string[], pkg_dep: bool, thresholds: ThresholdsHit | null },
 *       jest:   { configs: string[], pkg_dep: bool, thresholds: ThresholdsHit | null }
 *     },
 *     coverage: {
 *       configured: bool,
 *       current_thresholds: { lines, functions, branches, statements } | null,
 *       current_values: null,           // measured by the runner, not by detect
 *       source: string | null           // file/key the thresholds were read from
 *     }
 *   }
 *
 * Picking `runner` when both are present:
 *   1. vitest beats jest if either has stronger evidence (config file > pkg_dep).
 *   2. Tie → vitest (SPEC §3 default recommendation when both exist).
 *
 * Threshold reading strategy (intentionally pragmatic, not ts-morph — that
 * lives in Phase 2's `ts-config-edit.ts`):
 *   - JSON configs (`jest.config.json`, `package.json#jest`): exact parse.
 *   - JS/TS/MJS/CJS configs: best-effort regex over the file text. We only
 *     extract the four canonical keys (`lines|functions|branches|statements`)
 *     when they appear inside a recognized container key (`thresholds` or
 *     `coverageThreshold` or `global`), so unrelated `lines: 50` constants in
 *     the file do not pollute the result. Failure → `thresholds: null` (we
 *     never throw; harness treats null as "configured but not parseable" and
 *     falls back to AskUserQuestion).
 *
 * Exit code: always `OK` on success (read-only). Detection itself never fails
 * — missing files, malformed JSON, and unreadable text become "no evidence".
 * Only flag-parsing errors return `USAGE_ERROR`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";

export type RunnerName = "vitest" | "jest" | "none";

export interface ThresholdsHit {
  readonly lines: number | null;
  readonly functions: number | null;
  readonly branches: number | null;
  readonly statements: number | null;
}

export interface RunnerCandidate {
  readonly configs: readonly string[];
  readonly pkg_dep: boolean;
  readonly thresholds: ThresholdsHit | null;
  /** File or key path the thresholds were read from (informational). */
  readonly thresholds_source: string | null;
}

export interface DetectTestRunnerOk {
  readonly ok: true;
  readonly cwd: string;
  readonly runner: RunnerName;
  readonly candidates: {
    readonly vitest: RunnerCandidate;
    readonly jest: RunnerCandidate;
  };
  readonly coverage: {
    readonly configured: boolean;
    readonly current_thresholds: ThresholdsHit | null;
    readonly current_values: null;
    readonly source: string | null;
  };
}

export type DetectTestRunnerResult = DetectTestRunnerOk;

export interface DetectTestRunnerOptions {
  readonly cwd: string;
}

export interface DetectTestRunnerDeps {
  /** Test seam. Defaults to `node:fs.existsSync`. */
  readonly existsFn?: (path: string) => boolean;
  /** Test seam. Returns file contents or `null` on any read failure. */
  readonly readFileFn?: (path: string) => string | null;
}

interface RunnerDef {
  readonly name: Exclude<RunnerName, "none">;
  readonly configFiles: readonly string[];
  readonly packageJsonKeys: readonly string[];
  readonly pkgNames: readonly string[];
}

const RUNNERS: readonly RunnerDef[] = [
  {
    name: "vitest",
    configFiles: [
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.config.cts",
      "vitest.config.js",
      "vitest.config.mjs",
      "vitest.config.cjs",
      "vitest.workspace.ts",
      "vitest.workspace.js",
      "vitest.workspace.mjs",
      "vitest.workspace.json",
      // vite.config.* is NOT probed: Vitest can ride on a Vite config but
      // detecting it via filename alone would create false positives in
      // pure-Vite projects without tests.
    ],
    packageJsonKeys: ["vitest"],
    pkgNames: ["vitest"],
  },
  {
    name: "jest",
    configFiles: [
      "jest.config.ts",
      "jest.config.mts",
      "jest.config.cts",
      "jest.config.js",
      "jest.config.mjs",
      "jest.config.cjs",
      "jest.config.json",
    ],
    packageJsonKeys: ["jest"],
    pkgNames: ["jest"],
  },
];

interface PackageJsonShape {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function loadPackageJson(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): PackageJsonShape | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsFn(pkgPath)) return null;
  const raw = readFileFn(pkgPath);
  if (raw === null) return null;
  const parsed = parseDefensive<unknown>(raw);
  if (!parsed.ok) return null;
  if (typeof parsed.value !== "object" || parsed.value === null) return null;
  return parsed.value as PackageJsonShape;
}

function hasDep(pkg: PackageJsonShape, name: string): boolean {
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, name)) {
      return true;
    }
  }
  return false;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

const THRESHOLD_KEYS = ["lines", "functions", "branches", "statements"] as const;
type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

function readThresholdsFromObject(obj: unknown): ThresholdsHit | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const hit: Record<ThresholdKey, number | null> = {
    lines: readNumber(o["lines"]),
    functions: readNumber(o["functions"]),
    branches: readNumber(o["branches"]),
    statements: readNumber(o["statements"]),
  };
  if (THRESHOLD_KEYS.every((k) => hit[k] === null)) return null;
  return hit;
}

/**
 * Walks a parsed jest config / package.json#jest and returns the first
 * `coverageThreshold.global` (or any nested numeric threshold map) found.
 *
 * Jest accepts both `coverageThreshold.global.lines` and per-glob entries
 * like `coverageThreshold."./src/**".lines`. v1 only surfaces `global` —
 * per-glob is rare in the brownfield projects this skill targets and would
 * complicate the merge UX in `install/coverage.ts`.
 */
function readJestThresholds(parsed: unknown): ThresholdsHit | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const ct = root["coverageThreshold"];
  if (typeof ct !== "object" || ct === null) return null;
  const global = (ct as Record<string, unknown>)["global"];
  return readThresholdsFromObject(global);
}

/**
 * Walks a parsed vitest config (when JSON-only — workspace.json) and returns
 * any thresholds under `test.coverage.thresholds` or `coverage.thresholds`.
 */
function readVitestThresholdsFromJson(parsed: unknown): ThresholdsHit | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const containers: unknown[] = [];
  const test = root["test"];
  if (test && typeof test === "object") {
    const cov = (test as Record<string, unknown>)["coverage"];
    if (cov && typeof cov === "object") {
      containers.push(cov);
      containers.push((cov as Record<string, unknown>)["thresholds"]);
    }
  }
  const cov = root["coverage"];
  if (cov && typeof cov === "object") {
    containers.push(cov);
    containers.push((cov as Record<string, unknown>)["thresholds"]);
  }
  for (const c of containers) {
    const hit = readThresholdsFromObject(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Best-effort regex extraction over a JS/TS config text.
 *
 * Only matches threshold keys that appear *after* a known container key
 * (`thresholds`, `coverageThreshold`, `global`) within ~600 chars, to avoid
 * grabbing an unrelated `lines: 80` literal elsewhere in the file. Returns
 * `null` if no container key is present at all.
 */
function readThresholdsFromText(text: string): ThresholdsHit | null {
  const containerRe = /\b(thresholds|coverageThreshold|global)\b\s*[:=]\s*\{/g;
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = containerRe.exec(text)) !== null) matches.push(m.index);
  if (matches.length === 0) return null;

  const hit: Record<ThresholdKey, number | null> = {
    lines: null,
    functions: null,
    branches: null,
    statements: null,
  };
  for (const start of matches) {
    const slice = text.slice(start, start + 600);
    for (const key of THRESHOLD_KEYS) {
      if (hit[key] !== null) continue;
      // Match `key: 80`, `"key": 80.5`, `'key': 70`. Allow optional quotes.
      const keyRe = new RegExp(`["']?${key}["']?\\s*:\\s*(\\d+(?:\\.\\d+)?)`);
      const km = keyRe.exec(slice);
      if (km && km[1] !== undefined) {
        const n = Number(km[1]);
        if (Number.isFinite(n)) hit[key] = n;
      }
    }
  }
  if (THRESHOLD_KEYS.every((k) => hit[k] === null)) return null;
  return hit;
}

interface ThresholdsRead {
  readonly thresholds: ThresholdsHit;
  readonly source: string;
}

/**
 * Walks each candidate config file, parsing JSON via `jsonReader` (vitest- or
 * jest-shaped) and falling back to the regex-based text reader for JS/TS/MJS
 * configs. Returns the first non-empty hit, or `null` if no file yields one.
 */
function walkConfigsForThresholds(
  cwd: string,
  configFiles: readonly string[],
  readFileFn: (p: string) => string | null,
  jsonReader: (parsed: unknown) => ThresholdsHit | null,
): ThresholdsRead | null {
  for (const file of configFiles) {
    const text = readFileFn(join(cwd, file));
    if (text === null) continue;
    if (file.endsWith(".json")) {
      const parsed = parseDefensive<unknown>(text);
      const hit = parsed.ok ? jsonReader(parsed.value) : null;
      if (hit) return { thresholds: hit, source: file };
      continue;
    }
    const hit = readThresholdsFromText(text);
    if (hit) return { thresholds: hit, source: file };
  }
  return null;
}

function readVitestThresholds(
  cwd: string,
  configFiles: readonly string[],
  readFileFn: (p: string) => string | null,
): ThresholdsRead | null {
  return walkConfigsForThresholds(cwd, configFiles, readFileFn, readVitestThresholdsFromJson);
}

function readJestThresholdsFromCandidates(
  cwd: string,
  configFiles: readonly string[],
  pkg: PackageJsonShape | null,
  readFileFn: (p: string) => string | null,
): ThresholdsRead | null {
  const fromConfig = walkConfigsForThresholds(cwd, configFiles, readFileFn, readJestThresholds);
  if (fromConfig) return fromConfig;
  if (pkg) {
    const hit = readJestThresholds((pkg as Record<string, unknown>)["jest"]);
    if (hit) return { thresholds: hit, source: "package.json#jest" };
  }
  return null;
}

function pickRunner(
  vitest: RunnerCandidate,
  jest: RunnerCandidate,
): RunnerName {
  const vScore = vitest.configs.length * 2 + (vitest.pkg_dep ? 1 : 0);
  const jScore = jest.configs.length * 2 + (jest.pkg_dep ? 1 : 0);
  if (vScore === 0 && jScore === 0) return "none";
  if (vScore >= jScore) return "vitest";
  return "jest";
}

/**
 * Pure detection — never throws; missing/invalid files become "no evidence".
 * Inject `existsFn` / `readFileFn` in tests.
 */
export function detectTestRunner(
  opts: DetectTestRunnerOptions,
  deps: DetectTestRunnerDeps = {},
): DetectTestRunnerResult {
  const { cwd } = opts;
  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFileFn ?? defaultReadFile;

  const pkg = loadPackageJson(cwd, existsFn, readFileFn);

  const candidates: { vitest: RunnerCandidate; jest: RunnerCandidate } = {
    vitest: emptyCandidate(),
    jest: emptyCandidate(),
  };

  for (const def of RUNNERS) {
    const configs: string[] = def.configFiles.filter((file) => existsFn(join(cwd, file)));
    if (pkg) {
      for (const key of def.packageJsonKeys) {
        if (Object.prototype.hasOwnProperty.call(pkg, key) && pkg[key] !== undefined) {
          configs.push(`package.json#${key}`);
        }
      }
    }
    const pkgDep = pkg !== null && def.pkgNames.some((name) => hasDep(pkg, name));

    const read =
      def.name === "vitest"
        ? readVitestThresholds(cwd, def.configFiles, readFileFn)
        : readJestThresholdsFromCandidates(cwd, def.configFiles, pkg, readFileFn);

    candidates[def.name] = {
      configs,
      pkg_dep: pkgDep,
      thresholds: read?.thresholds ?? null,
      thresholds_source: read?.source ?? null,
    };
  }

  const runner = pickRunner(candidates.vitest, candidates.jest);
  const chosen = runner === "none" ? null : candidates[runner];

  const configured = chosen !== null && (chosen.configs.length > 0 || chosen.pkg_dep);
  const current_thresholds = chosen?.thresholds ?? null;
  const source = chosen?.thresholds_source ?? null;

  return {
    ok: true,
    cwd,
    runner,
    candidates,
    coverage: {
      configured,
      current_thresholds,
      current_values: null,
      source,
    },
  };
}

function emptyCandidate(): RunnerCandidate {
  return {
    configs: [],
    pkg_dep: false,
    thresholds: null,
    thresholds_source: null,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseDetectTestRunnerArgs(
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

export function runDetectTestRunner(argv: readonly string[]): ExitCode {
  const parsed = parseDetectTestRunnerArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy detect-test-runner [--cwd <path>]\n" +
          "\n" +
          "Detects vitest/jest configs, deps, and any current coverage thresholds.\n" +
          "Always exits 0 on success; output drives the coverage strategy decision.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "detect-test-runner",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = detectTestRunner(parsed.value);
  output({
    runner: result.runner,
    candidates: result.candidates,
    coverage: result.coverage,
  });
  logger.info("detect_test_runner_done", {
    runner: result.runner,
    configured: result.coverage.configured,
    has_thresholds: result.coverage.current_thresholds !== null,
  });
  return EXIT_CODES.OK;
}
