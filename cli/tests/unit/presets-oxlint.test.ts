/**
 * Oxlint preset contract tests (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §3).
 *
 * Locks the canonical thresholds table from SPEC §3 against the in-source
 * preset files at `cli/src/presets/oxlint/<stage>.<tier>.json`. These files
 * are copied byte-for-byte into target projects by `install-oxlint`, so any
 * drift between the SPEC table and the JSON ships immediately to users —
 * this suite is the gate.
 *
 * What is asserted:
 *   - All 6 files exist (3 stages × 2 tiers) and parse as JSON.
 *   - SPEC §4 metadata: `$schema` + `_comment` (with stage and tier).
 *   - Fast tier carries no `quality-metrics` rules (fast = oxlint built-ins).
 *   - Deep tier carries the 6 quality-metrics rules with the exact severity
 *     and `max` from the SPEC §3 table — drift here is a contract break.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "presets",
  "oxlint",
);

type Severity = "error" | "warn" | "off";
type RuleEntry = Severity | [Severity, { max: number }];

interface OxlintPreset {
  $schema: string;
  categories?: Record<string, Severity>;
  plugins?: string[];
  jsPlugins?: string[];
  rules?: Record<string, RuleEntry>;
}

const STAGES = ["greenfield", "brownfield-moderate", "legacy"] as const;
const TIERS = ["fast", "deep"] as const;

type Stage = (typeof STAGES)[number];
type Tier = (typeof TIERS)[number];

function loadPreset(stage: Stage, tier: Tier): OxlintPreset {
  const path = join(PRESETS_DIR, `${stage}.${tier}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as OxlintPreset;
}

/**
 * SPEC §3 thresholds table — the single source of truth this suite locks.
 * Any change to the table MUST land here AND in the preset JSONs together.
 */
const EXPECTED_DEEP_RULES: Record<
  Stage,
  Record<string, { severity: Severity; max: number }>
> = {
  greenfield: {
    "quality-metrics/wmc": { severity: "error", max: 15 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 800 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 300 },
    "quality-metrics/lcom": { severity: "warn", max: 0 },
    "quality-metrics/cbo": { severity: "error", max: 8 },
    "quality-metrics/dit": { severity: "warn", max: 4 },
  },
  "brownfield-moderate": {
    "quality-metrics/wmc": { severity: "error", max: 20 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 1000 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 400 },
    "quality-metrics/lcom": { severity: "warn", max: 2 },
    "quality-metrics/cbo": { severity: "error", max: 10 },
    "quality-metrics/dit": { severity: "warn", max: 5 },
  },
  legacy: {
    "quality-metrics/wmc": { severity: "warn", max: 40 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 2000 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 1000 },
    "quality-metrics/lcom": { severity: "warn", max: 4 },
    "quality-metrics/cbo": { severity: "warn", max: 20 },
    "quality-metrics/dit": { severity: "warn", max: 6 },
  },
};

describe("oxlint presets — file presence and metadata", () => {
  for (const stage of STAGES) {
    for (const tier of TIERS) {
      it(`${stage}.${tier}.json exists, parses, and declares $schema`, () => {
        const preset = loadPreset(stage, tier);
        expect(typeof preset.$schema).toBe("string");
        expect(preset.$schema.length).toBeGreaterThan(0);
      });

      it(`${stage}.${tier}.json carries no _comment field (oxlint 1.62.0 rejects it)`, () => {
        const preset = loadPreset(stage, tier) as Record<string, unknown>;
        expect(preset["_comment"]).toBeUndefined();
      });
    }
  }
});

describe("oxlint presets — fast tier", () => {
  for (const stage of STAGES) {
    it(`${stage}.fast carries no quality-metrics rules (oxlint built-ins only)`, () => {
      const preset = loadPreset(stage, "fast");
      const rules = preset.rules ?? {};
      const qmRules = Object.keys(rules).filter((r) => r.startsWith("quality-metrics/"));
      expect(qmRules).toEqual([]);
      const plugins = preset.plugins ?? [];
      expect(plugins).not.toContain("quality-metrics");
      const jsPlugins = preset.jsPlugins ?? [];
      expect(jsPlugins).toEqual([]);
    });

    it(`${stage}.fast declares a 'correctness' category severity`, () => {
      const preset = loadPreset(stage, "fast");
      const cats = preset.categories ?? {};
      expect(cats["correctness"]).toBeDefined();
    });
  }

  it("greenfield.fast keeps correctness as 'error' (strict)", () => {
    const preset = loadPreset("greenfield", "fast");
    expect(preset.categories?.correctness).toBe("error");
  });

  it("brownfield-moderate.fast keeps correctness as 'error'", () => {
    const preset = loadPreset("brownfield-moderate", "fast");
    expect(preset.categories?.correctness).toBe("error");
  });

  it("legacy.fast loosens correctness to 'warn' (don't block legacy)", () => {
    const preset = loadPreset("legacy", "fast");
    expect(preset.categories?.correctness).toBe("warn");
  });
});

describe("oxlint presets — deep tier carries SPEC §3 thresholds", () => {
  for (const stage of STAGES) {
    it(`${stage}.deep declares 'quality-metrics' in jsPlugins (not plugins)`, () => {
      const preset = loadPreset(stage, "deep");
      expect(preset.jsPlugins ?? []).toContain("quality-metrics");
      expect(preset.plugins ?? []).not.toContain("quality-metrics");
    });

    const expected = EXPECTED_DEEP_RULES[stage];
    for (const [ruleName, { severity, max }] of Object.entries(expected)) {
      it(`${stage}.deep · ${ruleName} = [${severity}, { max: ${max} }]`, () => {
        const preset = loadPreset(stage, "deep");
        const entry = preset.rules?.[ruleName];
        expect(Array.isArray(entry)).toBe(true);
        if (!Array.isArray(entry)) return;
        const [actualSeverity, options] = entry;
        expect(actualSeverity).toBe(severity);
        expect(options.max).toBe(max);
      });
    }

    it(`${stage}.deep declares exactly the 6 expected quality-metrics rules`, () => {
      const preset = loadPreset(stage, "deep");
      const ruleNames = Object.keys(preset.rules ?? {})
        .filter((r) => r.startsWith("quality-metrics/"))
        .sort();
      const expectedNames = Object.keys(EXPECTED_DEEP_RULES[stage]).sort();
      expect(ruleNames).toEqual(expectedNames);
    });
  }
});
