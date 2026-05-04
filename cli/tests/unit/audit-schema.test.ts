import { describe, expect, it } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  auditPayloadSchema,
  blastRadiusSchema,
  coverageSchema,
  metricViolationsSchema,
  METRIC_KEYS,
  recommendationSchema,
  REC_TYPES,
  REC_SEVERITIES,
  RULE_SEVERITIES,
  ruleActiveSchema,
  stageSchema,
  STAGES,
  TEST_RUNNERS,
  toolingSchema,
  validateAuditPayload,
  violationTopEntrySchema,
  violationsSchema,
} from "../../src/lib/audit-schema.ts";

// ---------------------------------------------------------------------------
// Canonical fixture mirroring the SPEC §3 example (lines 244-282).
// Touch this only when the SPEC contract changes — it's the lockstep for
// drift between the doc and the schema.
// ---------------------------------------------------------------------------

function canonicalAudit() {
  return {
    version: "1",
    generated_at: "2026-05-03T14:22:11Z",
    stage: "brownfield-moderate",
    stage_signals: {
      age_days: 540,
      loc: 12500,
      churn_90d: 312,
      authors: 4,
      has_tests: true,
      todo_density_per_100_loc: 0.6,
    },
    tooling: {
      oxlint: "1.0.0",
      oxfmt: "0.5.0-alpha",
      quality_metrics: "0.3.1",
      test_runner: "vitest",
      coverage: {
        configured: true,
        lines: 67.4,
        functions: 71.2,
        branches: 58.8,
        statements: 67.0,
        thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
    violations: {
      summary: { errors: 12, warnings: 47, files_affected: 18 },
      by_metric: {
        wmc: {
          violations: 4,
          max_seen: 38,
          top: [{ file: "src/api/router.ts", class: "Router", value: 38, max: 20 }],
        },
        halstead: {
          violations: 6,
          max_seen_volume: 1840,
          top: [{ file: "src/parser.ts", value: 1840 }],
        },
        lcom: {
          violations: 5,
          top: [{ file: "src/store/cache.ts", class: "Cache" }],
        },
        cbo: {
          violations: 9,
          top: [{ file: "src/auth/jwt.ts", class: "JwtSigner", value: 14, max: 10 }],
        },
        dit: {
          violations: 1,
          top: [{ file: "src/legacy/base.ts", class: "Base", value: 6, max: 5 }],
        },
      },
    },
    rules_active: [
      {
        rule: "quality-metrics/wmc",
        severity: "error",
        options: { max: 20 },
        origin: "preset:brownfield-moderate",
      },
      {
        rule: "quality-metrics/cbo",
        severity: "error",
        options: { max: 10 },
        origin: "preset:brownfield-moderate",
      },
      {
        rule: "quality-metrics/dit",
        severity: "warn",
        options: { max: 5 },
        origin: "user-override:2026-04-12",
      },
    ],
    recommendations: [
      {
        id: "rec-001",
        type: "raise-threshold",
        title: "WMC max está em 20 mas 90% das classes estão abaixo de 12 — apertar para 14",
        rationale: "Distribuição empírica permite threshold mais rígido sem inflar warnings.",
        blast_radius: { files_newly_violating: 3, files_currently_violating: 4 },
        patch: { rules: { "quality-metrics/wmc": { max: 14 } } },
        severity: "recommend",
        applies_to: "oxlint.fast.json",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Top-level enums (lock against drift from SPEC §3)
// ---------------------------------------------------------------------------

describe("audit-schema constants", () => {
  it("STAGES enumerates the three SPEC §3 stages", () => {
    expect(STAGES).toEqual(["greenfield", "brownfield-moderate", "legacy"]);
  });

  it("TEST_RUNNERS enumerates vitest|jest|none (SPEC §3 line 251)", () => {
    expect(TEST_RUNNERS).toEqual(["vitest", "jest", "none"]);
  });

  it("RULE_SEVERITIES allows error|warn|off", () => {
    expect(RULE_SEVERITIES).toEqual(["error", "warn", "off"]);
  });

  it("REC_SEVERITIES enumerates suggest|recommend|critical (SPEC §3 line 278)", () => {
    expect(REC_SEVERITIES).toEqual(["suggest", "recommend", "critical"]);
  });

  it("REC_TYPES enumerates the eight recommendation types from SPEC §3 line 273", () => {
    expect(REC_TYPES).toEqual([
      "raise-threshold",
      "lower-threshold",
      "add-rule",
      "remove-rule",
      "enable-tier",
      "tighten-coverage",
      "loosen-coverage",
      "fix-tooling",
    ]);
  });

  it("METRIC_KEYS covers wmc|halstead|lcom|cbo|dit (SPEC §3 lines 257-263)", () => {
    expect(METRIC_KEYS).toEqual(["wmc", "halstead", "lcom", "cbo", "dit"]);
  });

  it("AUDIT_SCHEMA_VERSION is the v1 literal locked by zod", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

describe("stageSchema", () => {
  it("accepts each canonical stage", () => {
    for (const s of STAGES) {
      expect(stageSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown stages", () => {
    expect(stageSchema.safeParse("brownfield").success).toBe(false);
    expect(stageSchema.safeParse("").success).toBe(false);
  });
});

describe("violationTopEntrySchema", () => {
  it("requires file but allows class/value/max omitted", () => {
    const parsed = violationTopEntrySchema.parse({ file: "src/x.ts" });
    expect(parsed.file).toBe("src/x.ts");
    expect(parsed.class).toBeUndefined();
  });

  it("rejects missing file", () => {
    expect(violationTopEntrySchema.safeParse({}).success).toBe(false);
  });
});

describe("metricViolationsSchema", () => {
  it("accepts halstead's max_seen_volume in addition to max_seen", () => {
    const result = metricViolationsSchema.safeParse({
      violations: 3,
      max_seen_volume: 1840,
      top: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative violations count", () => {
    expect(
      metricViolationsSchema.safeParse({ violations: -1, top: [] }).success,
    ).toBe(false);
  });

  it("requires top to be an array (not undefined)", () => {
    expect(
      metricViolationsSchema.safeParse({ violations: 0 }).success,
    ).toBe(false);
  });
});

describe("violationsSchema", () => {
  it("requires all five metrics under by_metric", () => {
    const partial = {
      summary: { errors: 0, warnings: 0, files_affected: 0 },
      by_metric: {
        wmc: { violations: 0, top: [] },
        halstead: { violations: 0, top: [] },
        lcom: { violations: 0, top: [] },
        cbo: { violations: 0, top: [] },
      },
    };
    expect(violationsSchema.safeParse(partial).success).toBe(false);
  });
});

describe("coverageSchema", () => {
  it("accepts coverage with thresholds omitted", () => {
    const parsed = coverageSchema.parse({ configured: false });
    expect(parsed.configured).toBe(false);
  });

  it("accepts null measurements (runner present, no run yet)", () => {
    const parsed = coverageSchema.parse({
      configured: true,
      lines: null,
      functions: null,
      branches: null,
      statements: null,
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    });
    expect(parsed.lines).toBeNull();
  });

  it("rejects non-boolean configured", () => {
    expect(
      coverageSchema.safeParse({ configured: "yes" }).success,
    ).toBe(false);
  });
});

describe("toolingSchema", () => {
  it("requires the version triplet but allows null entries", () => {
    const parsed = toolingSchema.parse({
      oxlint: null,
      oxfmt: null,
      quality_metrics: null,
      test_runner: "none",
      coverage: { configured: false },
    });
    expect(parsed.test_runner).toBe("none");
    expect(parsed.oxlint).toBeNull();
  });

  it("rejects unknown test_runner value", () => {
    expect(
      toolingSchema.safeParse({
        oxlint: "1.0.0",
        oxfmt: "0.5.0",
        quality_metrics: "0.3.1",
        test_runner: "mocha",
        coverage: { configured: false },
      }).success,
    ).toBe(false);
  });
});

describe("ruleActiveSchema", () => {
  it("accepts options omitted (rule with no opts)", () => {
    const parsed = ruleActiveSchema.parse({
      rule: "no-debugger",
      severity: "error",
      origin: "preset:greenfield",
    });
    expect(parsed.options).toBeUndefined();
  });

  it("rejects empty rule name or origin", () => {
    expect(
      ruleActiveSchema.safeParse({
        rule: "",
        severity: "error",
        origin: "preset:greenfield",
      }).success,
    ).toBe(false);
    expect(
      ruleActiveSchema.safeParse({
        rule: "no-debugger",
        severity: "error",
        origin: "",
      }).success,
    ).toBe(false);
  });

  it("rejects severity outside error|warn|off", () => {
    expect(
      ruleActiveSchema.safeParse({
        rule: "x",
        severity: "info",
        origin: "preset:x",
      }).success,
    ).toBe(false);
  });
});

describe("blastRadiusSchema", () => {
  it("requires both file counts as non-negative integers", () => {
    expect(
      blastRadiusSchema.safeParse({
        files_newly_violating: -1,
        files_currently_violating: 0,
      }).success,
    ).toBe(false);
    expect(
      blastRadiusSchema.parse({
        files_newly_violating: 0,
        files_currently_violating: 0,
      }),
    ).toEqual({ files_newly_violating: 0, files_currently_violating: 0 });
  });
});

describe("recommendationSchema", () => {
  function baseRec() {
    return {
      id: "rec-001",
      type: "raise-threshold" as const,
      title: "T",
      rationale: "R",
      blast_radius: { files_newly_violating: 0, files_currently_violating: 0 },
      patch: { foo: "bar" },
      severity: "recommend" as const,
      applies_to: "oxlint.fast.json",
    };
  }

  it("accepts a fully-populated recommendation", () => {
    expect(recommendationSchema.parse(baseRec()).id).toBe("rec-001");
  });

  it("rejects empty id", () => {
    expect(
      recommendationSchema.safeParse({ ...baseRec(), id: "" }).success,
    ).toBe(false);
  });

  it("rejects unknown recommendation type", () => {
    const bad = { ...baseRec(), type: "delete-everything" };
    expect(recommendationSchema.safeParse(bad).success).toBe(false);
  });

  it("requires patch (cannot be undefined)", () => {
    const { patch, ...withoutPatch } = baseRec();
    void patch;
    expect(recommendationSchema.safeParse(withoutPatch).success).toBe(false);
  });

  it("accepts empty patch object (no fields proposed yet)", () => {
    expect(
      recommendationSchema.parse({ ...baseRec(), patch: {} }).patch,
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Top-level audit payload
// ---------------------------------------------------------------------------

describe("auditPayloadSchema", () => {
  it("accepts the SPEC §3 canonical example", () => {
    const result = auditPayloadSchema.safeParse(canonicalAudit());
    expect(result.success).toBe(true);
  });

  it("rejects a payload whose version is not '1'", () => {
    const bad = { ...canonicalAudit(), version: "2" };
    expect(auditPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects generated_at without trailing Z", () => {
    const bad = { ...canonicalAudit(), generated_at: "2026-05-03T14:22:11" };
    expect(auditPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects generated_at in non-ISO format", () => {
    const bad = { ...canonicalAudit(), generated_at: "May 3 2026" };
    expect(auditPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts generated_at with milliseconds", () => {
    const ok = { ...canonicalAudit(), generated_at: "2026-05-03T14:22:11.123Z" };
    expect(auditPayloadSchema.safeParse(ok).success).toBe(true);
  });

  it("strips unknown top-level keys (zod default object mode)", () => {
    const withExtras = { ...canonicalAudit(), zonk: 42 };
    const result = auditPayloadSchema.safeParse(withExtras);
    expect(result.success).toBe(true);
    if (result.success) expect("zonk" in result.data).toBe(false);
  });

  it("preserves stage_signals as a free-form record", () => {
    const result = auditPayloadSchema.safeParse({
      ...canonicalAudit(),
      stage_signals: { whatever: { you: "want" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stage_signals).toEqual({ whatever: { you: "want" } });
    }
  });

  it("requires rules_active array (cannot be omitted)", () => {
    const bad = canonicalAudit() as Record<string, unknown>;
    delete bad.rules_active;
    expect(auditPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts empty recommendations array", () => {
    const ok = { ...canonicalAudit(), recommendations: [] };
    expect(auditPayloadSchema.safeParse(ok).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAuditPayload (defensive helper)
// ---------------------------------------------------------------------------

describe("validateAuditPayload", () => {
  it("returns ok=true for canonical payload", () => {
    const result = validateAuditPayload(canonicalAudit());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe("1");
  });

  it("returns ok=false with path-prefixed error for invalid stage", () => {
    const result = validateAuditPayload({ ...canonicalAudit(), stage: "wat" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith("stage:")).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns ok=false for non-object input", () => {
    const result = validateAuditPayload(42);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for null input without throwing", () => {
    expect(() => validateAuditPayload(null)).not.toThrow();
    expect(validateAuditPayload(null).ok).toBe(false);
  });

  it("surfaces nested path in error (tooling.coverage.configured)", () => {
    const bad = canonicalAudit();
    (bad.tooling.coverage as Record<string, unknown>).configured = "nope";
    const result = validateAuditPayload(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tooling.coverage.configured");
    }
  });
});
