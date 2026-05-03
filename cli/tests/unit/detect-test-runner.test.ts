import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  detectTestRunner,
  parseDetectTestRunnerArgs,
  runDetectTestRunner,
} from "../../src/commands/detect-test-runner.ts";
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

describe("detectTestRunner (pure)", () => {
  it("returns runner=none when no configs and no package.json", () => {
    const res = detectTestRunner(
      { cwd: CWD },
      { existsFn: existsFor([]), readFileFn: readFileFor({}) },
    );
    expect(res.runner).toBe("none");
    expect(res.candidates.vitest).toEqual({
      configs: [],
      pkg_dep: false,
      thresholds: null,
      thresholds_source: null,
    });
    expect(res.candidates.jest).toEqual({
      configs: [],
      pkg_dep: false,
      thresholds: null,
      thresholds_source: null,
    });
    expect(res.coverage.configured).toBe(false);
    expect(res.coverage.current_thresholds).toBeNull();
    expect(res.coverage.current_values).toBeNull();
    expect(res.coverage.source).toBeNull();
  });

  it("detects vitest via vitest.config.ts", () => {
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["vitest.config.ts"]),
        readFileFn: readFileFor({ "vitest.config.ts": "export default {}\n" }),
      },
    );
    expect(res.runner).toBe("vitest");
    expect(res.candidates.vitest.configs).toEqual(["vitest.config.ts"]);
    expect(res.candidates.vitest.pkg_dep).toBe(false);
    expect(res.coverage.configured).toBe(true);
    expect(res.coverage.current_thresholds).toBeNull();
  });

  it("detects vitest via devDependencies only", () => {
    const pkg = JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.runner).toBe("vitest");
    expect(res.candidates.vitest.pkg_dep).toBe(true);
    expect(res.candidates.vitest.configs).toEqual([]);
    expect(res.coverage.configured).toBe(true);
  });

  it("detects jest via jest.config.js", () => {
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.js"]),
        readFileFn: readFileFor({ "jest.config.js": "module.exports = {}\n" }),
      },
    );
    expect(res.runner).toBe("jest");
    expect(res.candidates.jest.configs).toEqual(["jest.config.js"]);
  });

  it("reads jest thresholds from jest.config.json (exact JSON parse)", () => {
    const cfg = JSON.stringify({
      coverageThreshold: {
        global: { lines: 60, functions: 65, branches: 50, statements: 60 },
      },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.json"]),
        readFileFn: readFileFor({ "jest.config.json": cfg }),
      },
    );
    expect(res.runner).toBe("jest");
    expect(res.coverage.current_thresholds).toEqual({
      lines: 60,
      functions: 65,
      branches: 50,
      statements: 60,
    });
    expect(res.coverage.source).toBe("jest.config.json");
  });

  it("reads jest thresholds from jest.config.js via best-effort regex", () => {
    const cfg = `module.exports = {
  testEnvironment: "node",
  coverageThreshold: {
    global: {
      lines: 60,
      functions: 70,
      branches: 50,
      statements: 60
    }
  }
};
`;
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.js"]),
        readFileFn: readFileFor({ "jest.config.js": cfg }),
      },
    );
    expect(res.coverage.current_thresholds).toEqual({
      lines: 60,
      functions: 70,
      branches: 50,
      statements: 60,
    });
    expect(res.coverage.source).toBe("jest.config.js");
  });

  it("reads jest thresholds from package.json#jest inline config", () => {
    const pkg = JSON.stringify({
      devDependencies: { jest: "^29.0.0" },
      jest: { coverageThreshold: { global: { lines: 80, branches: 75 } } },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.runner).toBe("jest");
    expect(res.candidates.jest.configs).toEqual(["package.json#jest"]);
    expect(res.coverage.current_thresholds).toEqual({
      lines: 80,
      functions: null,
      branches: 75,
      statements: null,
    });
    expect(res.coverage.source).toBe("package.json#jest");
  });

  it("reads vitest thresholds from vitest.config.ts via regex", () => {
    const cfg = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90
      }
    }
  }
});
`;
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["vitest.config.ts"]),
        readFileFn: readFileFor({ "vitest.config.ts": cfg }),
      },
    );
    expect(res.runner).toBe("vitest");
    expect(res.coverage.current_thresholds).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
    expect(res.coverage.source).toBe("vitest.config.ts");
  });

  it("returns thresholds=null when config exists but has no recognizable thresholds", () => {
    const cfg = "module.exports = { testEnvironment: 'node', verbose: true }\n";
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.js"]),
        readFileFn: readFileFor({ "jest.config.js": cfg }),
      },
    );
    expect(res.runner).toBe("jest");
    expect(res.coverage.configured).toBe(true);
    expect(res.coverage.current_thresholds).toBeNull();
  });

  it("ignores unrelated `lines: NN` outside threshold containers", () => {
    const cfg = `module.exports = {
  // unrelated comment with lines: 999 should not match
  reporters: [["jest-junit", { outputName: "results.xml" }]],
  testEnvironment: "node"
};
const lines = 12;
`;
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.js"]),
        readFileFn: readFileFor({ "jest.config.js": cfg }),
      },
    );
    expect(res.coverage.current_thresholds).toBeNull();
  });

  it("vitest beats jest when both detected (default preference)", () => {
    const pkg = JSON.stringify({
      devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json", "vitest.config.ts", "jest.config.js"]),
        readFileFn: readFileFor({
          "package.json": pkg,
          "vitest.config.ts": "export default {}\n",
          "jest.config.js": "module.exports = {}\n",
        }),
      },
    );
    expect(res.runner).toBe("vitest");
    expect(res.candidates.vitest.configs).toEqual(["vitest.config.ts"]);
    expect(res.candidates.jest.configs).toEqual(["jest.config.js"]);
  });

  it("jest wins when it has stronger evidence than vitest", () => {
    // Jest: config + dep (score 3). Vitest: dep only (score 1).
    const pkg = JSON.stringify({
      devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json", "jest.config.js"]),
        readFileFn: readFileFor({
          "package.json": pkg,
          "jest.config.js": "module.exports = {}\n",
        }),
      },
    );
    expect(res.runner).toBe("jest");
  });

  it("malformed package.json is treated as no evidence", () => {
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": "{ not valid json" }),
      },
    );
    expect(res.runner).toBe("none");
    expect(res.coverage.configured).toBe(false);
  });

  it("checks peerDependencies for runner deps too", () => {
    const pkg = JSON.stringify({ peerDependencies: { vitest: "*" } });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": pkg }),
      },
    );
    expect(res.runner).toBe("vitest");
    expect(res.candidates.vitest.pkg_dep).toBe(true);
  });

  it("reads vitest thresholds from vitest.workspace.json", () => {
    const cfg = JSON.stringify({
      test: { coverage: { thresholds: { lines: 75 } } },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["vitest.workspace.json"]),
        readFileFn: readFileFor({ "vitest.workspace.json": cfg }),
      },
    );
    expect(res.coverage.current_thresholds).toEqual({
      lines: 75,
      functions: null,
      branches: null,
      statements: null,
    });
    expect(res.coverage.source).toBe("vitest.workspace.json");
  });

  it("non-numeric threshold values are treated as null", () => {
    const cfg = JSON.stringify({
      coverageThreshold: { global: { lines: "60", functions: 70 } },
    });
    const res = detectTestRunner(
      { cwd: CWD },
      {
        existsFn: existsFor(["jest.config.json"]),
        readFileFn: readFileFor({ "jest.config.json": cfg }),
      },
    );
    expect(res.coverage.current_thresholds).toEqual({
      lines: null,
      functions: 70,
      branches: null,
      statements: null,
    });
  });
});

describe("parseDetectTestRunnerArgs", () => {
  it("default cwd when no flags", () => {
    const res = parseDetectTestRunnerArgs([], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/default" } });
  });

  it("--cwd absolute", () => {
    const res = parseDetectTestRunnerArgs(["--cwd", "/abs"], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/abs" } });
  });

  it("--cwd relative resolves against default", () => {
    const res = parseDetectTestRunnerArgs(["--cwd", "sub"], "/base");
    expect(res).toEqual({ ok: true, value: { cwd: "/base/sub" } });
  });

  it("rejects --cwd with no value", () => {
    const res = parseDetectTestRunnerArgs(["--cwd"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing value/);
  });

  it("rejects unknown flags", () => {
    const res = parseDetectTestRunnerArgs(["--bogus"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown flag/);
  });

  it("recognizes --help", () => {
    const res = parseDetectTestRunnerArgs(["--help"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("help");
  });
});

describe("runDetectTestRunner (handler)", () => {
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

  it("emits {runner, candidates, coverage} JSON and exits OK", () => {
    withStreams();
    const code = runDetectTestRunner([]);
    expect(code).toBe(EXIT_CODES.OK);
    const payload = JSON.parse(stdout.text());
    expect(payload).toHaveProperty("runner");
    expect(payload).toHaveProperty("candidates");
    expect(payload.candidates).toHaveProperty("vitest");
    expect(payload.candidates).toHaveProperty("jest");
    expect(payload).toHaveProperty("coverage");
    expect(payload.coverage).toHaveProperty("configured");
    expect(payload.coverage).toHaveProperty("current_thresholds");
    expect(payload.coverage).toHaveProperty("current_values");
    expect(payload.coverage).toHaveProperty("source");
  });

  it("returns OK on --help with no stdout payload", () => {
    withStreams();
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = runDetectTestRunner(["--help"]);
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("returns USAGE_ERROR on unknown flag", () => {
    withStreams();
    const code = runDetectTestRunner(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text());
    expect(payload.error).toBe("usage_error");
  });
});
