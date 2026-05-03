/**
 * `detect-stage` — read-only classifier for project maturity. SPEC §3
 * ("heurística de detecção de estágio") drives every downstream calibration:
 * the chosen preset (greenfield / brownfield-moderate / legacy) determines
 * which thresholds get applied to oxlint, quality-metrics, and coverage.
 *
 * Six raw signals (SPEC §3):
 *   1. Repo age      — `firstCommitDate()` from git.ts. `null` (empty repo) is
 *                      a signal, not an error: treat as age=0.
 *   2. LOC total     — sum of `text.split('\n').length` over every `*.ts|*.tsx
 *                      |*.js|*.jsx` file returned by `git ls-files`. We do not
 *                      shell out to `cloc` (no extra dep) and do not use
 *                      `find` (already filtered by git via `lsFilesByExt`).
 *   3. Source files  — count of those tracked source files.
 *   4. Churn 90d     — `churn90d()` from git.ts.
 *   5. Has tests     — directory probe (`test/`, `tests/`, `__tests__/`) at
 *                      project root, OR vitest/jest detected by
 *                      `detectTestRunner`.
 *   6. TODO density  — `\b(TODO|FIXME|HACK)\b` matches across all source files,
 *                      normalized to occurrences per 100 LOC.
 *   Plus: linter presence (from `detectExistingLinter`) — required only by the
 *   greenfield rule, but useful for downstream presentation.
 *
 * Classification (SPEC §3, exactly):
 *   - greenfield        : age < 6 months  AND  LOC < 5k          AND  no linter
 *   - legacy            : age > 3 years   AND  (LOC > 50k  OR  TODO/HACK density > 1/100  OR  no tests)
 *   - brownfield-moderate: anything else
 *
 * The detector emits raw signals alongside the classification so a user (or
 * the harness) can disagree with evidence — SPEC §6 Always: "Sempre justificar
 * a classificação de estágio com os sinais brutos coletados."
 *
 * Exit code: always `OK` on success (read-only). `RECOVERABLE_ERROR` only when
 * `git ls-files` itself fails (no repo / git binary missing).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { churn90d, firstCommitDate, lsFilesByExt } from "../lib/git.ts";
import { logger, output } from "../lib/logger.ts";
import { detectExistingLinter } from "./detect-existing-linter.ts";
import { detectTestRunner } from "./detect-test-runner.ts";

export type Stage = "greenfield" | "brownfield-moderate" | "legacy";

/**
 * Numeric thresholds for the SPEC §3 rules. Exported so tests can reference
 * the same constants the production code uses (no parallel hard-coded numbers
 * to drift apart).
 */
export const STAGE_THRESHOLDS = {
  /** "< 6 meses". 6 × 30.4375 ≈ 183 days. */
  GREENFIELD_MAX_AGE_DAYS: 183,
  GREENFIELD_MAX_LOC: 5000,
  /** "> 3 anos". 3 × 365.25 ≈ 1095 days (rounded down). */
  LEGACY_MIN_AGE_DAYS: 1095,
  LEGACY_MIN_LOC: 50000,
  /** "> 1/100 LOC" → density > 1.0 occurrences per 100 LOC. */
  LEGACY_MAX_TODO_DENSITY_PER_100_LOC: 1.0,
} as const;

const SOURCE_EXTS = ["ts", "tsx", "js", "jsx"] as const;

const TEST_DIRS = ["test", "tests", "__tests__"] as const;

/** Word-boundary match for TODO/FIXME/HACK so identifiers like `todoList` don't count. */
const TODO_REGEX = /\b(?:TODO|FIXME|HACK)\b/g;

export interface DetectStageSignals {
  readonly first_commit_date: string | null;
  readonly age_days: number | null;
  readonly source_files: number;
  readonly loc: number;
  readonly churn_90d: number;
  readonly has_tests: boolean;
  readonly todo_count: number;
  readonly todo_density_per_100_loc: number | null;
  readonly linter_present: boolean;
}

export interface DetectStageOk {
  readonly ok: true;
  readonly cwd: string;
  readonly stage: Stage;
  readonly signals: DetectStageSignals;
  readonly reasoning: string;
}

export interface DetectStageErr {
  readonly ok: false;
  readonly error: string;
}

export type DetectStageResult = DetectStageOk | DetectStageErr;

export interface DetectStageOptions {
  readonly cwd: string;
}

export interface DetectStageDeps {
  /** Test seam. Defaults to `node:fs.existsSync`. */
  readonly existsFn?: (path: string) => boolean;
  /** Test seam. Returns file contents or `null` on any read failure. */
  readonly readFileFn?: (path: string) => string | null;
  /** Test seam for "now" — controls age computation deterministically. */
  readonly now?: () => Date;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

interface FileScanResult {
  readonly loc: number;
  readonly todoCount: number;
}

/**
 * Sums LOC and TODO/FIXME/HACK occurrences across every tracked source file.
 *
 * LOC strategy: count `\n` characters per file — same semantics as the SPEC's
 * `wc -l` fallback. A file ending without a final newline contributes one
 * fewer line than its visual line count; this matches `wc -l` exactly and
 * avoids the off-by-one inflation of `text.split('\n').length`.
 *
 * Files that fail to read (returned `null` by `readFileFn`) are silently
 * skipped: a single unreadable file should not break detection of a 10k-file
 * legacy repo. The file is still counted in `source_files` (tracked by git),
 * but does not contribute to LOC or TODO totals.
 */
function scanSourceFiles(
  cwd: string,
  files: readonly string[],
  readFileFn: (p: string) => string | null,
): FileScanResult {
  let loc = 0;
  let todoCount = 0;
  for (const f of files) {
    const text = readFileFn(join(cwd, f));
    if (text === null) continue;
    const newlines = text.match(/\n/g);
    if (newlines) loc += newlines.length;
    const todos = text.match(TODO_REGEX);
    if (todos) todoCount += todos.length;
  }
  return { loc, todoCount };
}

function detectHasTests(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): boolean {
  for (const dir of TEST_DIRS) {
    if (existsFn(join(cwd, dir))) return true;
  }
  const tr = detectTestRunner({ cwd }, { existsFn, readFileFn });
  return tr.runner !== "none";
}

function detectLinterPresent(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): boolean {
  const r = detectExistingLinter({ cwd }, { existsFn, readFileFn });
  return r.linters.length > 0 || r.formatters.length > 0;
}

function ageInDays(firstCommit: Date | null, now: Date): number | null {
  if (firstCommit === null) return null;
  const ms = now.getTime() - firstCommit.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

interface Classification {
  readonly stage: Stage;
  readonly reasoning: string;
}

/**
 * Pure classifier — every input is in `signals`, no I/O. The SPEC's three
 * rules are evaluated in priority order: greenfield → legacy → brownfield.
 *
 * Edge cases:
 *   - `age_days === null` (empty repo): treated as "<6 months" for the
 *     greenfield rule (passes) and as "NOT >3 years" for the legacy rule
 *     (fails). An empty fresh repo with no linter therefore classifies as
 *     greenfield, which matches author intent for v1 day-zero scaffolding.
 */
function classifyStage(signals: DetectStageSignals): Classification {
  const ageDays = signals.age_days;
  const ageBelowGreen =
    ageDays === null || ageDays < STAGE_THRESHOLDS.GREENFIELD_MAX_AGE_DAYS;
  const locSmall = signals.loc < STAGE_THRESHOLDS.GREENFIELD_MAX_LOC;
  const noLinter = !signals.linter_present;

  if (ageBelowGreen && locSmall && noLinter) {
    return {
      stage: "greenfield",
      reasoning:
        `age ${ageDays === null ? "(no commits)" : `${ageDays}d`} < ` +
        `${STAGE_THRESHOLDS.GREENFIELD_MAX_AGE_DAYS}d AND LOC ${signals.loc} < ` +
        `${STAGE_THRESHOLDS.GREENFIELD_MAX_LOC} AND no prior linter`,
    };
  }

  const ageAboveLegacy =
    ageDays !== null && ageDays > STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS;
  const locHuge = signals.loc > STAGE_THRESHOLDS.LEGACY_MIN_LOC;
  const todoSpike =
    signals.todo_density_per_100_loc !== null &&
    signals.todo_density_per_100_loc > STAGE_THRESHOLDS.LEGACY_MAX_TODO_DENSITY_PER_100_LOC;
  const noTests = !signals.has_tests;

  if (ageAboveLegacy && (locHuge || todoSpike || noTests)) {
    const triggers: string[] = [];
    if (locHuge) triggers.push(`LOC ${signals.loc} > ${STAGE_THRESHOLDS.LEGACY_MIN_LOC}`);
    if (todoSpike) {
      triggers.push(
        `TODO/HACK density ${signals.todo_density_per_100_loc?.toFixed(2) ?? "n/a"} > ` +
          `${STAGE_THRESHOLDS.LEGACY_MAX_TODO_DENSITY_PER_100_LOC}/100 LOC`,
      );
    }
    if (noTests) triggers.push("no tests detected");
    return {
      stage: "legacy",
      reasoning:
        `age ${ageDays}d > ${STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS}d AND ` +
        `(${triggers.join(" OR ")})`,
    };
  }

  const why: string[] = [];
  if (!ageBelowGreen) why.push(`age ${ageDays}d not < ${STAGE_THRESHOLDS.GREENFIELD_MAX_AGE_DAYS}d`);
  if (!locSmall) why.push(`LOC ${signals.loc} not < ${STAGE_THRESHOLDS.GREENFIELD_MAX_LOC}`);
  if (!noLinter) why.push("prior linter present");
  if (!ageAboveLegacy) {
    why.push(
      `age ${ageDays === null ? "(no commits)" : `${ageDays}d`} not > ` +
        `${STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS}d`,
    );
  }
  return {
    stage: "brownfield-moderate",
    reasoning: `default classification (${why.join("; ")})`,
  };
}

/**
 * Pure detection. Calls `git` via the module-level runner (mockable via
 * `setGitRunner`), and reads files via injected `existsFn`/`readFileFn`. Never
 * throws — git failures bubble up as `ok: false`.
 */
export function detectStage(
  opts: DetectStageOptions,
  deps: DetectStageDeps = {},
): DetectStageResult {
  const cwd = opts.cwd;
  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFileFn ?? defaultReadFile;
  const nowFn = deps.now ?? (() => new Date());

  const filesRes = lsFilesByExt(cwd, [...SOURCE_EXTS]);
  if (!filesRes.ok) {
    return { ok: false, error: filesRes.error };
  }
  const files = filesRes.value;

  const firstRes = firstCommitDate(cwd);
  if (!firstRes.ok) {
    return { ok: false, error: firstRes.error };
  }
  const churnRes = churn90d(cwd);
  if (!churnRes.ok) {
    return { ok: false, error: churnRes.error };
  }

  const scan = scanSourceFiles(cwd, files, readFileFn);
  const ageDays = ageInDays(firstRes.value, nowFn());
  const todoDensity = scan.loc > 0 ? (scan.todoCount * 100) / scan.loc : null;

  const signals: DetectStageSignals = {
    first_commit_date: firstRes.value === null ? null : firstRes.value.toISOString(),
    age_days: ageDays,
    source_files: files.length,
    loc: scan.loc,
    churn_90d: churnRes.value,
    has_tests: detectHasTests(cwd, existsFn, readFileFn),
    todo_count: scan.todoCount,
    todo_density_per_100_loc: todoDensity,
    linter_present: detectLinterPresent(cwd, existsFn, readFileFn),
  };

  const { stage, reasoning } = classifyStage(signals);

  return { ok: true, cwd, stage, signals, reasoning };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseDetectStageArgs(
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

export function runDetectStage(argv: readonly string[]): ExitCode {
  const parsed = parseDetectStageArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy detect-stage [--cwd <path>]\n" +
          "\n" +
          "Heuristic project stage classifier (SPEC §3): greenfield, brownfield-moderate, legacy.\n" +
          "Emits raw signals (age, LOC, churn, TODO density, tests, linter) alongside the verdict.\n" +
          "Exit codes: 0 success, 1 detection error (e.g. not a git repo).\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "detect-stage", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = detectStage(parsed.value);
  if (!result.ok) {
    logger.error("detect_stage_failed", { reason: result.error });
    output({ ok: false, error: "detect_stage_failed", reason: result.error });
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("detect_stage_done", {
    stage: result.stage,
    age_days: result.signals.age_days,
    loc: result.signals.loc,
  });
  return EXIT_CODES.OK;
}
