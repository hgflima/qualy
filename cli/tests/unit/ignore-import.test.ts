/**
 * Contract tests for `lib/ignore-import.ts` (lint-ignore PLAN T3.4).
 *
 * Pins SPEC §2.4 brownfield-import semantics:
 *  - First mutation of an empty manifest scoops user-authored
 *    `ignorePatterns[]` outside the qualy markers into the manifest as
 *    `createdBy: "imported"` entries.
 *  - Greenfield (no patterns) and pre-managed (only patterns inside markers)
 *    presets import nothing.
 *  - Manifest with any existing entries is left alone (only the very first
 *    mutation imports).
 *  - Patterns shared between fast+deep are deduplicated; encounter order is
 *    fast-first, then deep.
 *  - `applyImportToPresets` strips imported globs from outside the markers in
 *    BOTH presets so the next compile can re-emit them inside without
 *    leaving duplicates.
 */
import { describe, expect, it } from "vitest";

import { type SafeIO } from "../../src/lib/fs-safe.ts";
import {
  applyImportToPresets,
  extractNonMarkerPatterns,
  importBrownfieldIgnores,
  IMPORT_REASON,
  stripImportedFromPreset,
} from "../../src/lib/ignore-import.ts";
import {
  generateEntryId,
  type IgnoreManifest,
} from "../../src/lib/ignore-manifest.ts";
import {
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");
const EMPTY: IgnoreManifest = { version: 1, entries: [] };

interface FakeFs {
  readonly files: Map<string, string>;
  readonly io: SafeIO;
}

function makeFs(seed: Record<string, string> = {}): FakeFs {
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

function presetJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// extractNonMarkerPatterns
// ---------------------------------------------------------------------------

describe("extractNonMarkerPatterns", () => {
  it("returns [] when ignorePatterns is missing", () => {
    expect(extractNonMarkerPatterns({})).toEqual([]);
  });

  it("returns every string when no markers are present", () => {
    expect(
      extractNonMarkerPatterns({ ignorePatterns: ["dist/**", "build/**"] }),
    ).toEqual(["dist/**", "build/**"]);
  });

  it("returns [] when only markers (no patterns inside) are present", () => {
    expect(
      extractNonMarkerPatterns({
        ignorePatterns: [IGNORE_MARKER_START, IGNORE_MARKER_END],
      }),
    ).toEqual([]);
  });

  it("returns [] when patterns sit only inside the marker slice", () => {
    expect(
      extractNonMarkerPatterns({
        ignorePatterns: [
          IGNORE_MARKER_START,
          "src/legacy/**",
          IGNORE_MARKER_END,
        ],
      }),
    ).toEqual([]);
  });

  it("returns patterns that sit OUTSIDE the marker slice", () => {
    expect(
      extractNonMarkerPatterns({
        ignorePatterns: [
          "dist/**",
          IGNORE_MARKER_START,
          "src/legacy/**",
          IGNORE_MARKER_END,
          "build/**",
        ],
      }),
    ).toEqual(["dist/**", "build/**"]);
  });

  it("filters out marker strings even when markers are out of order", () => {
    // Out-of-order markers fall through to the no-marker path; the marker
    // strings themselves should still be excluded from the imported list.
    expect(
      extractNonMarkerPatterns({
        ignorePatterns: [IGNORE_MARKER_END, "dist/**", IGNORE_MARKER_START],
      }),
    ).toEqual(["dist/**"]);
  });

  it("ignores non-string array members", () => {
    expect(
      extractNonMarkerPatterns({
        ignorePatterns: ["dist/**", 42, null, "build/**"],
      }),
    ).toEqual(["dist/**", "build/**"]);
  });
});

// ---------------------------------------------------------------------------
// importBrownfieldIgnores
// ---------------------------------------------------------------------------

describe("importBrownfieldIgnores — brownfield (3 patterns)", () => {
  it("imports unique non-marker patterns from fast+deep", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**", "build/**"],
      }),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["build/**", "src/old/**"],
      }),
    });

    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);

    // Encounter order: fast first (dist, build), then deep (skip build dup,
    // add src/old).
    expect(r.imported.map((p) => p.glob)).toEqual([
      "dist/**",
      "build/**",
      "src/old/**",
    ]);

    // Each imported entry → manifest entry with the canonical metadata.
    expect(r.manifest.entries).toHaveLength(3);
    for (const e of r.manifest.entries) {
      expect(e.createdBy).toBe("imported");
      expect(e.reason).toBe(IMPORT_REASON);
      expect(e.expires).toBeNull();
      expect(e.rule).toBeNull();
      expect(e.createdAt).toBe(NOW.toISOString());
    }

    // Ids match the deterministic helper (path-only ⇒ rule = null).
    for (const p of r.imported) {
      expect(p.id).toBe(generateEntryId(p.glob, null));
    }
  });

  it("preserves manifest version + entries (when none existed)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({ ignorePatterns: ["x/**"] }),
    });
    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.manifest.version).toBe(1);
  });
});

describe("importBrownfieldIgnores — greenfield (0 patterns)", () => {
  it("returns 0 imported when neither preset has ignorePatterns", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({}),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({}),
    });
    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
    expect(r.manifest).toBe(EMPTY);
  });

  it("returns 0 imported when both presets are missing", () => {
    const fs = makeFs({});
    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
  });

  it("returns 0 imported when a preset is malformed JSON (no fatal)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{not json",
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({}),
    });
    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
  });
});

describe("importBrownfieldIgnores — pre-managed (0 patterns)", () => {
  it("returns 0 imported when patterns sit only inside the markers", () => {
    const managed = presetJson({
      ignorePatterns: [
        IGNORE_MARKER_START,
        "src/legacy/**",
        IGNORE_MARKER_END,
      ],
    });
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: managed,
      [`/repo/${PRESET_PATHS.deep}`]: managed,
    });
    const r = importBrownfieldIgnores("/repo", EMPTY, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
  });
});

describe("importBrownfieldIgnores — manifest non-empty", () => {
  it("skips when manifest already has entries (only the first mutation imports)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const seeded: IgnoreManifest = {
      version: 1,
      entries: [
        {
          id: "ign-existing",
          glob: "src/x/**",
          rule: null,
          reason: "seeded",
          expires: null,
          createdAt: NOW.toISOString(),
          createdBy: "user",
        },
      ],
    };
    const r = importBrownfieldIgnores("/repo", seeded, NOW, fs.io);
    expect(r.ok).toBe(true);
    expect(r.imported).toEqual([]);
    expect(r.manifest).toBe(seeded);
  });
});

// ---------------------------------------------------------------------------
// stripImportedFromPreset
// ---------------------------------------------------------------------------

describe("stripImportedFromPreset", () => {
  it("removes imported globs from outside markers, leaves markers untouched", () => {
    const r = stripImportedFromPreset(
      {
        ignorePatterns: [
          "dist/**",
          IGNORE_MARKER_START,
          "src/legacy/**",
          IGNORE_MARKER_END,
          "build/**",
        ],
      },
      ["dist/**", "build/**"],
    );
    expect(r.changed).toBe(true);
    expect(r.preset.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "src/legacy/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("no-op when imported is empty", () => {
    const preset = { ignorePatterns: ["dist/**"] };
    const r = stripImportedFromPreset(preset, []);
    expect(r.changed).toBe(false);
    expect(r.preset).toBe(preset);
  });

  it("no-op when no imported pattern matches anything in the array", () => {
    const preset = { ignorePatterns: ["dist/**"] };
    const r = stripImportedFromPreset(preset, ["build/**"]);
    expect(r.changed).toBe(false);
  });

  it("preserves other preset keys verbatim", () => {
    const r = stripImportedFromPreset(
      {
        ignorePatterns: ["dist/**"],
        rules: { "no-debugger": "error" },
        plugins: ["typescript"],
      },
      ["dist/**"],
    );
    expect(r.changed).toBe(true);
    expect(r.preset.rules).toEqual({ "no-debugger": "error" });
    expect(r.preset.plugins).toEqual(["typescript"]);
  });
});

// ---------------------------------------------------------------------------
// applyImportToPresets
// ---------------------------------------------------------------------------

describe("applyImportToPresets", () => {
  it("strips imported globs from both presets and reports files_changed", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**", "build/**"],
      }),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const r = applyImportToPresets("/repo", ["dist/**", "build/**"], fs.io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed.sort()).toEqual(
      [PRESET_PATHS.fast, PRESET_PATHS.deep].sort(),
    );
    const fast = JSON.parse(fs.files.get(`/repo/${PRESET_PATHS.fast}`)!);
    const deep = JSON.parse(fs.files.get(`/repo/${PRESET_PATHS.deep}`)!);
    expect(fast.ignorePatterns).toEqual([]);
    expect(deep.ignorePatterns).toEqual([]);
  });

  it("no-op when imported is empty", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const before = fs.files.get(`/repo/${PRESET_PATHS.fast}`);
    const r = applyImportToPresets("/repo", [], fs.io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed).toEqual([]);
    expect(fs.files.get(`/repo/${PRESET_PATHS.fast}`)).toBe(before);
  });

  it("no-op when neither preset contains any of the imported globs", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["other/**"],
      }),
    });
    const before = fs.files.get(`/repo/${PRESET_PATHS.fast}`);
    const r = applyImportToPresets("/repo", ["dist/**"], fs.io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed).toEqual([]);
    expect(fs.files.get(`/repo/${PRESET_PATHS.fast}`)).toBe(before);
  });

  it("skips a malformed preset (compileToBothPresets surfaces it later)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{not json",
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const r = applyImportToPresets("/repo", ["dist/**"], fs.io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_changed).toEqual([PRESET_PATHS.deep]);
  });
});
