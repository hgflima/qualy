/**
 * Contract tests for `install-husky` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - `.husky/pre-commit` is created (mode 0o755) with a script that invokes
 *     `npx lint-staged`. Re-running on a project where the script already
 *     references "lint-staged" is action="unchanged"; presence of unrelated
 *     content is action="kept" (no clobber — harness owns the question).
 *   - lint-staged config is created from the bundled template ONLY when no
 *     pre-existing config (10 file probes + `package.json#lint-staged`) is
 *     present; otherwise action="kept" with `path` pointing at the survivor.
 *   - Filename selection: `.lintstagedrc.js` for `"type":"module"` packages,
 *     `.lintstagedrc.mjs` otherwise (or when package.json is absent/malformed).
 *   - Manifest entries: `kind: "husky"` for the script, `kind: "lintstaged"`
 *     for the config; neither carries `merged: true` (qualy owns both files).
 *   - `--strict` propagates to safeWriteFile.
 *   - Argument parser rejects malformed input with USAGE_ERROR.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  chooseLintstagedFilename,
  detectExistingLintstaged,
  installHusky,
  parseInstallHuskyArgs,
} from "../../src/commands/install/husky.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "templates",
  "lintstagedrc.example.js",
);

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

interface MemoryIO extends SafeIO {
  files: Map<string, string>;
  modes: Map<string, number>;
  fixedNow: Date;
}

function memoryIO(initial: Record<string, string> = {}): MemoryIO {
  const files = new Map<string, string>(Object.entries(initial));
  const modes = new Map<string, number>();
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
    modes,
    fixedNow,
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c, mode) => {
      files.set(p, c);
      if (typeof mode === "number") modes.set(p, mode);
    },
    mkdirFn: () => {
      /* in-memory */
    },
    removeFn: (p) => {
      files.delete(p);
      modes.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => fixedNow,
  };
}

function loadManifestFromMemory(io: MemoryIO): Manifest | null {
  const raw = io.files.get(join(ROOT, MANIFEST_FILENAME));
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

const HUSKY_ABS = join(ROOT, ".husky", "pre-commit");
const PKG_ABS = join(ROOT, "package.json");
const LSRC_MJS_ABS = join(ROOT, ".lintstagedrc.mjs");
const LSRC_JS_ABS = join(ROOT, ".lintstagedrc.js");

/**
 * Most tests use the in-memory IO for both safe writes AND template/file reads,
 * so we wire `readFileFn` and `existsFn` from the same map plus pre-seed the
 * template path so installHusky can resolve it without touching disk.
 */
function fullIO(initial: Record<string, string> = {}): MemoryIO {
  const templateBytes = readFileSync(TEMPLATE_PATH, "utf8");
  return memoryIO({ [TEMPLATE_PATH]: templateBytes, ...initial });
}

function depsFor(io: MemoryIO): Parameters<typeof installHusky>[1] {
  return {
    safeIO: io,
    readFileFn: (p: string) => io.files.get(p) ?? null,
    existsFn: (p: string) => io.files.has(p),
  };
}

describe("installHusky — fresh project", () => {
  it("creates .husky/pre-commit with lint-staged invocation and mode 0o755", () => {
    const io = fullIO();
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.husky.action).toBe("created");
    expect(r.husky.recorded).toBe(true);
    const body = io.files.get(HUSKY_ABS);
    expect(body).toBeDefined();
    expect(body).toContain("lint-staged");
    expect(body).toMatch(/^#!\/usr\/bin\/env sh\n/);
    expect(io.modes.get(HUSKY_ABS)).toBe(0o755);
  });

  it("writes .lintstagedrc.mjs by default (no package.json)", () => {
    const io = fullIO();
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.action).toBe("created");
    expect(r.lintstaged.path).toBe(".lintstagedrc.mjs");
    const body = io.files.get(LSRC_MJS_ABS);
    expect(body).toBeDefined();
    expect(body).toBe(readFileSync(TEMPLATE_PATH, "utf8"));
    expect(io.files.has(LSRC_JS_ABS)).toBe(false);
  });

  it("writes .lintstagedrc.js when package.json#type=module", () => {
    const io = fullIO({ [PKG_ABS]: JSON.stringify({ type: "module" }) });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.path).toBe(".lintstagedrc.js");
    expect(io.files.has(LSRC_JS_ABS)).toBe(true);
    expect(io.files.has(LSRC_MJS_ABS)).toBe(false);
  });

  it("falls back to .mjs when package.json is malformed", () => {
    const io = fullIO({ [PKG_ABS]: "{ broken" });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.path).toBe(".lintstagedrc.mjs");
  });

  it("records husky=kind:husky and lintstaged=kind:lintstaged with no merged flag", () => {
    const io = fullIO();
    installHusky({ cwd: ROOT }, depsFor(io));
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const byPath = new Map(m.entries.map((e) => [e.path, e]));
    expect(byPath.get(".husky/pre-commit")?.kind).toBe("husky");
    expect(byPath.get(".husky/pre-commit")?.merged).toBeUndefined();
    expect(byPath.get(".lintstagedrc.mjs")?.kind).toBe("lintstaged");
    expect(byPath.get(".lintstagedrc.mjs")?.merged).toBeUndefined();
  });
});

describe("installHusky — pre-existing .husky/pre-commit", () => {
  it("returns action=unchanged when existing script already calls lint-staged", () => {
    const io = fullIO({
      [HUSKY_ABS]: "#!/usr/bin/env sh\nset -e\nyarn lint-staged --concurrent false\n",
    });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.husky.action).toBe("unchanged");
    expect(r.husky.recorded).toBe(false);
    // Bytes preserved.
    expect(io.files.get(HUSKY_ABS)).toContain("yarn lint-staged");
  });

  it("returns action=kept (no overwrite) when existing script does not invoke lint-staged", () => {
    const original = "#!/usr/bin/env sh\nnpm test -- --bail\n";
    const io = fullIO({ [HUSKY_ABS]: original });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.husky.action).toBe("kept");
    expect(r.husky.recorded).toBe(false);
    expect(io.files.get(HUSKY_ABS)).toBe(original);
  });
});

describe("installHusky — pre-existing lint-staged config", () => {
  it("keeps an existing .lintstagedrc.json without writing", () => {
    const lsAbs = join(ROOT, ".lintstagedrc.json");
    const original = JSON.stringify({ "*.js": "eslint --fix" });
    const io = fullIO({ [lsAbs]: original });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.action).toBe("kept");
    expect(r.lintstaged.path).toBe(".lintstagedrc.json");
    expect(r.lintstaged.recorded).toBe(false);
    expect(io.files.get(lsAbs)).toBe(original);
    expect(io.files.has(LSRC_MJS_ABS)).toBe(false);
    expect(io.files.has(LSRC_JS_ABS)).toBe(false);
  });

  it("keeps an existing lint-staged.config.cjs", () => {
    const lsAbs = join(ROOT, "lint-staged.config.cjs");
    const io = fullIO({ [lsAbs]: "module.exports = {};" });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.action).toBe("kept");
    expect(r.lintstaged.path).toBe("lint-staged.config.cjs");
  });

  it("keeps inline package.json#lint-staged config", () => {
    const io = fullIO({
      [PKG_ABS]: JSON.stringify({
        type: "module",
        "lint-staged": { "*.ts": "eslint" },
      }),
    });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.action).toBe("kept");
    expect(r.lintstaged.path).toBe("package.json#lint-staged");
    // Even though type=module suggested .js, no file is written.
    expect(io.files.has(LSRC_JS_ABS)).toBe(false);
  });

  it("file-based config takes precedence over inline package.json key", () => {
    const lsAbs = join(ROOT, ".lintstagedrc.yaml");
    const io = fullIO({
      [lsAbs]: "*.ts: eslint\n",
      [PKG_ABS]: JSON.stringify({ "lint-staged": { "*.js": "x" } }),
    });
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lintstaged.path).toBe(".lintstagedrc.yaml");
  });
});

describe("installHusky — error paths", () => {
  it("reports template_read_failed when the bundled template is missing", () => {
    const io = memoryIO(); // template NOT pre-seeded
    const r = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("template_read_failed");
    // Husky was created BEFORE the template read, so it lands; that's ok —
    // uninstall (Phase 3) will remove it via the manifest entry.
    expect(io.files.has(HUSKY_ABS)).toBe(true);
    expect(io.files.has(LSRC_MJS_ABS)).toBe(false);
  });

  it("reports write_failed with DIRTY_TREE-friendly reason on --strict + dirty", () => {
    const io = fullIO();
    io.dirtyFilesFn = () => ({ ok: true, value: ["src/a.ts"] });
    const r = installHusky({ cwd: ROOT, strict: true }, depsFor(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });

  it("does not write lintstaged when husky write fails on --strict + dirty", () => {
    const io = fullIO();
    io.dirtyFilesFn = () => ({ ok: true, value: ["src/a.ts"] });
    installHusky({ cwd: ROOT, strict: true }, depsFor(io));
    expect(io.files.has(HUSKY_ABS)).toBe(false);
    expect(io.files.has(LSRC_MJS_ABS)).toBe(false);
  });
});

describe("installHusky — idempotency", () => {
  it("re-running yields a single manifest entry per path", () => {
    const io = fullIO();
    installHusky({ cwd: ROOT }, depsFor(io));
    installHusky({ cwd: ROOT }, depsFor(io));
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    // Second run sees the existing pre-commit and skips both writes; manifest
    // stays at exactly the entries from the first run.
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual([".husky/pre-commit", ".lintstagedrc.mjs"]);
  });

  it("second run is action=unchanged for husky and action=kept for lintstaged", () => {
    const io = fullIO();
    installHusky({ cwd: ROOT }, depsFor(io));
    const r2 = installHusky({ cwd: ROOT }, depsFor(io));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.husky.action).toBe("unchanged");
    expect(r2.lintstaged.action).toBe("kept");
    expect(r2.lintstaged.path).toBe(".lintstagedrc.mjs");
  });
});

describe("chooseLintstagedFilename — pure helper", () => {
  it("returns .lintstagedrc.mjs when raw is null", () => {
    expect(chooseLintstagedFilename(null)).toBe(".lintstagedrc.mjs");
  });

  it("returns .lintstagedrc.mjs on parse failure", () => {
    expect(chooseLintstagedFilename("{ not json")).toBe(".lintstagedrc.mjs");
  });

  it("returns .lintstagedrc.mjs on array root", () => {
    expect(chooseLintstagedFilename("[]")).toBe(".lintstagedrc.mjs");
  });

  it("returns .lintstagedrc.mjs when type is missing", () => {
    expect(chooseLintstagedFilename(JSON.stringify({ name: "x" }))).toBe(".lintstagedrc.mjs");
  });

  it("returns .lintstagedrc.mjs when type=commonjs", () => {
    expect(chooseLintstagedFilename(JSON.stringify({ type: "commonjs" }))).toBe(
      ".lintstagedrc.mjs",
    );
  });

  it("returns .lintstagedrc.js when type=module", () => {
    expect(chooseLintstagedFilename(JSON.stringify({ type: "module" }))).toBe(".lintstagedrc.js");
  });
});

describe("detectExistingLintstaged — pure helper", () => {
  it("returns null when nothing is present", () => {
    const exists = (_p: string) => false;
    const read = (_p: string) => null;
    expect(detectExistingLintstaged(ROOT, exists, read)).toBeNull();
  });

  it("returns the first matching config filename", () => {
    const present = new Set([join(ROOT, ".lintstagedrc.js")]);
    const exists = (p: string) => present.has(p);
    expect(detectExistingLintstaged(ROOT, exists, () => null)).toBe(".lintstagedrc.js");
  });

  it("respects probe order (early entries win over later ones)", () => {
    const present = new Set([
      join(ROOT, ".lintstagedrc.json"),
      join(ROOT, "lint-staged.config.mjs"),
    ]);
    const exists = (p: string) => present.has(p);
    expect(detectExistingLintstaged(ROOT, exists, () => null)).toBe(".lintstagedrc.json");
  });

  it("detects inline package.json#lint-staged", () => {
    const exists = (_p: string) => false;
    const read = (p: string) =>
      p === join(ROOT, "package.json")
        ? JSON.stringify({ "lint-staged": { "*.ts": "x" } })
        : null;
    expect(detectExistingLintstaged(ROOT, exists, read)).toBe("package.json#lint-staged");
  });

  it("ignores malformed package.json", () => {
    const exists = (_p: string) => false;
    const read = (p: string) => (p === join(ROOT, "package.json") ? "{ broken" : null);
    expect(detectExistingLintstaged(ROOT, exists, read)).toBeNull();
  });
});

describe("parseInstallHuskyArgs", () => {
  it("defaults to cwd=defaultCwd and strict=false", () => {
    const r = parseInstallHuskyArgs([], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/wd");
    expect(r.value.strict).toBe(false);
  });

  it("parses --cwd and --strict", () => {
    const r = parseInstallHuskyArgs(["--cwd", "/proj", "--strict"], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
    expect(r.value.strict).toBe(true);
  });

  it("rejects missing --cwd value", () => {
    expect(parseInstallHuskyArgs(["--cwd"], "/wd").ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseInstallHuskyArgs(["--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseInstallHuskyArgs(["--help"], "/wd")).toEqual({ ok: false, error: "help" });
    expect(parseInstallHuskyArgs(["-h"], "/wd")).toEqual({ ok: false, error: "help" });
  });
});
