/**
 * Contract tests for `commands/ignore/compile.ts` — the thin CLI handler that
 * wraps `lib/ignore-compile.ts#compileToBothPresets` (lint-ignore PLAN T2.3).
 *
 * Two modes:
 *   - default: writes any preset that is out-of-sync, returns
 *     `{ applied: string[] }`, exits OK.
 *   - `--check`: read-only drift detector, returns `{ in_sync: bool, drifted:
 *     string[] }`, exits `1` when drift is present (CI-friendly contract).
 */
import { describe, expect, it } from "vitest";

import {
  ignoreCompile,
  parseIgnoreCompileArgs,
} from "../../src/commands/ignore/compile.ts";
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

const MANIFEST_WITH_ONE_ENTRY = JSON.stringify(
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

describe("parseIgnoreCompileArgs", () => {
  it("defaults check=false, accepts --check", () => {
    const r1 = parseIgnoreCompileArgs([], "/repo");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.check).toBe(false);
    expect(r1.value.cwd).toBe("/repo");

    const r2 = parseIgnoreCompileArgs(["--check"], "/repo");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.check).toBe(true);
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreCompileArgs(["--bogus"], "/repo");
    expect(r.ok).toBe(false);
  });
});

describe("ignoreCompile — write mode", () => {
  it("returns applied=[] when no manifest exists (no-op)", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: false }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual([]);
  });

  it("writes both presets when drifted", () => {
    const { files, io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: false }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual([PRESET_PATHS.fast, PRESET_PATHS.deep]);
    const fast = JSON.parse(files.get(`/repo/${PRESET_PATHS.fast}`)!);
    expect(fast.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "src/legacy/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("returns applied=[] when presets are already in sync (idempotent)", () => {
    const synced = JSON.stringify(
      {
        ignorePatterns: [IGNORE_MARKER_START, "src/legacy/**", IGNORE_MARKER_END],
      },
      null,
      2,
    ) + "\n";
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: synced,
      [`/repo/${PRESET_PATHS.deep}`]: synced,
    });
    const r = ignoreCompile({ cwd: "/repo", check: false }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toEqual([]);
  });
});

describe("ignoreCompile — --check mode", () => {
  it("in_sync=true when presets match manifest", () => {
    const synced = JSON.stringify(
      {
        ignorePatterns: [IGNORE_MARKER_START, "src/legacy/**", IGNORE_MARKER_END],
      },
      null,
      2,
    ) + "\n";
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: synced,
      [`/repo/${PRESET_PATHS.deep}`]: synced,
    });
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.in_sync).toBe(true);
    expect(r.drifted).toEqual([]);
  });

  it("in_sync=false when presets differ from compiled output", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.in_sync).toBe(false);
    expect(r.drifted).toEqual([PRESET_PATHS.fast, PRESET_PATHS.deep]);
  });

  it("does NOT write when in --check mode (read-only)", () => {
    const { files, io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const before = files.get(`/repo/${PRESET_PATHS.fast}`);
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(true);
    expect(files.get(`/repo/${PRESET_PATHS.fast}`)).toBe(before);
  });
});

describe("ignoreCompile — manifest_corrupt", () => {
  it("returns INTERNAL_ERROR with error=manifest_corrupt when JSON is malformed", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: false }, io);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(r.reason).toBeDefined();
  });

  it("returns INTERNAL_ERROR with error=manifest_unsupported_version when version is unknown", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: JSON.stringify({ version: 99, entries: [] }),
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_unsupported_version");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});

describe("ignoreCompile — exit codes", () => {
  it("OK when applied", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: false }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });

  it("RECOVERABLE_ERROR when --check finds drift", () => {
    const { io } = makeFakeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: MANIFEST_WITH_ONE_ENTRY,
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("OK when --check finds no drift", () => {
    const { io } = makeFakeFs({
      [`/repo/${PRESET_PATHS.fast}`]: "{}\n",
      [`/repo/${PRESET_PATHS.deep}`]: "{}\n",
    });
    const r = ignoreCompile({ cwd: "/repo", check: true }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });
});
