/**
 * Contract tests for `lib/ignore-compile.ts` (lint-ignore PLAN T2.2).
 *
 * Phase 2 path-only: only entries with `rule === null` are projected into
 * `ignorePatterns[]` between the `_qualy:start_`/`_qualy:end_` sentinels.
 * Per-rule entries are deferred to Phase 3 (`overrides[]`).
 *
 * Invariants pinned by these tests:
 *
 *  - Output is deterministic (entries sorted by id; same input → same output)
 *  - Idempotent (compile(compile(x)) === compile(x)); `changed: false` on a
 *    second pass with no manifest mutation
 *  - Markers preserved exactly; user patterns OUTSIDE the markers preserved
 *    byte-a-byte (we never touch them)
 *  - Empty manifest → `[start, end]` pair
 *  - `rule !== null` entries are silently skipped in Phase 2 (defer to P3)
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

  it("entries with rule !== null are skipped in Phase 2", () => {
    const manifest: IgnoreManifest = {
      version: 1,
      entries: [
        mkEntry("src/x/**", null, "ign-aaaaaa"),
        mkEntry("src/x/**", "quality-metrics/wmc", "ign-bbbbbb"),
        mkEntry("src/y/**", "category:correctness", "ign-cccccc"),
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
