/**
 * Contract tests for `audit-latest` (IMPLEMENTATION_PLAN.md Phase 4 — line 84).
 *
 * What is locked:
 *   - Picks the lexically largest `.lint-audit/<ts>.json` (`toSafeTimestamp`
 *     emits monotonically sortable strings, so descending lexical = newest).
 *   - Non-`.json` entries in the directory are ignored.
 *   - Output shape `{ ok, cwd, path, timestamp, audit }` (PLAN §Contratos CLI
 *     line 76 + reader-side audit payload).
 *   - Missing dir / empty dir → `audit_missing` (RECOVERABLE_ERROR).
 *   - File unreadable → `read_failed`.
 *   - Malformed JSON → `parse_failed`.
 *   - Schema drift → `schema_validation_failed`.
 *   - parseAuditLatestArgs covers every flag combination + error path.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type AuditLatestDeps,
  auditLatest,
  parseAuditLatestArgs,
} from "../../src/commands/audit-latest.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

function canonicalAudit() {
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
        wmc: { violations: 1, max_seen: 22, top: [{ file: "src/big.ts", class: "Big", value: 22, max: 20 }] },
        halstead: { violations: 0, top: [] },
        lcom: { violations: 0, top: [] },
        cbo: { violations: 0, top: [] },
        dit: { violations: 0, top: [] },
      },
    },
    rules_active: [
      {
        rule: "quality-metrics/wmc",
        severity: "error",
        options: { max: 20 },
        origin: "preset:brownfield-moderate:deep",
      },
    ],
    recommendations: [],
  };
}

const TS_OLDER = "2026-05-01T08-00-00-000Z";
const TS_NEWER = "2026-05-03T14-22-11-000Z";
const TS_NEWEST = "2026-05-03T15-00-00-000Z";

interface FakeFS {
  readonly listings: Record<string, readonly string[]>;
  readonly files: Record<string, string>;
}

function makeDeps(fs: FakeFS): AuditLatestDeps {
  return {
    readdirFn: (dir) => fs.listings[dir] ?? [],
    readFileFn: (p) => fs.files[p] ?? null,
  };
}

const AUDIT_DIR_ABS = pathJoin(ROOT, ".lint-audit");

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("auditLatest — happy path", () => {
  it("picks the lexically largest .json filename", () => {
    const audit = canonicalAudit();
    const deps = makeDeps({
      listings: {
        [AUDIT_DIR_ABS]: [
          `${TS_OLDER}.json`,
          `${TS_NEWEST}.json`,
          `${TS_NEWER}.json`,
        ],
      },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWEST}.json`)]: JSON.stringify(audit),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.timestamp).toBe(TS_NEWEST);
    expect(result.path).toBe(`.lint-audit/${TS_NEWEST}.json`);
    expect(result.cwd).toBe(ROOT);
    expect(result.audit.stage).toBe("brownfield-moderate");
    expect(result.audit.violations.summary.errors).toBe(3);
  });

  it("ignores non-.json entries (directories, README, lockfiles)", () => {
    const audit = canonicalAudit();
    const deps = makeDeps({
      listings: {
        [AUDIT_DIR_ABS]: [
          "README.md",
          ".gitkeep",
          `${TS_NEWER}.json.bak`,
          `${TS_NEWER}.json`,
        ],
      },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(audit),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.timestamp).toBe(TS_NEWER);
  });

  it("returns ok with single file present", () => {
    const audit = canonicalAudit();
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_OLDER}.json`] },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_OLDER}.json`)]: JSON.stringify(audit),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.timestamp).toBe(TS_OLDER);
  });

  it("audit field is the validated payload (not raw JSON)", () => {
    const audit = canonicalAudit();
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_NEWER}.json`] },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(audit),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    // Round-trips structurally — schema validate keeps the shape.
    expect(result.audit.version).toBe("1");
    expect(result.audit.tooling.oxlint).toBe("1.0.0");
    expect(result.audit.rules_active[0]?.rule).toBe("quality-metrics/wmc");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("auditLatest — error paths", () => {
  it("missing .lint-audit/ directory → audit_missing", () => {
    const deps = makeDeps({ listings: {}, files: {} });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("audit_missing");
    expect(result.reason).toContain(".lint-audit");
  });

  it("empty directory → audit_missing", () => {
    const deps = makeDeps({ listings: { [AUDIT_DIR_ABS]: [] }, files: {} });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("audit_missing");
  });

  it("dir contains only non-.json files → audit_missing", () => {
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: ["README.md", ".gitkeep", "stale.json.bak"] },
      files: {},
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("audit_missing");
  });

  it("file unreadable → read_failed", () => {
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_NEWER}.json`] },
      files: {}, // file present in listing but readFileFn returns null
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("read_failed");
    expect(result.reason).toContain(`.lint-audit/${TS_NEWER}.json`);
  });

  it("malformed JSON → parse_failed", () => {
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_NEWER}.json`] },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: "{ not json",
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("parse_failed");
    expect(result.reason).toContain(`.lint-audit/${TS_NEWER}.json`);
  });

  it("schema drift (missing required field) → schema_validation_failed", () => {
    const broken = canonicalAudit() as Record<string, unknown>;
    delete broken.tooling;
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_NEWER}.json`] },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(broken),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("schema_validation_failed");
    expect(result.reason).toContain("tooling");
  });

  it("schema drift (wrong version literal) → schema_validation_failed", () => {
    const broken = { ...canonicalAudit(), version: "2" };
    const deps = makeDeps({
      listings: { [AUDIT_DIR_ABS]: [`${TS_NEWER}.json`] },
      files: {
        [pathJoin(AUDIT_DIR_ABS, `${TS_NEWER}.json`)]: JSON.stringify(broken),
      },
    });
    const result = auditLatest({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("schema_validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

describe("parseAuditLatestArgs", () => {
  it("defaults cwd to defaultCwd when no flags", () => {
    const r = parseAuditLatestArgs([], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe(ROOT);
  });

  it("parses --cwd <path>", () => {
    const r = parseAuditLatestArgs(["--cwd", "subdir"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe(pathJoin(ROOT, "subdir"));
  });

  it("rejects --cwd without value", () => {
    const r = parseAuditLatestArgs(["--cwd"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--cwd");
  });

  it("rejects --cwd with empty value", () => {
    const r = parseAuditLatestArgs(["--cwd", ""], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--cwd");
  });

  it("rejects unknown flags", () => {
    const r = parseAuditLatestArgs(["--zonk"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--zonk");
  });

  it("returns help sentinel for --help", () => {
    const r = parseAuditLatestArgs(["--help"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });

  it("returns help sentinel for -h", () => {
    const r = parseAuditLatestArgs(["-h"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });
});
