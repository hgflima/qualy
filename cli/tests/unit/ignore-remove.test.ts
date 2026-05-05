/**
 * Contract tests for `commands/ignore/remove.ts` (lint-ignore PLAN T2.5
 * remove slot).
 *
 * Pins SPEC §3.2 + §10 #8:
 *   - reason mandatory → exit 1 reason_required.
 *   - glob match exact (no fuzzy) → entry_not_found when no match.
 *   - multiple matches without --rule → entry_ambiguous (exit 1) carrying
 *     `candidates[]` for the slash command to disambiguate.
 *   - --rule path resolves to `null`; --rule <name> resolves per-rule entry.
 *   - happy path: removes entry, recompiles both presets, appends
 *     `ignore-remove` decision.
 *   - --strict + dirty tree → exit 3 DIRTY_TREE.
 *   - manifest corrupt → exit 70 INTERNAL_ERROR.
 */
import { describe, expect, it } from "vitest";

import {
  ignoreRemove,
  parseIgnoreRemoveArgs,
} from "../../src/commands/ignore/remove.ts";
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

function presetWithManaged(globs: string[]): string {
  return (
    JSON.stringify(
      {
        ignorePatterns: [IGNORE_MARKER_START, ...globs, IGNORE_MARKER_END],
      },
      null,
      2,
    ) + "\n"
  );
}

function manifest(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, entries }, null, 2) + "\n";
}

function deps(fs: FakeFs, extra: Record<string, unknown> = {}) {
  return {
    safeIO: fs.io,
    readFileFn: (p: string) => fs.files.get(p) ?? null,
    authorFn: () => "alice@example.com",
    now: () => NOW,
    templatePath: TPL_PATH,
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

const ENTRY_PATH_ONLY = {
  id: "ign-c34c5e", // sha256("src/legacy/**|").slice(0, 6); not asserted.
  glob: "src/legacy/**",
  rule: null,
  reason: "legacy",
  expires: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  createdBy: "user",
};
const ENTRY_PER_RULE = {
  id: "ign-perrule",
  glob: "src/legacy/**",
  rule: "quality-metrics/wmc",
  reason: "wmc",
  expires: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  createdBy: "user",
};

// ---------------------------------------------------------------------------
// parseIgnoreRemoveArgs
// ---------------------------------------------------------------------------

describe("parseIgnoreRemoveArgs", () => {
  it("accepts glob positional + --reason", () => {
    const r = parseIgnoreRemoveArgs(
      ["src/legacy/**", "--reason", "no longer needed"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("src/legacy/**");
    expect(r.value.reason).toBe("no longer needed");
    expect(r.value.rule).toBeUndefined();
    expect(r.value.strict).toBe(false);
  });

  it("accepts --rule path and --rule <name>", () => {
    const a = parseIgnoreRemoveArgs(
      ["src/legacy/**", "--rule", "path", "--reason", "x"],
      "/repo",
    );
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.value.rule).toBe("path");

    const b = parseIgnoreRemoveArgs(
      ["src/legacy/**", "--rule", "quality-metrics/wmc", "--reason", "x"],
      "/repo",
    );
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.rule).toBe("quality-metrics/wmc");
  });

  it("rejects when glob is missing", () => {
    const r = parseIgnoreRemoveArgs(["--reason", "x"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("rejects when --reason is missing", () => {
    const r = parseIgnoreRemoveArgs(["src/legacy/**"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreRemoveArgs(
      ["a/**", "--reason", "x", "--bogus"],
      "/repo",
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ignoreRemove — happy path
// ---------------------------------------------------------------------------

describe("ignoreRemove — happy path", () => {
  it("removes the only matching entry, recompiles presets, appends decision", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH_ONLY]),
      [`/repo/${PRESET_PATHS.fast}`]: presetWithManaged(["src/legacy/**"]),
      [`/repo/${PRESET_PATHS.deep}`]: presetWithManaged(["src/legacy/**"]),
    });
    const r = ignoreRemove(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "no longer needed",
      },
      deps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.glob).toBe("src/legacy/**");
    expect(r.rule).toBeNull();
    expect(r.exitCode).toBe(EXIT_CODES.OK);

    // Manifest now empty.
    const m = JSON.parse(fs.files.get(`/repo/${IGNORE_MANIFEST_PATH}`)!);
    expect(m.entries).toHaveLength(0);

    // Both presets recompiled (markers without the glob).
    for (const tier of ["fast", "deep"] as const) {
      const preset = JSON.parse(fs.files.get(`/repo/${PRESET_PATHS[tier]}`)!);
      expect(preset.ignorePatterns).toEqual([
        IGNORE_MARKER_START,
        IGNORE_MARKER_END,
      ]);
    }

    // Decision log carries the ignore-remove block.
    const log = fs.files.get(`/repo/${DECISION_LOG_PATH}`)!;
    expect(log).toMatch(/ignore-remove: src\/legacy\/\*\* \(\(path-only\)\)/);
    expect(log).toMatch(/- \*\*kind\*\*: ignore-remove/);
    expect(log).toMatch(/- \*\*reason\*\*: no longer needed/);
    expect(log).toMatch(/- \*\*author\*\*: alice@example\.com/);

    expect(r.files_changed).toContain(IGNORE_MANIFEST_PATH);
    expect(r.files_changed).toContain(PRESET_PATHS.fast);
    expect(r.files_changed).toContain(PRESET_PATHS.deep);
    expect(r.files_changed).toContain(DECISION_LOG_PATH);
  });

  it("disambiguates by --rule when multiple entries share the glob", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        ENTRY_PATH_ONLY,
        ENTRY_PER_RULE,
      ]),
      [`/repo/${PRESET_PATHS.fast}`]: presetWithManaged(["src/legacy/**"]),
      [`/repo/${PRESET_PATHS.deep}`]: presetWithManaged(["src/legacy/**"]),
    });
    const r = ignoreRemove(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        rule: "path",
        reason: "drop the broad ignore",
      },
      deps(fs),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).toBeNull();

    const m = JSON.parse(fs.files.get(`/repo/${IGNORE_MANIFEST_PATH}`)!);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].rule).toBe("quality-metrics/wmc");
  });
});

// ---------------------------------------------------------------------------
// ignoreRemove — error cases
// ---------------------------------------------------------------------------

describe("ignoreRemove — errors", () => {
  it("rejects empty reason → exit 1 reason_required", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH_ONLY]),
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreRemove(
      { cwd: "/repo", glob: "src/legacy/**", reason: "   " },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("reason_required");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("returns entry_not_found when manifest is empty/absent", () => {
    const fs = makeFs({
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreRemove(
      { cwd: "/repo", glob: "src/legacy/**", reason: "x" },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_not_found");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("returns entry_not_found when the glob/rule pair is unknown", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH_ONLY]),
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreRemove(
      { cwd: "/repo", glob: "nonexistent/**", reason: "x" },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_not_found");
  });

  it("returns entry_ambiguous when glob matches multiple entries and no --rule", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        ENTRY_PATH_ONLY,
        ENTRY_PER_RULE,
      ]),
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreRemove(
      { cwd: "/repo", glob: "src/legacy/**", reason: "x" },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_ambiguous");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    expect(r.candidates).toHaveLength(2);
    // Manifest must remain untouched on ambiguous miss.
    const m = JSON.parse(fs.files.get(`/repo/${IGNORE_MANIFEST_PATH}`)!);
    expect(m.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ignoreRemove — --strict / dirty tree
// ---------------------------------------------------------------------------

describe("ignoreRemove — --strict", () => {
  it("refuses dirty tree under --strict → exit 3 DIRTY_TREE", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH_ONLY]),
      [`/repo/${PRESET_PATHS.fast}`]: presetWithManaged(["src/legacy/**"]),
      [`/repo/${PRESET_PATHS.deep}`]: presetWithManaged(["src/legacy/**"]),
    });
    const r = ignoreRemove(
      {
        cwd: "/repo",
        glob: "src/legacy/**",
        reason: "x",
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
  });
});

// ---------------------------------------------------------------------------
// ignoreRemove — manifest corrupt
// ---------------------------------------------------------------------------

describe("ignoreRemove — manifest corrupt", () => {
  it("returns INTERNAL_ERROR when ignore.json is malformed JSON", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
      [`/repo/${PRESET_PATHS.fast}`]: emptyPreset(),
      [`/repo/${PRESET_PATHS.deep}`]: emptyPreset(),
    });
    const r = ignoreRemove(
      { cwd: "/repo", glob: "src/legacy/**", reason: "x" },
      deps(fs),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});
