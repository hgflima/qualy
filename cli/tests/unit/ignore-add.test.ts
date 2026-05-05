/**
 * Contract tests for `commands/ignore/add.ts` (lint-ignore PLAN T2.4 —
 * path-only `qualy ignore-add <glob> --reason <text>`).
 *
 * Pins the SPEC §3.1 + §10 #1, #8, #9 contract:
 *   - validates glob/reason/expires (exit 1 RECOVERABLE_ERROR on each).
 *   - `--strict` + dirty tree → exit 3 DIRTY_TREE.
 *   - manifest corrupt → exit 70 INTERNAL_ERROR.
 *   - first add → action=added; re-add same glob → action=updated, kind in
 *     decision log flips to `ignore-update`, manifest entry count stays at 1.
 *   - writes manifest, recompiles fast+deep presets between markers, appends
 *     a single entry to `.harn/qualy/docs/lint-decisions.md`.
 *   - `--reason` parser missing-flag handling → exit 4 USAGE_ERROR upstream.
 */
import { describe, expect, it } from "vitest";

import {
  ignoreAdd,
  parseIgnoreAddArgs,
} from "../../src/commands/ignore/add.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";
import {
  DECISION_LOG_PATH,
  IGNORE_MANIFEST_PATH,
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");
const TPL_PATH = "/fake/templates/lint-decisions.md.tpl";
const TEMPLATE = `# Lint decisions

(stub template)

## Entries

<!-- qualy:entries-start -->
<!-- qualy:entries-end -->
`;

interface FakeFs {
  readonly files: Map<string, string>;
  readonly io: SafeIO;
}

function makeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  // The decision-log template is read via the `readFileFn` injected on the
  // command deps (not via SafeIO); seeding it under the same map keeps a
  // single source for the fake.
  files.set(TPL_PATH, TEMPLATE);
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

function emptyPreset(): string {
  return JSON.stringify({}, null, 2) + "\n";
}

function deps(fs: FakeFs, extra: Record<string, unknown> = {}) {
  return {
    safeIO: fs.io,
    readFileFn: (p: string) => fs.files.get(p) ?? null,
    authorFn: () => "alice@example.com",
    now: () => NOW,
    templatePath: TPL_PATH,
    // No legacy `docs/lint-decisions.md` in the fake; migration is a no-op.
    migrationDeps: {
      existsFn: (p: string) => fs.files.has(p),
      readFileFn: (p: string) => fs.files.get(p) ?? null,
      writeFileFn: (p: string, content: string) => {
        fs.files.set(p, content);
      },
      mkdirFn: () => {},
      mvFn: () => {},
      gitTracksFn: () => false,
      gitMvFn: () => true,
      now: () => NOW,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// parseIgnoreAddArgs
// ---------------------------------------------------------------------------

describe("parseIgnoreAddArgs", () => {
  it("accepts glob as positional + --reason", () => {
    const r = parseIgnoreAddArgs(
      ["src/legacy/**", "--reason", "legacy code"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("src/legacy/**");
    expect(r.value.reason).toBe("legacy code");
    expect(r.value.expires).toBeNull();
    expect(r.value.strict).toBe(false);
    expect(r.value.cwd).toBe("/repo");
  });

  it("accepts --glob explicitly", () => {
    const r = parseIgnoreAddArgs(
      ["--glob", "a/**", "--reason", "x"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("a/**");
  });

  it("parses --expires and --strict", () => {
    const r = parseIgnoreAddArgs(
      ["a/**", "--reason", "x", "--expires", "2026-09-30", "--strict"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expires).toBe("2026-09-30");
    expect(r.value.strict).toBe(true);
  });

  it("rejects when --reason is missing (USAGE_ERROR)", () => {
    const r = parseIgnoreAddArgs(["a/**"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("rejects when glob is missing", () => {
    const r = parseIgnoreAddArgs(["--reason", "x"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreAddArgs(
      ["a/**", "--reason", "x", "--bogus"],
      "/repo",
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ignoreAdd — happy path
// ---------------------------------------------------------------------------

describe("ignoreAdd — happy path", () => {
  it("adds a new entry, recompiles both presets, appends decision (action=added)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "Codebase legado",
        expires: null,
      },
      deps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("added");
    expect(r.glob).toBe("src/legacy/**");
    expect(r.rule).toBeNull();
    expect(r.id.startsWith("ign-")).toBe(true);
    expect(r.exitCode).toBe(EXIT_CODES.OK);

    // Manifest was written.
    const manifestRaw = fs.files.get(`/repo/${IGNORE_MANIFEST_PATH}`);
    expect(manifestRaw).toBeDefined();
    const manifest = JSON.parse(manifestRaw!);
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].glob).toBe("src/legacy/**");
    expect(manifest.entries[0].rule).toBeNull();
    expect(manifest.entries[0].createdBy).toBe("user");

    // Both presets were rewritten with the managed marker block.
    for (const tier of ["fast", "deep"] as const) {
      const presetRaw = fs.files.get(`/repo/${PRESET_PATHS[tier]}`);
      expect(presetRaw).toBeDefined();
      const preset = JSON.parse(presetRaw!);
      expect(preset.ignorePatterns).toEqual([
        IGNORE_MARKER_START,
        "src/legacy/**",
        IGNORE_MARKER_END,
      ]);
    }

    // Decision log was created and contains an `ignore-add` entry.
    const log = fs.files.get(`/repo/${DECISION_LOG_PATH}`);
    expect(log).toBeDefined();
    expect(log).toMatch(/ignore-add: src\/legacy\/\*\* \(path-only\)/);
    expect(log).toMatch(/- \*\*kind\*\*: ignore-add/);
    expect(log).toMatch(/- \*\*reason\*\*: Codebase legado/);
    expect(log).toMatch(/- \*\*author\*\*: alice@example\.com/);

    // files_changed reports manifest, both presets, decision log.
    expect(r.files_changed).toContain(IGNORE_MANIFEST_PATH);
    expect(r.files_changed).toContain(PRESET_PATHS.fast);
    expect(r.files_changed).toContain(PRESET_PATHS.deep);
    expect(r.files_changed).toContain(DECISION_LOG_PATH);
  });

  it("re-adding the same glob updates in place (action=updated, kind=ignore-update)", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const first = ignoreAdd(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "first reason",
        expires: null,
      },
      deps(fs),
    );
    expect(first.ok).toBe(true);

    const second = ignoreAdd(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "second reason",
        expires: "2026-09-30",
      },
      deps(fs),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("updated");

    // Manifest stays at 1 entry, with the updated reason/expires.
    const manifest = JSON.parse(
      fs.files.get(`/repo/${IGNORE_MANIFEST_PATH}`)!,
    );
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].reason).toBe("second reason");
    expect(manifest.entries[0].expires).toBe("2026-09-30");

    // Decision log carries both entries (append-only).
    const log = fs.files.get(`/repo/${DECISION_LOG_PATH}`)!;
    const addCount = (log.match(/kind\*\*: ignore-add\b/g) ?? []).length;
    const updateCount = (log.match(/kind\*\*: ignore-update\b/g) ?? []).length;
    expect(addCount).toBe(1);
    expect(updateCount).toBe(1);
  });

  it("preserves user patterns outside the qualy markers in presets", () => {
    const presetWithUserPattern =
      JSON.stringify(
        {
          ignorePatterns: ["dist/**", "build/**"],
        },
        null,
        2,
      ) + "\n";
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: presetWithUserPattern,
      [`/repo/${PRESET_PATHS.deep}`]: presetWithUserPattern,
    });
    const r = ignoreAdd(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "legacy",
        expires: null,
      },
      deps(fs),
    );
    expect(r.ok).toBe(true);

    const fast = JSON.parse(fs.files.get(`/repo/${PRESET_PATHS.fast}`)!);
    expect(fast.ignorePatterns).toEqual([
      "dist/**",
      "build/**",
      IGNORE_MARKER_START,
      "src/legacy/**",
      IGNORE_MARKER_END,
    ]);
  });
});

// ---------------------------------------------------------------------------
// ignoreAdd — validation errors
// ---------------------------------------------------------------------------

describe("ignoreAdd — validation", () => {
  it("rejects empty glob → exit 1 invalid_glob", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      { cwd: "/repo", glob: "", reason: "x", expires: null },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_glob");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("rejects empty reason → exit 1 reason_required", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      { cwd: "/repo", glob: "a/**", reason: "   ", expires: null },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reason_required");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("rejects past expires → exit 1 invalid_expires", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      {
        cwd: "/repo",
        glob: "a/**",
        reason: "x",
        expires: "2026-04-01",
      },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_expires");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });
});

// ---------------------------------------------------------------------------
// ignoreAdd — strict / dirty tree
// ---------------------------------------------------------------------------

describe("ignoreAdd — --strict", () => {
  it("refuses dirty tree under --strict → exit 3 DIRTY_TREE", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      {
        cwd: "/repo",
        glob: "a/**",
        reason: "x",
        expires: null,
        strict: true,
      },
      deps(fs, {
        dirtyFilesFn: () => ({ ok: true, value: ["src/index.ts"] }),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("dirty_tree");
    expect(r.exitCode).toBe(EXIT_CODES.DIRTY_TREE);
    // Nothing was written.
    expect(fs.files.has(`/repo/${IGNORE_MANIFEST_PATH}`)).toBe(false);
  });

  it("proceeds when strict is set and tree is clean", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreAdd(
      {
        cwd: "/repo",
        glob: "a/**",
        reason: "x",
        expires: null,
        strict: true,
      },
      deps(fs, { dirtyFilesFn: () => ({ ok: true, value: [] }) }),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ignoreAdd — manifest corrupt
// ---------------------------------------------------------------------------

describe("ignoreAdd — manifest corrupt", () => {
  it("returns INTERNAL_ERROR when ignore.json is malformed JSON", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
    });
    const r = ignoreAdd(
      { cwd: "/repo", glob: "a/**", reason: "x", expires: null },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });

  it("returns INTERNAL_ERROR when ignore.json declares an unsupported version", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
      [`/repo/${IGNORE_MANIFEST_PATH}`]: JSON.stringify({
        version: 99,
        entries: [],
      }),
    });
    const r = ignoreAdd(
      { cwd: "/repo", glob: "a/**", reason: "x", expires: null },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_unsupported_version");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});

// ---------------------------------------------------------------------------
// ignoreAdd — preset missing
// ---------------------------------------------------------------------------

describe("ignoreAdd — preset missing", () => {
  it("returns RECOVERABLE_ERROR when oxlint preset is absent", () => {
    const fs = makeFs({}); // no presets
    const r = ignoreAdd(
      { cwd: "/repo", glob: "a/**", reason: "x", expires: null },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_missing");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });
});
