/**
 * Contract tests for `rules-add` (IMPLEMENTATION_PLAN.md Phase 5 — line 99
 * + line 102 verification: idempotency of add and lint-decisions.md format).
 *
 * Locks the SPEC §2 + §7.9 contract:
 *   - Tier defaults from rule namespace (quality-metrics/* → deep,
 *     category:* and oxlint built-ins → fast); --tier overrides.
 *   - Severity / max default from the stage baseline for quality-metrics
 *     rules; --severity / --max override; missing-stage requires explicit
 *     values.
 *   - Idempotent: same rule with same severity+max → action=already-present,
 *     no preset write, no decision append.
 *   - On write, the preset gains the entry (with plugins for QM rules) and
 *     `docs/lint-decisions.md` gains an H3 entry between the
 *     `qualy:entries-start`/`end` markers carrying timestamp/kind/rule/author/
 *     reason.
 *   - Dry-run never writes; with an injected runFn it computes blast radius
 *     (files newly violating, no longer violating, currently violating).
 *   - Argv parsing: positional + --rule + all flags + --help + unknown flag.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyAddRule,
  defaultTierForRule,
  insertEntryBetweenMarkers,
  parseRulesAddArgs,
  readExistingEntry,
  resolveSettings,
  rulesAdd,
  type RulesAddDeps,
  type RunFn,
} from "../../src/commands/rules/add.ts";

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

function fsDeps(fs: FakeFS, extra: Partial<RulesAddDeps> = {}): RulesAddDeps {
  const writes: string[] = [];
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
        writes.push(p);
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

function greenfieldDeepPreset(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=deep",
    categories: { correctness: "error", suspicious: "warn" },
    plugins: ["quality-metrics"],
    rules: {
      "quality-metrics/wmc": ["error", { max: 15 }],
      ...((extra.rules as Record<string, unknown>) ?? {}),
    },
    ...extra,
  });
}

function greenfieldFastPreset(): string {
  return JSON.stringify({
    _comment: "qualy preset · stage=greenfield · tier=fast",
    categories: { correctness: "error", suspicious: "warn" },
  });
}

// ---------------------------------------------------------------------------
// defaultTierForRule
// ---------------------------------------------------------------------------

describe("defaultTierForRule", () => {
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
// readExistingEntry
// ---------------------------------------------------------------------------

describe("readExistingEntry", () => {
  it("returns null when rule is absent", () => {
    expect(readExistingEntry({ rules: {} }, "quality-metrics/wmc")).toBeNull();
  });
  it("reads tuple form for named rules", () => {
    const r = readExistingEntry(
      { rules: { "quality-metrics/wmc": ["error", { max: 15 }] } },
      "quality-metrics/wmc",
    );
    expect(r).toEqual({ severity: "error", max: 15 });
  });
  it("reads bare-severity form", () => {
    const r = readExistingEntry(
      { rules: { "correctness/no-eval": "warn" } },
      "correctness/no-eval",
    );
    expect(r).toEqual({ severity: "warn" });
  });
  it("reads category from preset.categories", () => {
    const r = readExistingEntry(
      { categories: { correctness: "error" } },
      "category:correctness",
    );
    expect(r).toEqual({ severity: "error" });
  });
  it("returns null for unknown severity strings", () => {
    expect(
      readExistingEntry({ rules: { "x/y": "info" } }, "x/y"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSettings
// ---------------------------------------------------------------------------

describe("resolveSettings", () => {
  it("uses stage baseline for QM rule on deep when stage detected", () => {
    const r = resolveSettings(
      "quality-metrics/wmc",
      "deep",
      "greenfield",
      null,
      undefined,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ severity: "error", max: 15 });
  });

  it("user severity/max override baseline", () => {
    const r = resolveSettings(
      "quality-metrics/wmc",
      "deep",
      "greenfield",
      null,
      "warn",
      30,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ severity: "warn", max: 30 });
  });

  it("falls back to existing entry when stage unknown for QM rule", () => {
    const r = resolveSettings(
      "quality-metrics/wmc",
      "deep",
      null,
      { severity: "warn", max: 25 },
      undefined,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ severity: "warn", max: 25 });
  });

  it("requires --severity when stage unknown and rule absent", () => {
    const r = resolveSettings(
      "quality-metrics/wmc",
      "deep",
      null,
      null,
      undefined,
      10,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("severity_required");
  });

  it("requires --max when stage unknown and QM rule absent", () => {
    const r = resolveSettings(
      "quality-metrics/wmc",
      "deep",
      null,
      null,
      "warn",
      undefined,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error).toBe("max_required");
  });

  it("category rule defaults severity to warn when absent and no --severity", () => {
    const r = resolveSettings(
      "category:correctness",
      "fast",
      "greenfield",
      null,
      undefined,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ severity: "warn" });
  });

  it("category rule reuses existing severity when present", () => {
    const r = resolveSettings(
      "category:correctness",
      "fast",
      "greenfield",
      { severity: "error" },
      undefined,
      undefined,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ severity: "error" });
  });
});

// ---------------------------------------------------------------------------
// applyAddRule
// ---------------------------------------------------------------------------

describe("applyAddRule", () => {
  it("inserts QM rule with plugins:['quality-metrics']", () => {
    const cur = { categories: { correctness: "error" }, rules: {} };
    const edit = applyAddRule(
      cur,
      "quality-metrics/cbo",
      { severity: "error", max: 8 },
      null,
    );
    expect(edit.action).toBe("added");
    const proposed = edit.proposed as {
      rules: Record<string, unknown>;
      plugins: unknown;
    };
    expect(proposed.rules["quality-metrics/cbo"]).toEqual(["error", { max: 8 }]);
    expect(Array.isArray(proposed.plugins)).toBe(true);
    expect((proposed.plugins as unknown[]).includes("quality-metrics")).toBe(true);
  });

  it("does not duplicate quality-metrics in plugins[]", () => {
    const cur = { plugins: ["quality-metrics"], rules: {} };
    const edit = applyAddRule(
      cur,
      "quality-metrics/wmc",
      { severity: "error", max: 15 },
      null,
    );
    const proposed = edit.proposed as { plugins: unknown };
    const plugins = proposed.plugins as unknown[];
    expect(plugins.filter((p) => p === "quality-metrics").length).toBe(1);
  });

  it("returns already-present when severity+max match exactly", () => {
    const cur = {
      plugins: ["quality-metrics"],
      rules: { "quality-metrics/wmc": ["error", { max: 15 }] },
    };
    const edit = applyAddRule(
      cur,
      "quality-metrics/wmc",
      { severity: "error", max: 15 },
      { severity: "error", max: 15 },
    );
    expect(edit.action).toBe("already-present");
  });

  it("returns updated when severity changes", () => {
    const cur = {
      plugins: ["quality-metrics"],
      rules: { "quality-metrics/wmc": ["error", { max: 15 }] },
    };
    const edit = applyAddRule(
      cur,
      "quality-metrics/wmc",
      { severity: "warn", max: 15 },
      { severity: "error", max: 15 },
    );
    expect(edit.action).toBe("updated");
  });

  it("returns updated when max changes", () => {
    const cur = {
      plugins: ["quality-metrics"],
      rules: { "quality-metrics/wmc": ["error", { max: 15 }] },
    };
    const edit = applyAddRule(
      cur,
      "quality-metrics/wmc",
      { severity: "error", max: 30 },
      { severity: "error", max: 15 },
    );
    expect(edit.action).toBe("updated");
  });

  it("category goes under preset.categories (not rules)", () => {
    const cur = { categories: { correctness: "warn" } };
    const edit = applyAddRule(
      cur,
      "category:correctness",
      { severity: "error" },
      { severity: "warn" },
    );
    expect(edit.action).toBe("updated");
    const proposed = edit.proposed as { categories: Record<string, unknown> };
    expect(proposed.categories.correctness).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// insertEntryBetweenMarkers
// ---------------------------------------------------------------------------

describe("insertEntryBetweenMarkers", () => {
  it("appends into an empty entry region", () => {
    const r = insertEntryBetweenMarkers(TEMPLATE, "### entry-1\n\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(/<!-- qualy:entries-start -->\n+### entry-1\n+\n+<!-- qualy:entries-end -->/);
  });

  it("preserves prior entries (append-only)", () => {
    const base = TEMPLATE.replace(
      "<!-- qualy:entries-end -->",
      "### prior\n\n- foo\n\n<!-- qualy:entries-end -->",
    );
    const r = insertEntryBetweenMarkers(base, "### entry-2\n\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const start = r.text.indexOf("<!-- qualy:entries-start -->");
    const end = r.text.indexOf("<!-- qualy:entries-end -->");
    const between = r.text.slice(start, end);
    expect(between.indexOf("### prior")).toBeGreaterThan(-1);
    expect(between.indexOf("### entry-2")).toBeGreaterThan(-1);
    expect(between.indexOf("### prior")).toBeLessThan(between.indexOf("### entry-2"));
  });

  it("returns error when markers are missing", () => {
    const r = insertEntryBetweenMarkers("# no markers", "### x\n\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/markers/i);
  });
});

// ---------------------------------------------------------------------------
// rulesAdd — error paths
// ---------------------------------------------------------------------------

describe("rulesAdd — error paths", () => {
  it("rejects unknown rule", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const r = rulesAdd({ cwd: ROOT, rule: "nope/whatever" }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("unknown_rule");
  });

  it("returns preset_missing when target preset is absent", () => {
    const fs: FakeFS = { files: {} };
    const r = rulesAdd({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
  });

  it("returns preset_malformed when target preset is invalid JSON", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: "{ broken" },
    };
    const r = rulesAdd({ cwd: ROOT, rule: "quality-metrics/wmc" }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_malformed");
  });

  it("forwards severity_required when stage unknown and QM rule absent", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: JSON.stringify({
          // no _comment → stage cannot be detected
          plugins: ["quality-metrics"],
          rules: {},
        }),
      },
    };
    const r = rulesAdd({ cwd: ROOT, rule: "quality-metrics/lcom" }, fsDeps(fs));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("severity_required");
  });
});

// ---------------------------------------------------------------------------
// rulesAdd — write path (tier defaulting, preset edit, decision append)
// ---------------------------------------------------------------------------

describe("rulesAdd — write path", () => {
  it("defaults to deep tier for quality-metrics rules and adds plugin", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", reason: "tighten coupling" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("deep");
    expect(r.applies_to).toBe("oxlint.deep.json");
    expect(r.action).toBe("added");
    expect(r.severity).toBe("error");
    expect(r.max).toBe(8);
    expect(r.applied).toBe(true);
    expect(r.files_changed).toContain("oxlint.deep.json");
    expect(r.files_changed).toContain("docs/lint-decisions.md");

    const newPreset = JSON.parse(fs.files[pj(ROOT, "oxlint.deep.json")]) as {
      rules: Record<string, unknown>;
    };
    expect(newPreset.rules["quality-metrics/cbo"]).toEqual([
      "error",
      { max: 8 },
    ]);
  });

  it("defaults to fast tier for category rules", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.fast.json")]: greenfieldFastPreset() },
    };
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "category:correctness",
        severity: "error",
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("fast");
    expect(r.applies_to).toBe("oxlint.fast.json");
    // existing severity was already 'error' → already-present (no write)
    expect(r.action).toBe("already-present");
    expect(r.applied).toBe(false);
    expect(r.files_changed).toEqual([]);
  });

  it("--tier override forces a different preset", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.fast.json")]: greenfieldFastPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/cbo",
        tier: "fast",
        severity: "warn",
        max: 10,
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    expect(r.tier).toBe("fast");
    expect(r.applies_to).toBe("oxlint.fast.json");
    expect(r.action).toBe("added");
  });

  it("creates docs/lint-decisions.md from template when missing", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/lcom",
        reason: "lcom > 0 surfacing real splits",
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
    expect(md).toContain("rule-add: quality-metrics/lcom");
    expect(md).toContain("- **rule**: quality-metrics/lcom");
    expect(md).toContain("- **author**: alice@example.com");
    expect(md).toContain("- **reason**: lcom > 0 surfacing real splits");
    expect(md).toContain("2026-05-03T12:00:00Z");
  });

  it("appends to existing decisions log preserving prior entries", () => {
    const existing =
      "# Lint decisions\n\n## Entries\n\n<!-- qualy:entries-start -->\n### 2026-04-01T00:00:00Z — rule-remove: foo\n\n- **kind**: rule-remove\n- **rule**: foo\n\n<!-- qualy:entries-end -->\n";
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [pj(ROOT, "docs/lint-decisions.md")]: existing,
      },
    };
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/dit", reason: "limit depth" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    const md = fs.files[pj(ROOT, "docs/lint-decisions.md")];
    expect(md).toContain("rule-remove: foo");
    expect(md).toContain("rule-add: quality-metrics/dit");
    expect(md.indexOf("rule-remove: foo")).toBeLessThan(
      md.indexOf("rule-add: quality-metrics/dit"),
    );
  });

  it("respects --reason when provided; falls back to (none) when empty", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/lcom" },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.dry_run) return;
    const md = fs.files[pj(ROOT, "docs/lint-decisions.md")];
    expect(md).toContain("- **reason**: (none)");
  });
});

// ---------------------------------------------------------------------------
// rulesAdd — idempotency
// ---------------------------------------------------------------------------

describe("rulesAdd — idempotency", () => {
  it("running twice with the same args is a no-op the second time", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const deps = fsDeps(fs);

    const r1 = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", reason: "first" },
      deps,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.dry_run) return;
    expect(r1.action).toBe("added");

    const presetAfter1 = fs.files[pj(ROOT, "oxlint.deep.json")];
    const decisionsAfter1 = fs.files[pj(ROOT, "docs/lint-decisions.md")];

    const r2 = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", reason: "second" },
      deps,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok || r2.dry_run) return;
    expect(r2.action).toBe("already-present");
    expect(r2.applied).toBe(false);
    expect(r2.files_changed).toEqual([]);
    // No second decision entry, no preset rewrite.
    expect(fs.files[pj(ROOT, "oxlint.deep.json")]).toBe(presetAfter1);
    expect(fs.files[pj(ROOT, "docs/lint-decisions.md")]).toBe(decisionsAfter1);
  });

  it("running with a different severity changes action to updated and rewrites preset", () => {
    const fs: FakeFS = {
      files: {
        [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset(),
        [TPL_PATH]: TEMPLATE,
      },
    };
    const deps = fsDeps(fs);
    const r1 = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/wmc", severity: "warn", max: 30 },
      deps,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.dry_run) return;
    expect(r1.action).toBe("updated");
    const newPreset = JSON.parse(fs.files[pj(ROOT, "oxlint.deep.json")]) as {
      rules: Record<string, unknown>;
    };
    expect(newPreset.rules["quality-metrics/wmc"]).toEqual([
      "warn",
      { max: 30 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// rulesAdd — dry-run
// ---------------------------------------------------------------------------

describe("rulesAdd — dry-run", () => {
  it("never writes to disk", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const before = fs.files[pj(ROOT, "oxlint.deep.json")];
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", dryRun: true },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.action).toBe("would-add");
    expect(r.applied).toBe(false);
    expect(r.files_changed).toEqual([]);
    expect(r.decision).toBeNull();
    expect(r.blast_radius).toBeNull();
    // preset unchanged
    expect(fs.files[pj(ROOT, "oxlint.deep.json")]).toBe(before);
    // decisions never created
    expect(
      Object.prototype.hasOwnProperty.call(
        fs.files,
        pj(ROOT, "docs/lint-decisions.md"),
      ),
    ).toBe(false);
  });

  it("would-update when severity differs from existing", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        severity: "warn",
        max: 30,
        dryRun: true,
      },
      fsDeps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.action).toBe("would-update");
  });

  it("computes blast_radius when measureBlastRadius and runFn injected", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    let calls = 0;
    const runFn: RunFn = () => {
      calls++;
      // First call (current): 1 file violating; second call (proposed): 3.
      if (calls === 1) {
        return {
          ok: true,
          stdout: JSON.stringify([{ filename: "src/a.ts" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify([
          { filename: "src/a.ts" },
          { filename: "src/b.ts" },
          { filename: "src/c.ts" },
        ]),
        stderr: "",
        exitCode: 0,
      };
    };
    const tmpRoot = pj("/tmp", "qualy-rules-add-XXXX");
    const fakeWrites: Record<string, string> = {};
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/cbo",
        dryRun: true,
        measureBlastRadius: true,
      },
      fsDeps(fs, {
        runFn,
        mkdtempFn: () => tmpRoot,
        writeTmpFn: (p, c) => {
          fakeWrites[p] = c;
        },
        removeFn: () => undefined,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.blast_radius).toEqual({
      files_currently_violating: 1,
      files_newly_violating: 2,
      files_no_longer_violating: 0,
    });
    expect(calls).toBe(2);
    // proposed preset was staged in tmp dir
    expect(Object.keys(fakeWrites).some((k) => k.endsWith("oxlint.deep.json"))).toBe(true);
  });

  it("returns oxlint_missing when runFn returns empty stdout and non-ok", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const runFn: RunFn = () => ({
      ok: false,
      stdout: "",
      stderr: "command not found: oxlint",
      exitCode: -1,
    });
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/cbo",
        dryRun: true,
        measureBlastRadius: true,
      },
      fsDeps(fs, {
        runFn,
        mkdtempFn: () => pj("/tmp", "qualy-rules-add-XXXX"),
        writeTmpFn: () => undefined,
        removeFn: () => undefined,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("oxlint_missing");
  });

  it("dry-run already-present: no blast radius measured even when requested", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    let runCalls = 0;
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/wmc",
        severity: "error",
        max: 15,
        dryRun: true,
        measureBlastRadius: true,
      },
      fsDeps(fs, {
        runFn: () => {
          runCalls++;
          return { ok: true, stdout: "[]", stderr: "", exitCode: 0 };
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.dry_run) return;
    expect(r.action).toBe("already-present");
    expect(r.blast_radius).toBeNull();
    expect(runCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rulesAdd — strict pre-flight
// ---------------------------------------------------------------------------

describe("rulesAdd — strict pre-flight", () => {
  it("returns dirty_tree when --strict and dirtyFilesFn reports unclean", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", strict: true },
      fsDeps(fs, {
        dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("dirty_tree");
  });

  it("forwards git_check_failed when dirtyFilesFn errors", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const r = rulesAdd(
      { cwd: ROOT, rule: "quality-metrics/cbo", strict: true },
      fsDeps(fs, {
        dirtyFilesFn: () => ({ ok: false, error: "not a repo" }),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("git_check_failed");
  });

  it("strict is skipped during --dry-run (read-only)", () => {
    const fs: FakeFS = {
      files: { [pj(ROOT, "oxlint.deep.json")]: greenfieldDeepPreset() },
    };
    const r = rulesAdd(
      {
        cwd: ROOT,
        rule: "quality-metrics/cbo",
        strict: true,
        dryRun: true,
      },
      fsDeps(fs, {
        dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
      }),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRulesAddArgs
// ---------------------------------------------------------------------------

describe("parseRulesAddArgs", () => {
  it("accepts --rule", () => {
    const r = parseRulesAddArgs(["--rule", "quality-metrics/wmc"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/wmc");
  });

  it("accepts positional rule", () => {
    const r = parseRulesAddArgs(["quality-metrics/wmc"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("quality-metrics/wmc");
  });

  it("--rule wins over positional when both present", () => {
    const r = parseRulesAddArgs(
      ["positional/x", "--rule", "explicit/y"],
      ROOT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("explicit/y");
  });

  it("missing rule triggers usage error", () => {
    const r = parseRulesAddArgs([], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing rule/i);
  });

  it("--severity accepts error|warn|off and rejects others", () => {
    const ok = parseRulesAddArgs(["x", "--severity", "warn"], ROOT);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.severity).toBe("warn");

    const bad = parseRulesAddArgs(["x", "--severity", "info"], ROOT);
    expect(bad.ok).toBe(false);
  });

  it("--max parses numeric value", () => {
    const r = parseRulesAddArgs(["x", "--max", "20"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.max).toBe(20);
  });

  it("--max rejects non-numeric value", () => {
    const r = parseRulesAddArgs(["x", "--max", "twenty"], ROOT);
    expect(r.ok).toBe(false);
  });

  it("--tier accepts fast|deep and rejects others", () => {
    const ok = parseRulesAddArgs(["x", "--tier", "deep"], ROOT);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.tier).toBe("deep");

    const bad = parseRulesAddArgs(["x", "--tier", "huge"], ROOT);
    expect(bad.ok).toBe(false);
  });

  it("--reason captures empty string", () => {
    const r = parseRulesAddArgs(["x", "--reason", ""], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reason).toBe("");
  });

  it("--dry-run / --measure-blast-radius / --strict are flags", () => {
    const r = parseRulesAddArgs(
      ["x", "--dry-run", "--measure-blast-radius", "--strict"],
      ROOT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dryRun).toBe(true);
    expect(r.value.measureBlastRadius).toBe(true);
    expect(r.value.strict).toBe(true);
  });

  it("--oxlint-bin captures the binary path", () => {
    const r = parseRulesAddArgs(["x", "--oxlint-bin", "/usr/bin/oxlint"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.oxlintBin).toBe("/usr/bin/oxlint");
  });

  it("--cwd resolves against defaultCwd", () => {
    const r = parseRulesAddArgs(["x", "--cwd", "subdir"], ROOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toContain("subdir");
  });

  it("rejects unknown flag", () => {
    const r = parseRulesAddArgs(["x", "--zonk"], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag/i);
  });

  it("returns help marker for --help", () => {
    const r = parseRulesAddArgs(["--help"], ROOT);
    expect(r).toEqual({ ok: false, error: "help" });
  });

  it("returns help marker for -h", () => {
    const r = parseRulesAddArgs(["-h"], ROOT);
    expect(r).toEqual({ ok: false, error: "help" });
  });
});
