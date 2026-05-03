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

describe("installOxlint — explicit stage", () => {
  for (const stage of STAGES) {
    it(`writes byte-exact fast+deep presets for stage=${stage}`, () => {
      const io = memoryIO();
      const r = installOxlint({ cwd: ROOT, stage }, { safeIO: io });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.stage).toBe(stage);
      expect(r.stageSource).toBe("explicit");
      expect(r.written).toHaveLength(2);

      const fastBytes = readFileSync(join(PRESETS_DIR, `${stage}.fast.json`), "utf8");
      const deepBytes = readFileSync(join(PRESETS_DIR, `${stage}.deep.json`), "utf8");
      expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe(fastBytes);
      expect(io.files.get(join(ROOT, "oxlint.deep.json"))).toBe(deepBytes);
    });

    it(`records manifest entries with kind=preset for stage=${stage}`, () => {
      const io = memoryIO();
      installOxlint({ cwd: ROOT, stage }, { safeIO: io });
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
  it("delegates to detectStage when --stage is omitted", () => {
    const io = memoryIO();
    const r = installOxlint(
      { cwd: ROOT },
      {
        safeIO: io,
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
  it("rewriting the same stage leaves a single manifest entry per path", () => {
    const io = memoryIO();
    installOxlint({ cwd: ROOT, stage: "greenfield" }, { safeIO: io });
    installOxlint({ cwd: ROOT, stage: "greenfield" }, { safeIO: io });
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.entries).toHaveLength(2);
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual(["oxlint.deep.json", "oxlint.fast.json"]);
  });

  it("switching stages overwrites the file in place", () => {
    const io = memoryIO();
    installOxlint({ cwd: ROOT, stage: "greenfield" }, { safeIO: io });
    installOxlint({ cwd: ROOT, stage: "legacy" }, { safeIO: io });
    const legacyDeep = readFileSync(join(PRESETS_DIR, "legacy.deep.json"), "utf8");
    expect(io.files.get(join(ROOT, "oxlint.deep.json"))).toBe(legacyDeep);
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
