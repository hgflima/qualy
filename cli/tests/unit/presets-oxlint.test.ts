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
type RuleOptions = {
  max?: number;
  maxVolume?: number;
  maxEffort?: number;
  maxLcom?: number;
};
type RuleEntry = Severity | [Severity, RuleOptions];

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

type ExpectedRule =
  | { kind: "single-max"; severity: Severity; max: number }
  | { kind: "lcom"; severity: Severity; maxLcom: number }
  | { kind: "halstead"; severity: Severity; maxVolume: number; maxEffort: number };

/**
 * SPEC §3 thresholds table — the single source of truth this suite locks.
 * `halstead` is now a single rule with `{ maxVolume, maxEffort }` options
 * (the plugin exports it that way; halstead-volume / halstead-effort don't
 * exist as separate rules).
 */
const EXPECTED_DEEP_RULES: Record<Stage, Record<string, ExpectedRule>> = {
  greenfield: {
    "quality-metrics/wmc": { kind: "single-max", severity: "error", max: 15 },
    "quality-metrics/halstead": {
      kind: "halstead",
      severity: "warn",
      maxVolume: 800,
      maxEffort: 300,
    },
    "quality-metrics/lcom": { kind: "lcom", severity: "warn", maxLcom: 0 },
    "quality-metrics/cbo": { kind: "single-max", severity: "error", max: 8 },
    "quality-metrics/dit": { kind: "single-max", severity: "warn", max: 4 },
  },
  "brownfield-moderate": {
    "quality-metrics/wmc": { kind: "single-max", severity: "error", max: 20 },
    "quality-metrics/halstead": {
      kind: "halstead",
      severity: "warn",
      maxVolume: 1000,
      maxEffort: 400,
    },
    "quality-metrics/lcom": { kind: "lcom", severity: "warn", maxLcom: 2 },
    "quality-metrics/cbo": { kind: "single-max", severity: "error", max: 10 },
    "quality-metrics/dit": { kind: "single-max", severity: "warn", max: 5 },
  },
  legacy: {
    "quality-metrics/wmc": { kind: "single-max", severity: "warn", max: 40 },
    "quality-metrics/halstead": {
      kind: "halstead",
      severity: "warn",
      maxVolume: 2000,
      maxEffort: 1000,
    },
    "quality-metrics/lcom": { kind: "lcom", severity: "warn", maxLcom: 4 },
    "quality-metrics/cbo": { kind: "single-max", severity: "warn", max: 20 },
    "quality-metrics/dit": { kind: "single-max", severity: "warn", max: 6 },
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
    for (const [ruleName, spec] of Object.entries(expected)) {
      it(`${stage}.deep · ${ruleName} matches expected spec`, () => {
        const preset = loadPreset(stage, "deep");
        const entry = preset.rules?.[ruleName];
        expect(Array.isArray(entry)).toBe(true);
        if (!Array.isArray(entry)) return;
        const [actualSeverity, options] = entry;
        expect(actualSeverity).toBe(spec.severity);
        if (spec.kind === "single-max") {
          expect(options.max).toBe(spec.max);
        } else if (spec.kind === "lcom") {
          expect(options.maxLcom).toBe(spec.maxLcom);
        } else {
          expect(options.maxVolume).toBe(spec.maxVolume);
          expect(options.maxEffort).toBe(spec.maxEffort);
        }
      });
    }

    it(`${stage}.deep declares exactly the 5 expected quality-metrics rules`, () => {
      const preset = loadPreset(stage, "deep");
      const ruleNames = Object.keys(preset.rules ?? {})
        .filter((r) => r.startsWith("quality-metrics/"))
        .sort();
      const expectedNames = Object.keys(EXPECTED_DEEP_RULES[stage]).sort();
      expect(ruleNames).toEqual(expectedNames);
    });

    it(`${stage}.deep does not carry the legacy halstead-volume/halstead-effort rule names`, () => {
      const preset = loadPreset(stage, "deep");
      const rules = preset.rules ?? {};
      expect(rules["quality-metrics/halstead-volume"]).toBeUndefined();
      expect(rules["quality-metrics/halstead-effort"]).toBeUndefined();
    });
  }
});
