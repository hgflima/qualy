/**
 * Contract tests for `commands/ignore/import-preview.ts` — read-only brownfield
 * import preview consumed by the slash command `/lint:ignore:add` (lint-ignore
 * PLAN T3.4b).
 *
 * Pinned guarantees:
 *  - Greenfield (no patterns) → `count: 0`, `manifest_empty: true`.
 *  - Brownfield (patterns outside markers) → enumerated in encounter order
 *    (fast first, then deep), each tagged with the tier where it was first
 *    encountered. Patterns shared between fast+deep land once with
 *    `tier: "fast"`, mirroring `importBrownfieldIgnores` dedup order.
 *  - Pre-managed (patterns only inside markers) → `count: 0`.
 *  - Manifest non-empty → skip preview entirely (`manifest_empty: false`,
 *    `count: 0`); only the very first mutation actually imports.
 *  - Manifest corrupt → exit `70` `manifest_corrupt`.
 *  - Subcommand never writes — fake fs `files` map is unchanged after a call.
 */
import { describe, expect, it } from "vitest";

import {
  ignoreImportPreview,
  parseIgnoreImportPreviewArgs,
} from "../../src/commands/ignore/import-preview.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";
import {
  IGNORE_MANIFEST_PATH,
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");

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

function presetJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const MANIFEST_WITH_ENTRY = JSON.stringify(
  {
    version: 1,
    entries: [
      {
        id: "ign-aaaaaa",
        glob: "src/legacy/**",
        rule: null,
        reason: "x",
        expires: null,
        createdAt: NOW.toISOString(),
        createdBy: "user",
      },
    ],
  },
  null,
  2,
) + "\n";

describe("parseIgnoreImportPreviewArgs", () => {
  it("defaults cwd to provided default when no flags", () => {
    const r = parseIgnoreImportPreviewArgs([], "/repo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/repo");
  });

  it("accepts --cwd <path>", () => {
    const r = parseIgnoreImportPreviewArgs(["--cwd", "/elsewhere"], "/repo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/elsewhere");
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreImportPreviewArgs(["--bogus"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("returns error: 'help' for --help", () => {
    const r = parseIgnoreImportPreviewArgs(["--help"], "/repo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });
});

describe("ignoreImportPreview — brownfield (count > 0)", () => {
  it("lists unique non-marker patterns from fast+deep, tagged with first-encountered tier", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**", "build/**"],
      }),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["build/**", "src/old/**"],
      }),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_empty).toBe(true);
    expect(r.count).toBe(3);
    expect(r.would_import).toEqual([
      { glob: "dist/**", tier: "fast" },
      { glob: "build/**", tier: "fast" },
      { glob: "src/old/**", tier: "deep" },
    ]);
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });

  it("ignores patterns inside the qualy markers (only outside slice imports)", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: [
          "outside/**",
          IGNORE_MARKER_START,
          "managed/**",
          IGNORE_MARKER_END,
        ],
      }),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({}),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.would_import).toEqual([{ glob: "outside/**", tier: "fast" }]);
  });
});

describe("ignoreImportPreview — pre-managed (count = 0)", () => {
  it("returns count 0 when patterns sit only inside the markers", () => {
    const managed = presetJson({
      ignorePatterns: [
        IGNORE_MARKER_START,
        "src/legacy/**",
        IGNORE_MARKER_END,
      ],
    });
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: managed,
      [`/repo/${PRESET_PATHS.deep}`]: managed,
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_empty).toBe(true);
    expect(r.count).toBe(0);
    expect(r.would_import).toEqual([]);
  });
});

describe("ignoreImportPreview — greenfield (count = 0)", () => {
  it("returns count 0 when neither preset has ignorePatterns", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({}),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({}),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_empty).toBe(true);
    expect(r.count).toBe(0);
  });

  it("returns count 0 when both presets are missing entirely", () => {
    const { io } = makeFakeFs({});
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_empty).toBe(true);
    expect(r.count).toBe(0);
    expect(r.would_import).toEqual([]);
  });

  it("skips a malformed preset (lenient — surfaced later by compile)", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{not json",
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.would_import).toEqual([{ glob: "dist/**", tier: "deep" }]);
  });
});

describe("ignoreImportPreview — manifest non-empty (skip)", () => {
  it("returns count 0 with manifest_empty=false when manifest already has entries", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**"],
      }),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest_empty).toBe(false);
    expect(r.count).toBe(0);
    expect(r.would_import).toEqual([]);
  });
});

describe("ignoreImportPreview — manifest corrupt", () => {
  it("returns INTERNAL_ERROR with error=manifest_corrupt for malformed JSON", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({}),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });

  it("returns INTERNAL_ERROR for unsupported version", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: JSON.stringify({
        version: 99,
        entries: [],
      }),
    });
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_unsupported_version");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});

describe("ignoreImportPreview — read-only", () => {
  it("does NOT mutate any file (manifest, presets, decision log)", () => {
    const { files, io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetJson({
        ignorePatterns: ["dist/**", "build/**"],
      }),
      [`/repo/${PRESET_PATHS.deep}`]: presetJson({
        ignorePatterns: ["src/old/**"],
      }),
    });
    const before = new Map(files);
    const r = ignoreImportPreview({ cwd: "/repo" }, { safeIO: io });
    expect(r.ok).toBe(true);
    expect(files.size).toBe(before.size);
    for (const [path, content] of before) {
      expect(files.get(path)).toBe(content);
    }
  });
});
