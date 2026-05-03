import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectStage,
  parseDetectStageArgs,
  STAGE_THRESHOLDS,
} from "../../src/commands/detect-stage.ts";
import {
  type GitRunResult,
  type GitRunner,
  setGitRunner,
} from "../../src/lib/git.ts";

function gitOk(stdout: string): GitRunResult {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function gitFail(stderr: string): GitRunResult {
  return { ok: false, stdout: "", stderr, exitCode: 128 };
}

interface MuxOpts {
  readonly files?: readonly string[];
  /** ISO date string of first commit, `null` for empty repo, or `undefined` to fail. */
  readonly firstCommit?: string | null;
  readonly churn?: number;
}

/**
 * Build a git runner that responds to every command path used by detectStage:
 * `ls-files`, `log --max-parents=0`, `rev-list --count`. Any other invocation
 * returns empty stdout (ok).
 */
function gitMux(opts: MuxOpts): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "ls-files") {
      const files = opts.files ?? [];
      const stdout = files.length === 0 ? "" : files.join("\0") + "\0";
      return gitOk(stdout);
    }
    if (args[0] === "log") {
      if (opts.firstCommit === null) {
        return gitFail("fatal: your current branch 'main' does not have any commits yet");
      }
      if (opts.firstCommit === undefined) {
        return gitFail("fatal: not a git repository");
      }
      return gitOk(`${opts.firstCommit}\n`);
    }
    if (args[0] === "rev-list") {
      return gitOk(`${String(opts.churn ?? 0)}\n`);
    }
    return gitOk("");
  };
}

/** Mock `existsFn` that flags listed basenames as present at `<cwd>/<name>`. */
function existsFor(present: readonly string[], cwd = "/repo") {
  const set = new Set(present.map((p) => join(cwd, p)));
  return (path: string) => set.has(path);
}

/** Mock `readFileFn` that returns content for listed paths only. */
function readFor(map: Record<string, string>, cwd = "/repo") {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    resolved[join(cwd, k)] = v;
  }
  return (path: string) => resolved[path] ?? null;
}

function isoDaysAgo(days: number, ref: Date): string {
  return new Date(ref.getTime() - days * 86400000).toISOString();
}

describe("detectStage", () => {
  afterEach(() => {
    setGitRunner(null);
  });

  const NOW = new Date("2026-05-03T12:00:00Z");
  const now = () => NOW;

  it("classifies as greenfield when young + small + no linter", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts", "src/b.ts"],
        firstCommit: isoDaysAgo(30, NOW),
        churn: 5,
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const a = 1;\n",
          "src/b.ts": "const b = 2;\n",
        }),
        now,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stage).toBe("greenfield");
    expect(res.signals.linter_present).toBe(false);
    expect(res.signals.loc).toBe(2);
    expect(res.signals.source_files).toBe(2);
    expect(res.signals.age_days).toBe(30);
  });

  it("classifies as brownfield-moderate when prior linter exists in a young small repo", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(30, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", ".eslintrc.json"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const a = 1;\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("brownfield-moderate");
    expect(res.signals.linter_present).toBe(true);
  });

  it("classifies as brownfield-moderate for a mid-age mid-size repo", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const reads: Record<string, string> = { "package.json": JSON.stringify({}) };
    for (const f of files) reads[f] = "x\n".repeat(50); // 50 lines each → 1000 LOC

    setGitRunner(
      gitMux({
        files,
        firstCommit: isoDaysAgo(400, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", "tests"]),
        readFileFn: readFor(reads),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("brownfield-moderate");
    expect(res.signals.has_tests).toBe(true);
    expect(res.signals.loc).toBeGreaterThan(900);
  });

  it("classifies as legacy when old + huge LOC", () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/f${i}.ts`);
    const reads: Record<string, string> = { "package.json": JSON.stringify({}) };
    // 5 files × 11000 lines each = 55000 LOC
    for (const f of files) reads[f] = "x\n".repeat(11000);

    setGitRunner(
      gitMux({
        files,
        firstCommit: isoDaysAgo(STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS + 100, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", "tests"]),
        readFileFn: readFor(reads),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("legacy");
    expect(res.signals.loc).toBeGreaterThan(STAGE_THRESHOLDS.LEGACY_MIN_LOC);
  });

  it("classifies as legacy when old + no tests (low LOC, low TODOs)", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS + 50, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        // no test/, tests/, __tests__ dirs; no vitest/jest
        existsFn: existsFor(["package.json"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const a = 1;\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("legacy");
    expect(res.signals.has_tests).toBe(false);
  });

  it("classifies as legacy when old + high TODO/HACK density", () => {
    // 100 LOC, but 5 TODO comments → density 5/100 (well over 1/100)
    const fileText =
      "// TODO: rewrite\n// FIXME: edge\n// HACK: monkey-patch\n// TODO: more\n// FIXME: again\n" +
      "x\n".repeat(95);
    setGitRunner(
      gitMux({
        files: ["src/legacy.ts"],
        firstCommit: isoDaysAgo(STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS + 1, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", "tests"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/legacy.ts": fileText,
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("legacy");
    expect(res.signals.todo_count).toBe(5);
    if (res.signals.todo_density_per_100_loc !== null) {
      expect(res.signals.todo_density_per_100_loc).toBeGreaterThan(1);
    }
  });

  it("does NOT classify as legacy when only the age trigger fires (must have one of LOC/TODOs/no-tests)", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS + 10, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", "tests"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const a = 1;\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("brownfield-moderate");
  });

  it("treats empty repo (no commits) as greenfield candidate", () => {
    setGitRunner(
      gitMux({
        files: [],
        firstCommit: null, // empty repo
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor([]),
        readFileFn: readFor({}),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.stage).toBe("greenfield");
    expect(res.signals.first_commit_date).toBeNull();
    expect(res.signals.age_days).toBeNull();
    expect(res.signals.loc).toBe(0);
  });

  it("propagates ls-files git failure as ok:false", () => {
    setGitRunner((_cwd, args) => {
      if (args[0] === "ls-files") return gitFail("fatal: not a git repository");
      return gitOk("");
    });
    const res = detectStage(
      { cwd: "/repo" },
      { existsFn: existsFor([]), readFileFn: readFor({}), now },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/);
  });

  it("includes detect-existing-linter result via package.json devDependencies", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(30, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({
            devDependencies: { eslint: "^9.0.0" },
          }),
          "src/a.ts": "const a = 1;\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.linter_present).toBe(true);
    expect(res.stage).toBe("brownfield-moderate");
  });

  it("detects has_tests via vitest config (no test dirs)", () => {
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(STAGE_THRESHOLDS.LEGACY_MIN_AGE_DAYS + 1, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json", "vitest.config.ts"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const a = 1;\n",
          "vitest.config.ts": "export default {};\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.has_tests).toBe(true);
    // age old, has tests, low LOC, low TODOs → no legacy trigger
    expect(res.stage).toBe("brownfield-moderate");
  });

  it("computes todo_density_per_100_loc=null when LOC=0", () => {
    setGitRunner(
      gitMux({
        files: [],
        firstCommit: isoDaysAgo(30, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor([]),
        readFileFn: readFor({}),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.loc).toBe(0);
    expect(res.signals.todo_count).toBe(0);
    expect(res.signals.todo_density_per_100_loc).toBeNull();
  });

  it("uses word-boundary matching for TODO/FIXME/HACK (does not match within identifiers)", () => {
    // "todoList" should NOT match (no word boundary on the right edge of TODO).
    // "// TODO" should match.
    setGitRunner(
      gitMux({
        files: ["src/a.ts"],
        firstCommit: isoDaysAgo(30, NOW),
      }),
    );
    const res = detectStage(
      { cwd: "/repo" },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFor({
          "package.json": JSON.stringify({}),
          "src/a.ts": "const todoList = [];\nconst fixmeup = 1;\n// TODO: real one\n",
        }),
        now,
      },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.todo_count).toBe(1);
  });
});

describe("parseDetectStageArgs", () => {
  it("returns the default cwd when no flags are provided", () => {
    const res = parseDetectStageArgs([], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/default" } });
  });

  it("resolves --cwd against the default", () => {
    const res = parseDetectStageArgs(["--cwd", "/abs/path"], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/abs/path" } });
  });

  it("rejects --cwd with no value", () => {
    const res = parseDetectStageArgs(["--cwd"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing value/);
  });

  it("rejects unknown flags", () => {
    const res = parseDetectStageArgs(["--bogus"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown flag/);
  });

  it("recognizes --help", () => {
    const res = parseDetectStageArgs(["--help"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("help");
  });
});
