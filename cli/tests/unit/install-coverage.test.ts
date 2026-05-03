/**
 * Contract tests for `install-coverage` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - Stage → preset filename mapping (brownfield-moderate → brownfield).
 *   - Thresholds resolve from explicit override, otherwise from the
 *     bundled jest preset for the resolved stage. Vitest paths consume the
 *     same numeric source of truth.
 *   - Vitest path: edits an existing config via ts-morph (preserves comments
 *     and unrelated keys), or generates a fresh `vitest.config.ts` from the
 *     skeleton when no config exists.
 *   - Jest JSON path: merges into existing `jest.config.json` and is a no-op
 *     when leaves already match.
 *   - Jest package.json path: when only `package.json#jest` exists (or
 *     nothing), the merge lands inside `package.json#jest`.
 *   - Jest JS/TS configs are NOT edited (returns `jest_js_config_unsupported`).
 *   - Runner=none short-circuits to `action: "noop"` with no FS writes.
 *   - Manifest entries use kind="coverage" with merged=true on edits and
 *     merged=false on a freshly-generated vitest config.
 *   - Argument parser validates --runner, --stage, and --thresholds JSON.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CoverageThresholds,
  installCoverage,
  parseInstallCoverageArgs,
} from "../../src/commands/install/coverage.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";
import { readVitestThresholds } from "../../src/lib/ts-config-edit.ts";

const PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "presets",
  "coverage",
);

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

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

function deps(io: MemoryIO) {
  // Pre-load jest preset files into the memory map so the command can read
  // them via the injected readFileFn (avoids hitting real disk in tests).
  // Tests still occasionally seed their own files; pre-loading is idempotent.
  for (const slug of ["greenfield", "brownfield", "legacy"] as const) {
    const path = join(PRESETS_DIR, `jest.${slug}.json`);
    if (!io.files.has(path)) {
      io.files.set(path, readFileSync(path, "utf8"));
    }
  }
  return {
    existsFn: (p: string) => io.files.has(p),
    readFileFn: (p: string) => io.files.get(p) ?? null,
    safeIO: io,
    presetsDir: PRESETS_DIR,
    detectStageFn: () =>
      ({ ok: true, stage: "greenfield" }) as ReturnType<
        typeof import("../../src/commands/detect-stage.ts").detectStage
      >,
    detectRunnerFn: () =>
      ({
        ok: true,
        cwd: ROOT,
        runner: "none" as const,
        candidates: {
          vitest: { configs: [], pkg_dep: false, thresholds: null, thresholds_source: null },
          jest: { configs: [], pkg_dep: false, thresholds: null, thresholds_source: null },
        },
        coverage: {
          configured: false,
          current_thresholds: null,
          current_values: null,
          source: null,
        },
      }) as ReturnType<
        typeof import("../../src/commands/detect-test-runner.ts").detectTestRunner
      >,
  };
}

function loadManifestFromMemory(io: MemoryIO): Manifest | null {
  const path = join(ROOT, MANIFEST_FILENAME);
  const raw = io.files.get(path);
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

const GREENFIELD_THRESHOLDS: CoverageThresholds = {
  lines: 90,
  functions: 90,
  branches: 80,
  statements: 90,
};
const BROWNFIELD_THRESHOLDS: CoverageThresholds = {
  lines: 70,
  functions: 70,
  branches: 60,
  statements: 70,
};
const LEGACY_THRESHOLDS: CoverageThresholds = {
  lines: 40,
  functions: 40,
  branches: 30,
  statements: 40,
};

describe("installCoverage — runner=none", () => {
  it("returns action=noop without writing anything", () => {
    const io = memoryIO();
    const r = installCoverage({ cwd: ROOT, runner: "none" }, deps(io));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runner).toBe("none");
    expect(r.action).toBe("noop");
    expect(r.written).toBeNull();
    expect(loadManifestFromMemory(io)).toBeNull();
  });
});

describe("installCoverage — vitest", () => {
  it("generates vitest.config.ts from skeleton when no config exists", () => {
    const io = memoryIO();
    const r = installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.action).toBe("created");
    expect(r.written).not.toBeNull();
    expect(r.written?.merged).toBe(false);

    const written = io.files.get(join(ROOT, "vitest.config.ts"));
    expect(written).toBeDefined();
    expect(readVitestThresholds(written ?? "")).toEqual(GREENFIELD_THRESHOLDS);
    expect(written).toContain("defineConfig(");
    expect(written).toContain('provider: "v8"');
  });

  it("edits an existing vitest.config.ts in place, preserving comments", () => {
    const initial = `import { defineConfig } from "vitest/config";

// banner comment
export default defineConfig({
  test: {
    // existing inline note
    setupFiles: ["./test-setup.ts"],
  },
});
`;
    const io = memoryIO({ [join(ROOT, "vitest.config.ts")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "brownfield-moderate" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");
    expect(r.written?.merged).toBe(true);

    const next = io.files.get(join(ROOT, "vitest.config.ts")) ?? "";
    expect(next).toContain("// banner comment");
    expect(next).toContain("// existing inline note");
    expect(next).toContain('setupFiles: ["./test-setup.ts"]');
    expect(readVitestThresholds(next)).toEqual(BROWNFIELD_THRESHOLDS);
  });

  it("is action=noop when leaves already match the preset", () => {
    const initial = `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 }
    }
  }
});
`;
    const io = memoryIO({ [join(ROOT, "vitest.config.ts")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.written).toBeNull();
  });

  it("explicit thresholds override the stage preset", () => {
    const io = memoryIO();
    const custom: CoverageThresholds = {
      lines: 55,
      functions: 50,
      branches: 45,
      statements: 50,
    };
    const r = installCoverage(
      {
        cwd: ROOT,
        runner: "vitest",
        stage: "greenfield",
        thresholds: custom,
      },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.thresholdsSource).toBe("explicit");
    expect(r.thresholds).toEqual(custom);
    expect(
      readVitestThresholds(io.files.get(join(ROOT, "vitest.config.ts")) ?? ""),
    ).toEqual(custom);
  });

  it("legacy stage surfaces warnOnly: true", () => {
    const io = memoryIO();
    const r = installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "legacy" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnOnly).toBe(true);
    expect(r.thresholds).toEqual(LEGACY_THRESHOLDS);
  });

  it("records a manifest entry with kind=coverage on write", () => {
    const io = memoryIO();
    installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "greenfield" },
      deps(io),
    );
    const manifest = loadManifestFromMemory(io);
    expect(manifest).not.toBeNull();
    if (!manifest) return;
    const entry = manifest.entries.find((e) => e.path === "vitest.config.ts");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("coverage");
    expect(entry?.merged ?? false).toBe(false);
  });

  it("merged=true when editing a pre-existing vitest config", () => {
    const initial = `export default { test: {} };\n`;
    const io = memoryIO({ [join(ROOT, "vitest.config.ts")]: initial });
    installCoverage(
      { cwd: ROOT, runner: "vitest", stage: "greenfield" },
      deps(io),
    );
    const manifest = loadManifestFromMemory(io);
    if (!manifest) throw new Error("manifest missing");
    const entry = manifest.entries.find((e) => e.path === "vitest.config.ts");
    expect(entry?.merged).toBe(true);
  });
});

describe("installCoverage — jest JSON config", () => {
  it("merges thresholds into an existing jest.config.json", () => {
    const initial = JSON.stringify(
      { testMatch: ["**/*.test.ts"], coverageThreshold: { global: { lines: 50 } } },
      null,
      2,
    );
    const io = memoryIO({ [join(ROOT, "jest.config.json")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "brownfield-moderate" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");

    const written = io.files.get(join(ROOT, "jest.config.json")) ?? "";
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed["testMatch"]).toEqual(["**/*.test.ts"]);
    expect(parsed["collectCoverage"]).toBe(true);
    expect(parsed["coverageProvider"]).toBe("v8");
    expect((parsed["coverageThreshold"] as Record<string, unknown>)["global"]).toEqual(
      BROWNFIELD_THRESHOLDS,
    );
  });

  it("is action=noop when jest.config.json already matches", () => {
    const initial = JSON.stringify(
      {
        collectCoverage: true,
        coverageProvider: "v8",
        coverageReporters: ["text", "json", "json-summary", "html"],
        coverageThreshold: { global: GREENFIELD_THRESHOLDS },
      },
      null,
      2,
    );
    const io = memoryIO({ [join(ROOT, "jest.config.json")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("noop");
    expect(r.written).toBeNull();
  });
});

describe("installCoverage — jest via package.json", () => {
  it("creates package.json#jest when no jest config exists", () => {
    const initial = JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2);
    const io = memoryIO({ [join(ROOT, "package.json")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");

    const written = io.files.get(join(ROOT, "package.json")) ?? "";
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed["name"]).toBe("demo");
    const jest = parsed["jest"] as Record<string, unknown>;
    expect(jest["coverageProvider"]).toBe("v8");
    expect((jest["coverageThreshold"] as Record<string, unknown>)["global"]).toEqual(
      GREENFIELD_THRESHOLDS,
    );
  });

  it("merges into an existing package.json#jest preserving siblings", () => {
    const initial = JSON.stringify(
      {
        name: "demo",
        jest: {
          testMatch: ["**/*.test.ts"],
          coverageThreshold: { global: { lines: 30 } },
        },
      },
      null,
      2,
    );
    const io = memoryIO({ [join(ROOT, "package.json")]: initial });
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "legacy" },
      deps(io),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const written = io.files.get(join(ROOT, "package.json")) ?? "";
    const jest = (JSON.parse(written) as Record<string, unknown>)["jest"] as Record<
      string,
      unknown
    >;
    expect(jest["testMatch"]).toEqual(["**/*.test.ts"]);
    expect((jest["coverageThreshold"] as Record<string, unknown>)["global"]).toEqual(
      LEGACY_THRESHOLDS,
    );
  });

  it("returns package_json_missing when no package.json and no jest config", () => {
    const io = memoryIO();
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("package_json_missing");
  });
});

describe("installCoverage — jest with JS/TS config refuses to edit", () => {
  it("returns jest_js_config_unsupported when jest.config.ts exists", () => {
    const io = memoryIO({
      [join(ROOT, "jest.config.ts")]: "export default { testMatch: [] };\n",
    });
    const r = installCoverage(
      { cwd: ROOT, runner: "jest", stage: "greenfield" },
      deps(io),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("jest_js_config_unsupported");
    // package.json was NOT touched.
    expect(io.files.has(join(ROOT, "package.json"))).toBe(false);
  });
});

describe("installCoverage — error paths", () => {
  it("invalid stage in args is rejected by parser", () => {
    const r = parseInstallCoverageArgs(["--stage", "huge"], "/cwd");
    expect(r.ok).toBe(false);
  });

  it("invalid runner in args is rejected by parser", () => {
    const r = parseInstallCoverageArgs(["--runner", "mocha"], "/cwd");
    expect(r.ok).toBe(false);
  });

  it("invalid --thresholds JSON is rejected", () => {
    const r = parseInstallCoverageArgs(["--thresholds", "not-json"], "/cwd");
    expect(r.ok).toBe(false);
  });

  it("--thresholds object missing required keys is rejected", () => {
    const r = parseInstallCoverageArgs(
      ["--thresholds", JSON.stringify({ lines: 90 })],
      "/cwd",
    );
    expect(r.ok).toBe(false);
  });

  it("--thresholds with non-finite values is rejected", () => {
    const r = parseInstallCoverageArgs(
      [
        "--thresholds",
        JSON.stringify({ lines: 90, functions: 80, branches: "x", statements: 90 }),
      ],
      "/cwd",
    );
    expect(r.ok).toBe(false);
  });

  it("parses a complete --thresholds object", () => {
    const r = parseInstallCoverageArgs(
      [
        "--thresholds",
        JSON.stringify({ lines: 90, functions: 80, branches: 70, statements: 75 }),
      ],
      "/cwd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.thresholds).toEqual({
      lines: 90,
      functions: 80,
      branches: 70,
      statements: 75,
    });
  });

  it("--strict propagates", () => {
    const r = parseInstallCoverageArgs(["--strict"], "/cwd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.strict).toBe(true);
  });

  it("unknown flag is rejected", () => {
    const r = parseInstallCoverageArgs(["--banana"], "/cwd");
    expect(r.ok).toBe(false);
  });
});

describe("installCoverage — idempotency", () => {
  it("running twice with the same explicit thresholds is a no-op the second time", () => {
    const io = memoryIO();
    const opts = { cwd: ROOT, runner: "vitest" as const, stage: "greenfield" as const };
    const r1 = installCoverage(opts, deps(io));
    expect(r1.ok && r1.action === "created").toBe(true);
    const r2 = installCoverage(opts, deps(io));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // After the first write the config now exists; second pass becomes
    // updated→noop because all leaves already match.
    expect(r2.action).toBe("noop");
  });
});
