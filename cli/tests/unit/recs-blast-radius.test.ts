/**
 * Contract tests for `recs-blast-radius` (IMPLEMENTATION_PLAN.md Phase 4 line 87).
 *
 * What is locked:
 *   - Skip path for non-applicable candidate types: fix-tooling,
 *     tighten-coverage, loosen-coverage, enable-tier → applicable: false
 *     with a reason (SPEC §6 Always — show blast_radius before applying;
 *     non-measurable types must still terminate gracefully).
 *   - Patch application:
 *       raise/lower-threshold rewrites `rules[rule]` preserving severity and
 *       sibling options; add-rule inserts the rule and ensures
 *       `plugins[]` carries "quality-metrics" when the rule is in that
 *       namespace.
 *   - Diagnostic parsing accepts JSON array, `{ diagnostics: [] }`, and NDJSON.
 *   - Counting: `files_currently_violating` = unique files in current run;
 *     `files_newly_violating` = files in proposed but not current;
 *     `files_no_longer_violating` = files in current but not proposed.
 *   - oxlint binary missing → `oxlint_missing` (MISSING_DEPENDENCY).
 *   - Argv parser covers every flag plus the required `--candidate-id`.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type AuditPayload,
  AUDIT_SCHEMA_VERSION,
  type RuleActive,
} from "../../src/lib/audit-schema.ts";
import {
  type BlastRadiusDeps,
  type BlastRadiusOptions,
  APPLICABLE_TYPES,
  applyPatch,
  blastRadius,
  parseRecsBlastRadiusArgs,
  violatingFiles,
} from "../../src/commands/recs/blast-radius.ts";
import type { Candidate } from "../../src/commands/recs/generate.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function emptyMetric() {
  return { violations: 0, top: [] };
}

function brownfieldDeepRules(): RuleActive[] {
  const origin = "preset:brownfield-moderate:deep";
  return [
    { rule: "quality-metrics/wmc", severity: "error", options: { max: 20 }, origin },
    { rule: "quality-metrics/cbo", severity: "error", options: { max: 10 }, origin },
  ];
}

function baseAudit(): AuditPayload {
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
    rules_active: brownfieldDeepRules(),
    recommendations: [],
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
    },
  },
  null,
  2,
);

const FAST_PRESET_NO_PLUGINS = JSON.stringify(
  {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    _comment: "qualy preset · stage=brownfield-moderate · tier=fast",
    categories: { correctness: "error", suspicious: "warn" },
  },
  null,
  2,
);

function lowerThresholdCandidate(): Candidate {
  return {
    id: "rec-lower-threshold-wmc-deep",
    type: "lower-threshold",
    title: "wmc max está em 20 — afrouxar para 28",
    rationale_stub: "stub",
    evidence: { metric: "wmc", current_max: 20, max_seen: 31, violations: 5 },
    suggested_change: { applies_to: "oxlint.deep.json", rule: "quality-metrics/wmc", max: 28 },
    blast_radius: { files_currently_violating: 5, files_newly_violating: null },
    severity: "recommend",
    applies_to: "oxlint.deep.json",
  };
}

function raiseThresholdCandidate(): Candidate {
  return {
    id: "rec-raise-threshold-wmc-deep",
    type: "raise-threshold",
    title: "wmc max está em 20 — apertar para 14",
    rationale_stub: "stub",
    evidence: { metric: "wmc", current_max: 20, max_seen: 12 },
    suggested_change: { applies_to: "oxlint.deep.json", rule: "quality-metrics/wmc", max: 14 },
    blast_radius: { files_currently_violating: 0, files_newly_violating: null },
    severity: "suggest",
    applies_to: "oxlint.deep.json",
  };
}

function addRuleCandidate(presetFile = "oxlint.fast.json"): Candidate {
  return {
    id: "rec-add-rule-quality-metrics-lcom-deep",
    type: "add-rule",
    title: "Adicionar regra quality-metrics/lcom",
    rationale_stub: "stub",
    evidence: { rule: "quality-metrics/lcom", proposed_value: 2 },
    suggested_change: { applies_to: presetFile, rule: "quality-metrics/lcom", max: 2 },
    blast_radius: { files_currently_violating: 0, files_newly_violating: null },
    severity: "recommend",
    applies_to: presetFile,
  };
}

function fixToolingCandidate(): Candidate {
  return {
    id: "rec-fix-tooling-oxlint",
    type: "fix-tooling",
    title: "oxlint não instalado",
    rationale_stub: "stub",
    evidence: { package: "oxlint", installed: false },
    suggested_change: { applies_to: "package.json", package: "oxlint" },
    blast_radius: { files_currently_violating: 0, files_newly_violating: null },
    severity: "critical",
    applies_to: "package.json",
  };
}

// ---------------------------------------------------------------------------
// Test deps factory
// ---------------------------------------------------------------------------

interface RunCall {
  binary: string;
  args: readonly string[];
  cwd: string;
}

interface FakeDepsOptions {
  files?: Record<string, string>;
  /** Map config-arg → diagnostics JSON to return as stdout. */
  byConfig?: Record<string, string>;
  defaultStdout?: string;
  ok?: boolean;
  stderr?: string;
}

function fakeDeps(opts: FakeDepsOptions = {}): {
  deps: BlastRadiusDeps;
  calls: RunCall[];
  writes: Map<string, string>;
  removes: string[];
} {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const writes = new Map<string, string>();
  const removes: string[] = [];
  const calls: RunCall[] = [];

  let tmpCounter = 0;

  const deps: BlastRadiusDeps = {
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      writes.set(p, c);
    },
    mkdtempFn: (prefix) => {
      tmpCounter++;
      return `${prefix}fake${tmpCounter}`;
    },
    removeFn: (p) => {
      removes.push(p);
    },
    runFn: (binary, args, cwd) => {
      calls.push({ binary, args: [...args], cwd });
      const cfgIdx = args.indexOf("--config");
      const cfg = cfgIdx >= 0 ? args[cfgIdx + 1] : "";
      const stdout = opts.byConfig?.[cfg] ?? opts.defaultStdout ?? "[]";
      return {
        ok: opts.ok ?? true,
        stdout,
        stderr: opts.stderr ?? "",
        exitCode: 0,
      };
    },
  };

  return { deps, calls, writes, removes };
}

// ---------------------------------------------------------------------------
// APPLICABLE_TYPES contract
// ---------------------------------------------------------------------------

describe("APPLICABLE_TYPES", () => {
  it("includes the three preset-affecting candidate types only", () => {
    expect([...APPLICABLE_TYPES].sort()).toEqual([
      "add-rule",
      "lower-threshold",
      "raise-threshold",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Skip path for non-applicable types
// ---------------------------------------------------------------------------

describe("blastRadius — non-applicable types", () => {
  it("fix-tooling → applicable:false with reason mentioning the type", () => {
    const { deps, calls } = fakeDeps();
    const r = blastRadius(
      { cwd: ROOT, audit: baseAudit(), candidate: fixToolingCandidate() },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.applicable) throw new Error("expected applicable:false");
    expect(r.candidate_id).toBe("rec-fix-tooling-oxlint");
    expect(r.reason).toContain("fix-tooling");
    expect(calls).toHaveLength(0);
  });

  it("tighten-coverage → applicable:false (vitest config, not measurable)", () => {
    const { deps } = fakeDeps();
    const candidate: Candidate = {
      id: "rec-tighten-coverage-vitest-lines",
      type: "tighten-coverage",
      title: "tighten",
      rationale_stub: "stub",
      evidence: {},
      suggested_change: { applies_to: "vitest.config.ts" },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "suggest",
      applies_to: "vitest.config.ts",
    };
    const r = blastRadius({ cwd: ROOT, audit: baseAudit(), candidate }, deps);
    if (!r.ok || r.applicable) throw new Error("expected applicable:false");
    expect(r.reason).toContain("tighten-coverage");
  });

  it("enable-tier → applicable:false even though applies_to is a preset file", () => {
    const { deps } = fakeDeps();
    const candidate: Candidate = {
      id: "rec-enable-tier-deep",
      type: "enable-tier",
      title: "enable",
      rationale_stub: "stub",
      evidence: {},
      suggested_change: { applies_to: "oxlint.deep.json" },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "recommend",
      applies_to: "oxlint.deep.json",
    };
    const r = blastRadius({ cwd: ROOT, audit: baseAudit(), candidate }, deps);
    if (!r.ok || r.applicable) throw new Error("expected applicable:false");
    expect(r.reason).toContain("enable-tier");
  });
});

// ---------------------------------------------------------------------------
// applyPatch unit
// ---------------------------------------------------------------------------

describe("applyPatch", () => {
  it("lower-threshold rewrites max while preserving severity and sibling options", () => {
    const current = {
      rules: {
        "quality-metrics/wmc": ["error", { max: 20, allowList: ["foo"] }],
      },
    };
    const r = applyPatch(current, lowerThresholdCandidate());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rules?.["quality-metrics/wmc"]).toEqual([
      "error",
      { max: 28, allowList: ["foo"] },
    ]);
    // Original must not mutate.
    expect(current.rules["quality-metrics/wmc"]).toEqual([
      "error",
      { max: 20, allowList: ["foo"] },
    ]);
  });

  it("raise-threshold tightens an error rule and keeps severity", () => {
    const current = {
      rules: {
        "quality-metrics/wmc": ["error", { max: 20 }],
      },
    };
    const r = applyPatch(current, raiseThresholdCandidate());
    if (!r.ok) throw new Error(`unexpected: ${r.error}`);
    expect(r.value.rules?.["quality-metrics/wmc"]).toEqual(["error", { max: 14 }]);
  });

  it("threshold change on absent rule → patch_invalid (heuristic invariant)", () => {
    const current = { rules: {} };
    const r = applyPatch(current, lowerThresholdCandidate());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("patch_invalid");
    expect(r.reason).toContain("absent");
  });

  it("add-rule inserts rule with default warn severity", () => {
    const current = {
      plugins: ["quality-metrics"],
      rules: { "quality-metrics/wmc": ["error", { max: 20 }] },
    };
    const r = applyPatch(current, addRuleCandidate());
    if (!r.ok) throw new Error(`unexpected: ${r.error}`);
    expect(r.value.rules?.["quality-metrics/lcom"]).toEqual(["warn", { max: 2 }]);
    // Existing rule untouched.
    expect(r.value.rules?.["quality-metrics/wmc"]).toEqual(["error", { max: 20 }]);
  });

  it("add-rule appends quality-metrics plugin when missing", () => {
    const current = { rules: {} }; // no plugins field
    const r = applyPatch(current, addRuleCandidate());
    if (!r.ok) throw new Error(`unexpected: ${r.error}`);
    expect(r.value.plugins).toEqual(["quality-metrics"]);
  });

  it("add-rule does not duplicate quality-metrics in plugins[]", () => {
    const current = { plugins: ["quality-metrics", "import"], rules: {} };
    const r = applyPatch(current, addRuleCandidate());
    if (!r.ok) throw new Error(`unexpected: ${r.error}`);
    expect(r.value.plugins).toEqual(["quality-metrics", "import"]);
  });

  it("add-rule with non-quality-metrics rule does NOT touch plugins", () => {
    const current = { rules: {} };
    const candidate: Candidate = {
      ...addRuleCandidate(),
      suggested_change: {
        applies_to: "oxlint.fast.json",
        rule: "correctness/no-debugger",
        max: 0,
      },
    };
    const r = applyPatch(current, candidate);
    if (!r.ok) throw new Error(`unexpected: ${r.error}`);
    expect(r.value.plugins).toBeUndefined();
    expect(r.value.rules?.["correctness/no-debugger"]).toEqual(["warn", { max: 0 }]);
  });

  it("missing rule/max in suggested_change → patch_invalid", () => {
    const current = { rules: {} };
    const candidate: Candidate = {
      ...addRuleCandidate(),
      suggested_change: { applies_to: "oxlint.deep.json" },
    };
    const r = applyPatch(current, candidate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("patch_invalid");
  });
});

// ---------------------------------------------------------------------------
// violatingFiles parser
// ---------------------------------------------------------------------------

describe("violatingFiles", () => {
  it("empty stdout → empty set", () => {
    expect(violatingFiles("")).toEqual(new Set());
    expect(violatingFiles("   \n  ")).toEqual(new Set());
  });

  it("JSON array of diagnostics — dedupes by file path", () => {
    const raw = JSON.stringify([
      { filename: "src/a.ts", severity: "error", rule: "x" },
      { filename: "src/b.ts", severity: "warning", rule: "y" },
      { filename: "src/a.ts", severity: "error", rule: "z" },
    ]);
    expect([...violatingFiles(raw)].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("`{ diagnostics: [] }` envelope is honored", () => {
    const raw = JSON.stringify({
      diagnostics: [
        { file: "src/c.ts", severity: "error", rule: "x" },
        { file: "src/d.ts", severity: "warning", rule: "y" },
      ],
    });
    expect([...violatingFiles(raw)].sort()).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("NDJSON fallback when top-level parse fails", () => {
    const raw = [
      JSON.stringify({ filename: "a.ts", severity: "error" }),
      JSON.stringify({ filename: "b.ts", severity: "warn" }),
      "garbage line",
      JSON.stringify({ path: "c.ts", severity: "warn" }),
    ].join("\n");
    expect([...violatingFiles(raw)].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("falls back across filename → file → path keys", () => {
    const raw = JSON.stringify([
      { filename: "a.ts" },
      { file: "b.ts" },
      { path: "c.ts" },
      { somethingElse: "ignored" },
    ]);
    expect([...violatingFiles(raw)].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

// ---------------------------------------------------------------------------
// blastRadius main flow
// ---------------------------------------------------------------------------

describe("blastRadius — measurement", () => {
  function setup(
    candidate: Candidate,
    presetFile: string,
    presetContent: string,
    runs: { current: string; proposed: string },
  ) {
    const presetPath = `${ROOT}${sep}${presetFile}`;
    const { deps, calls, writes, removes } = fakeDeps({
      files: { [presetPath]: presetContent },
      byConfig: {},
    });
    // Re-bind runFn to map by argv: the proposed path is generated dynamically
    // (mkdtempFn returns a deterministic stub). Capture both calls and key by
    // call index instead of argv.
    let n = 0;
    deps.runFn = (binary, args, cwd) => {
      calls.push({ binary, args: [...args], cwd });
      const idx = n++;
      const stdout = idx === 0 ? runs.current : runs.proposed;
      return { ok: true, stdout, stderr: "", exitCode: 0 };
    };
    const opts: BlastRadiusOptions = { cwd: ROOT, audit: baseAudit(), candidate };
    const result = blastRadius(opts, deps);
    return { result, calls, writes, removes };
  }

  it("counts current/newly/no-longer for a lower-threshold candidate", () => {
    const current = JSON.stringify([
      { filename: "src/a.ts", rule: "quality-metrics/wmc" },
      { filename: "src/b.ts", rule: "quality-metrics/wmc" },
      { filename: "src/c.ts", rule: "quality-metrics/wmc" },
    ]);
    // Proposed (max raised from 20 → 28): 'a' and 'b' drop out, 'c' stays;
    // a brand-new 'src/d.ts' starts violating because we modified options.
    const proposed = JSON.stringify([
      { filename: "src/c.ts", rule: "quality-metrics/wmc" },
      { filename: "src/d.ts", rule: "quality-metrics/wmc" },
    ]);
    const { result, calls, writes, removes } = setup(
      lowerThresholdCandidate(),
      "oxlint.deep.json",
      DEEP_PRESET,
      { current, proposed },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.applicable) throw new Error("expected applicable:true");
    expect(result.applies_to).toBe("oxlint.deep.json");
    expect(result.blast_radius).toEqual({
      files_currently_violating: 3,
      files_newly_violating: 1,
      files_no_longer_violating: 2,
    });
    // Two oxlint runs.
    expect(calls).toHaveLength(2);
    expect(calls[0].binary).toBe("oxlint");
    expect(calls[0].args.slice(0, 2)).toEqual(["--config", `${ROOT}${sep}oxlint.deep.json`]);
    expect(calls[0].args.slice(-3)).toEqual(["--format", "json", "."]);
    // Second run uses the tmp-written proposed config.
    const proposedCfgArg = calls[1].args[1];
    expect(proposedCfgArg.endsWith("oxlint.deep.json")).toBe(true);
    expect(writes.has(proposedCfgArg)).toBe(true);
    // Cleanup attempted on the tmp dir.
    expect(removes.length).toBeGreaterThanOrEqual(1);
  });

  it("identical violation sets → all deltas zero", () => {
    const fixed = JSON.stringify([
      { filename: "src/a.ts", rule: "quality-metrics/wmc" },
      { filename: "src/b.ts", rule: "quality-metrics/wmc" },
    ]);
    const { result } = setup(
      lowerThresholdCandidate(),
      "oxlint.deep.json",
      DEEP_PRESET,
      { current: fixed, proposed: fixed },
    );
    if (!result.ok || !result.applicable) throw new Error("expected applicable:true");
    expect(result.blast_radius).toEqual({
      files_currently_violating: 2,
      files_newly_violating: 0,
      files_no_longer_violating: 0,
    });
  });

  it("add-rule on fast preset writes a tmp config that includes the plugin", () => {
    const { result, writes } = setup(
      addRuleCandidate("oxlint.fast.json"),
      "oxlint.fast.json",
      FAST_PRESET_NO_PLUGINS,
      { current: "[]", proposed: JSON.stringify([{ filename: "src/x.ts" }]) },
    );
    if (!result.ok || !result.applicable) throw new Error("expected applicable:true");
    // Find the tmp file content.
    const writtenContents = [...writes.values()];
    expect(writtenContents).toHaveLength(1);
    const proposedRaw = writtenContents[0];
    const proposedObj = JSON.parse(proposedRaw) as {
      plugins?: unknown;
      rules?: Record<string, unknown>;
    };
    expect(proposedObj.plugins).toEqual(["quality-metrics"]);
    expect(proposedObj.rules?.["quality-metrics/lcom"]).toEqual(["warn", { max: 2 }]);
    expect(result.blast_radius).toEqual({
      files_currently_violating: 0,
      files_newly_violating: 1,
      files_no_longer_violating: 0,
    });
  });

  it("preset missing → preset_missing error", () => {
    const { deps } = fakeDeps();
    const r = blastRadius(
      { cwd: ROOT, audit: baseAudit(), candidate: lowerThresholdCandidate() },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
  });

  it("preset malformed → preset_malformed error (no oxlint runs)", () => {
    const { deps, calls } = fakeDeps({
      files: { [`${ROOT}${sep}oxlint.deep.json`]: "{ not json" },
    });
    const r = blastRadius(
      { cwd: ROOT, audit: baseAudit(), candidate: lowerThresholdCandidate() },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
    expect(calls).toHaveLength(0);
  });

  it("oxlint binary missing on first run → oxlint_missing", () => {
    const presetPath = `${ROOT}${sep}oxlint.deep.json`;
    const { deps, calls } = fakeDeps({
      files: { [presetPath]: DEEP_PRESET },
    });
    deps.runFn = (binary, args, cwd) => {
      calls.push({ binary, args: [...args], cwd });
      return { ok: false, stdout: "", stderr: "command not found", exitCode: 127 };
    };
    const r = blastRadius(
      { cwd: ROOT, audit: baseAudit(), candidate: lowerThresholdCandidate() },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("oxlint_missing");
    expect(r.reason).toContain("command not found");
  });

  it("non-applicable preset path on a threshold candidate → applicable:false", () => {
    const { deps } = fakeDeps();
    const candidate: Candidate = {
      ...lowerThresholdCandidate(),
      suggested_change: {
        applies_to: "oxlint.weird.json",
        rule: "quality-metrics/wmc",
        max: 28,
      },
      applies_to: "oxlint.weird.json",
    };
    const r = blastRadius({ cwd: ROOT, audit: baseAudit(), candidate }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || r.applicable) throw new Error("expected applicable:false");
    expect(r.reason).toContain("oxlint.weird.json");
  });

  it("propagates oxlintBin override into the runFn binary argument", () => {
    const presetPath = `${ROOT}${sep}oxlint.deep.json`;
    const { deps, calls } = fakeDeps({
      files: { [presetPath]: DEEP_PRESET },
      defaultStdout: "[]",
    });
    blastRadius(
      {
        cwd: ROOT,
        audit: baseAudit(),
        candidate: lowerThresholdCandidate(),
        oxlintBin: "/custom/oxlint",
      },
      deps,
    );
    expect(calls.every((c) => c.binary === "/custom/oxlint")).toBe(true);
  });

  it("tmp dir is removed after measurement (best-effort cleanup)", () => {
    const presetPath = `${ROOT}${sep}oxlint.deep.json`;
    const { deps, removes } = fakeDeps({
      files: { [presetPath]: DEEP_PRESET },
      defaultStdout: "[]",
    });
    blastRadius(
      { cwd: ROOT, audit: baseAudit(), candidate: lowerThresholdCandidate() },
      deps,
    );
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatch(/qualy-blast-/);
  });
});

// ---------------------------------------------------------------------------
// parseRecsBlastRadiusArgs
// ---------------------------------------------------------------------------

describe("parseRecsBlastRadiusArgs", () => {
  it("requires --candidate-id", () => {
    const r = parseRecsBlastRadiusArgs([], "/p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--candidate-id");
  });

  it("parses --candidate-id with default cwd", () => {
    const r = parseRecsBlastRadiusArgs(["--candidate-id", "rec-foo"], "/p");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidateId).toBe("rec-foo");
    expect(r.value.cwd).toBe("/p");
    expect(r.value.oxlintBin).toBeUndefined();
  });

  it("parses --cwd, --candidate-id, --oxlint-bin together", () => {
    const r = parseRecsBlastRadiusArgs(
      ["--cwd", "/work", "--candidate-id", "rec-x", "--oxlint-bin", "/usr/bin/oxlint"],
      "/p",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toContain("/work");
    expect(r.value.candidateId).toBe("rec-x");
    expect(r.value.oxlintBin).toBe("/usr/bin/oxlint");
  });

  it("missing value for --candidate-id is rejected", () => {
    const r = parseRecsBlastRadiusArgs(["--candidate-id"], "/p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("missing value");
  });

  it("missing value for --cwd is rejected", () => {
    const r = parseRecsBlastRadiusArgs(["--cwd"], "/p");
    expect(r.ok).toBe(false);
  });

  it("--help → error 'help' (handled at runner level)", () => {
    const r = parseRecsBlastRadiusArgs(["--help"], "/p");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });

  it("unknown flag is rejected", () => {
    const r = parseRecsBlastRadiusArgs(
      ["--candidate-id", "rec-foo", "--zonk"],
      "/p",
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });
});
