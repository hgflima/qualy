/**
 * Contract tests for `install-scripts` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - Default mode reads `cli/src/templates/package-scripts.json` and merges
 *     `lint`/`lint:deep`/`format` into `package.json#scripts`. With `--runner
 *     vitest|jest` a `coverage` script is added; with `none` it is omitted.
 *   - `--scripts <json>` override skips the template entirely.
 *   - Merge is idempotent + non-destructive: existing keys with the same value
 *     are reported as `skipped`, with a different value as `conflicts`. We
 *     NEVER overwrite a user-defined script.
 *   - When `added` is empty the file is left untouched (action=noop, recorded=false).
 *   - Manifest entry uses kind="scripts", merged=true.
 *   - Missing or malformed package.json fails recoverably without writing.
 *   - `--strict` propagates to safeWriteFile.
 *   - Argument parser validates `--runner` and `--scripts` JSON shape.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installScripts,
  mergeScripts,
  parseInstallScriptsArgs,
  resolveDesiredScripts,
} from "../../src/commands/install/scripts.ts";
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
  "package-scripts.json",
);

const ROOT = sep === "/" ? "/proj" : "C:\\proj";
const PKG_ABS = join(ROOT, "package.json");

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

/**
 * Wires both the install-scripts level (existsFn/readFileFn) and the
 * safeWriteFile level (safeIO) to the same in-memory map so tests see a
 * coherent FS. The template at TEMPLATE_PATH is pre-loaded from disk so we
 * exercise the real bundled JSON (vs. duplicating it in tests).
 */
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
  const path = join(ROOT, MANIFEST_FILENAME);
  const raw = io.files.get(path);
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

const REAL_TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");

describe("resolveDesiredScripts", () => {
  const template = parseDefensive<Record<string, unknown>>(REAL_TEMPLATE);
  if (!template.ok) throw new Error("template malformed in test setup");
  const tpl = template.value;

  it("returns the trio + coverage when runner=vitest", () => {
    const r = resolveDesiredScripts(tpl, "vitest", undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["coverage", "format", "lint", "lint:deep"]);
    expect(r.value.coverage).toBe("vitest run --coverage");
  });

  it("returns the trio + coverage when runner=jest", () => {
    const r = resolveDesiredScripts(tpl, "jest", undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.coverage).toBe("jest --coverage");
  });

  it("omits coverage when runner=none", () => {
    const r = resolveDesiredScripts(tpl, "none", undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["format", "lint", "lint:deep"]);
    expect(r.value.coverage).toBeUndefined();
  });

  it("override wins outright (template ignored)", () => {
    const r = resolveDesiredScripts(tpl, "vitest", { foo: "bar" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ foo: "bar" });
  });

  it("fails when template lacks scripts field", () => {
    const r = resolveDesiredScripts({ scripts: "nope" } as never, "none", undefined);
    expect(r.ok).toBe(false);
  });

  it("fails when runner=vitest but coverage_by_runner.vitest missing", () => {
    const r = resolveDesiredScripts(
      { scripts: { lint: "x" }, coverage_by_runner: {} } as never,
      "vitest",
      undefined,
    );
    expect(r.ok).toBe(false);
  });
});

describe("mergeScripts", () => {
  it("classifies absent keys as added", () => {
    const r = mergeScripts({}, { lint: "oxlint .", format: "oxfmt ." });
    expect(r.added.sort()).toEqual(["format", "lint"]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.nextScripts).toEqual({ lint: "oxlint .", format: "oxfmt ." });
  });

  it("classifies equal-value keys as skipped (no override)", () => {
    const r = mergeScripts({ lint: "oxlint ." }, { lint: "oxlint ." });
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual(["lint"]);
    expect(r.nextScripts).toEqual({ lint: "oxlint ." });
  });

  it("classifies different-value keys as conflicts (preserves user value)", () => {
    const r = mergeScripts({ lint: "eslint ." }, { lint: "oxlint ." });
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([{ name: "lint", existing: "eslint .", proposed: "oxlint ." }]);
    expect(r.nextScripts.lint).toBe("eslint .");
  });

  it("preserves unrelated existing keys", () => {
    const r = mergeScripts({ test: "vitest", build: "tsc" }, { lint: "oxlint ." });
    expect(r.added).toEqual(["lint"]);
    expect(r.nextScripts).toEqual({ test: "vitest", build: "tsc", lint: "oxlint ." });
  });

  it("non-string existing values surface as conflicts (defensive)", () => {
    const r = mergeScripts({ lint: 42 } as Record<string, unknown>, { lint: "oxlint ." });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].existing).toBe("42");
  });

  it("appends new keys after existing ones (insertion order preserved)", () => {
    const r = mergeScripts({ a: "1", b: "2" }, { c: "3", d: "4" });
    expect(Object.keys(r.nextScripts)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("installScripts — fresh merge (greenfield package.json)", () => {
  it("adds lint/lint:deep/format/coverage when runner=vitest and writes file", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo", version: "0.0.0" }),
    });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");
    expect(r.added.sort()).toEqual(["coverage", "format", "lint", "lint:deep"]);
    expect(r.skipped).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.recorded).toBe(true);

    const written = io.files.get(PKG_ABS);
    expect(written).toBeDefined();
    if (!written) return;
    const parsed = parseDefensive<{
      name: string;
      version: string;
      scripts: Record<string, string>;
    }>(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("demo");
    expect(parsed.value.version).toBe("0.0.0");
    expect(parsed.value.scripts.lint).toBe("oxlint --config oxlint.fast.json .");
    expect(parsed.value.scripts["lint:deep"]).toBe("oxlint --config oxlint.deep.json .");
    expect(parsed.value.scripts.format).toBe("oxfmt --write .");
    expect(parsed.value.scripts.coverage).toBe("vitest run --coverage");
  });

  it("does not add coverage when runner=none", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    const r = installScripts({ cwd: ROOT, runner: "none" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added.sort()).toEqual(["format", "lint", "lint:deep"]);
    const parsed = parseDefensive<{ scripts: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scripts.coverage).toBeUndefined();
  });

  it("uses jest variant when runner=jest", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    const r = installScripts({ cwd: ROOT, runner: "jest" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseDefensive<{ scripts: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    if (!parsed.ok) return;
    expect(parsed.value.scripts.coverage).toBe("jest --coverage");
  });

  it("records manifest entry with kind=scripts, merged=true", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const entry = m.entries.find((e) => e.path === "package.json");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("scripts");
    expect(entry?.merged).toBe(true);
  });

  it("preserves unrelated package.json fields (name, version, deps)", () => {
    const original = {
      name: "demo",
      version: "1.2.3",
      type: "module" as const,
      dependencies: { foo: "1.0.0" },
      devDependencies: { vitest: "2.0.0" },
    };
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify(original),
    });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(true);
    const parsed = parseDefensive<typeof original & { scripts: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("demo");
    expect(parsed.value.version).toBe("1.2.3");
    expect(parsed.value.type).toBe("module");
    expect(parsed.value.dependencies).toEqual({ foo: "1.0.0" });
    expect(parsed.value.devDependencies).toEqual({ vitest: "2.0.0" });
  });
});

describe("installScripts — idempotency and conflicts", () => {
  it("a second run is a noop (action=noop, recorded=false, no manifest update)", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    const firstWrite = io.files.get(PKG_ABS);
    const r2 = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.action).toBe("noop");
    expect(r2.added).toEqual([]);
    expect(r2.skipped.sort()).toEqual(["coverage", "format", "lint", "lint:deep"]);
    expect(r2.conflicts).toEqual([]);
    expect(r2.recorded).toBe(false);
    expect(io.files.get(PKG_ABS)).toBe(firstWrite); // bytes unchanged
  });

  it("reports conflicts without overwriting user scripts", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        scripts: {
          lint: "eslint . --fix",
          format: "prettier --write .",
        },
      }),
    });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added.sort()).toEqual(["coverage", "lint:deep"]);
    expect(r.conflicts.map((c) => c.name).sort()).toEqual(["format", "lint"]);
    expect(r.action).toBe("updated");

    const parsed = parseDefensive<{ scripts: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    if (!parsed.ok) return;
    expect(parsed.value.scripts.lint).toBe("eslint . --fix"); // preserved
    expect(parsed.value.scripts.format).toBe("prettier --write ."); // preserved
    expect(parsed.value.scripts["lint:deep"]).toBe("oxlint --config oxlint.deep.json .");
    expect(parsed.value.scripts.coverage).toBe("vitest run --coverage");
  });

  it("noop when every desired key already matches (skipped only)", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({
        name: "demo",
        scripts: {
          lint: "oxlint --config oxlint.fast.json .",
          "lint:deep": "oxlint --config oxlint.deep.json .",
          format: "oxfmt --write .",
          coverage: "vitest run --coverage",
        },
      }),
    });
    const original = io.files.get(PKG_ABS);
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.added).toEqual([]);
    expect(r.skipped.sort()).toEqual(["coverage", "format", "lint", "lint:deep"]);
    expect(io.files.get(PKG_ABS)).toBe(original);
  });
});

describe("installScripts — error paths", () => {
  it("fails when package.json is missing", () => {
    const io = memoryIO({ [TEMPLATE_PATH]: REAL_TEMPLATE });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_missing");
  });

  it("fails on malformed package.json without writing", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: "{ not json",
    });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_malformed");
    expect(io.files.get(PKG_ABS)).toBe("{ not json"); // untouched
  });

  it("fails when package.json root is not an object", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: "[]",
    });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_malformed");
  });

  it("fails when template is missing in default mode", () => {
    const io = memoryIO({ [PKG_ABS]: JSON.stringify({ name: "demo" }) });
    const r = installScripts({ cwd: ROOT, runner: "vitest" }, deps(io));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("template_read_failed");
  });

  it("override mode bypasses the template entirely", () => {
    const io = memoryIO({
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    const r = installScripts(
      { cwd: ROOT, scripts: { custom: "echo hi" } },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toEqual(["custom"]);
    const parsed = parseDefensive<{ scripts: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    if (!parsed.ok) return;
    expect(parsed.value.scripts.custom).toBe("echo hi");
  });

  it("--strict + dirty tree returns DIRTY_TREE-shaped error", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    const dirtyIO: MemoryIO = {
      ...io,
      dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
    };
    const r = installScripts(
      { cwd: ROOT, runner: "vitest", strict: true },
      { ...deps(io), safeIO: dirtyIO },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });
});

describe("installScripts — package.json without scripts field", () => {
  it("creates the scripts field when absent", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo" }),
    });
    const r = installScripts({ cwd: ROOT, runner: "none" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseDefensive<{ scripts?: Record<string, string> }>(
      io.files.get(PKG_ABS) ?? "",
    );
    if (!parsed.ok) return;
    expect(parsed.value.scripts).toBeDefined();
    expect(parsed.value.scripts?.lint).toBe("oxlint --config oxlint.fast.json .");
  });

  it("treats non-object scripts field as empty (defensive)", () => {
    const io = memoryIO({
      [TEMPLATE_PATH]: REAL_TEMPLATE,
      [PKG_ABS]: JSON.stringify({ name: "demo", scripts: "not an object" }),
    });
    const r = installScripts({ cwd: ROOT, runner: "none" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added.sort()).toEqual(["format", "lint", "lint:deep"]);
  });
});

describe("parseInstallScriptsArgs", () => {
  const DEFAULT = "/cwd";

  it("defaults: cwd=defaultCwd, runner=none, strict=false, no scripts", () => {
    const r = parseInstallScriptsArgs([], DEFAULT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe(DEFAULT);
    expect(r.value.runner).toBe("none");
    expect(r.value.strict).toBe(false);
    expect(r.value.scripts).toBeUndefined();
  });

  it("parses --cwd, --runner, --strict", () => {
    const r = parseInstallScriptsArgs(
      ["--cwd", "sub", "--runner", "vitest", "--strict"],
      DEFAULT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe(join(DEFAULT, "sub"));
    expect(r.value.runner).toBe("vitest");
    expect(r.value.strict).toBe(true);
  });

  it("parses --scripts as JSON object of strings", () => {
    const r = parseInstallScriptsArgs(
      ["--scripts", JSON.stringify({ build: "tsc", test: "vitest" })],
      DEFAULT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scripts).toEqual({ build: "tsc", test: "vitest" });
  });

  it("rejects invalid runner value", () => {
    const r = parseInstallScriptsArgs(["--runner", "mocha"], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid runner");
  });

  it("rejects malformed --scripts JSON", () => {
    const r = parseInstallScriptsArgs(["--scripts", "{ not json"], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid --scripts JSON");
  });

  it("rejects --scripts with non-string values", () => {
    const r = parseInstallScriptsArgs(["--scripts", JSON.stringify({ x: 42 })], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("string→string");
  });

  it("rejects --scripts as non-object", () => {
    const r = parseInstallScriptsArgs(["--scripts", "[1,2]"], DEFAULT);
    expect(r.ok).toBe(false);
  });

  it("rejects missing values for flags", () => {
    expect(parseInstallScriptsArgs(["--cwd"], DEFAULT).ok).toBe(false);
    expect(parseInstallScriptsArgs(["--runner"], DEFAULT).ok).toBe(false);
    expect(parseInstallScriptsArgs(["--scripts"], DEFAULT).ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const r = parseInstallScriptsArgs(["--zonk"], DEFAULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("--help is a recognized signal", () => {
    expect(parseInstallScriptsArgs(["--help"], DEFAULT).ok).toBe(false);
    expect(parseInstallScriptsArgs(["-h"], DEFAULT).ok).toBe(false);
  });
});
