/**
 * Contract tests for `recs-apply` (IMPLEMENTATION_PLAN.md Phase 4 line 88).
 *
 * What is locked:
 *   - Reads `audit.recommendations[]` (NOT candidates) — ADR 0008 single-source
 *     contract for `audit → update`.
 *   - Type matrix:
 *       raise/lower-threshold | add-rule | remove-rule → oxlint preset edit
 *       tighten/loosen-coverage                        → vitest config / jest
 *                                                        JSON config edit
 *       enable-tier | fix-tooling                      → applicable:false
 *                                                        with `delegate` hint
 *   - Reason capture (SPEC §6): loosening kinds (lower-threshold, remove-rule,
 *     loosen-coverage) require `--reason`; tightening kinds accept any value.
 *   - Every successful apply appends an entry between
 *     `<!-- qualy:entries-start -->` and `<!-- qualy:entries-end -->` in
 *     `docs/lint-decisions.md`. Markers preserved, oldest-first.
 *   - `files_changed[]` always includes `docs/lint-decisions.md`. The preset
 *     path is included unless the patch was a no-op (changed=false).
 *   - `--strict` blocks the apply when the working tree is dirty.
 *   - Argv parser covers every flag plus the required `--rec-id`.
 */
import { describe, expect, it } from "vitest";

import {
  type AuditPayload,
  AUDIT_SCHEMA_VERSION,
  type Recommendation,
} from "../../src/lib/audit-schema.ts";
import {
  type RecsApplyDeps,
  APPLICABLE_TYPES,
  ENTRIES_END,
  ENTRIES_START,
  KIND_BY_TYPE,
  REASON_REQUIRED_TYPES,
  appendEntry,
  applyAddRuleToPreset,
  applyRemoveRuleToPreset,
  applyThresholdToPreset,
  parseAddRulePatch,
  parseCoveragePatch,
  parseRecsApplyArgs,
  parseRemoveRulePatch,
  parseThresholdPatch,
  recsApply,
} from "../../src/commands/recs/apply.ts";

const ROOT = "/proj";
const TPL_PATH = "/templates/lint-decisions.md.tpl";

const TEMPLATE_TEXT = [
  "# Lint decisions",
  "",
  "## Entries",
  "",
  ENTRIES_START,
  ENTRIES_END,
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function emptyMetric() {
  return { violations: 0, top: [] };
}

function baseAuditWith(recs: Recommendation[]): AuditPayload {
  return {
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
    rules_active: [],
    recommendations: recs,
  };
}

function lowerThresholdRec(): Recommendation {
  return {
    id: "rec-001",
    type: "lower-threshold",
    title: "wmc max=20 com 6 violações — afrouxar para 28",
    rationale: "Stage permite afrouxar quando max_seen excede teto atual.",
    blast_radius: { files_currently_violating: 6, files_newly_violating: 0 },
    patch: { rule: "quality-metrics/wmc", max: 28 },
    severity: "recommend",
    applies_to: "oxlint.deep.json",
  };
}

function raiseThresholdRec(): Recommendation {
  return {
    id: "rec-002",
    type: "raise-threshold",
    title: "wmc max=20 — apertar para 14",
    rationale: "max_seen está bem abaixo do teto.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { rule: "quality-metrics/wmc", max: 14 },
    severity: "suggest",
    applies_to: "oxlint.deep.json",
  };
}

function addRuleRec(): Recommendation {
  return {
    id: "rec-003",
    type: "add-rule",
    title: "Adicionar quality-metrics/lcom (max=2)",
    rationale: "Stage habilita lcom no preset; ausente em deep.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 1 },
    patch: { rule: "quality-metrics/lcom", max: 2 },
    severity: "recommend",
    applies_to: "oxlint.deep.json",
  };
}

function removeRuleRec(): Recommendation {
  return {
    id: "rec-004",
    type: "remove-rule",
    title: "Remover quality-metrics/dit",
    rationale: "Decisão registrada por user-override.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { rule: "quality-metrics/dit" },
    severity: "recommend",
    applies_to: "oxlint.deep.json",
  };
}

function loosenCoverageRec(): Recommendation {
  return {
    id: "rec-005",
    type: "loosen-coverage",
    title: "vitest.lines=58% abaixo do threshold (70%) — afrouxar para 58%",
    rationale: "Cobertura abaixo do alvo; registrar motivo.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { runner: "vitest", key: "lines", threshold: 58 },
    severity: "recommend",
    applies_to: "vitest.config.ts",
  };
}

function tightenCoverageRec(): Recommendation {
  return {
    id: "rec-006",
    type: "tighten-coverage",
    title: "vitest.lines=82% acima do threshold — apertar para 80%",
    rationale: "Subir threshold já alcançado.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { runner: "vitest", key: "lines", threshold: 80 },
    severity: "suggest",
    applies_to: "vitest.config.ts",
  };
}

function fixToolingRec(): Recommendation {
  return {
    id: "rec-007",
    type: "fix-tooling",
    title: "oxlint não instalado",
    rationale: "Instalar via install-deps.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { applies_to: "package.json", package: "oxlint" },
    severity: "critical",
    applies_to: "package.json",
  };
}

function enableTierRec(): Recommendation {
  return {
    id: "rec-008",
    type: "enable-tier",
    title: "Tier deep ausente",
    rationale: "Habilitar via /lint:setup.",
    blast_radius: { files_currently_violating: 0, files_newly_violating: 0 },
    patch: { applies_to: "oxlint.deep.json" },
    severity: "recommend",
    applies_to: "oxlint.deep.json",
  };
}

const DEEP_PRESET = JSON.stringify(
  {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    _comment: "qualy preset · stage=brownfield-moderate · tier=deep",
    categories: { correctness: "error", suspicious: "warn" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/wmc": ["error", { max: 20 }],
      "quality-metrics/cbo": ["error", { max: 10 }],
      "quality-metrics/dit": ["warn", { max: 5 }],
    },
  },
  null,
  2,
);

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
`;

// ---------------------------------------------------------------------------
// Test deps factory
// ---------------------------------------------------------------------------

interface FakeDepsOpts {
  readonly files?: Record<string, string>;
  readonly templateText?: string;
  readonly author?: string;
  readonly now?: Date;
  readonly dirty?: readonly string[];
}

function fakeDeps(opts: FakeDepsOpts = {}): {
  deps: RecsApplyDeps;
  files: Map<string, string>;
  writes: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const writes = new Map<string, string>();
  files.set(TPL_PATH, opts.templateText ?? TEMPLATE_TEXT);
  const safeIO = {
    readFileFn: (p: string) => files.get(p) ?? null,
    existsFn: (p: string) => files.has(p),
    writeFileFn: (p: string, c: string) => {
      writes.set(p, c);
      files.set(p, c);
    },
    mkdirFn: () => {
      // no-op for in-memory tests
    },
    now: () => opts.now ?? new Date("2026-05-03T15:00:00Z"),
  };
  const deps: RecsApplyDeps = {
    readFileFn: (p) => files.get(p) ?? null,
    existsFn: (p) => files.has(p),
    safeIO,
    authorFn: () => opts.author ?? "alice@example.com",
    now: () => opts.now ?? new Date("2026-05-03T15:00:00Z"),
    templatePath: TPL_PATH,
    dirtyFilesFn: () => ({ ok: true, value: opts.dirty ?? [] }),
  };
  return { deps, files, writes };
}

// ---------------------------------------------------------------------------
// APPLICABLE_TYPES + KIND_BY_TYPE contracts
// ---------------------------------------------------------------------------

describe("APPLICABLE_TYPES & KIND_BY_TYPE", () => {
  it("APPLICABLE_TYPES is exactly the six handled rec types", () => {
    expect([...APPLICABLE_TYPES].sort()).toEqual([
      "add-rule",
      "loosen-coverage",
      "lower-threshold",
      "raise-threshold",
      "remove-rule",
      "tighten-coverage",
    ]);
  });

  it("REASON_REQUIRED_TYPES is exactly the three loosening types (SPEC §6)", () => {
    expect([...REASON_REQUIRED_TYPES].sort()).toEqual([
      "loosen-coverage",
      "lower-threshold",
      "remove-rule",
    ]);
  });

  it("KIND_BY_TYPE maps each rec type to a kind enumerated in the template", () => {
    const allowed = new Set([
      "rule-add",
      "rule-remove",
      "threshold-raise",
      "threshold-lower",
      "coverage-lower",
      "rec-apply",
    ]);
    for (const k of Object.values(KIND_BY_TYPE)) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Patch parsers
// ---------------------------------------------------------------------------

describe("patch parsers", () => {
  it("parseThresholdPatch accepts {rule, max}", () => {
    const r = parseThresholdPatch({ rule: "quality-metrics/wmc", max: 14 });
    expect(r.ok).toBe(true);
  });

  it("parseThresholdPatch rejects missing rule", () => {
    const r = parseThresholdPatch({ max: 14 });
    expect(r.ok).toBe(false);
  });

  it("parseThresholdPatch rejects non-number max", () => {
    const r = parseThresholdPatch({ rule: "x", max: "14" });
    expect(r.ok).toBe(false);
  });

  it("parseAddRulePatch picks up optional severity", () => {
    const r = parseAddRulePatch({
      rule: "quality-metrics/lcom",
      max: 2,
      severity: "warn",
    });
    expect(r.ok && r.value.severity).toBe("warn");
  });

  it("parseRemoveRulePatch requires rule only", () => {
    expect(parseRemoveRulePatch({ rule: "x" }).ok).toBe(true);
    expect(parseRemoveRulePatch({}).ok).toBe(false);
  });

  it("parseCoveragePatch validates runner ∈ {vitest,jest} and key ∈ COVERAGE_KEYS", () => {
    expect(
      parseCoveragePatch({ runner: "vitest", key: "lines", threshold: 80 }).ok,
    ).toBe(true);
    expect(
      parseCoveragePatch({ runner: "mocha", key: "lines", threshold: 80 }).ok,
    ).toBe(false);
    expect(
      parseCoveragePatch({ runner: "vitest", key: "loc", threshold: 80 }).ok,
    ).toBe(false);
    expect(
      parseCoveragePatch({ runner: "vitest", key: "lines", threshold: "80" }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Preset patch helpers
// ---------------------------------------------------------------------------

describe("oxlint preset patch helpers", () => {
  it("applyThresholdToPreset preserves severity and sibling options", () => {
    const preset = JSON.parse(DEEP_PRESET);
    preset.rules["quality-metrics/wmc"] = ["error", { max: 20, allowList: ["legacy/*"] }];
    const r = applyThresholdToPreset(preset, "quality-metrics/wmc", 14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = JSON.parse(r.value.content);
    expect(next.rules["quality-metrics/wmc"]).toEqual([
      "error",
      { max: 14, allowList: ["legacy/*"] },
    ]);
  });

  it("applyThresholdToPreset rejects when rule is absent", () => {
    const preset = JSON.parse(DEEP_PRESET);
    const r = applyThresholdToPreset(preset, "quality-metrics/halstead-volume", 800);
    expect(r.ok).toBe(false);
  });

  it("applyAddRuleToPreset inserts plugins=[quality-metrics] when missing", () => {
    const preset = JSON.parse(DEEP_PRESET);
    delete preset.plugins;
    const r = applyAddRuleToPreset(preset, {
      rule: "quality-metrics/lcom",
      max: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = JSON.parse(r.value.content);
    expect(next.plugins).toEqual(["quality-metrics"]);
    expect(next.rules["quality-metrics/lcom"]).toEqual(["warn", { max: 2 }]);
  });

  it("applyAddRuleToPreset uses provided severity over the default", () => {
    const preset = JSON.parse(DEEP_PRESET);
    const r = applyAddRuleToPreset(preset, {
      rule: "quality-metrics/lcom",
      max: 2,
      severity: "error",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = JSON.parse(r.value.content);
    expect(next.rules["quality-metrics/lcom"]).toEqual(["error", { max: 2 }]);
  });

  it("applyRemoveRuleToPreset deletes the rule key", () => {
    const preset = JSON.parse(DEEP_PRESET);
    const r = applyRemoveRuleToPreset(preset, "quality-metrics/dit");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = JSON.parse(r.value.content);
    expect("quality-metrics/dit" in next.rules).toBe(false);
  });

  it("applyRemoveRuleToPreset rejects when the rule is already absent", () => {
    const preset = JSON.parse(DEEP_PRESET);
    const r = applyRemoveRuleToPreset(preset, "quality-metrics/halstead-volume");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendEntry — markers preserved, content interleaved
// ---------------------------------------------------------------------------

describe("appendEntry", () => {
  it("inserts the entry between the marker pair and keeps both markers exactly once", () => {
    const r = appendEntry(TEMPLATE_TEXT, {
      timestamp: "2026-05-03T15:00:00Z",
      kind: "threshold-lower",
      subject: "quality-metrics/wmc: max=28",
      rule: "quality-metrics/wmc",
      author: "alice@example.com",
      reason: "many violations",
      recommendation_id: "rec-001",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text.match(new RegExp(escapeRegex(ENTRIES_START), "g"))?.length).toBe(1);
    expect(r.text.match(new RegExp(escapeRegex(ENTRIES_END), "g"))?.length).toBe(1);
    expect(r.text).toContain("### 2026-05-03T15:00:00Z — threshold-lower:");
    expect(r.text).toContain("- **kind**: threshold-lower");
    expect(r.text).toContain("- **rule**: quality-metrics/wmc");
    expect(r.text).toContain("- **author**: alice@example.com");
    expect(r.text).toContain("- **reason**: many violations");
    expect(r.text).toContain("- **recommendation_id**: rec-001");
  });

  it("appends successive entries oldest-first", () => {
    const first = appendEntry(TEMPLATE_TEXT, {
      timestamp: "2026-05-03T15:00:00Z",
      kind: "rule-add",
      subject: "x",
      author: "a",
      reason: "(none)",
      recommendation_id: "rec-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendEntry(first.text, {
      timestamp: "2026-05-03T16:00:00Z",
      kind: "rule-remove",
      subject: "y",
      author: "b",
      reason: "noisy",
      recommendation_id: "rec-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const idx1 = second.text.indexOf("rec-1");
    const idx2 = second.text.indexOf("rec-2");
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it("rejects when markers are missing or out of order", () => {
    expect(appendEntry("no markers here", entry()).ok).toBe(false);
    expect(
      appendEntry(`${ENTRIES_END}\nfoo\n${ENTRIES_START}\n`, entry()).ok,
    ).toBe(false);
  });
});

function entry() {
  return {
    timestamp: "2026-05-03T15:00:00Z",
    kind: "rule-add",
    subject: "x",
    author: "a",
    reason: "(none)",
    recommendation_id: "rec-1",
  };
}

// ---------------------------------------------------------------------------
// recsApply — main flow
// ---------------------------------------------------------------------------

describe("recsApply — applicability gates", () => {
  it("returns recommendation_not_found when id is unknown", () => {
    const audit = baseAuditWith([lowerThresholdRec()]);
    const { deps } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-zzz" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("recommendation_not_found");
  });

  it("fix-tooling → applicable:false with delegate=install-deps", () => {
    const audit = baseAuditWith([fixToolingRec()]);
    const { deps } = fakeDeps();
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-007" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || r.applied) return;
    expect(r.delegate).toBe("install-deps");
  });

  it("enable-tier → applicable:false with delegate=/lint:setup", () => {
    const audit = baseAuditWith([enableTierRec()]);
    const { deps } = fakeDeps();
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-008" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || r.applied) return;
    expect(r.delegate).toBe("/lint:setup");
  });

  it("loosening kinds require --reason", () => {
    const audit = baseAuditWith([lowerThresholdRec()]);
    const { deps } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-001" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reason_required");
  });

  it("--strict + dirty tree → dirty_tree", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const { deps } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
      dirty: ["src/foo.ts"],
    });
    const r = recsApply(
      { cwd: ROOT, audit, recId: "rec-002", strict: true },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("dirty_tree");
  });
});

describe("recsApply — oxlint preset edits", () => {
  it("lower-threshold writes preset and appends a coverage-aware entry", () => {
    const audit = baseAuditWith([lowerThresholdRec()]);
    const { deps, files, writes } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply(
      { cwd: ROOT, audit, recId: "rec-001", reason: "muitas violações" },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    expect(r.kind).toBe("threshold-lower");
    expect(r.files_changed).toContain("oxlint.deep.json");
    expect(r.files_changed).toContain("docs/lint-decisions.md");

    const presetWrite = writes.get(`${ROOT}/oxlint.deep.json`);
    expect(presetWrite).toBeDefined();
    const presetJson = JSON.parse(presetWrite as string);
    expect(presetJson.rules["quality-metrics/wmc"]).toEqual(["error", { max: 28 }]);
    expect(presetJson.rules["quality-metrics/cbo"]).toEqual(["error", { max: 10 }]);

    const decisions = files.get(`${ROOT}/docs/lint-decisions.md`);
    expect(decisions).toContain("- **kind**: threshold-lower");
    expect(decisions).toContain("- **rule**: quality-metrics/wmc");
    expect(decisions).toContain("- **reason**: muitas violações");
    expect(decisions).toContain("- **recommendation_id**: rec-001");
  });

  it("raise-threshold (no --reason needed) tightens max and records the entry", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const { deps, writes } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    expect(r.kind).toBe("threshold-raise");
    const presetJson = JSON.parse(writes.get(`${ROOT}/oxlint.deep.json`) as string);
    expect(presetJson.rules["quality-metrics/wmc"]).toEqual(["error", { max: 14 }]);
  });

  it("add-rule inserts the rule and ensures plugins[]", () => {
    const audit = baseAuditWith([addRuleRec()]);
    const { deps, writes } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-003" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    const presetJson = JSON.parse(writes.get(`${ROOT}/oxlint.deep.json`) as string);
    expect(presetJson.rules["quality-metrics/lcom"]).toEqual(["warn", { max: 2 }]);
    expect(presetJson.plugins).toContain("quality-metrics");
  });

  it("remove-rule deletes the rule when --reason is provided", () => {
    const audit = baseAuditWith([removeRuleRec()]);
    const { deps, writes, files } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply(
      { cwd: ROOT, audit, recId: "rec-004", reason: "rule muito ruidosa" },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    const presetJson = JSON.parse(writes.get(`${ROOT}/oxlint.deep.json`) as string);
    expect("quality-metrics/dit" in presetJson.rules).toBe(false);
    const decisions = files.get(`${ROOT}/docs/lint-decisions.md`);
    expect(decisions).toContain("- **kind**: rule-remove");
    expect(decisions).toContain("- **reason**: rule muito ruidosa");
  });

  it("preset_missing surfaces when the file is not readable", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const { deps } = fakeDeps();
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
  });

  it("preset_malformed surfaces when JSON is broken", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const { deps } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: "{ not json" },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });

  it("patch_invalid surfaces when raise/lower targets an absent rule", () => {
    const audit = baseAuditWith([
      {
        ...raiseThresholdRec(),
        patch: { rule: "quality-metrics/halstead-volume", max: 800 },
      },
    ]);
    const { deps } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("patch_invalid");
  });
});

describe("recsApply — coverage edits", () => {
  it("loosen-coverage edits vitest config and records coverage-lower entry", () => {
    const audit = baseAuditWith([loosenCoverageRec()]);
    const { deps, writes, files } = fakeDeps({
      files: { [`${ROOT}/vitest.config.ts`]: VITEST_CONFIG },
    });
    const r = recsApply(
      {
        cwd: ROOT,
        audit,
        recId: "rec-005",
        reason: "rebaseline pós migração",
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    expect(r.kind).toBe("coverage-lower");
    const updated = writes.get(`${ROOT}/vitest.config.ts`) ?? "";
    expect(updated).toContain("lines: 58");
    expect(updated).toContain("functions: 70"); // siblings preserved
    const decisions = files.get(`${ROOT}/docs/lint-decisions.md`);
    expect(decisions).toContain("- **kind**: coverage-lower");
    expect(decisions).toContain("- **reason**: rebaseline pós migração");
  });

  it("tighten-coverage applies without --reason and records rec-apply kind", () => {
    const audit = baseAuditWith([tightenCoverageRec()]);
    const { deps, writes } = fakeDeps({
      files: { [`${ROOT}/vitest.config.ts`]: VITEST_CONFIG },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-006" }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    expect(r.kind).toBe("rec-apply");
    expect((writes.get(`${ROOT}/vitest.config.ts`) ?? "")).toContain("lines: 80");
  });

  it("config_missing surfaces when no vitest config exists", () => {
    const audit = baseAuditWith([loosenCoverageRec()]);
    const { deps } = fakeDeps();
    const r = recsApply(
      { cwd: ROOT, audit, recId: "rec-005", reason: "x" },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("config_missing");
  });

  it("jest path edits jest.config.json when present", () => {
    const jestRec: Recommendation = {
      ...loosenCoverageRec(),
      id: "rec-009",
      patch: { runner: "jest", key: "lines", threshold: 55 },
      applies_to: "jest.config.json",
    };
    const initial = JSON.stringify(
      { coverageThreshold: { global: { lines: 70, functions: 70 } } },
      null,
      2,
    );
    const audit = baseAuditWith([jestRec]);
    const { deps, writes } = fakeDeps({
      files: { [`${ROOT}/jest.config.json`]: initial },
    });
    const r = recsApply(
      { cwd: ROOT, audit, recId: "rec-009", reason: "x" },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.applied) return;
    const next = JSON.parse(writes.get(`${ROOT}/jest.config.json`) as string);
    expect(next.coverageThreshold.global.lines).toBe(55);
    expect(next.coverageThreshold.global.functions).toBe(70);
  });
});

describe("recsApply — decisions log behaviour", () => {
  it("creates docs/lint-decisions.md from template when missing", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const { deps, files } = fakeDeps({
      files: { [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET },
    });
    expect(files.has(`${ROOT}/docs/lint-decisions.md`)).toBe(false);
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(true);
    const decisions = files.get(`${ROOT}/docs/lint-decisions.md`);
    expect(decisions).toBeDefined();
    expect(decisions).toContain(ENTRIES_START);
    expect(decisions).toContain(ENTRIES_END);
    expect(decisions).toContain("- **kind**: threshold-raise");
  });

  it("decisions_failed when template is missing AND file does not exist", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const files = new Map<string, string>([
      [`${ROOT}/oxlint.deep.json`, DEEP_PRESET],
    ]);
    const writes = new Map<string, string>();
    const safeIO = {
      readFileFn: (p: string) => files.get(p) ?? null,
      existsFn: (p: string) => files.has(p),
      writeFileFn: (p: string, c: string) => {
        writes.set(p, c);
        files.set(p, c);
      },
      mkdirFn: () => undefined,
      now: () => new Date("2026-05-03T15:00:00Z"),
    };
    const deps: RecsApplyDeps = {
      readFileFn: (p) => files.get(p) ?? null,
      existsFn: (p) => files.has(p),
      safeIO,
      authorFn: () => "alice@example.com",
      now: () => new Date("2026-05-03T15:00:00Z"),
      templatePath: "/no/such/template.md.tpl",
    };
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("decisions_failed");
  });

  it("decisions_failed when existing file has malformed markers", () => {
    const audit = baseAuditWith([raiseThresholdRec()]);
    const broken = "# Lint decisions\n\n## Entries\n\nno markers anywhere\n";
    const { deps } = fakeDeps({
      files: {
        [`${ROOT}/oxlint.deep.json`]: DEEP_PRESET,
        [`${ROOT}/docs/lint-decisions.md`]: broken,
      },
    });
    const r = recsApply({ cwd: ROOT, audit, recId: "rec-002" }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("decisions_failed");
  });
});

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

describe("parseRecsApplyArgs", () => {
  it("requires --rec-id", () => {
    const r = parseRecsApplyArgs([], "/cwd");
    expect(r.ok).toBe(false);
  });

  it("happy path with all flags", () => {
    const r = parseRecsApplyArgs(
      [
        "--rec-id",
        "rec-001",
        "--audit",
        ".lint-audit/2026-05-03T14-22-11Z.json",
        "--reason",
        "noisy",
        "--cwd",
        "/proj",
        "--strict",
      ],
      "/cwd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recId).toBe("rec-001");
    expect(r.value.auditPath).toBe(".lint-audit/2026-05-03T14-22-11Z.json");
    expect(r.value.reason).toBe("noisy");
    expect(r.value.strict).toBe(true);
  });

  it("--reason accepts empty string (parser-level)", () => {
    const r = parseRecsApplyArgs(
      ["--rec-id", "rec-001", "--reason", ""],
      "/cwd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reason).toBe("");
  });

  it("rejects missing values for paired flags", () => {
    expect(parseRecsApplyArgs(["--rec-id"], "/cwd").ok).toBe(false);
    expect(
      parseRecsApplyArgs(["--rec-id", "rec-001", "--audit"], "/cwd").ok,
    ).toBe(false);
    expect(
      parseRecsApplyArgs(["--rec-id", "rec-001", "--cwd"], "/cwd").ok,
    ).toBe(false);
  });

  it("--help returns sentinel error 'help'", () => {
    const r = parseRecsApplyArgs(["--help"], "/cwd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });

  it("rejects unknown flags", () => {
    expect(
      parseRecsApplyArgs(["--rec-id", "rec-001", "--zonk"], "/cwd").ok,
    ).toBe(false);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
