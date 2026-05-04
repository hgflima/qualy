/**
 * Contract tests for `rules-remove` (IMPLEMENTATION_PLAN.md Phase 5 — line
 * 100 + line 102 verification: idempotency of remove and lint-decisions.md
 * format).
 *
 * Locks the SPEC §2 + §6 contract:
 *   - Tier defaults from rule namespace (quality-metrics/* → deep,
 *     category:* and oxlint built-ins → fast); --tier overrides.
 *   - --reason is mandatory (SPEC §6 line 389): rule removal loosens
 *     enforcement and the rationale must be recorded.
 *   - Idempotent: rule already absent → action=already-absent, no preset
 *     write, no decision append.
 *   - On write, the preset loses the entry and `docs/lint-decisions.md`
 *     gains an H3 `rule-remove` entry between the
 *     `qualy:entries-start`/`end` markers carrying timestamp/kind/rule/
 *     author/reason.
 *   - Dry-run never writes and does not require --reason.
 *   - Argv parsing: positional + --rule + all flags + --help + unknown flag.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyRemoveRule,
  defaultTierForRule,
  formatDecisionEntry,
  parseRulesRemoveArgs,
  rulesRemove,
  type RulesRemoveDeps,
} from "../../src/commands/rules/remove.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";
function pj(...parts: string[]): string {
  return parts.join(sep);
}

const TPL_PATH = "/fake/templates/lint-decisions.md.tpl";
const TEMPLATE = `# Lint decisions

(stub template)

## Entries

<!-- qualy:entries-start -->
<!-- qualy:entries-end -->
`;

const NOW = new Date("2026-05-03T12:00:00.000Z");

interface FakeFS {
  files: Record<string, string>;
}

function fsDeps(fs: FakeFS, extra: Partial<RulesRemoveDeps> = {}): RulesRemoveDeps {
  return {
    existsFn: (p) => Object.prototype.hasOwnProperty.call(fs.files, p),
    readFileFn: (p) =>
      Object.prototype.hasOwnProperty.call(fs.files, p) ? fs.files[p] : null,
    safeIO: {
      existsFn: (p) => Object.prototype.hasOwnProperty.call(fs.files, p),
      readFileFn: (p) =>
        Object.prototype.hasOwnProperty.call(fs.files, p) ? fs.files[p] : null,
      writeFileFn: (p, content) => {
        fs.files[p] = content;
      },
      mkdirFn: () => undefined,
      removeFn: (p) => {
        delete fs.files[p];
      },
      now: () => NOW,
    },
    authorFn: () => "alice@example.com",
    now: () => NOW,
    templatePath: TPL_PATH,
    ...extra,
  };
}

function deepPresetWithWmc(): string {
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

function deepPresetWithoutWmc(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=deep",
    categories: { correctness: "error", suspicious: "warn" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/cbo": ["error", { max: 8 }],
    },
  });
}

function fastPresetWithCorrectness(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=fast",
    categories: { correctness: "error", suspicious: "warn" },
  });
}

// ---------------------------------------------------------------------------
// defaultTierForRule
// ---------------------------------------------------------------------------

describe("rules-remove · defaultTierForRule", () => {
  it("routes quality-metrics rules to deep", () => {
    expect(defaultTierForRule("quality-metrics/wmc")).toBe("deep");
    expect(defaultTierForRule("quality-metrics/cbo")).toBe("deep");
  });
  it("routes category and oxlint rules to fast", () => {
    expect(defaultTierForRule("category:correctness")).toBe("fast");
    expect(defaultTierForRule("category:suspicious")).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// applyRemoveRule
// ---------------------------------------------------------------------------

describe("applyRemoveRule", () => {
  it("returns already-absent and leaves preset untouched when rule missing", () => {
    const cur = {
      categories: { correctness: "error" },
      rules: { "quality-metrics/cbo": ["error", { max: 8 }] },
    };
    const edit = applyRemoveRule(cur, "quality-metrics/wmc", null);
    expect(edit.action).toBe("already-absent");
    const proposed = edit.proposed as { rules: Record<string, unknown> };
    expect(proposed.rules["quality-metrics/cbo"]).toEqual(["error", { max: 8 }]);
  });

  it("removes a named rule from preset.rules", () => {
    const cur = {
      plugins: ["quality-metrics"],
      rules: {
        "quality-metrics/wmc": ["error", { max: 15 }],
        "quality-metrics/cbo": ["error", { max: 8 }],
      },
    };
    const edit = applyRemoveRule(cur, "quality-metrics/wmc", {
      severity: "error",
      max: 15,
    });
    expect(edit.action).toBe("removed");
    const proposed = edit.proposed as { rules: Record<string, unknown> };
    expect(proposed.rules).not.toHaveProperty("quality-metrics/wmc");
    expect(proposed.rules["quality-metrics/cbo"]).toEqual(["error", { max: 8 }]);
  });

  it("removes a category from preset.categories (not preset.rules)", () => {
    const cur = {
      categories: { correctness: "error", suspicious: "warn" },
    };
    const edit = applyRemoveRule(cur, "category:correctness", {
      severity: "error",
    });
    expect(edit.action).toBe("removed");
    const proposed = edit.proposed as { categories: Record<string, unknown> };
    expect(proposed.categories).not.toHaveProperty("correctness");
    expect(proposed.categories.suspicious).toBe("warn");
  });

  it("does not mutate the caller's preset object", () => {
    const cur = {
      rules: { "quality-metrics/wmc": ["error", { max: 15 }] },
    };
    applyRemoveRule(cur, "quality-metrics/wmc", { severity: "error", max: 15 });
    expect(
      (cur.rules as Record<string, unknown>)["quality-metrics/wmc"],
    ).toEqual(["error", { max: 15 }]);
  });
});

// ---------------------------------------------------------------------------
// formatDecisionEntry
// ---------------------------------------------------------------------------

describe("formatDecisionEntry", () => {
  it("includes previous severity+max in the subject when max present", () => {
    const text = formatDecisionEntry({
      timestamp: "2026-05-03T12:00:00Z",
      kind: "rule-remove",
      subject: "quality-metrics/wmc (was severity=error, max=15)",
      rule: "quality-metrics/wmc",
      author: "alice@example.com",
      reason: "metric too noisy on this codebase",
    });
    expect(text).toContain(
      "### 2026-05-03T12:00:00Z — rule-remove: quality-metrics/wmc (was severity=error, max=15)",
    );
    expect(text).toContain("- **kind**: rule-remove");
    expect(text).toContain("- **rule**: quality-metrics/wmc");
    expect(text).toContain("- **author**: alice@example.com");
    expect(text).toContain("- **reason**: metric too noisy on this codebase");
  });

  it("omits the max segment when previous had no max (categories)", () => {
    const text = formatDecisionEntry({
      timestamp: "2026-05-03T12:00:00Z",
      kind: "rule-remove",
      subject: "category:correctness (was severity=error)",
      rule: "category:correctness",
      author: "alice@example.com",
      reason: "switching to deep tier only",
    });
    expect(text).toContain(
      "### 2026-05-03T12:00:00Z — rule-remove: category:correctness (was severity=error)",
    );
    expect(text).not.toContain("max=");
  });
});

// ---------------------------------------------------------------------------
// rulesRemove — error paths
// ---------------------------------------------------------------------------

describe("rulesRemove — error paths", () => {
  it("rejects unknown rule before reading any preset", () => {
    const fs: FakeFS = { files: {} };
    const r = rulesRemove(
      { cwd: ROOT, rule: "nope/whatever", reason: "x" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_rule");
  });

  it("requires --reason for non-dry-run invocations", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc() },
    };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reason_required");
  });

  it("treats whitespace-only reason as empty", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc() },
    };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "   \n\t  " },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reason_required");
  });

  it("returns preset_missing when target preset is absent", () => {
    const fs: FakeFS = { files: {} };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "drop" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
  });

  it("returns preset_malformed when target preset is invalid JSON", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: "{ broken" },
    };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "drop" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });

  it("forwards dirty_tree when --strict and tree is dirty", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "drop",
        strict: true,
      },
      fsDeps(fs, {
        dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("dirty_tree");
  });

  it("does not check git when rule is already absent under --strict", () => {
    let dirtyCalls = 0;
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithoutWmc() },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "drop",
        strict: true,
      },
      fsDeps(fs, {
        dirtyFilesFn: () => {
          dirtyCalls++;
          return { ok: true, value: ["src/foo.ts"] };
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.action).toBe("already-absent");
    expect(dirtyCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rulesRemove — write path (tier defaulting, preset edit, decision append)
// ---------------------------------------------------------------------------

describe("rulesRemove — write path", () => {
  it("defaults to deep tier for quality-metrics rules and removes the entry", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "metric noisy on legacy code",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("deep");
    expect(r.applies_to).toBe("oxlint.deep.json");
    expect(r.action).toBe("removed");
    expect(r.previous).toEqual({ severity: "error", max: 15 });
    expect(r.applied).toBe(true);
    expect(r.files_changed).toContain("oxlint.deep.json");
    expect(r.files_changed).toContain("docs/lint-decisions.md");

    const newPreset = JSON.parse(fs.files[pj(ROOT, "oxlint.deep.json")]) as {
      rules: Record<string, unknown>;
    };
    expect(newPreset.rules).not.toHaveProperty("quality-metrics/wmc");
    expect(newPreset.rules["quality-metrics/cbo"]).toEqual([
      "error",
      { max: 8 },
    ]);
  });

  it("defaults to fast tier for category rules", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.fast.json")]: fastPresetWithCorrectness(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "category:correctness",
        reason: "category overlaps with explicit rules",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("fast");
    expect(r.applies_to).toBe("oxlint.fast.json");
    expect(r.action).toBe("removed");
    expect(r.previous).toEqual({ severity: "error" });
  });

  it("--tier override forces a different preset", () => {
    const fs: FakeFS = {
      files: {
        // category:correctness lives in deep preset for this test
        [pj(ROOT, "oxlint.deep.json")]: JSON.stringify({
          _comment: "qualy preset · stage=greenfield · tier=deep",
          categories: { correctness: "error" },
        }),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "category:correctness",
        reason: "drop",
        tier: "deep",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("deep");
    expect(r.applies_to).toBe("oxlint.deep.json");
    expect(r.action).toBe("removed");
  });

  it("creates docs/lint-decisions.md from template when missing", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "wmc not actionable here",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.decision).toEqual({
      path: "docs/lint-decisions.md",
      appended: true,
    });
    const md = fs.files[pj(ROOT, "docs/lint-decisions.md")];
    expect(md).toContain("# Lint decisions");
    expect(md).toContain(
      "rule-remove: quality-metrics/wmc (was severity=error, max=15)",
    );
    expect(md).toContain("- **kind**: rule-remove");
    expect(md).toContain("- **rule**: quality-metrics/wmc");
    expect(md).toContain("- **author**: alice@example.com");
    expect(md).toContain("- **reason**: wmc not actionable here");
    expect(md).toContain("2026-05-03T12:00:00Z");
  });

  it("appends to existing decisions log preserving prior entries", () => {
    const existing =
      "# Lint decisions\n\n## Entries\n\n<!-- qualy:entries-start -->\n### 2026-04-01T00:00:00Z — rule-add: quality-metrics/dit\n\n- **kind**: rule-add\n- **rule**: quality-metrics/dit\n\n<!-- qualy:entries-end -->\n";
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [pj(ROOT, "docs/lint-decisions.md")]: existing,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "noise > signal",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    const md = fs.files[pj(ROOT, "docs/lint-decisions.md")];
    expect(md).toContain("rule-add: quality-metrics/dit");
    expect(md).toContain("rule-remove: quality-metrics/wmc");
    expect(md.indexOf("rule-add: quality-metrics/dit")).toBeLessThan(
      md.indexOf("rule-remove: quality-metrics/wmc"),
    );
  });

  it("returns decisions_failed when existing log lacks the markers", () => {
    const broken =
      "# Lint decisions\n\n(no markers here)\n\nSome random body.\n";
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [pj(ROOT, "docs/lint-decisions.md")]: broken,
      },
    };
    const r = rulesRemove(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        reason: "drop",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("decisions_failed");
  });
});

// ---------------------------------------------------------------------------
// rulesRemove — idempotency
// ---------------------------------------------------------------------------

describe("rulesRemove — idempotency", () => {
  it("running twice with the same args is a no-op the second time", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const first = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "drop" },
      fsDeps(fs),
    );
    expect(first.ok).toBe(true);
    if (!first.ok || first.dry_run) return;
    expect(first.action).toBe("removed");
    expect(first.applied).toBe(true);

    const presetAfterFirst = fs.files[pj(ROOT, "oxlint.deep.json")];
    const decisionsAfterFirst = fs.files[pj(ROOT, "docs/lint-decisions.md")];

    const second = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "drop again" },
      fsDeps(fs),
    );
    expect(second.ok).toBe(true);
    if (!second.ok || second.dry_run) return;
    expect(second.action).toBe("already-absent");
    expect(second.applied).toBe(false);
    expect(second.files_changed).toEqual([]);
    expect(second.decision).toBeNull();
    expect(second.previous).toBeNull();

    // Preset and decisions log remain byte-for-byte unchanged.
    expect(fs.files[pj(ROOT, "oxlint.deep.json")]).toBe(presetAfterFirst);
    expect(fs.files[pj(ROOT, "docs/lint-decisions.md")]).toBe(
      decisionsAfterFirst,
    );
  });

  it("returns already-absent without writing when rule missing on first call", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: deepPresetWithoutWmc(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const before = fs.files[pj(ROOT, "oxlint.deep.json")];
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", reason: "drop" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.action).toBe("already-absent");
    expect(r.applied).toBe(false);
    expect(fs.files[pj(ROOT, "oxlint.deep.json")]).toBe(before);
    expect(fs.files[pj(ROOT, "docs/lint-decisions.md")]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rulesRemove — dry-run
// ---------------------------------------------------------------------------

describe("rulesRemove — dry-run", () => {
  it("never writes and reports would-remove with previous values", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc() },
    };
    const before = { ...fs.files };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", dryRun: true },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.action).toBe("would-remove");
    expect(r.previous).toEqual({ severity: "error", max: 15 });
    expect(r.applied).toBe(false);
    expect(r.files_changed).toEqual([]);
    expect(r.decision).toBeNull();
    expect(fs.files).toEqual(before);
  });

  it("does not require --reason in dry-run mode", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithWmc() },
    };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", dryRun: true },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
  });

  it("reports already-absent in dry-run when rule is missing", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: deepPresetWithoutWmc() },
    };
    const r = rulesRemove(
      { cwd: ROOT, rule: "quality-metrics/wmc", dryRun: true },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.action).toBe("already-absent");
    expect(r.previous).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRulesRemoveArgs
// ---------------------------------------------------------------------------

describe("parseRulesRemoveArgs", () => {
  it("accepts a positional rule", () => {
    const r = parseRulesRemoveArgs(
      ["quality-metrics/wmc", "--reason", "drop"],
      ROOT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/wmc");
    expect(r.value.reason).toBe("drop");
  });

  it("accepts --rule explicitly", () => {
    const r = parseRulesRemoveArgs(
      ["--rule", "category:correctness", "--reason", "y"],
      ROOT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("category:correctness");
  });

  it("parses --tier, --dry-run, --strict, --cwd", () => {
    const r = parseRulesRemoveArgs(
      [
        "quality-metrics/wmc",
        "--tier",
        "fast",
        "--dry-run",
        "--strict",
        "--cwd",
        sep === "/" ? "/elsewhere" : "C:\\elsewhere",
        "--reason",
        "x",
      ],
      ROOT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tier).toBe("fast");
    expect(r.value.dryRun).toBe(true);
    expect(r.value.strict).toBe(true);
    expect(r.value.cwd).toBe(sep === "/" ? "/elsewhere" : "C:\\elsewhere");
  });

  it("rejects an invalid --tier value", () => {
    const r = parseRulesRemoveArgs(
      ["quality-metrics/wmc", "--tier", "medium", "--reason", "x"],
      ROOT,
    );
    expect(r.ok).toBe(false);
  });

  it("requires a rule to be present", () => {
    const r = parseRulesRemoveArgs(["--reason", "x"], ROOT);
    expect(r.ok).toBe(false);
  });

  it("returns help sentinel for --help", () => {
    const r = parseRulesRemoveArgs(["--help"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });

  it("rejects unknown flags", () => {
    const r = parseRulesRemoveArgs(
      ["quality-metrics/wmc", "--bogus"],
      ROOT,
    );
    expect(r.ok).toBe(false);
  });
});
