/**
 * Contract tests for `cli/src/report/data-loader.ts`
 * (IMPLEMENTATION_PLAN.md Phase 6 — line 108).
 *
 * What is locked:
 *   - `loadReportData` aggregates audit + history + coverage + git into the
 *     SPEC §4 line 326 shape.
 *   - History is built from every `.lint-audit/*.json`, sorted ascending,
 *     malformed entries silently dropped.
 *   - Coverage parses `coverage/coverage-summary.json` (istanbul shape) into
 *     `{lines, functions, branches, statements}` percentages.
 *   - Git deps default to `lib/git.ts` wrappers; failures degrade to
 *     `{first_commit_date: null, churn_90d: 0}` without breaking the loader.
 *   - Failure of `auditLatest` propagates as the loader's only fatal path
 *     (`audit_missing` → `/lint:report` should suggest `/lint:audit`).
 *   - parseReportDataArgs covers every flag combination + error path.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_SUMMARY_PATH,
  type LoadDeps,
  REPORT_DATA_VERSION,
  loadCoverage,
  loadGit,
  loadHistory,
  loadReportData,
  parseReportDataArgs,
} from "../../src/report/data-loader.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

const AUDIT_DIR_ABS = pathJoin(ROOT, ".lint-audit");
const COVERAGE_ABS = pathJoin(ROOT, "coverage", "coverage-summary.json");

const TS_OLDER = "2026-05-01T08-00-00-000Z";
const TS_NEWER = "2026-05-03T14-22-11-000Z";
const TS_NEWEST = "2026-05-03T15-00-00-000Z";

function canonicalAudit(over: Partial<Record<string, unknown>> = {}) {
  return {
    version: "1",
    generated_at: "2026-05-03T14:22:11Z",
    stage: "brownfield-moderate",
    stage_signals: {
      age_days: 540,
      loc: 12500,
      churn_90d: 312,
      has_tests: true,
    },
    tooling: {
      oxlint: "1.0.0",
      oxfmt: "0.5.0-alpha",
      quality_metrics: "0.3.1",
      test_runner: "vitest",
      coverage: {
        configured: true,
        thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
    violations: {
      summary: { errors: 3, warnings: 12, files_affected: 7 },
      by_metric: {
        wmc: { violations: 1, max_seen: 22, top: [] },
        halstead: { violations: 0, top: [] },
        lcom: { violations: 0, top: [] },
        cbo: { violations: 0, top: [] },
        dit: { violations: 0, top: [] },
      },
    },
    rules_active: [],
    recommendations: [],
    ...over,
  };
}

interface FakeFS {
  readonly listings: Record<string, readonly string[]>;
  readonly files: Record<string, string>;
  readonly existing?: ReadonlySet<string>;
}

function makeDeps(fs: FakeFS, gitOverrides: Partial<LoadDeps> = {}): LoadDeps {
  return {
    readdirFn: (dir) => fs.listings[dir] ?? [],
    readFileFn: (p) => fs.files[p] ?? null,
    existsFn: (p) => {
      if (fs.existing) return fs.existing.has(p);
      return fs.files[p] !== undefined;
    },
    firstCommitDateFn: gitOverrides.firstCommitDateFn ?? (() => ({ ok: true, value: null })),
    churn90dFn: gitOverrides.churn90dFn ?? (() => ({ ok: true, value: 0 })),
  };
}

// ---------------------------------------------------------------------------
// loadHistory
// ---------------------------------------------------------------------------

describe("loadHistory", () => {
  it("returns ascending list, dropping non-.json entries", () => {
    const a1 = canonicalAudit({
      generated_at: "2026-05-01T08:00:00Z",
      stage: "greenfield",
      violations: {
        summary: { errors: 0, warnings: 1, files_affected: 1 },
        by_metric: {
          wmc: { violations: 5, top: [] },
          halstead: { violations: 0, top: [] },
          lcom: { violations: 0, top: [] },
          cbo: { violations: 0, top: [] },
          dit: { violations: 0, top: [] },
        },
      },
    });
    const a2 = canonicalAudit({
      generated_at: "2026-05-03T15:00:00Z",
      stage: "brownfield-moderate",
    });

    const history = loadHistory(
      ROOT,
      makeDeps({
        listings: {
          [AUDIT_DIR_ABS]: [
            `${TS_OLDER}.json`,
            "README.md",
            ".gitkeep",
            `${TS_NEWEST}.json`,
            "broken.json.bak",
          ],
        },
        files: {
          [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: JSON.stringify(a1),
          [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(a2),
        },
      }),
    );

    expect(history).toHaveLength(2);
    expect(history[0]?.timestamp).toBe(TS_OLDER);
    expect(history[1]?.timestamp).toBe(TS_NEWEST);
    expect(history[0]?.stage).toBe("greenfield");
    expect(history[0]?.by_metric.wmc).toBe(5);
    expect(history[0]?.errors).toBe(0);
    expect(history[1]?.errors).toBe(3);
  });

  it("drops malformed JSON entries without failing", () => {
    const audit = canonicalAudit();
    const history = loadHistory(
      ROOT,
      makeDeps({
        listings: {
          [AUDIT_DIR_ABS]: [`${TS_OLDER}.json`, `${TS_NEWER}.json`],
        },
        files: {
          [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: "{ not json",
          [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(audit),
        },
      }),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.timestamp).toBe(TS_NEWER);
  });

  it("drops entries that fail schema validation", () => {
    const valid = canonicalAudit();
    const broken = { ...canonicalAudit(), version: "2" };
    const history = loadHistory(
      ROOT,
      makeDeps({
        listings: {
          [AUDIT_DIR_ABS]: [`${TS_OLDER}.json`, `${TS_NEWEST}.json`],
        },
        files: {
          [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: JSON.stringify(broken),
          [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(valid),
        },
      }),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.timestamp).toBe(TS_NEWEST);
  });

  it("returns [] when audit dir is empty or absent", () => {
    expect(
      loadHistory(ROOT, makeDeps({ listings: {}, files: {} })),
    ).toEqual([]);
    expect(
      loadHistory(ROOT, makeDeps({ listings: { [AUDIT_DIR_ABS]: [] }, files: {} })),
    ).toEqual([]);
  });

  it("preserves ascending order across 3 timestamps fed unsorted", () => {
    const audit = canonicalAudit();
    const history = loadHistory(
      ROOT,
      makeDeps({
        listings: {
          [AUDIT_DIR_ABS]: [
            `${TS_NEWEST}.json`,
            `${TS_OLDER}.json`,
            `${TS_NEWER}.json`,
          ],
        },
        files: {
          [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: JSON.stringify(audit),
          [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(audit),
          [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(audit),
        },
      }),
    );
    expect(history.map((h) => h.timestamp)).toEqual([TS_OLDER, TS_NEWER, TS_NEWEST]);
  });
});

// ---------------------------------------------------------------------------
// loadCoverage
// ---------------------------------------------------------------------------

describe("loadCoverage", () => {
  it("parses canonical istanbul shape", () => {
    const summary = {
      total: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 50, covered: 45, skipped: 0, pct: 90 },
        branches: { total: 40, covered: 30, skipped: 0, pct: 75 },
        statements: { total: 100, covered: 78, skipped: 0, pct: 78 },
      },
    };
    const out = loadCoverage(
      ROOT,
      makeDeps({
        listings: {},
        files: { [COVERAGE_ABS]: JSON.stringify(summary) },
      }),
    );
    expect(out).toEqual({
      source: COVERAGE_SUMMARY_PATH,
      lines: 80,
      functions: 90,
      branches: 75,
      statements: 78,
    });
  });

  it("returns null when file is missing", () => {
    const out = loadCoverage(ROOT, makeDeps({ listings: {}, files: {} }));
    expect(out).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    const out = loadCoverage(
      ROOT,
      makeDeps({ listings: {}, files: { [COVERAGE_ABS]: "{ not json" } }),
    );
    expect(out).toBeNull();
  });

  it("returns null when total block is missing", () => {
    const out = loadCoverage(
      ROOT,
      makeDeps({
        listings: {},
        files: { [COVERAGE_ABS]: JSON.stringify({ "src/foo.ts": {} }) },
      }),
    );
    expect(out).toBeNull();
  });

  it("returns nulls per-key when a metric pct is missing or non-numeric", () => {
    const summary = {
      total: {
        lines: { pct: 80 },
        functions: { pct: "ninety" },
        branches: {},
        statements: { pct: 78 },
      },
    };
    const out = loadCoverage(
      ROOT,
      makeDeps({
        listings: {},
        files: { [COVERAGE_ABS]: JSON.stringify(summary) },
      }),
    );
    expect(out).toEqual({
      source: COVERAGE_SUMMARY_PATH,
      lines: 80,
      functions: null,
      branches: null,
      statements: 78,
    });
  });
});

// ---------------------------------------------------------------------------
// loadGit
// ---------------------------------------------------------------------------

describe("loadGit", () => {
  it("returns ISO date + churn count on success", () => {
    const out = loadGit(ROOT, {
      firstCommitDateFn: () => ({ ok: true, value: new Date("2025-01-01T00:00:00Z") }),
      churn90dFn: () => ({ ok: true, value: 42 }),
    });
    expect(out).toEqual({
      first_commit_date: "2025-01-01T00:00:00.000Z",
      churn_90d: 42,
    });
  });

  it("treats null commit date (empty repo) as null first_commit_date", () => {
    const out = loadGit(ROOT, {
      firstCommitDateFn: () => ({ ok: true, value: null }),
      churn90dFn: () => ({ ok: true, value: 0 }),
    });
    expect(out.first_commit_date).toBeNull();
    expect(out.churn_90d).toBe(0);
  });

  it("degrades to null/0 when git probes fail", () => {
    const out = loadGit(ROOT, {
      firstCommitDateFn: () => ({ ok: false, error: "git missing" }),
      churn90dFn: () => ({ ok: false, error: "git missing" }),
    });
    expect(out).toEqual({ first_commit_date: null, churn_90d: 0 });
  });
});

// ---------------------------------------------------------------------------
// loadReportData (top-level)
// ---------------------------------------------------------------------------

describe("loadReportData", () => {
  const FIXED_NOW = new Date("2026-05-03T16:00:00Z");

  it("aggregates audit + history + coverage + git into the canonical shape", () => {
    const audit = canonicalAudit();
    const summary = {
      total: {
        lines: { pct: 80 },
        functions: { pct: 90 },
        branches: { pct: 70 },
        statements: { pct: 78 },
      },
    };
    const result = loadReportData(
      { cwd: ROOT, now: FIXED_NOW },
      makeDeps(
        {
          listings: {
            [AUDIT_DIR_ABS]: [`${TS_OLDER}.json`, `${TS_NEWEST}.json`],
          },
          files: {
            [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: JSON.stringify(audit),
            [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(audit),
            [COVERAGE_ABS]: JSON.stringify(summary),
          },
        },
        {
          firstCommitDateFn: () => ({ ok: true, value: new Date("2025-01-01T00:00:00Z") }),
          churn90dFn: () => ({ ok: true, value: 99 }),
        },
      ),
    );

    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    const data = result.data;
    expect(data.version).toBe(REPORT_DATA_VERSION);
    expect(data.generated_at).toBe("2026-05-03T16:00:00.000Z");
    expect(data.cwd).toBe(ROOT);
    expect(data.audit_path).toBe(`.lint-audit/${TS_NEWEST}.json`);
    expect(data.audit.stage).toBe("brownfield-moderate");
    expect(data.history).toHaveLength(2);
    expect(data.coverage?.lines).toBe(80);
    expect(data.git).toEqual({
      first_commit_date: "2025-01-01T00:00:00.000Z",
      churn_90d: 99,
    });
  });

  it("propagates audit_missing as a loader failure", () => {
    const result = loadReportData(
      { cwd: ROOT, now: FIXED_NOW },
      makeDeps({ listings: {}, files: {} }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("audit_missing");
  });

  it("hides coverage when summary file is absent", () => {
    const audit = canonicalAudit();
    const result = loadReportData(
      { cwd: ROOT, now: FIXED_NOW },
      makeDeps({
        listings: { [AUDIT_DIR_ABS]: [`${TS_NEWEST}.json`] },
        files: { [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(audit) },
      }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.coverage).toBeNull();
  });

  it("preserves history while audit_missing → loader still fails", () => {
    // History reads from the same dir as auditLatest. If auditLatest fails
    // (e.g., dir empty), the loader still bails — proves the precedence.
    const result = loadReportData(
      { cwd: ROOT, now: FIXED_NOW },
      makeDeps({ listings: { [AUDIT_DIR_ABS]: [] }, files: {} }),
    );
    expect(result.ok).toBe(false);
  });

  it("uses a real Date when opts.now is omitted", () => {
    const audit = canonicalAudit();
    const before = new Date();
    const result = loadReportData(
      { cwd: ROOT },
      makeDeps({
        listings: { [AUDIT_DIR_ABS]: [`${TS_NEWEST}.json`] },
        files: { [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(audit) },
      }),
    );
    if (!result.ok) throw new Error("expected ok");
    const after = new Date();
    const stamp = new Date(result.data.generated_at);
    expect(stamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(stamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ---------------------------------------------------------------------------
// parseReportDataArgs
// ---------------------------------------------------------------------------

describe("parseReportDataArgs", () => {
  it("returns defaults when no args", () => {
    const out = parseReportDataArgs([], ROOT);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.cwd).toBe(ROOT);
  });

  it("accepts --cwd <path>", () => {
    const out = parseReportDataArgs(["--cwd", "subdir"], ROOT);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.cwd).toBe(pathJoin(ROOT, "subdir"));
  });

  it("rejects --cwd without value", () => {
    const out = parseReportDataArgs(["--cwd"], ROOT);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/missing value/);
  });

  it("rejects --cwd with empty value", () => {
    const out = parseReportDataArgs(["--cwd", ""], ROOT);
    expect(out.ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const out = parseReportDataArgs(["--zonk"], ROOT);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/unknown flag/);
  });

  it("returns error 'help' for --help/-h", () => {
    expect(parseReportDataArgs(["--help"], ROOT)).toEqual({ ok: false, error: "help" });
    expect(parseReportDataArgs(["-h"], ROOT)).toEqual({ ok: false, error: "help" });
  });
});
