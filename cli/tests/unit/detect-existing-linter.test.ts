import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  detectExistingLinter,
  parseDetectExistingLinterArgs,
  runDetectExistingLinter,
} from "../../src/commands/detect-existing-linter.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { setStreams } from "../../src/lib/logger.ts";

const CWD = "/repo";

function existsFor(present: readonly string[], cwd = CWD) {
  const set = new Set(present.map((p) => join(cwd, p)));
  return (path: string) => set.has(path);
}

function readFileFor(map: Record<string, string>, cwd = CWD) {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) resolved[join(cwd, k)] = v;
  return (path: string) => resolved[path] ?? null;
}

class StringSink extends Writable {
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

describe("detectExistingLinter (pure)", () => {
  it("returns empty arrays when no configs and no package.json", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      { existsFn: existsFor([]), readFileFn: readFileFor({}) },
    );
    expect(res).toEqual({ ok: true, cwd: CWD, linters: [], formatters: [] });
  });

  it("detects ESLint via .eslintrc.json", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor([".eslintrc.json"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.linters).toEqual([
      { name: "eslint", configs: [".eslintrc.json"], pkg_dep: false },
    ]);
    expect(res.formatters).toEqual([]);
  });

  it("detects ESLint flat config (eslint.config.js)", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["eslint.config.js"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.linters[0]?.configs).toEqual(["eslint.config.js"]);
  });

  it("detects ESLint via package.json#eslintConfig", () => {
    const pkg = JSON.stringify({ eslintConfig: { extends: ["eslint:recommended"] } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters).toEqual([
      { name: "eslint", configs: ["package.json#eslintConfig"], pkg_dep: false },
    ]);
  });

  it("detects ESLint via devDependencies", () => {
    const pkg = JSON.stringify({ devDependencies: { eslint: "^9.0.0" } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters).toEqual([{ name: "eslint", configs: [], pkg_dep: true }]);
  });

  it("detects Prettier (config + dep)", () => {
    const pkg = JSON.stringify({ devDependencies: { prettier: "^3.0.0" } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json", ".prettierrc"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.formatters).toEqual([
      { name: "prettier", configs: [".prettierrc"], pkg_dep: true },
    ]);
    expect(res.linters).toEqual([]);
  });

  it("detects Prettier via package.json#prettier inline config", () => {
    const pkg = JSON.stringify({ prettier: { semi: false } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.formatters).toEqual([
      { name: "prettier", configs: ["package.json#prettier"], pkg_dep: false },
    ]);
  });

  it("classifies Biome in BOTH linters and formatters", () => {
    const pkg = JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json", "biome.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters).toEqual([
      { name: "biome", configs: ["biome.json"], pkg_dep: true },
    ]);
    expect(res.formatters).toEqual([
      { name: "biome", configs: ["biome.json"], pkg_dep: true },
    ]);
  });

  it("detects dprint via dprint.json", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["dprint.json"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.formatters).toEqual([
      { name: "dprint", configs: ["dprint.json"], pkg_dep: false },
    ]);
    expect(res.linters).toEqual([]);
  });

  it("returns multiple tools simultaneously (brownfield-eslint-prettier)", () => {
    const pkg = JSON.stringify({
      devDependencies: { eslint: "^8.0.0", prettier: "^3.0.0" },
    });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json", ".eslintrc.cjs", ".prettierrc.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters).toEqual([
      { name: "eslint", configs: [".eslintrc.cjs"], pkg_dep: true },
    ]);
    expect(res.formatters).toEqual([
      { name: "prettier", configs: [".prettierrc.json"], pkg_dep: true },
    ]);
  });

  it("dedups multiple ESLint config files (lists every match)", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor([".eslintrc", ".eslintrc.json", "eslint.config.mjs"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.linters[0]?.configs).toEqual([
      ".eslintrc",
      ".eslintrc.json",
      "eslint.config.mjs",
    ]);
  });

  it("malformed package.json is treated as missing (no throw)", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": "{ not valid json" }),
      },
    );
    expect(res).toEqual({ ok: true, cwd: CWD, linters: [], formatters: [] });
  });

  it("non-object package.json is treated as missing", () => {
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": "[1,2,3]" }),
      },
    );
    // Arrays are objects in JS, but our shape access just won't find dep maps.
    // We don't care if this is included or not — it just must not throw.
    expect(res.ok).toBe(true);
  });

  it("checks peerDependencies and optionalDependencies too", () => {
    const pkg = JSON.stringify({
      peerDependencies: { eslint: "*" },
      optionalDependencies: { prettier: "*" },
    });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters[0]?.pkg_dep).toBe(true);
    expect(res.formatters[0]?.pkg_dep).toBe(true);
  });

  it("does not include tools with zero evidence", () => {
    const pkg = JSON.stringify({ devDependencies: { typescript: "^5.0.0" } });
    const res = detectExistingLinter(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.linters).toEqual([]);
    expect(res.formatters).toEqual([]);
  });
});

describe("parseDetectExistingLinterArgs", () => {
  it("default cwd when no flags", () => {
    const res = parseDetectExistingLinterArgs([], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/default" } });
  });

  it("--cwd absolute", () => {
    const res = parseDetectExistingLinterArgs(["--cwd", "/abs"], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/abs" } });
  });

  it("--cwd relative resolves against default", () => {
    const res = parseDetectExistingLinterArgs(["--cwd", "sub"], "/base");
    expect(res).toEqual({ ok: true, value: { cwd: "/base/sub" } });
  });

  it("rejects --cwd with no value", () => {
    const res = parseDetectExistingLinterArgs(["--cwd"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing value/);
  });

  it("rejects unknown flags", () => {
    const res = parseDetectExistingLinterArgs(["--bogus"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown flag/);
  });

  it("recognizes --help", () => {
    const res = parseDetectExistingLinterArgs(["--help"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("help");
  });
});

describe("runDetectExistingLinter (handler)", () => {
  let stdout: StringSink;
  let stderr: StringSink;

  function withStreams() {
    stdout = new StringSink();
    stderr = new StringSink();
    setStreams({ stdout, stderr });
  }

  afterEach(() => {
    setStreams({ stdout: process.stdout, stderr: process.stderr });
  });

  it("emits {linters, formatters} JSON and exits OK", () => {
    withStreams();
    // No --cwd, runs against process.cwd() — qualy repo itself, which has no
    // ESLint/Prettier/Biome/dprint configs at the root, so output is empty.
    const code = runDetectExistingLinter([]);
    expect(code).toBe(EXIT_CODES.OK);
    const payload = JSON.parse(stdout.text());
    expect(payload).toHaveProperty("linters");
    expect(payload).toHaveProperty("formatters");
    expect(Array.isArray(payload.linters)).toBe(true);
    expect(Array.isArray(payload.formatters)).toBe(true);
  });

  it("returns OK on --help with no stdout payload", () => {
    withStreams();
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = runDetectExistingLinter(["--help"]);
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("returns USAGE_ERROR on unknown flag", () => {
    withStreams();
    const code = runDetectExistingLinter(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text());
    expect(payload.error).toBe("usage_error");
  });
});
