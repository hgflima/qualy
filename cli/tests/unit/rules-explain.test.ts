/**
 * Contract tests for `rules-explain` (IMPLEMENTATION_PLAN.md Phase 5).
 *
 * Locks the SPEC §2 `/lint:rules:explain <rule>` contract:
 *   - Output carries title, description, rationale, current threshold (if
 *     installed), stage default (if stage detected), and docs links.
 *   - `current` is read from the project's preset files; `null` when the rule
 *     is not present in any preset.
 *   - `default_for_stage` is the baseline entry for the stage detected from
 *     the preset's `_comment`.
 *   - Unknown rules return `unknown_rule` (RECOVERABLE_ERROR), not a crash.
 *   - Rule may be passed via `--rule` flag or as positional first arg.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  catalogedRules,
  parseRulesExplainArgs,
  type RulesExplainDeps,
  rulesExplain,
} from "../../src/commands/rules/explain.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

interface FakeFS {
  readonly files: Record<string, string>;
}

function fsDeps(fs: FakeFS): RulesExplainDeps {
  return {
    existsFn: (p) => Object.prototype.hasOwnProperty.call(fs.files, p),
    readFileFn: (p) =>
      Object.prototype.hasOwnProperty.call(fs.files, p) ? fs.files[p] : null,
  };
}

function greenfieldDeepPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=deep",
    categories: { correctness: "error", suspicious: "warn" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/wmc": ["error", { max: 15 }],
      "quality-metrics/cbo": ["error", { max: 8 }],
    },
  });
}

function brownfieldDeepPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=brownfield-moderate · tier=deep",
    categories: { correctness: "error" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/wmc": ["error", { max: 20 }],
      "quality-metrics/cbo": ["error", { max: 10 }],
      "quality-metrics/dit": ["warn", { max: 5 }],
      "correctness/no-debugger": "off",
    },
  });
}

function greenfieldFastPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=fast",
    categories: { correctness: "error", suspicious: "warn" },
  });
}

// ---------------------------------------------------------------------------
// Catalog completeness
// ---------------------------------------------------------------------------

describe("catalogedRules — coverage", () => {
  it("includes all 6 quality-metrics rules", () => {
    const cat = catalogedRules();
    expect(cat).toContain("quality-metrics/wmc");
    expect(cat).toContain("quality-metrics/halstead-volume");
    expect(cat).toContain("quality-metrics/halstead-effort");
    expect(cat).toContain("quality-metrics/lcom");
    expect(cat).toContain("quality-metrics/cbo");
    expect(cat).toContain("quality-metrics/dit");
  });

  it("includes oxlint correctness and suspicious categories", () => {
    const cat = catalogedRules();
    expect(cat).toContain("category:correctness");
    expect(cat).toContain("category:suspicious");
  });
});

// ---------------------------------------------------------------------------
// Happy path — rule present in preset
// ---------------------------------------------------------------------------

describe("rulesExplain — current state from preset", () => {
  it("returns ok with current threshold matching project's deep preset", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).toBe("quality-metrics/wmc");
    expect(r.category).toBe("quality-metrics");
    expect(r.current).toEqual({
      stage: "greenfield",
      tier: "deep",
      severity: "error",
      options: { max: 15 },
      origin: "preset:greenfield:deep",
    });
  });

  it("provides default_for_stage matching the detected stage baseline", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: brownfieldDeepPreset(),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/cbo" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.default_for_stage).toEqual({
      stage: "brownfield-moderate",
      severity: "error",
      max: 10,
    });
  });

  it("includes title, description, rationale, and links", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toMatch(/Weighted Methods/i);
    expect(r.description.length).toBeGreaterThan(20);
    expect(r.rationale.length).toBeGreaterThan(20);
    expect(r.links.length).toBeGreaterThan(0);
    expect(r.links).toContain("https://github.com/hgflima/quality-metrics");
  });

  it("scans both fast and deep tiers; deep wins when rule appears in only one", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: greenfieldFastPreset(),
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current?.tier).toBe("deep");
  });

  it("fast tier wins when rule is present there (first match)", () => {
    // Synthetic: rule exists only in fast tier
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: JSON.stringify({
          _comment: "stage=greenfield · tier=fast",
          rules: { "quality-metrics/cbo": ["warn", { max: 6 }] },
        }),
        [pathJoin(ROOT, "oxlint.deep.json")]: JSON.stringify({
          _comment: "stage=greenfield · tier=deep",
          categories: { correctness: "error" },
        }),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/cbo" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current?.tier).toBe("fast");
    expect(r.current?.severity).toBe("warn");
    expect(r.current?.options).toEqual({ max: 6 });
    expect(r.current?.origin).toBe("preset:greenfield:fast");
  });

  it("origin lacks stage tag when _comment has no stage=", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: JSON.stringify({
          rules: { "quality-metrics/wmc": ["error", { max: 12 }] },
        }),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current?.stage).toBeNull();
    expect(r.current?.origin).toBe("preset:deep");
    // Without stage, default cannot be looked up.
    expect(r.default_for_stage).toBeNull();
  });

  it("classifies disabled rules as current with severity=off", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: brownfieldDeepPreset(),
      },
    };
    const r = rulesExplain(
      { cwd: ROOT, rule: "category:correctness" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current?.severity).toBe("error");
    expect(r.category).toBe("category");
  });
});

// ---------------------------------------------------------------------------
// current=null paths (rule absent from preset / preset missing)
// ---------------------------------------------------------------------------

describe("rulesExplain — current=null paths", () => {
  it("returns current=null when no preset is present, but stays ok", () => {
    const fs: FakeFS = { files: {} };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current).toBeNull();
    expect(r.current_source).toBe("preset_missing");
    // Without a stage, no default can be resolved.
    expect(r.default_for_stage).toBeNull();
  });

  it("returns current=null when preset is malformed JSON, but stays ok", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: "{ not json",
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current).toBeNull();
    expect(r.current_source).toBe("preset_malformed");
  });

  it("returns current=null when rule is absent but preset stage still resolves default_for_stage", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: JSON.stringify({
          _comment: "qualy preset · stage=legacy · tier=deep",
          categories: { correctness: "warn" },
          rules: {},
        }),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.current).toBeNull();
    expect(r.current_source).toBe("rule_absent_from_presets");
    expect(r.default_for_stage).toEqual({
      stage: "legacy",
      severity: "warn",
      max: 40,
    });
  });

  it("rules not in stage baseline return default_for_stage=null even when stage detected", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesExplain(
      { cwd: ROOT, rule: "category:correctness" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Categories are not in STAGE_BASELINE_DEEP — only quality-metrics rules are.
    expect(r.default_for_stage).toBeNull();
    // But current still came from the preset.
    expect(r.current?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Unknown rule
// ---------------------------------------------------------------------------

describe("rulesExplain — unknown rule", () => {
  it("returns unknown_rule for rules not in the catalog", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "made-up/no-such-rule" }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_rule");
    expect(r.rule).toBe("made-up/no-such-rule");
    expect(r.reason).toMatch(/not in the qualy catalog/);
  });

  it("does not consult presets for unknown rules", () => {
    let readCalls = 0;
    const deps: RulesExplainDeps = {
      existsFn: () => true,
      readFileFn: () => {
        readCalls++;
        return null;
      },
    };
    const r = rulesExplain({ cwd: ROOT, rule: "made-up/unknown" }, deps);
    expect(r.ok).toBe(false);
    expect(readCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

describe("parseRulesExplainArgs", () => {
  const DEFAULT_CWD = ROOT;

  it("accepts --rule <name>", () => {
    const r = parseRulesExplainArgs(["--rule", "quality-metrics/wmc"], DEFAULT_CWD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/wmc");
    expect(r.value.cwd).toBe(DEFAULT_CWD);
  });

  it("accepts positional rule argument", () => {
    const r = parseRulesExplainArgs(["quality-metrics/cbo"], DEFAULT_CWD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/cbo");
  });

  it("accepts --cwd alongside positional rule", () => {
    const r = parseRulesExplainArgs(
      ["quality-metrics/cbo", "--cwd", "."],
      DEFAULT_CWD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/cbo");
  });

  it("--rule overrides positional when both are present", () => {
    const r = parseRulesExplainArgs(
      ["quality-metrics/wmc", "--rule", "quality-metrics/cbo"],
      DEFAULT_CWD,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/cbo");
  });

  it("returns error when no rule is given", () => {
    const r = parseRulesExplainArgs(["--cwd", "."], DEFAULT_CWD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing rule/);
  });

  it("errors on unknown flag", () => {
    const r = parseRulesExplainArgs(
      ["--rule", "quality-metrics/wmc", "--zonk"],
      DEFAULT_CWD,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag/);
  });

  it("errors on missing value for --rule", () => {
    const r = parseRulesExplainArgs(["--rule"], DEFAULT_CWD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing value for --rule/);
  });

  it("errors on missing value for --cwd", () => {
    const r = parseRulesExplainArgs(
      ["--rule", "quality-metrics/wmc", "--cwd"],
      DEFAULT_CWD,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing value for --cwd/);
  });

  it("returns error 'help' on --help and -h", () => {
    expect(parseRulesExplainArgs(["--help"], DEFAULT_CWD)).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseRulesExplainArgs(["-h"], DEFAULT_CWD)).toEqual({
      ok: false,
      error: "help",
    });
  });

  it("only the first non-flag arg is treated as positional rule", () => {
    const r = parseRulesExplainArgs(
      ["quality-metrics/wmc", "extra"],
      DEFAULT_CWD,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag: extra/);
  });
});
