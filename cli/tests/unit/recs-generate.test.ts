/**
 * Contract tests for `recs-generate` (IMPLEMENTATION_PLAN.md Phase 4 — line 86).
 *
 * Locks the heuristics in `docs/recs-heuristics.md` (single source of truth):
 *   - Output ordering (§7) — fix-tooling → enable-tier → add-rule →
 *     lower-threshold → raise-threshold → loosen-coverage → tighten-coverage.
 *   - Stable IDs (§4) — `rec-<type>-<slug>` shape.
 *   - Each heuristic carries a positive, a negative (boundary), and an
 *     idempotence assertion.
 *   - `user-override:*` is intocable for raise/lower-threshold (§7.2).
 *   - `remove-rule` is a no-op in v1 (§6.4).
 *   - Halstead reads `max_seen_volume` (§6.1 footnote).
 *   - Argv parser covers all flags.
 */
import { describe, expect, it } from "vitest";

import {
  type AuditPayload,
  AUDIT_SCHEMA_VERSION,
  type RuleActive,
} from "../../src/lib/audit-schema.ts";
import {
  type Candidate,
  parseRecsGenerateArgs,
  recsGenerate,
} from "../../src/commands/recs/generate.ts";

const ROOT = "/proj";

// ---------------------------------------------------------------------------
// Audit payload builders — build a minimal valid AuditPayload, override what
// each test needs.
// ---------------------------------------------------------------------------

function emptyMetric() {
  return { violations: 0, top: [] };
}

function baseAudit(overrides: Partial<AuditPayload> = {}): AuditPayload {
  const base: AuditPayload = {
    version: AUDIT_SCHEMA_VERSION,
    generated_at: "2026-05-03T14:22:11.000Z",
    stage: "brownfield-moderate",
    stage_signals: { age_days: 540 },
    tooling: {
      oxlint: "1.0.0",
      oxfmt: "0.5.0",
      quality_metrics: "0.3.1",
      test_runner: "vitest",
      coverage: {
        configured: true,
        thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
    violations: {
      summary: { errors: 0, warnings: 0, files_affected: 0 },
      by_metric: {
        wmc: emptyMetric(),
        halstead: emptyMetric(),
        lcom: emptyMetric(),
        cbo: emptyMetric(),
        dit: emptyMetric(),
      },
    },
    rules_active: brownfieldDeepRules(),
    recommendations: [],
  };
  return { ...base, ...overrides };
}

function brownfieldDeepRules(): RuleActive[] {
  const origin = "preset:brownfield-moderate:deep";
  return [
    { rule: "quality-metrics/wmc", severity: "error", options: { max: 20 }, origin },
    {
      rule: "quality-metrics/halstead",
      severity: "warn",
      options: { maxVolume: 1000, maxEffort: 400 },
      origin,
    },
    {
      rule: "quality-metrics/lcom",
      severity: "warn",
      options: { maxLcom: 2 },
      origin,
    },
    { rule: "quality-metrics/cbo", severity: "error", options: { max: 10 }, origin },
    { rule: "quality-metrics/dit", severity: "warn", options: { max: 5 }, origin },
  ];
}

const ALWAYS_EXISTS = (_: string) => true;
const NEVER_EXISTS = (_: string) => false;

// ---------------------------------------------------------------------------
// Happy path: clean audit on configured project → no candidates
// ---------------------------------------------------------------------------

describe("recsGenerate — empty case", () => {
  it("clean audit with all tooling installed and no signals → empty list", () => {
    const audit = baseAudit();
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toEqual([]);
  });

  it("idempotent: same audit twice → byte-equal candidate list", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxlint: null },
    });
    const a = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    const b = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// 6.8 fix-tooling
// ---------------------------------------------------------------------------

describe("fix-tooling", () => {
  it("oxlint=null → emits rec-fix-tooling-oxlint with critical severity", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxlint: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ft = r.candidates.find((c) => c.id === "rec-fix-tooling-oxlint");
    expect(ft).toBeDefined();
    expect(ft?.type).toBe("fix-tooling");
    expect(ft?.severity).toBe("critical");
    expect(ft?.applies_to).toBe("package.json");
  });

  it("oxfmt=null → emits rec-fix-tooling-oxfmt", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxfmt: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.map((c) => c.id)).toContain("rec-fix-tooling-oxfmt");
  });

  it("quality_metrics=null AND has active QM rules → emits", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, quality_metrics: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.map((c) => c.id)).toContain("rec-fix-tooling-quality-metrics");
  });

  it("quality_metrics=null but NO active QM rules → does NOT emit", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, quality_metrics: null },
      rules_active: [], // no QM rules
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.map((c) => c.id)).not.toContain("rec-fix-tooling-quality-metrics");
  });
});

// ---------------------------------------------------------------------------
// 6.5 enable-tier
// ---------------------------------------------------------------------------

describe("enable-tier", () => {
  it("oxlint.deep.json missing → emits rec-enable-tier-deep", () => {
    const audit = baseAudit();
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: NEVER_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const e = r.candidates.find((c) => c.id === "rec-enable-tier-deep");
    expect(e).toBeDefined();
    expect(e?.severity).toBe("recommend");
    expect(e?.applies_to).toBe("oxlint.deep.json");
  });

  it("quality_metrics=null → emits rec-enable-tier-deep even when deep file present", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, quality_metrics: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.map((c) => c.id)).toContain("rec-enable-tier-deep");
  });

  it("both deep file present and QM installed → does NOT emit", () => {
    const audit = baseAudit();
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.map((c) => c.id)).not.toContain("rec-enable-tier-deep");
  });
});

// ---------------------------------------------------------------------------
// 6.3 add-rule
// ---------------------------------------------------------------------------

describe("add-rule", () => {
  it("missing quality-metrics/cbo → emits rec-add-rule-quality-metrics-cbo-deep", () => {
    const rules = brownfieldDeepRules().filter(
      (r) => r.rule !== "quality-metrics/cbo",
    );
    const audit = baseAudit({ rules_active: rules });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-add-rule-quality-metrics-cbo-deep");
    expect(c).toBeDefined();
    expect(c?.evidence["proposed_value"]).toBe(10); // brownfield cbo max
    expect(c?.severity).toBe("recommend");
  });

  it("rule present in any form → does NOT emit add-rule", () => {
    const r = recsGenerate(
      { cwd: ROOT, audit: baseAudit() },
      { existsFn: ALWAYS_EXISTS },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(
      r.candidates.filter((c) => c.type === "add-rule").map((c) => c.id),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6.1 raise-threshold
// ---------------------------------------------------------------------------

describe("raise-threshold", () => {
  it("max_seen=12 < 0.7 × 20 (wmc) → emits raise with proposed clamped to greenfield floor (15)", () => {
    // round(12 × 1.2) = 14 — but §7.3 clamps to [greenfield=15, legacy=40].
    const audit = baseAudit({
      violations: {
        summary: { errors: 0, warnings: 0, files_affected: 0 },
        by_metric: {
          wmc: { violations: 0, max_seen: 12, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-raise-threshold-wmc-deep");
    expect(c).toBeDefined();
    expect(c?.evidence["proposed_value"]).toBe(15);
    expect(c?.evidence["current_max"]).toBe(20);
    expect(c?.severity).toBe("recommend"); // 20 - 15 = 5 >= 5
    expect(c?.suggested_change).toMatchObject({
      applies_to: "oxlint.deep.json",
      rule: "quality-metrics/wmc",
      max: 15,
    });
  });

  it("boundary: max_seen at threshold (0.7×current_max) → does NOT emit", () => {
    // 0.7 × 20 = 14 — equality is NOT less-than, must drop.
    const audit = baseAudit({
      violations: {
        summary: { errors: 0, warnings: 0, files_affected: 0 },
        by_metric: {
          wmc: { violations: 0, max_seen: 14, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "raise-threshold")).toBeUndefined();
  });

  it("violations > 0 → does NOT emit raise (no headroom)", () => {
    const audit = baseAudit({
      violations: {
        summary: { errors: 0, warnings: 1, files_affected: 1 },
        by_metric: {
          wmc: { violations: 1, max_seen: 12, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "raise-threshold")).toBeUndefined();
  });

  it("user-override:* origin is intocable", () => {
    const audit = baseAudit({
      rules_active: [
        {
          rule: "quality-metrics/wmc",
          severity: "error",
          options: { max: 20 },
          origin: "user-override:2026-04-12",
        },
      ],
      violations: {
        summary: { errors: 0, warnings: 0, files_affected: 0 },
        by_metric: {
          wmc: { violations: 0, max_seen: 5, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "raise-threshold")).toBeUndefined();
  });

  it("halstead reads max_seen_volume (not max_seen)", () => {
    const audit = baseAudit({
      violations: {
        summary: { errors: 0, warnings: 0, files_affected: 0 },
        by_metric: {
          wmc: emptyMetric(),
          halstead: { violations: 0, max_seen_volume: 500, top: [] },
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-raise-threshold-halstead-deep");
    expect(c).toBeDefined();
    // 500 < 0.7 × 1000 (700) → propose round(500 × 1.2) = 600 — but §7.3
    // clamps to [greenfield=800, legacy=2000].
    expect(c?.evidence["proposed_value"]).toBe(800);
  });

  it("severity=suggest when gain < 5", () => {
    // current_max=10 (cbo), max_seen=6 → 6 < 7 trigger; proposed=round(7.2)=7; gain=3 → suggest
    const audit = baseAudit({
      violations: {
        summary: { errors: 0, warnings: 0, files_affected: 0 },
        by_metric: {
          wmc: emptyMetric(),
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: { violations: 0, max_seen: 6, top: [] },
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-raise-threshold-cbo-deep");
    expect(c).toBeDefined();
    expect(c?.severity).toBe("suggest");
  });
});

// ---------------------------------------------------------------------------
// 6.2 lower-threshold
// ---------------------------------------------------------------------------

describe("lower-threshold", () => {
  it("violations=10, max_seen=35 (>1.5×20) on wmc → emits lower with proposed=32", () => {
    // round(35 × 0.9) = 32; clamp to legacy[wmc]=40 (no change).
    const audit = baseAudit({
      violations: {
        summary: { errors: 10, warnings: 0, files_affected: 5 },
        by_metric: {
          wmc: { violations: 10, max_seen: 35, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-lower-threshold-wmc-deep");
    expect(c).toBeDefined();
    expect(c?.evidence["proposed_value"]).toBe(32);
    expect(c?.severity).toBe("recommend");
  });

  it("violations >= 20 → severity=critical", () => {
    const audit = baseAudit({
      violations: {
        summary: { errors: 25, warnings: 0, files_affected: 12 },
        by_metric: {
          wmc: { violations: 25, max_seen: 35, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-lower-threshold-wmc-deep");
    expect(c?.severity).toBe("critical");
  });

  it("boundary: violations < 5 → does NOT emit", () => {
    const audit = baseAudit({
      violations: {
        summary: { errors: 4, warnings: 0, files_affected: 4 },
        by_metric: {
          wmc: { violations: 4, max_seen: 35, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "lower-threshold")).toBeUndefined();
  });

  it("boundary: max_seen at 1.5×current_max → does NOT emit", () => {
    // 1.5 × 20 = 30 — equality is not strictly greater, must drop.
    const audit = baseAudit({
      violations: {
        summary: { errors: 10, warnings: 0, files_affected: 5 },
        by_metric: {
          wmc: { violations: 10, max_seen: 30, top: [] },
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: emptyMetric(),
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "lower-threshold")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6.6 tighten-coverage / 6.7 loosen-coverage
// ---------------------------------------------------------------------------

describe("tighten-coverage", () => {
  it("legacy stage with lines=80% → emits tighten to brownfield (70%) — but skipped because 80<70 is false; emits when actual >= next", () => {
    // Legacy thresholds=40; next=brownfield=70. actual=80 → emit (>= 70).
    // Skipped if current_threshold >= 70 already.
    const audit = baseAudit({
      stage: "legacy",
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "vitest",
        coverage: {
          configured: true,
          lines: 80,
          thresholds: { lines: 40 },
        },
      },
      rules_active: [], // suppress add-rule noise
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-tighten-coverage-vitest-lines");
    expect(c).toBeDefined();
    expect(c?.evidence["proposed_value"]).toBe(70);
    expect(c?.severity).toBe("suggest");
  });

  it("greenfield stage → never emits (already top tier)", () => {
    const audit = baseAudit({
      stage: "greenfield",
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "vitest",
        coverage: {
          configured: true,
          lines: 95,
          thresholds: { lines: 90 },
        },
      },
      rules_active: [],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "tighten-coverage")).toBeUndefined();
  });

  it("test_runner=none → skipped", () => {
    const audit = baseAudit({
      stage: "legacy",
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "none",
        coverage: { configured: true, lines: 80 },
      },
      rules_active: [],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "tighten-coverage")).toBeUndefined();
  });
});

describe("loosen-coverage", () => {
  it("actual < threshold → emits with proposed=floor(actual)", () => {
    const audit = baseAudit({
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "vitest",
        coverage: {
          configured: true,
          lines: 65.7,
          thresholds: { lines: 70 },
        },
      },
      rules_active: [],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const c = r.candidates.find((x) => x.id === "rec-loosen-coverage-vitest-lines");
    expect(c).toBeDefined();
    expect(c?.evidence["proposed_value"]).toBe(65);
    expect(c?.rationale_stub).toContain("lint-decisions.md");
    expect(c?.severity).toBe("recommend");
  });

  it("proposed below legacy floor → does NOT emit", () => {
    // legacy_table.lines=40; actual=30, floor would be 30 < 40, drop.
    const audit = baseAudit({
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "vitest",
        coverage: {
          configured: true,
          lines: 30,
          thresholds: { lines: 70 },
        },
      },
      rules_active: [],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "loosen-coverage")).toBeUndefined();
  });

  it("coverage.configured=false → skipped", () => {
    const audit = baseAudit({
      tooling: {
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "vitest",
        coverage: {
          configured: false,
          lines: 65,
          thresholds: { lines: 70 },
        },
      },
      rules_active: [],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "loosen-coverage")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ordering & invariants
// ---------------------------------------------------------------------------

describe("ordering invariant (heuristics §7)", () => {
  it("emits in fix-tooling → enable-tier → add-rule → lower → raise → loosen → tighten", () => {
    const audit = baseAudit({
      tooling: {
        oxlint: null,
        oxfmt: "0.5.0",
        quality_metrics: null,
        test_runner: "vitest",
        coverage: {
          configured: true,
          lines: 65, // below threshold → loosen
          thresholds: { lines: 70 },
        },
      },
      rules_active: brownfieldDeepRules().filter(
        (r) => r.rule !== "quality-metrics/cbo",
      ),
      violations: {
        summary: { errors: 6, warnings: 0, files_affected: 3 },
        by_metric: {
          wmc: { violations: 6, max_seen: 35, top: [] }, // lower
          halstead: emptyMetric(),
          lcom: emptyMetric(),
          cbo: emptyMetric(),
          dit: { violations: 0, max_seen: 1, top: [] }, // raise: 1 < 0.7×5 → propose round(1.2)=2 < dit greenfield floor=4 → clamped to 4
        },
      },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: NEVER_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const types = r.candidates.map((c) => c.type);
    const phaseRank: Record<string, number> = {
      "fix-tooling": 1,
      "enable-tier": 2,
      "add-rule": 3,
      "lower-threshold": 4,
      "raise-threshold": 5,
      "loosen-coverage": 6,
      "tighten-coverage": 7,
    };
    const ranks = types.map((t) => phaseRank[t] ?? -1);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    // sanity: at least one of each was emitted
    expect(types).toContain("fix-tooling");
    expect(types).toContain("enable-tier");
  });

  it("no duplicate IDs", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxlint: null, oxfmt: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const ids = r.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rationale_stub never empty", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxlint: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: NEVER_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.rationale_stub.length).toBeGreaterThan(0);
    }
  });

  it("v1 never emits remove-rule", () => {
    const audit = baseAudit({
      rules_active: [
        {
          rule: "quality-metrics/wmc",
          severity: "error",
          options: { max: 20 },
          origin: "user-override:2026-04-12",
        },
      ],
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.candidates.find((c) => c.type === "remove-rule")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

describe("parseRecsGenerateArgs", () => {
  it("defaults cwd to defaultCwd when no flags", () => {
    const r = parseRecsGenerateArgs([], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe(ROOT);
  });

  it("parses --cwd <path>", () => {
    const r = parseRecsGenerateArgs(["--cwd", "subdir"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toContain("subdir");
  });

  it("rejects --cwd without value", () => {
    const r = parseRecsGenerateArgs(["--cwd"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--cwd");
  });

  it("rejects unknown flags", () => {
    const r = parseRecsGenerateArgs(["--zonk"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--zonk");
  });

  it("returns help sentinel for --help", () => {
    const r = parseRecsGenerateArgs(["--help"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });
});

// ---------------------------------------------------------------------------
// Candidate shape — type assertion only (compile-time)
// ---------------------------------------------------------------------------

describe("Candidate type contract", () => {
  it("output candidates conform to the Candidate type", () => {
    const audit = baseAudit({
      tooling: { ...baseAudit().tooling, oxlint: null },
    });
    const r = recsGenerate({ cwd: ROOT, audit }, { existsFn: ALWAYS_EXISTS });
    if (!r.ok) throw new Error("expected ok");
    const sample: Candidate | undefined = r.candidates[0];
    expect(sample).toBeDefined();
    if (!sample) return;
    expect(typeof sample.id).toBe("string");
    expect(typeof sample.title).toBe("string");
    expect(typeof sample.rationale_stub).toBe("string");
    expect(sample.blast_radius.files_newly_violating).toBeNull();
  });
});
