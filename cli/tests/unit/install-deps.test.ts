/**
 * Contract tests for `install-deps` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - Default mode installs `DEFAULT_DEPS` (oxlint, oxfmt, quality-metrics, ts-morph).
 *   - `--deps <json>` array overrides the default set.
 *   - Idempotency: a name already in `dependencies` or `devDependencies` is
 *     reported as `skipped` and the package manager is NOT invoked for it.
 *   - When nothing remains to install → `action: "noop"`, runFn is never called.
 *   - The detected package manager drives the binary + argv shape:
 *       npm → ["install","--save-dev",…specs]
 *       pnpm → ["add","--save-dev",…specs]
 *       yarn → ["add","--dev",…specs]
 *       bun → ["add","--dev",…specs]
 *   - Subprocess non-zero exit propagates as `pkg_install_failed`.
 *   - Manifest entries: one per installed package, with virtual path
 *     `package.json#devDependencies/<name>`, kind="dep", merged=true.
 *   - Missing or malformed package.json fails recoverably without invoking the pm.
 *   - `--strict` + dirty tree returns `dirty_tree`.
 *   - Argument parser validates `--deps` as a JSON array of non-empty strings.
 *   - `specName` extracts the bare name from `name@version` and scoped specs.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEPS,
  buildArgs,
  installDeps,
  parseInstallDepsArgs,
  type RunFn,
  type RunResult,
  specName,
} from "../../src/commands/install/deps.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";
import {
  type DetectionResult,
  type PackageManager,
} from "../../src/lib/pkg-manager.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";
const PKG_ABS = `${ROOT}${sep}package.json`;
const MANIFEST_ABS = `${ROOT}${sep}${MANIFEST_FILENAME}`;

interface MemoryIO extends SafeIO {
  files: Map<string, string>;
}

function memoryIO(initial: Record<string, string> = {}): MemoryIO {
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
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

interface RecordedCall {
  binary: string;
  args: readonly string[];
  cwd: string;
}

function recordingRun(
  outcome: Partial<RunResult> = {},
): { fn: RunFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: RunFn = (binary, args, cwd) => {
    calls.push({ binary, args, cwd });
    return {
      ok: outcome.ok ?? true,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      exitCode: outcome.exitCode ?? 0,
    };
  };
  return { fn, calls };
}

function fakeDetect(
  manager: PackageManager,
  source: DetectionResult["source"] = "default",
): typeof import("../../src/lib/pkg-manager.ts").detectPackageManager {
  return () => ({ manager, source });
}

function deps(io: MemoryIO) {
  return {
    existsFn: (p: string) => io.files.has(p),
    readFileFn: (p: string) => {
      const v = io.files.get(p);
      if (v !== undefined) return v;
      throw new Error(`ENOENT: ${p}`);
    },
    safeIO: io,
  };
}

function loadManifestFromMemory(io: MemoryIO): Manifest | null {
  const raw = io.files.get(MANIFEST_ABS);
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

describe("specName", () => {
  it("returns the bare name for unscoped specs", () => {
    expect(specName("oxlint")).toBe("oxlint");
    expect(specName("oxlint@1.0.0")).toBe("oxlint");
    expect(specName("oxlint@latest")).toBe("oxlint");
    expect(specName("oxlint@^1.0.0")).toBe("oxlint");
  });

  it("preserves scoped names without versions", () => {
    expect(specName("@oxc-project/quality-metrics")).toBe("@oxc-project/quality-metrics");
  });

  it("strips version from scoped specs", () => {
    expect(specName("@oxc-project/quality-metrics@1.2.3")).toBe(
      "@oxc-project/quality-metrics",
    );
    expect(specName("@scope/foo@^2.0")).toBe("@scope/foo");
  });

  it("returns empty string for empty input", () => {
    expect(specName("")).toBe("");
  });
});

describe("buildArgs", () => {
  const SPECS = ["oxlint", "oxfmt"];

  it("npm uses install --save-dev", () => {
    expect(buildArgs("npm", SPECS)).toEqual(["install", "--save-dev", "oxlint", "oxfmt"]);
  });

  it("pnpm uses add --save-dev", () => {
    expect(buildArgs("pnpm", SPECS)).toEqual(["add", "--save-dev", "oxlint", "oxfmt"]);
  });

  it("yarn uses add --dev", () => {
    expect(buildArgs("yarn", SPECS)).toEqual(["add", "--dev", "oxlint", "oxfmt"]);
  });

  it("bun uses add --dev", () => {
    expect(buildArgs("bun", SPECS)).toEqual(["add", "--dev", "oxlint", "oxfmt"]);
  });

  it("preserves spec order (deterministic)", () => {
    const args = buildArgs("npm", ["c", "a", "b"]);
    expect(args).toEqual(["install", "--save-dev", "c", "a", "b"]);
  });
});

describe("DEFAULT_DEPS", () => {
  it("contains the SPEC §1.18 quartet in deterministic order", () => {
    expect(DEFAULT_DEPS).toEqual(["oxlint", "oxfmt", "quality-metrics", "ts-morph"]);
  });
});

describe("installDeps — fresh greenfield package.json", () => {
  it("installs DEFAULT_DEPS via npm when no lockfile is present", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo", version: "0.0.0" }) });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm", "default") },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("installed");
    expect(r.installed).toEqual(["oxlint", "oxfmt", "quality-metrics", "ts-morph"]);
    expect(r.skipped).toEqual([]);
    expect(r.pkg_manager).toBe("npm");
    expect(r.source).toBe("default");
    expect(r.recorded).toBe(4);

    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("npm");
    expect(calls[0].args).toEqual([
      "install",
      "--save-dev",
      "oxlint",
      "oxfmt",
      "quality-metrics",
      "ts-morph",
    ]);
    expect(calls[0].cwd).toBe(ROOT);
  });

  it("uses pnpm add --save-dev when pnpm-lock.yaml is detected", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    installDeps(
      { cwd: ROOT, deps: ["oxlint"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("pnpm", "pnpm-lock.yaml") },
    );
    expect(calls[0].binary).toBe("pnpm");
    expect(calls[0].args).toEqual(["add", "--save-dev", "oxlint"]);
  });

  it("uses bun add --dev when bun.lock is detected", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    installDeps(
      { cwd: ROOT, deps: ["oxlint"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("bun", "bun.lock") },
    );
    expect(calls[0].binary).toBe("bun");
    expect(calls[0].args).toEqual(["add", "--dev", "oxlint"]);
  });

  it("uses yarn add --dev when yarn.lock is detected", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    installDeps(
      { cwd: ROOT, deps: ["oxlint"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("yarn", "yarn.lock") },
    );
    expect(calls[0].binary).toBe("yarn");
    expect(calls[0].args).toEqual(["add", "--dev", "oxlint"]);
  });

  it("records one manifest entry per installed package (kind=dep, merged=true)", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn } = recordingRun();
    installDeps(
      { cwd: ROOT, deps: ["oxlint", "oxfmt"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const depEntries = m.entries.filter((e) => e.kind === "dep");
    expect(depEntries.map((e) => e.path).sort()).toEqual([
      "package.json#devDependencies/oxfmt",
      "package.json#devDependencies/oxlint",
    ]);
    for (const e of depEntries) {
      expect(e.merged).toBe(true);
      expect(e.created_at).toBe("2026-05-03T12:00:00.000Z");
    }
  });
});

describe("installDeps — idempotency", () => {
  it("skips packages already in devDependencies (no subprocess for the skipped names)", () => {
    const io = memoryIO({
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        devDependencies: { oxlint: "^1.0.0", "ts-morph": "^24.0.0" },
      }),
    });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installed).toEqual(["oxfmt", "quality-metrics"]);
    expect(r.skipped.sort()).toEqual(["oxlint", "ts-morph"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["install", "--save-dev", "oxfmt", "quality-metrics"]);
  });

  it("treats `dependencies` (prod) as already-installed too (preserves user choice)", () => {
    const io = memoryIO({
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        dependencies: { oxlint: "^1.0.0" },
      }),
    });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["oxlint"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.installed).toEqual([]);
    expect(r.skipped).toEqual(["oxlint"]);
    expect(calls).toHaveLength(0);
  });

  it("noop when every desired package is already present (no subprocess, no manifest write)", () => {
    const io = memoryIO({
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        devDependencies: {
          oxlint: "^1.0.0",
          oxfmt: "^0.0.0-alpha",
          "quality-metrics": "^1.0.0",
          "ts-morph": "^24.0.0",
        },
      }),
    });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.installed).toEqual([]);
    expect(r.skipped).toEqual(["oxlint", "oxfmt", "quality-metrics", "ts-morph"]);
    expect(r.recorded).toBe(0);
    expect(calls).toHaveLength(0);
    expect(loadManifestFromMemory(io)).toBeNull();
  });

  it("specs with version are matched by bare name (oxlint@1.0.0 → oxlint)", () => {
    const io = memoryIO({
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        devDependencies: { oxlint: "^0.5.0" },
      }),
    });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["oxlint@1.0.0"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.skipped).toEqual(["oxlint"]);
    expect(calls).toHaveLength(0);
  });
});

describe("installDeps — error paths", () => {
  it("fails when package.json is missing (no subprocess)", () => {
    const io = memoryIO({});
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_missing");
    expect(calls).toHaveLength(0);
  });

  it("fails on malformed package.json", () => {
    const io = memoryIO({ [PKG_ABS]: "{ not json" });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_malformed");
    expect(calls).toHaveLength(0);
  });

  it("fails when package.json root is not an object", () => {
    const io = memoryIO({ [PKG_ABS]: "[]" });
    const { fn } = recordingRun();
    const r = installDeps({ cwd: ROOT }, { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_malformed");
  });

  it("propagates package manager non-zero exit as pkg_install_failed", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn } = recordingRun({ ok: false, stderr: "ETARGET No matching version", exitCode: 1 });
    const r = installDeps(
      { cwd: ROOT, deps: ["bogus"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("pkg_install_failed");
    expect(r.reason).toContain("ETARGET");
    expect(r.reason).toContain("npm install --save-dev bogus");
    // Manifest must NOT record on failed install (no entries beyond noop manifest).
    const m = loadManifestFromMemory(io);
    expect(m?.entries.filter((e) => e.kind === "dep") ?? []).toEqual([]);
  });

  it("rejects empty deps array (override)", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: [] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("deps_empty");
  });

  it("rejects non-string entries in deps array", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["oxlint", "" as string] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("deps_invalid");
  });

  it("--strict + dirty tree returns dirty_tree without invoking the package manager", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["oxlint"], strict: true },
      {
        ...deps(io),
        runFn: fn,
        detectFn: fakeDetect("npm"),
        dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("dirty_tree");
    expect(r.reason).toContain("working tree is dirty");
    expect(calls).toHaveLength(0);
  });

  it("--strict + git failure returns git_check_failed", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["oxlint"], strict: true },
      {
        ...deps(io),
        runFn: fn,
        detectFn: fakeDetect("npm"),
        dirtyFilesFn: () => ({ ok: false, error: "not a git repo" }),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("git_check_failed");
    expect(calls).toHaveLength(0);
  });
});

describe("installDeps — override mode", () => {
  it("--deps replaces DEFAULT_DEPS entirely", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const { fn, calls } = recordingRun();
    const r = installDeps(
      { cwd: ROOT, deps: ["zod@3.22.0", "@scope/x"] },
      { ...deps(io), runFn: fn, detectFn: fakeDetect("npm") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.installed).toEqual(["zod", "@scope/x"]);
    expect(calls[0].args).toEqual(["install", "--save-dev", "zod@3.22.0", "@scope/x"]);
  });
});

describe("parseInstallDepsArgs", () => {
  const DEFAULT = sep === "/" ? "/cwd" : "C:\\cwd";

  it("defaults: empty argv", () => {
    const r = parseInstallDepsArgs([], DEFAULT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ cwd: DEFAULT, strict: false });
    expect(r.value.deps).toBeUndefined();
  });

  it("--cwd resolves against defaultCwd", () => {
    const r = parseInstallDepsArgs(["--cwd", "subdir"], DEFAULT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd.endsWith(`${sep}subdir`)).toBe(true);
  });

  it("--strict toggles", () => {
    const r = parseInstallDepsArgs(["--strict"], DEFAULT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.strict).toBe(true);
  });

  it("--deps parses a JSON array of strings", () => {
    const r = parseInstallDepsArgs(["--deps", '["oxlint","oxfmt"]'], DEFAULT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deps).toEqual(["oxlint", "oxfmt"]);
  });

  it("--deps accepts version-suffixed specs", () => {
    const r = parseInstallDepsArgs(
      ["--deps", '["oxlint@1.0.0","@scope/x@2.0.0"]'],
      DEFAULT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deps).toEqual(["oxlint@1.0.0", "@scope/x@2.0.0"]);
  });

  it("rejects malformed JSON in --deps", () => {
    const r = parseInstallDepsArgs(["--deps", "{not-json"], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid --deps JSON");
  });

  it("rejects non-array --deps", () => {
    const r = parseInstallDepsArgs(["--deps", '{"oxlint":"1.0.0"}'], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("array of strings");
  });

  it("rejects array with non-string entries", () => {
    const r = parseInstallDepsArgs(["--deps", '["oxlint",42]'], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects array with empty string entries", () => {
    const r = parseInstallDepsArgs(["--deps", '["oxlint",""]'], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects missing values for --cwd / --deps", () => {
    expect(parseInstallDepsArgs(["--cwd"], DEFAULT).ok).toBe(false);
    expect(parseInstallDepsArgs(["--deps"], DEFAULT).ok).toBe(false);
  });

  it("--help is reported as 'help'", () => {
    expect(parseInstallDepsArgs(["--help"], DEFAULT)).toEqual({ ok: false, error: "help" });
    expect(parseInstallDepsArgs(["-h"], DEFAULT)).toEqual({ ok: false, error: "help" });
  });

  it("rejects unknown flags", () => {
    const r = parseInstallDepsArgs(["--zonk"], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });
});
