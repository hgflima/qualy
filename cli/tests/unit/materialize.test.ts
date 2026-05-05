import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeFixture } from "../fixtures/_materialize.ts";

function gitOut(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("materializeFixture", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
        // best-effort
      }
    }
  });

  it("copies the named fixture into a fresh tmp dir under os.tmpdir()", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    expect(fx.dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(fx.dir)).toBe(true);
    expect(existsSync(join(fx.dir, "package.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "src"))).toBe(true);
    expect(statSync(join(fx.dir, "src")).isDirectory()).toBe(true);
  });

  it("filters out EXPECTED.md and EXPECTED.json when copying", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);
    expect(existsSync(join(fx.dir, "EXPECTED.json"))).toBe(false);
  });

  it("preserves all source files of the fixture verbatim", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const tsFiles = readdirSync(join(fx.dir, "src")).filter((f) => f.endsWith(".ts"));
    expect(tsFiles.length).toBe(5);

    const original = readFileSync(
      join(import.meta.dirname!, "..", "fixtures", "greenfield-ts", "package.json"),
      "utf8",
    );
    const materialized = readFileSync(join(fx.dir, "package.json"), "utf8");
    expect(materialized).toBe(original);
  });

  it("initializes a git repo on branch main with one commit by the fixture author", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, ".git"))).toBe(true);
    expect(gitOut(fx.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(gitOut(fx.dir, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(gitOut(fx.dir, ["log", "-1", "--pretty=%an"])).toBe("fixture");
    expect(gitOut(fx.dir, ["log", "-1", "--pretty=%ae"])).toBe("fixture@qualy.local");
    expect(gitOut(fx.dir, ["log", "-1", "--pretty=%s"])).toBe("fixture: greenfield-ts");
  });

  it("uses the default commit date 2025-01-01T00:00:00Z when none is provided", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const author = gitOut(fx.dir, ["log", "-1", "--pretty=%aI"]);
    const committer = gitOut(fx.dir, ["log", "-1", "--pretty=%cI"]);
    expect(new Date(author).toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(new Date(committer).toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("forwards an explicit commitDate to both author and committer", () => {
    const fx = materializeFixture("greenfield-ts", { commitDate: "2024-06-15T12:30:00Z" });
    cleanups.push(fx.cleanup);

    const author = gitOut(fx.dir, ["log", "-1", "--pretty=%aI"]);
    const committer = gitOut(fx.dir, ["log", "-1", "--pretty=%cI"]);
    expect(new Date(author).toISOString()).toBe("2024-06-15T12:30:00.000Z");
    expect(new Date(committer).toISOString()).toBe("2024-06-15T12:30:00.000Z");
  });

  it("produces a clean working tree (everything is committed)", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    expect(gitOut(fx.dir, ["status", "--porcelain"])).toBe("");
  });

  it("yields independent dirs across calls (no shared state)", () => {
    const a = materializeFixture("greenfield-ts");
    cleanups.push(a.cleanup);
    const b = materializeFixture("greenfield-ts");
    cleanups.push(b.cleanup);

    expect(a.dir).not.toBe(b.dir);
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);
  });

  it("cleanup removes the directory and is safe to call twice", () => {
    const fx = materializeFixture("greenfield-ts");
    expect(existsSync(fx.dir)).toBe(true);
    fx.cleanup();
    expect(existsSync(fx.dir)).toBe(false);
    expect(() => fx.cleanup()).not.toThrow();
  });

  it("works for the brownfield-eslint-prettier fixture (configs survive copy)", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, ".eslintrc.json"))).toBe(true);
    expect(existsSync(join(fx.dir, ".prettierrc.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "package.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);
  });

  it("works for the unsupported-python fixture (no package.json, has pyproject.toml)", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "pyproject.toml"))).toBe(true);
    expect(existsSync(join(fx.dir, "package.json"))).toBe(false);
    expect(existsSync(join(fx.dir, "src", "unsupported_python", "main.py"))).toBe(true);
  });

  it("works for the jest-with-coverage fixture (jest.config.js + threshold survive copy)", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "jest.config.js"))).toBe(true);
    expect(existsSync(join(fx.dir, "package.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "src"))).toBe(true);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);

    const jestConfig = readFileSync(join(fx.dir, "jest.config.js"), "utf8");
    expect(jestConfig).toMatch(/coverageThreshold/);
    expect(jestConfig).toMatch(/lines\s*:\s*60/);

    const pkg = JSON.parse(readFileSync(join(fx.dir, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.jest).toBeDefined();
  });

  it("works for the legacy-monorepo fixture (pnpm workspace + 3 packages survive copy)", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(fx.dir, "package.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);

    for (const pkg of ["auth", "core", "api"] as const) {
      expect(existsSync(join(fx.dir, "packages", pkg, "package.json"))).toBe(true);
      expect(existsSync(join(fx.dir, "packages", pkg, "src", "index.ts"))).toBe(true);
    }

    const root = JSON.parse(readFileSync(join(fx.dir, "package.json"), "utf8")) as {
      private?: boolean;
      packageManager?: string;
    };
    expect(root.private).toBe(true);
    expect(root.packageManager).toMatch(/^pnpm@/);

    const apiPkg = JSON.parse(
      readFileSync(join(fx.dir, "packages", "api", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(apiPkg.dependencies?.["@legacy-monorepo/auth"]).toBe("workspace:*");
    expect(apiPkg.dependencies?.["@legacy-monorepo/core"]).toBe("workspace:*");
  });

  it("works for the ignore-greenfield fixture (oxlint presets present, no manifest)", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "package.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "oxlint.fast.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "oxlint.deep.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, "src", "legacy", "old-module.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, ".harn", "qualy", "ignore.json"))).toBe(false);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);

    const fast = JSON.parse(readFileSync(join(fx.dir, "oxlint.fast.json"), "utf8")) as {
      ignorePatterns?: unknown;
      overrides?: unknown;
    };
    expect(fast.ignorePatterns).toBeUndefined();
    expect(fast.overrides).toBeUndefined();

    const legacy = readFileSync(join(fx.dir, "src", "legacy", "old-module.ts"), "utf8");
    expect(legacy).toMatch(/debugger;/);
  });

  it("works for the ignore-brownfield fixture (user-authored ignorePatterns outside markers)", () => {
    const fx = materializeFixture("ignore-brownfield");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "oxlint.fast.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "oxlint.deep.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, "src", "old", "legacy.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, ".harn", "qualy", "ignore.json"))).toBe(false);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);

    for (const tier of ["fast", "deep"] as const) {
      const preset = JSON.parse(
        readFileSync(join(fx.dir, `oxlint.${tier}.json`), "utf8"),
      ) as { ignorePatterns?: unknown };
      expect(Array.isArray(preset.ignorePatterns)).toBe(true);
      const patterns = preset.ignorePatterns as readonly string[];
      expect(patterns).toEqual(["src/old/**"]);
      expect(patterns).not.toContain("_qualy:start_");
      expect(patterns).not.toContain("_qualy:end_");
    }
  });

  it("works for the ignore-expired fixture (manifest pre-populated with expired entry)", () => {
    const fx = materializeFixture("ignore-expired");
    cleanups.push(fx.cleanup);

    expect(existsSync(join(fx.dir, "oxlint.fast.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "oxlint.deep.json"))).toBe(true);
    expect(existsSync(join(fx.dir, ".harn", "qualy", "ignore.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "src", "legacy", "old-module.ts"))).toBe(true);
    expect(existsSync(join(fx.dir, "EXPECTED.md"))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(fx.dir, ".harn", "qualy", "ignore.json"), "utf8"),
    ) as {
      version: number;
      entries: ReadonlyArray<{
        id: string;
        glob: string;
        rule: string | null;
        expires: string | null;
        createdBy: string;
      }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    const [entry] = manifest.entries;
    expect(entry?.id).toBe("ign-19160e");
    expect(entry?.glob).toBe("src/legacy/**");
    expect(entry?.rule).toBeNull();
    expect(entry?.expires).toBe("2025-06-01");
    expect(entry?.createdBy).toBe("user");

    for (const tier of ["fast", "deep"] as const) {
      const preset = JSON.parse(
        readFileSync(join(fx.dir, `oxlint.${tier}.json`), "utf8"),
      ) as { ignorePatterns?: readonly string[] };
      expect(preset.ignorePatterns).toEqual([
        "_qualy:start_",
        "src/legacy/**",
        "_qualy:end_",
      ]);
    }
  });

  it("rejects fixture names with path separators", () => {
    expect(() => materializeFixture("../etc")).toThrow(/invalid fixture name/);
    expect(() => materializeFixture("foo/bar")).toThrow(/invalid fixture name/);
    expect(() => materializeFixture("foo\\bar")).toThrow(/invalid fixture name/);
    expect(() => materializeFixture("..")).toThrow(/invalid fixture name/);
  });

  it("rejects empty fixture name", () => {
    expect(() => materializeFixture("")).toThrow(/invalid fixture name/);
  });

  it("throws when the named fixture does not exist", () => {
    expect(() => materializeFixture("does-not-exist-12345")).toThrow(/fixture not found/);
  });
});
