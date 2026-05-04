/**
 * `report/data-loader` — single source of truth that the report shell hydrates
 * with. Aggregates the three signals SPEC §4 line 326 enumerates:
 *
 *   1. The latest `.lint-audit/<ts>.json` (delegated to `auditLatest`).
 *   2. Historical audit summaries (every `.lint-audit/*.json` validated by the
 *      same schema, sorted ascending by timestamp). Powers the trend chart
 *      (`ChartLine` task) without forcing the browser to read disk.
 *   3. Coverage from the runner's `coverage/coverage-summary.json` (istanbul
 *      shape — both Vitest and Jest emit this with `json-summary` reporter).
 *   4. Git stats (first commit date + last-90d churn) from `lib/git.ts`.
 *
 * Why a single loader: `server.ts` and `export.ts` both need an identical JSON
 * blob (live page hydration vs. inlined offline export). Centralizing here
 * means future trend extensions land in one place and the schema travels into
 * the browser unchanged.
 *
 * Failure model:
 *   - Audit is the only required signal — `audit_missing` propagates as a
 *     loader failure (`/lint:report` should suggest running `/lint:audit`).
 *   - Coverage is optional → null when the file is missing or malformed.
 *   - History never fails: corrupt entries are silently dropped (read-only
 *     view should not crash because one old audit drifted).
 *   - Git fallbacks to `{first_commit_date: null, churn_90d: 0}` on error.
 *
 * Pure module: every FS / git interaction goes through optional deps so unit
 * tests run without disk or git. `defaultDeps` mirrors `auditLatest` /
 * `lib/git.ts` defaults.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type AuditPayload,
  type Stage,
  validateAuditPayload,
} from "../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { resolveSafePath } from "../lib/fs-safe.ts";
import {
  type GitResult,
  churn90d as defaultChurn90d,
  firstCommitDate as defaultFirstCommitDate,
} from "../lib/git.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";

import { AUDIT_DIR } from "../commands/audit.ts";
import { auditLatest } from "../commands/audit-latest.ts";

export const COVERAGE_SUMMARY_PATH = "coverage/coverage-summary.json";
export const REPORT_DATA_VERSION = "1" as const;

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/**
 * Trend-friendly summary of a historical audit. Drops `top[]` and `rules_active`
 * to keep the inlined JSON small (legacy-monorepo can have hundreds of entries
 * per metric); the latest audit carries the full payload separately.
 */
export interface ReportHistoryEntry {
  readonly timestamp: string;
  readonly generated_at: string;
  readonly stage: Stage;
  readonly errors: number;
  readonly warnings: number;
  readonly files_affected: number;
  readonly by_metric: {
    readonly wmc: number;
    readonly halstead: number;
    readonly lcom: number;
    readonly cbo: number;
    readonly dit: number;
  };
}

export interface ReportCoverage {
  /** Project-relative path the values came from. */
  readonly source: string;
  readonly lines: number | null;
  readonly functions: number | null;
  readonly branches: number | null;
  readonly statements: number | null;
}

export interface ReportGit {
  readonly first_commit_date: string | null;
  readonly churn_90d: number;
}

export interface ReportData {
  readonly version: typeof REPORT_DATA_VERSION;
  readonly generated_at: string;
  readonly cwd: string;
  /** Project-relative path of the latest audit (`.lint-audit/<ts>.json`). */
  readonly audit_path: string;
  readonly audit: AuditPayload;
  readonly history: readonly ReportHistoryEntry[];
  readonly coverage: ReportCoverage | null;
  readonly git: ReportGit;
}

export interface LoadOptions {
  readonly cwd: string;
  /** Overrides `new Date()` so callers (and tests) can pin `generated_at`. */
  readonly now?: Date;
}

export interface LoadDeps {
  readonly readdirFn?: (dir: string) => readonly string[];
  readonly readFileFn?: (path: string) => string | null;
  readonly existsFn?: (path: string) => boolean;
  readonly firstCommitDateFn?: (cwd: string) => GitResult<Date | null>;
  readonly churn90dFn?: (cwd: string) => GitResult<number>;
}

export interface LoadOk {
  readonly ok: true;
  readonly data: ReportData;
}

export interface LoadErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type LoadResult = LoadOk | LoadErr;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultExists(p: string): boolean {
  try {
    readFileSync(p, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const JSON_SUFFIX = ".json";

/**
 * Build a chronologically ascending list of historical audit summaries.
 * Drops files that fail JSON parse or schema validation — a corrupt or
 * partially-written audit must not break the report. The list is sorted by
 * filename (lexical), which equals chronological order because
 * `toSafeTimestamp` produces monotonically sortable strings.
 */
export function loadHistory(
  cwd: string,
  deps: Pick<LoadDeps, "readdirFn" | "readFileFn">,
): readonly ReportHistoryEntry[] {
  const readdirFn = deps.readdirFn ?? defaultReaddir;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const safe = resolveSafePath(cwd, AUDIT_DIR);
  if (!safe.ok) return [];

  const filenames = readdirFn(safe.value)
    .filter((n) => n.endsWith(JSON_SUFFIX))
    .slice()
    .sort();

  const out: ReportHistoryEntry[] = [];
  for (const filename of filenames) {
    const raw = readFileFn(join(safe.value, filename));
    if (raw === null) continue;
    const parsed = parseDefensive(raw);
    if (!parsed.ok) continue;
    const validated = validateAuditPayload(parsed.value);
    if (!validated.ok) continue;
    const audit = validated.value;
    out.push({
      timestamp: filename.slice(0, -JSON_SUFFIX.length),
      generated_at: audit.generated_at,
      stage: audit.stage,
      errors: audit.violations.summary.errors,
      warnings: audit.violations.summary.warnings,
      files_affected: audit.violations.summary.files_affected,
      by_metric: {
        wmc: audit.violations.by_metric.wmc.violations,
        halstead: audit.violations.by_metric.halstead.violations,
        lcom: audit.violations.by_metric.lcom.violations,
        cbo: audit.violations.by_metric.cbo.violations,
        dit: audit.violations.by_metric.dit.violations,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Parse `coverage/coverage-summary.json` (istanbul format used by both Vitest
 * with `coverage-v8` and Jest with `--coverage --coverageReporters=json-summary`).
 *
 * The relevant subtree is `total.{lines|functions|branches|statements}.pct`.
 * Returns null when the file is missing, malformed, or the `total` block is
 * absent — the report degrades gracefully (coverage card hides).
 */
export function loadCoverage(
  cwd: string,
  deps: Pick<LoadDeps, "existsFn" | "readFileFn">,
): ReportCoverage | null {
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const safe = resolveSafePath(cwd, COVERAGE_SUMMARY_PATH);
  if (!safe.ok) return null;
  if (!existsFn(safe.value)) return null;

  const raw = readFileFn(safe.value);
  if (raw === null) return null;
  const parsed = parseDefensive(raw);
  if (!parsed.ok) return null;
  const root = parsed.value;
  if (typeof root !== "object" || root === null) return null;
  const total = (root as { total?: unknown }).total;
  if (typeof total !== "object" || total === null) return null;

  const pickPct = (key: string): number | null => {
    const block = (total as Record<string, unknown>)[key];
    if (typeof block !== "object" || block === null) return null;
    const pct = (block as Record<string, unknown>).pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
    return pct;
  };

  return {
    source: COVERAGE_SUMMARY_PATH,
    lines: pickPct("lines"),
    functions: pickPct("functions"),
    branches: pickPct("branches"),
    statements: pickPct("statements"),
  };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Resolve the two git signals the report cares about. Failures degrade to
 * neutral defaults — a brand-new repo with no commits is a valid greenfield
 * signal, not an error.
 */
export function loadGit(
  cwd: string,
  deps: Pick<LoadDeps, "firstCommitDateFn" | "churn90dFn">,
): ReportGit {
  const firstCommitFn = deps.firstCommitDateFn ?? defaultFirstCommitDate;
  const churnFn = deps.churn90dFn ?? defaultChurn90d;

  const firstCommit = firstCommitFn(cwd);
  const churn = churnFn(cwd);

  return {
    first_commit_date: firstCommit.ok && firstCommit.value !== null
      ? firstCommit.value.toISOString()
      : null,
    churn_90d: churn.ok ? churn.value : 0,
  };
}

// ---------------------------------------------------------------------------
// Top-level loader
// ---------------------------------------------------------------------------

export function loadReportData(opts: LoadOptions, deps: LoadDeps = {}): LoadResult {
  const cwd = opts.cwd;
  const now = opts.now ?? new Date();

  const latest = auditLatest(
    { cwd },
    {
      readdirFn: deps.readdirFn,
      readFileFn: deps.readFileFn,
    },
  );
  if (!latest.ok) {
    return { ok: false, error: latest.error, reason: latest.reason };
  }

  const history = loadHistory(cwd, deps);
  const coverage = loadCoverage(cwd, deps);
  const git = loadGit(cwd, deps);

  const data: ReportData = {
    version: REPORT_DATA_VERSION,
    generated_at: now.toISOString(),
    cwd,
    audit_path: latest.path,
    audit: latest.audit,
    history,
    coverage,
    git,
  };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Argv (debug subcommand: `qualy report-data` dumps the JSON to stdout)
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseReportDataArgs(
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

export function runReportData(argv: readonly string[]): ExitCode {
  const parsed = parseReportDataArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy report-data [--cwd <path>]\n" +
          "\n" +
          "Aggregates the latest audit, audit history, coverage summary,\n" +
          "and git stats into the JSON shape consumed by the report shell.\n" +
          "Exit codes: 0 ok, 1 audit/data failure, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "report-data", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = loadReportData(parsed.value);
  if (!result.ok) {
    logger.error("report_data_failed", { reason: result.reason ?? result.error });
    output(result);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output({ ok: true, ...result.data });
  logger.info("report_data_ok", {
    history_entries: result.data.history.length,
    has_coverage: result.data.coverage !== null,
    cwd: result.data.cwd,
  });
  return EXIT_CODES.OK;
}

