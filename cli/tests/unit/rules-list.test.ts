/**
 * Contract tests for `rules-list` (IMPLEMENTATION_PLAN.md Phase 5 — line 97).
 *
 * Locks the SPEC §2 `/lint:rules:list` contract:
 *   - Three buckets: active (severity error|warn), disabled (severity off),
 *     available (rules from stage baseline absent from both presets).
 *   - Origin tag mirrors `audit.ts`: `preset:<stage>:<tier>` when `_comment`
 *     carries `stage=`; `preset:<tier>` otherwise.
 *   - `categories.<name>` is recorded as `category:<name>` so callers can see
 *     bulk severity decisions alongside named rules.
 *   - `available[]` is empty when stage cannot be detected (no `_comment`).
 *   - Missing both presets → `preset_missing` (RECOVERABLE_ERROR).
 *   - All present presets unparseable → `preset_malformed` (RECOVERABLE_ERROR).
 *   - parseRulesListArgs covers --cwd, --help, unknown flag.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseRulesListArgs,
  type RulesListDeps,
  rulesList,
} from "../../src/commands/rules/list.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

interface FakeFS {
  readonly files: Record<string, string>;
}

function fsDeps(fs: FakeFS): RulesListDeps {
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
      "quality-metrics/halstead-volume": ["warn", { max: 1000 }],
      "quality-metrics/halstead-effort": ["warn", { max: 500 }],
      "quality-metrics/lcom": ["warn", { max: 2 }],
      "quality-metrics/cbo": ["error", { max: 10 }],
      "quality-metrics/dit": ["warn", { max: 5 }],
      // explicitly disabled by user
      "correctness/no-debugger": "off",
    },
  });
}

function brownfieldFastPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=brownfield-moderate · tier=fast",
    categories: { correctness: "error", suspicious: "warn" },
  });
}

function legacyDeepPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=legacy · tier=deep",
    categories: { correctness: "warn", suspicious: "warn" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/wmc": ["warn", { max: 40 }],
    },
  });
}

describe("rulesList — happy path", () => {
  it("returns ok with stage detected from _comment", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("greenfield");
  });

  it("classifies severity error|warn as active", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wmc = r.active.find((e) => e.rule === "quality-metrics/wmc");
    expect(wmc).toEqual({
      rule: "quality-metrics/wmc",
      severity: "error",
      options: { max: 15 },
      origin: "preset:greenfield:deep",
    });
    const susp = r.active.find((e) => e.rule === "category:suspicious");
    expect(susp).toEqual({
      rule: "category:suspicious",
      severity: "warn",
      origin: "preset:greenfield:deep",
    });
  });

  it("classifies severity off as disabled (not active)", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: brownfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.disabled.map((e) => e.rule)).toContain("correctness/no-debugger");
    expect(r.active.map((e) => e.rule)).not.toContain("correctness/no-debugger");
    const off = r.disabled.find((e) => e.rule === "correctness/no-debugger");
    expect(off?.severity).toBe("off");
    expect(off?.origin).toBe("preset:brownfield-moderate:deep");
  });

  it("merges entries from both fast and deep tiers", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: brownfieldFastPreset(),
        [pathJoin(ROOT, "oxlint.deep.json")]: brownfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const origins = new Set(r.active.map((e) => e.origin));
    expect(origins.has("preset:brownfield-moderate:fast")).toBe(true);
    expect(origins.has("preset:brownfield-moderate:deep")).toBe(true);
  });

  it("origin lacks stage tag when _comment has no stage=", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: JSON.stringify({
          categories: { correctness: "error" },
        }),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBeNull();
    expect(r.active[0]?.origin).toBe("preset:deep");
  });
});

describe("rulesList — available[] computed from stage baseline", () => {
  it("emits baseline entries that are absent from active+disabled", () => {
    // greenfield baseline has 6 quality-metrics rules; preset only has wmc+cbo
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const availableRules = r.available.map((a) => a.rule);
    expect(availableRules).toContain("quality-metrics/halstead-volume");
    expect(availableRules).toContain("quality-metrics/halstead-effort");
    expect(availableRules).toContain("quality-metrics/lcom");
    expect(availableRules).toContain("quality-metrics/dit");
    expect(availableRules).not.toContain("quality-metrics/wmc");
    expect(availableRules).not.toContain("quality-metrics/cbo");
  });

  it("carries suggested_severity, suggested_max, source from baseline", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lcom = r.available.find((a) => a.rule === "quality-metrics/lcom");
    expect(lcom).toEqual({
      rule: "quality-metrics/lcom",
      suggested_severity: "warn",
      suggested_max: 0,
      source: "baseline:greenfield:deep",
    });
  });

  it("excludes rules that are explicitly disabled (severity off)", () => {
    const preset = JSON.stringify({
      _comment: "stage=greenfield · tier=deep",
      categories: { correctness: "error" },
      rules: {
        "quality-metrics/wmc": "off",
      },
    });
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: preset,
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const availableRules = r.available.map((a) => a.rule);
    expect(availableRules).not.toContain("quality-metrics/wmc");
  });

  it("returns full baseline when project preset has no quality-metrics rules", () => {
    const preset = JSON.stringify({
      _comment: "stage=legacy · tier=deep",
      categories: { correctness: "warn" },
    });
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: preset,
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.available.length).toBe(6);
    expect(r.available.every((a) => a.source === "baseline:legacy:deep")).toBe(true);
  });

  it("emits empty available[] when stage cannot be detected", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: JSON.stringify({
          categories: { correctness: "error" },
        }),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBeNull();
    expect(r.available).toEqual([]);
  });

  it("brownfield-moderate baseline is a complete superset of preset", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: brownfieldDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // brownfield baseline has all 6 quality-metrics; preset enables all 6
    expect(r.available).toEqual([]);
  });
});

describe("rulesList — error paths", () => {
  it("returns preset_missing when neither preset is present", () => {
    const fs: FakeFS = { files: {} };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
    expect(r.reason).toMatch(/oxlint\.fast\.json|oxlint\.deep\.json/);
  });

  it("returns preset_malformed when only present preset is invalid JSON", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: "{ not json",
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });

  it("returns preset_malformed when both presets are invalid JSON", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: "{ broken",
        [pathJoin(ROOT, "oxlint.deep.json")]: "also broken",
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });

  it("succeeds when one preset is malformed but the other is valid", () => {
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: "{ broken",
        [pathJoin(ROOT, "oxlint.deep.json")]: legacyDeepPreset(),
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("legacy");
  });

  it("returns preset_malformed when present file is unreadable (returns null)", () => {
    const deps: RulesListDeps = {
      existsFn: (p) => p.endsWith("oxlint.deep.json"),
      readFileFn: () => null,
    };
    const r = rulesList({ cwd: ROOT }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });
});

describe("rulesList — preset shape edge cases", () => {
  it("ignores unknown severity values", () => {
    const preset = JSON.stringify({
      _comment: "stage=greenfield · tier=deep",
      rules: {
        "foo/bar": "info",
        "foo/baz": ["unknown", { max: 5 }],
        "quality-metrics/wmc": ["error", { max: 15 }],
      },
    });
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: preset,
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.active.map((e) => e.rule)).not.toContain("foo/bar");
    expect(r.active.map((e) => e.rule)).not.toContain("foo/baz");
    expect(r.active.map((e) => e.rule)).toContain("quality-metrics/wmc");
  });

  it("accepts bare severity string (no options tuple)", () => {
    const preset = JSON.stringify({
      _comment: "stage=greenfield · tier=deep",
      rules: {
        "correctness/no-eval": "error",
      },
    });
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: preset,
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.active.find((x) => x.rule === "correctness/no-eval");
    expect(e?.severity).toBe("error");
    expect(e?.options).toBeUndefined();
  });

  it("preserves deterministic ordering: categories first then rules, both sorted", () => {
    const preset = JSON.stringify({
      _comment: "stage=greenfield · tier=deep",
      categories: { suspicious: "warn", correctness: "error" },
      rules: {
        "z/last": "warn",
        "a/first": "error",
      },
    });
    const fs: FakeFS = {
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: preset,
      },
    };
    const r = rulesList({ cwd: ROOT }, fsDeps(fs));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ruleOrder = r.active.map((e) => e.rule);
    expect(ruleOrder).toEqual([
      "category:correctness",
      "category:suspicious",
      "a/first",
      "z/last",
    ]);
  });
});

describe("parseRulesListArgs", () => {
  it("returns default cwd with no args", () => {
    const r = parseRulesListArgs([], ROOT);
    expect(r).toEqual({ ok: true, value: { cwd: ROOT } });
  });

  it("accepts --cwd", () => {
    const r = parseRulesListArgs(["--cwd", "subdir"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toContain("subdir");
  });

  it("rejects --cwd without value", () => {
    const r = parseRulesListArgs(["--cwd"], ROOT);
    expect(r).toEqual({ ok: false, error: "missing value for --cwd" });
  });

  it("returns help marker for --help", () => {
    const r = parseRulesListArgs(["--help"], ROOT);
    expect(r).toEqual({ ok: false, error: "help" });
  });

  it("returns help marker for -h", () => {
    const r = parseRulesListArgs(["-h"], ROOT);
    expect(r).toEqual({ ok: false, error: "help" });
  });

  it("rejects unknown flag", () => {
    const r = parseRulesListArgs(["--zonk"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag: --zonk/);
  });
});
