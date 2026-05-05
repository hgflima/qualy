/**
 * Contract tests for `install-oxlint` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - Each stage emits the byte-exact preset bundled at
 *     `cli/src/presets/oxlint/<stage>.<tier>.json` to the project root as
 *     `oxlint.<tier>.json` — preset is the single source of truth (SPEC §3).
 *   - Manifest entries are recorded with `kind: "preset"` for both files so
 *     uninstall can clean them up later.
 *   - Stage source: explicit `--stage` overrides detection; otherwise
 *     `detectStage()` is consulted and its failure is surfaced.
 *   - `--strict` propagates to `safeWriteFile` (DIRTY_TREE on dirty tree).
 *   - Argument parser rejects malformed input with USAGE_ERROR.
 *   - Idempotency: running twice produces identical files and a single entry
 *     per path in the manifest.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installOxlint,
  parseInstallOxlintArgs,
} from "../../src/commands/install/oxlint.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";

const PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "presets",
  "oxlint",
);

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
  fixedNow: Date;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
    fixedNow,
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      files.set(p, c);
    },
    mkdirFn: () => {
      /* in-memory */
    },
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => fixedNow,
  };
}

function loadManifestFromMemory(io: { files: Map<string, string> }): Manifest | null {
  const manifestPath = join(ROOT, MANIFEST_FILENAME);
  const raw = io.files.get(manifestPath);
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

const STAGES = ["greenfield", "brownfield-moderate", "legacy"] as const;

describe("installOxlint — jsPlugins path resolution", () => {
  const resolveStub = (id: string, paths: readonly string[]): string => {
    if (id !== "quality-metrics") throw new Error(`unexpected id ${id}`);
    return `${paths[0]}/node_modules/quality-metrics/dist/index.js`;
  };

  it("rewrites the deep preset's jsPlugins[] with an absolute resolved path", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: resolveStub },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const written = io.files.get(join(ROOT, "oxlint.deep.json"));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as { jsPlugins?: unknown };
    expect(parsed.jsPlugins).toEqual([
      `${ROOT}/node_modules/quality-metrics/dist/index.js`,
    ]);
  });

  it("does not touch the fast preset (no jsPlugins to rewrite)", () => {
    const io = memoryIO();
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: resolveStub },
    );
    const fastBytes = readFileSync(join(PRESETS_DIR, "greenfield.fast.json"), "utf8");
    expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe(fastBytes);
  });

  it("returns quality_metrics_missing when require.resolve throws", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      {
        safeIO: io,
        resolveModule: () => {
          throw new Error("Cannot find module 'quality-metrics'");
        },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("quality_metrics_missing");
    expect(r.reason).toContain("quality-metrics");
    // Nothing should land on disk when we can't resolve the plugin.
    expect(io.files.has(join(ROOT, "oxlint.deep.json"))).toBe(false);
  });

  it("is idempotent: rerunning produces the same resolved path", () => {
    const io = memoryIO();
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: resolveStub },
    );
    const firstWrite = io.files.get(join(ROOT, "oxlint.deep.json"));
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: resolveStub },
    );
    expect(io.files.get(join(ROOT, "oxlint.deep.json"))).toBe(firstWrite);
  });
});

describe("installOxlint — manifest.stage", () => {
  const stubResolve = (id: string, paths: readonly string[]): string =>
    `${paths[0]}/node_modules/${id}/dist/index.js`;

  for (const stage of STAGES) {
    it(`records stage=${stage} on the manifest after writing presets`, () => {
      const io = memoryIO();
      installOxlint({ cwd: ROOT, stage }, { safeIO: io, resolveModule: stubResolve });
      const manifest = loadManifestFromMemory(io);
      expect(manifest).not.toBeNull();
      if (!manifest) return;
      expect(manifest.stage).toBe(stage);
    });
  }

  it("overwrites stage when re-installing for a different stage", () => {
    const io = memoryIO();
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: stubResolve },
    );
    installOxlint(
      { cwd: ROOT, stage: "legacy" },
      { safeIO: io, resolveModule: stubResolve },
    );
    expect(loadManifestFromMemory(io)?.stage).toBe("legacy");
  });
});

describe("installOxlint — explicit stage", () => {
  const stubResolve = (id: string, paths: readonly string[]): string => {
    if (id !== "quality-metrics") throw new Error(`unexpected id ${id}`);
    return `${paths[0]}/node_modules/quality-metrics/dist/index.js`;
  };

  for (const stage of STAGES) {
    it(`writes the fast preset byte-exact for stage=${stage}`, () => {
      const io = memoryIO();
      const r = installOxlint(
        { cwd: ROOT, stage },
        { safeIO: io, resolveModule: stubResolve },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.stage).toBe(stage);
      expect(r.stageSource).toBe("explicit");
      expect(r.written).toHaveLength(2);

      const fastBytes = readFileSync(join(PRESETS_DIR, `${stage}.fast.json`), "utf8");
      expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe(fastBytes);
    });

    it(`writes the deep preset with jsPlugins path resolved for stage=${stage}`, () => {
      const io = memoryIO();
      installOxlint({ cwd: ROOT, stage }, { safeIO: io, resolveModule: stubResolve });
      const written = io.files.get(join(ROOT, "oxlint.deep.json"));
      expect(written).toBeDefined();
      const parsed = JSON.parse(written!) as { jsPlugins?: unknown };
      expect(parsed.jsPlugins).toEqual([
        `${ROOT}/node_modules/quality-metrics/dist/index.js`,
      ]);
    });

    it(`records manifest entries with kind=preset for stage=${stage}`, () => {
      const io = memoryIO();
      installOxlint({ cwd: ROOT, stage }, { safeIO: io, resolveModule: stubResolve });
      const manifest = loadManifestFromMemory(io);
      expect(manifest).not.toBeNull();
      if (!manifest) return;
      const paths = manifest.entries.map((e) => e.path).sort();
      expect(paths).toEqual(["oxlint.deep.json", "oxlint.fast.json"]);
      for (const e of manifest.entries) {
        expect(e.kind).toBe("preset");
        expect(e.merged).toBeUndefined();
      }
    });
  }
});

describe("installOxlint — stage source", () => {
  const stubResolve = (id: string, paths: readonly string[]): string =>
    `${paths[0]}/node_modules/${id}/dist/index.js`;

  it("delegates to detectStage when --stage is omitted", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT },
      {
        safeIO: io,
        resolveModule: stubResolve,
        detectStageFn: () => ({
          ok: true,
          cwd: ROOT,
          stage: "brownfield-moderate",
          signals: {
            first_commit_date: null,
            age_days: null,
            source_files: 0,
            loc: 0,
            churn_90d: 0,
            has_tests: false,
            todo_count: 0,
            todo_density_per_100_loc: null,
            linter_present: false,
          },
          reasoning: "stub",
        }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("brownfield-moderate");
    expect(r.stageSource).toBe("detected");
    const fastBytes = readFileSync(
      join(PRESETS_DIR, "brownfield-moderate.fast.json"),
      "utf8",
    );
    expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe(fastBytes);
  });

  it("surfaces detect-stage failure as stage_detection_failed", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT },
      {
        safeIO: io,
        detectStageFn: () => ({ ok: false, error: "not a git repo" }),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("stage_detection_failed");
    expect(r.reason).toContain("not a git repo");
    expect(io.files.size).toBe(0);
  });
});

describe("installOxlint — error paths", () => {
  it("reports preset_read_failed when a preset cannot be loaded", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      {
        safeIO: io,
        readFileFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("preset_read_failed");
    expect(r.reason).toContain("ENOENT");
    // First write attempt is gated on read; nothing should land on disk.
    expect(io.files.has(join(ROOT, "oxlint.fast.json"))).toBe(false);
  });

  it("reports write_failed when --strict and tree is dirty", () => {
    const io: SafeIO & { files: Map<string, string> } = {
      ...memoryIO(),
      dirtyFilesFn: () => ({ ok: true, value: ["src/a.ts"] }),
    };
    const r = installOxlint(
      { cwd: ROOT, stage: "greenfield", strict: true },
      { safeIO: io },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });
});

describe("installOxlint — idempotency", () => {
  const stubResolve = (id: string, paths: readonly string[]): string =>
    `${paths[0]}/node_modules/${id}/dist/index.js`;

  it("rewriting the same stage leaves a single manifest entry per path", () => {
    const io = memoryIO();
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: stubResolve },
    );
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: stubResolve },
    );
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.entries).toHaveLength(2);
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual(["oxlint.deep.json", "oxlint.fast.json"]);
  });

  it("switching stages overwrites the deep preset with the new stage's thresholds", () => {
    const io = memoryIO();
    installOxlint(
      { cwd: ROOT, stage: "greenfield" },
      { safeIO: io, resolveModule: stubResolve },
    );
    installOxlint(
      { cwd: ROOT, stage: "legacy" },
      { safeIO: io, resolveModule: stubResolve },
    );
    const written = io.files.get(join(ROOT, "oxlint.deep.json"));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      rules?: Record<string, [string, { max: number }]>;
    };
    expect(parsed.rules?.["quality-metrics/wmc"]).toEqual(["warn", { max: 40 }]);
  });
});

describe("parseInstallOxlintArgs", () => {
  it("defaults to cwd=defaultCwd, no stage, strict=false", () => {
    const r = parseInstallOxlintArgs([], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/wd");
    expect(r.value.stage).toBeUndefined();
    expect(r.value.strict).toBe(false);
  });

  it("parses --cwd and --stage and --strict", () => {
    const r = parseInstallOxlintArgs(
      ["--cwd", "/proj", "--stage", "legacy", "--strict"],
      "/wd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
    expect(r.value.stage).toBe("legacy");
    expect(r.value.strict).toBe(true);
  });

  it("rejects unknown stage", () => {
    const r = parseInstallOxlintArgs(["--stage", "experimental"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid stage");
  });

  it("rejects missing --cwd / --stage value", () => {
    expect(parseInstallOxlintArgs(["--cwd"], "/wd").ok).toBe(false);
    expect(parseInstallOxlintArgs(["--stage"], "/wd").ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseInstallOxlintArgs(["--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseInstallOxlintArgs(["--help"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseInstallOxlintArgs(["-h"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
  });
});
