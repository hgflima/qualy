/**
 * Contract tests for `lib/ignore-drift.ts` (lint-ignore PLAN T4.1).
 *
 * Pinned invariants:
 *  - `manifest_absent` short-circuits with `recompiled: false`. Audit's hot
 *    path must stay cheap when the user has no ignore manifest.
 *  - `presets_fresh` short-circuits when both presets are newer-or-equal to
 *    the manifest mtime — drift gate stays free of FS reads.
 *  - When the manifest is newer than ANY tracked preset, recompile runs and
 *    `compileToBothPresets` writes the diff.
 *  - Manifest corruption surfaces (`manifest_corrupt`) so callers can
 *    refuse to proceed instead of silently running on stale presets.
 *  - TOCTOU: stat says manifest exists but loader returns null → degrade to
 *    `manifest_absent` rather than crashing.
 */
import { describe, expect, it } from "vitest";

import { type SafeIO } from "../../src/lib/fs-safe.ts";
import {
  type StatLike,
  checkDriftAndRecompile,
} from "../../src/lib/ignore-drift.ts";
import {
  IGNORE_MANIFEST_PATH,
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";

const ROOT = "/repo";

function makeFakeFs(seed: Record<string, string> = {}): {
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
    now: () => new Date("2026-05-05T12:00:00.000Z"),
  };
  return { files, io };
}

function statFromMap(mtimes: Record<string, number>) {
  return (path: string): StatLike | null => {
    const ms = mtimes[path];
    return typeof ms === "number" ? { mtimeMs: ms } : null;
  };
}

function manifestJson(): string {
  return (
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            id: "ign-aaaaaa",
            glob: "src/legacy/**",
            rule: null,
            reason: "manual edit",
            expires: null,
            createdAt: "2026-05-05T11:00:00.000Z",
            createdBy: "user",
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

const EMPTY_PRESET = "{}\n";

describe("checkDriftAndRecompile — short-circuits", () => {
  it("manifest absent → no-op (manifest_absent)", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1000,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(false);
    if (result.recompiled) return;
    expect(result.reason).toBe("manifest_absent");
    expect(result.files_changed).toEqual([]);
  });

  it("both presets missing → no-op (preset_missing)", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: manifestJson(),
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 2000,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(false);
    if (result.recompiled) return;
    expect(result.reason).toBe("preset_missing");
  });

  it("manifest older than both presets → no-op (presets_fresh)", () => {
    const { io, files } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: manifestJson(),
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const before = new Map(files);
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 6000,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(false);
    if (result.recompiled) return;
    expect(result.reason).toBe("presets_fresh");
    // Pure read path — no writes.
    expect([...files.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("manifest equal to oldest preset mtime → still considered fresh", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: manifestJson(),
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1500,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(false);
    if (result.recompiled) return;
    expect(result.reason).toBe("presets_fresh");
  });
});

describe("checkDriftAndRecompile — recompile path", () => {
  it("manifest newer than oldest preset → recompiles both presets", () => {
    const { io, files } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: manifestJson(),
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1000,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(true);
    if (!result.recompiled) return;
    expect(result.files_changed).toEqual([
      PRESET_PATHS.fast,
      PRESET_PATHS.deep,
    ]);

    const fast = JSON.parse(files.get(`${ROOT}/${PRESET_PATHS.fast}`)!);
    expect(fast.ignorePatterns).toEqual([
      IGNORE_MARKER_START,
      "src/legacy/**",
      IGNORE_MARKER_END,
    ]);
  });

  it("only fast preset present + manifest newer → triggers compile (which surfaces preset_missing for deep)", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: manifestJson(),
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
      }),
    });
    // compileToBothPresets requires both — bubbles up as `preset_missing`.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("preset_missing");
  });
});

describe("checkDriftAndRecompile — failure modes", () => {
  it("corrupt manifest surfaces manifest_corrupt error", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: "not-json{",
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1000,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_corrupt");
  });

  it("unsupported manifest version surfaces manifest_unsupported_version", () => {
    const { io } = makeFakeFs({
      [`${ROOT}/${IGNORE_MANIFEST_PATH}`]:
        JSON.stringify({ version: 99, entries: [] }) + "\n",
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1000,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_unsupported_version");
  });

  it("TOCTOU: stat sees manifest but loader returns null → degrades to manifest_absent", () => {
    // io.existsFn returns false → loadIgnoreManifest treats as absent. The
    // statFn still reports the file (simulating a delete-after-stat race).
    const { io } = makeFakeFs({
      [`${ROOT}/${PRESET_PATHS.fast}`]: EMPTY_PRESET,
      [`${ROOT}/${PRESET_PATHS.deep}`]: EMPTY_PRESET,
    });
    const result = checkDriftAndRecompile(ROOT, {
      safeIO: io,
      statFn: statFromMap({
        [`${ROOT}/${IGNORE_MANIFEST_PATH}`]: 5000,
        [`${ROOT}/${PRESET_PATHS.fast}`]: 1000,
        [`${ROOT}/${PRESET_PATHS.deep}`]: 1000,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recompiled).toBe(false);
    if (result.recompiled) return;
    expect(result.reason).toBe("manifest_absent");
  });
});
