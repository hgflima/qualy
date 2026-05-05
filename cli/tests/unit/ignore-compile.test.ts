/**
 * Contract tests for `lib/ignore-compile.ts` (lint-ignore PLAN T2.2 + T3.2).
 *
 * Two projections, both bounded by `_qualy:start_`/`_qualy:end_` markers:
 *  - Path-only entries (`rule === null`) → `ignorePatterns[]` (T2.2).
 *  - Per-rule entries (`rule !== null`) → `overrides[]` blocks (T3.2),
 *    with `category:*` expanded via `category-catalog`.
 *
 * Invariants pinned by these tests:
 *
 *  - Output is deterministic (entries sorted by id; same input → same output)
 *  - Idempotent (compile(compile(x)) === compile(x)); `changed: false` on a
 *    second pass with no manifest mutation
 *  - ignorePatterns markers always emitted; overrides markers only emitted
 *    when manifest has per-rule entries OR markers already exist (asymmetry
 *    noted in compile.ts header — avoids inflating brownfield presets that
 *    only use path-only ignores)
 *  - User patterns OUTSIDE the markers preserved byte-a-byte
 *  - Multiple per-rule entries with the same glob collapse into a single
 *    override block; rules within a block are alphabetically sorted
 *  - Other preset keys (`rules`, `categories`, `plugins`, `_comment`, etc.)
 *    are preserved exactly
 */
import { describe, expect, it } from "vitest";

import {
  compileToBothPresets,
  compileToPreset,
} from "../../src/lib/ignore-compile.ts";
import {
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";
import {
  type IgnoreEntry,
  type IgnoreManifest,
} from "../../src/lib/ignore-manifest.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");

function mkEntry(
  glob: string,
  rule: string | null,
  id: string,
): IgnoreEntry {
  return {
    id,
    glob,
    rule,
    reason: "r",
    expires: null,
    createdAt: NOW.toISOString(),
    createdBy: "user",
  };
}

const EMPTY_MANIFEST: IgnoreManifest = { version: 1, entries: [] };

describe("compileToPreset — path-only (Phase 2)", () => {
  it("greenfield: empty preset + 1 entry → markers wrapping the glob", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("src/legacy/**", null, "ign-aaaaaa")],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "src/legacy/**",
      IGNORE_MARKER_END,
    ]);
    expect(r.changed).toBe(true);
  });

  it("zero entries → empty marker pair `[start, end]`", () => {
    const r = compileToPreset({}, EMPTY_MANIFEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      IGNORE_MARKER_END,
    ]);
  });

  it("entries are sorted by id (deterministic output)", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("z/**", null, "ign-zzzzzz"),
        mkEntry("a/**", null, "ign-aaaaaa"),
        mkEntry("m/**", null, "ign-mmmmmm"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "a/**",
      "m/**",
      "z/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("path-only and per-rule entries route to ignorePatterns and overrides respectively", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/x/**", null, "ign-aaaaaa"),
        mkEntry("src/x/**", "quality-metrics/wmc", "ign-bbbbbb"),
        mkEntry("src/y/**", "eslint/no-debugger", "ign-cccccc"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "src/x/**",
      IGNORE_MARKER_END,
    ]);
    expect(r.proposed.overrides).toEqual([
      { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
      { files: ["src/x/**"], rules: { "quality-metrics/wmc": "off" } },
      { files: ["src/y/**"], rules: { "eslint/no-debugger": "off" } },
      { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
    ]);
  });

  it("idempotent: compile(compile(x)) === compile(x); second pass reports `changed: false`", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("a/**", null, "ign-aaaaaa"),
        mkEntry("b/**", null, "ign-bbbbbb"),
      ],
    };
    const r1 = compileToPreset({}, manifest);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = compileToPreset(r1.proposed, manifest);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.changed).toBe(false);
    expect(r2.proposed.ignorePatterns).toEqual(r1.proposed.ignorePatterns);
  });

  it("preserves user patterns OUTSIDE the markers byte-a-byte", () => {
    const current = {
      ignorePatterns: [
        "user/before/**",
        IGNORE_MARKER_START,
        "old-managed/**",
        IGNORE_MARKER_END,
        "user/after/**",
      ],
    };
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("new-managed/**", null, "ign-aaaaaa")],
    };
    const r = compileToPreset(current, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      "user/before/**",
      IGNORE_MARKER_START,
      "new-managed/**",
      IGNORE_MARKER_END,
      "user/after/**",
    ]);
  });

  it("appends managed block when no markers exist (user patterns preserved untouched)", () => {
    const current = {
      ignorePatterns: ["user/foo/**", "user/bar/**"],
    };
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("managed/**", null, "ign-aaaaaa")],
    };
    const r = compileToPreset(current, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.ignorePatterns).toEqual([
      "user/foo/**",
      "user/bar/**",
      IGNORE_MARKER_START,
      "managed/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("preserves other preset keys (`rules`, `categories`, `plugins`, `_comment`)", () => {
    const current = {
      _comment: "stage:greenfield",
      categories: { correctness: "warn" },
      rules: { "quality-metrics/wmc": ["error", { max: 12 }] },
      plugins: ["quality-metrics"],
    };
    const r = compileToPreset(current, EMPTY_MANIFEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed._comment).toBe("stage:greenfield");
    expect(r.proposed.categories).toEqual({ correctness: "warn" });
    expect(r.proposed.rules).toEqual({
      "quality-metrics/wmc": ["error", { max: 12 }],
    });
    expect(r.proposed.plugins).toEqual(["quality-metrics"]);
  });

  it("`changed: false` when manifest is empty AND preset already has empty marker pair", () => {
    const current = {
      ignorePatterns: [IGNORE_MARKER_START, IGNORE_MARKER_END],
    };
    const r = compileToPreset(current, EMPTY_MANIFEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
  });
});

describe("compileToPreset — overrides (Phase 3, T3.2)", () => {
  it("greenfield with empty manifest does NOT add an `overrides` key", () => {
    const r = compileToPreset({}, EMPTY_MANIFEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("overrides" in r.proposed).toBe(false);
  });

  it("path-only-only manifest does NOT touch overrides (no markers added)", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("src/legacy/**", null, "ign-aaaaaa")],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("overrides" in r.proposed).toBe(false);
  });

  it("single per-rule entry → 1 managed override block wrapped by markers", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/generated/**", "quality-metrics/wmc", "ign-aaaaaa"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.overrides).toEqual([
      { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
      { files: ["src/generated/**"], rules: { "quality-metrics/wmc": "off" } },
      { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
    ]);
    expect(r.changed).toBe(true);
  });

  it("multiple per-rule entries on the same glob collapse into 1 block, rules sorted", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/x/**", "quality-metrics/wmc", "ign-aaaaaa"),
        mkEntry("src/x/**", "eslint/no-debugger", "ign-bbbbbb"),
        mkEntry("src/x/**", "eslint/no-eval", "ign-cccccc"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    // 1 start + 1 grouped block + 1 end = 3 entries
    expect(overrides).toHaveLength(3);
    expect(overrides[1]).toEqual({
      files: ["src/x/**"],
      rules: {
        "eslint/no-debugger": "off",
        "eslint/no-eval": "off",
        "quality-metrics/wmc": "off",
      },
    });
    // Verify rules iteration order (alphabetical)
    const block = overrides[1] as { rules: Record<string, string> };
    expect(Object.keys(block.rules)).toEqual([
      "eslint/no-debugger",
      "eslint/no-eval",
      "quality-metrics/wmc",
    ]);
  });

  it("category:perf expands to all 13 catalog rules in a single block", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/generated/**", "category:perf", "ign-aaaaaa"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides).toHaveLength(3); // start + 1 block + end
    const block = overrides[1] as {
      files: readonly string[];
      rules: Record<string, string>;
    };
    expect(block.files).toEqual(["src/generated/**"]);
    expect(Object.keys(block.rules)).toHaveLength(13);
    // Spot-check known perf-category rules
    expect(block.rules["unicorn/prefer-set-has"]).toBe("off");
    expect(block.rules["react/jsx-no-constructed-context-values"]).toBe("off");
  });

  it("category:* + named rule on the same glob merge into one block", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/x/**", "category:perf", "ign-aaaaaa"),
        mkEntry("src/x/**", "eslint/no-debugger", "ign-bbbbbb"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides).toHaveLength(3);
    const block = overrides[1] as {
      files: readonly string[];
      rules: Record<string, string>;
    };
    expect(block.files).toEqual(["src/x/**"]);
    // 13 perf rules + eslint/no-debugger = 14 entries
    expect(Object.keys(block.rules)).toHaveLength(14);
    expect(block.rules["eslint/no-debugger"]).toBe("off");
  });

  it("unknown category falls through opaque (single rule named `category:foo`)", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/x/**", "category:foo", "ign-aaaaaa"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides[1]).toEqual({
      files: ["src/x/**"],
      rules: { "category:foo": "off" },
    });
  });

  it("multiple globs produce multiple blocks, ordered deterministically by id-sort", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/z/**", "eslint/no-debugger", "ign-zzzzzz"),
        mkEntry("src/a/**", "eslint/no-eval", "ign-aaaaaa"),
        mkEntry("src/m/**", "eslint/no-alert", "ign-mmmmmm"),
      ],
    };
    const r = compileToPreset({}, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides).toHaveLength(5); // start + 3 blocks + end
    expect((overrides[1] as { files: string[] }).files).toEqual(["src/a/**"]);
    expect((overrides[2] as { files: string[] }).files).toEqual(["src/m/**"]);
    expect((overrides[3] as { files: string[] }).files).toEqual(["src/z/**"]);
  });

  it("preserves user-authored override blocks OUTSIDE the markers", () => {
    const userBlock = {
      files: ["**/*.test.ts"],
      rules: { "typescript/no-explicit-any": "off" },
    };
    const current = {
      overrides: [
        userBlock,
        { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
        { files: ["old/**"], rules: { "eslint/no-debugger": "off" } },
        { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
      ],
    };
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("new/**", "eslint/no-eval", "ign-aaaaaa"),
      ],
    };
    const r = compileToPreset(current, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides[0]).toEqual(userBlock);
    expect(overrides[1]).toEqual({
      files: [],
      rules: { [IGNORE_MARKER_START]: "off" },
    });
    expect(overrides[2]).toEqual({
      files: ["new/**"],
      rules: { "eslint/no-eval": "off" },
    });
    expect(overrides[3]).toEqual({
      files: [],
      rules: { [IGNORE_MARKER_END]: "off" },
    });
  });

  it("appends managed overrides block when no markers exist", () => {
    const userBlock = {
      files: ["**/*.test.ts"],
      rules: { "typescript/no-explicit-any": "off" },
    };
    const current = { overrides: [userBlock] };
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("src/x/**", "eslint/no-eval", "ign-aaaaaa")],
    };
    const r = compileToPreset(current, manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overrides = r.proposed.overrides as readonly unknown[];
    expect(overrides).toHaveLength(4);
    expect(overrides[0]).toEqual(userBlock);
    expect(overrides[3]).toEqual({
      files: [],
      rules: { [IGNORE_MARKER_END]: "off" },
    });
  });

  it("idempotent for mixed manifest (path-only + per-rule + category)", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/legacy/**", null, "ign-aaaaaa"),
        mkEntry("src/x/**", "quality-metrics/wmc", "ign-bbbbbb"),
        mkEntry("src/y/**", "category:perf", "ign-cccccc"),
      ],
    };
    const r1 = compileToPreset({}, manifest);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.changed).toBe(true);
    const r2 = compileToPreset(r1.proposed, manifest);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.changed).toBe(false);
    expect(JSON.stringify(r2.proposed)).toBe(JSON.stringify(r1.proposed));
  });

  it("manifest with no per-rule entries strips overrides markers to an empty pair", () => {
    const current = {
      overrides: [
        { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
        { files: ["old/**"], rules: { "eslint/no-debugger": "off" } },
        { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
      ],
    };
    const r = compileToPreset(current, EMPTY_MANIFEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed.overrides).toEqual([
      { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
      { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
    ]);
    expect(r.changed).toBe(true);
  });

  it("`changed: false` when preset already has the expected empty marker pair", () => {
    const current = {
      overrides: [
        { files: [], rules: { [IGNORE_MARKER_START]: "off" } },
        { files: [], rules: { [IGNORE_MARKER_END]: "off" } },
      ],
    };
    // Manifest must contain at least one per-rule entry so we hit the
    // overrides codepath; use an entry that produces a single-block diff.
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("src/x/**", "eslint/no-debugger", "ign-aaaaaa")],
    };
    const r1 = compileToPreset(current, manifest);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.changed).toBe(true);
    const r2 = compileToPreset(r1.proposed, manifest);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.changed).toBe(false);
  });
});

describe("compileToBothPresets — orchestrate fast + deep", () => {
  function makeFakeFs(seed: Record<string, string>): {
    files: Map<string, string>;
    io: SafeIO;
  } {
    const files = new Map<string, string>(Object.entries(seed));
    const io: SafeIO = {
      existsFn: (p) => files.has(p),
      readFileFn: (p) => files.get(p) ?? null,
      writeFileFn: (p, content) => {
        files.set(p, content);
      },
      mkdirFn: () => {},
      removeFn: (p) => {
        files.delete(p);
      },
      dirtyFilesFn: () => ({ ok: true, value: [] }),
      now: () => NOW,
    };
    return { files, io };
  }

  it("writes both presets when manifest mutation produces a diff", () => {
    const { files, io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: JSON.stringify({}, null, 2) + "\n",
      [`/repo/${PRESET_PATHS.deep}`]: JSON.stringify({}, null, 2) + "\n",
    });
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("a/**", null, "ign-aaaaaa")],
    };
    const r = compileToBothPresets("/repo", manifest, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed).toEqual([PRESET_PATHS.fast, PRESET_PATHS.deep]);
    const fast = JSON.parse(files.get(`/repo/${PRESET_PATHS.fast}`)!);
    expect(fast.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "a/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("skips writing presets that are already in sync", () => {
    const synced = JSON.stringify(
      {
        ignorePatterns: [IGNORE_MARKER_START, "a/**", IGNORE_MARKER_END],
      },
      null,
      2,
    ) + "\n";
    const { files, io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: synced,
      [`/repo/${PRESET_PATHS.deep}`]: synced,
    });
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [mkEntry("a/**", null, "ign-aaaaaa")],
    };
    const before = files.get(`/repo/${PRESET_PATHS.fast}`);
    const r = compileToBothPresets("/repo", manifest, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed).toEqual([]);
    expect(files.get(`/repo/${PRESET_PATHS.fast}`)).toBe(before);
  });

  it("error when a preset file is missing", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      // deep missing
    });
    const r = compileToBothPresets("/repo", EMPTY_MANIFEST, io);
    expect(r.ok).toBe(false);
  });
});
