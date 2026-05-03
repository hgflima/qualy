import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  parseStatusArgs,
  runStatus,
  status,
} from "../../src/commands/status.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { setStreams } from "../../src/lib/logger.ts";
import {
  type GitRunResult,
  type GitRunner,
  setGitRunner,
} from "../../src/lib/git.ts";

const CWD = "/repo";

function gitOk(stdout: string): GitRunResult {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function existsFor(present: readonly string[], cwd = CWD) {
  const set = new Set(present.map((p) => join(cwd, p)));
  return (path: string) => set.has(path);
}

function readFileFor(map: Record<string, string>, cwd = CWD) {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) resolved[join(cwd, k)] = v;
  return (path: string) => resolved[path] ?? null;
}

/**
 * Default git runner: empty repo, no files, no commits. Lets stage detection
 * succeed cleanly so tests can focus on the non-git portions of status.
 */
function emptyRepoRunner(): GitRunner {
  return (_cwd, args) => {
    if (args[0] === "ls-files") return gitOk("");
    if (args[0] === "log") {
      return {
        ok: false,
        stdout: "",
        stderr: "fatal: your current branch 'main' does not have any commits yet",
        exitCode: 128,
      };
    }
    if (args[0] === "rev-list") return gitOk("0\n");
    if (args[0] === "status") return gitOk("");
    return gitOk("");
  };
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

describe("status (pure)", () => {
  afterEach(() => {
    setGitRunner(null);
  });

  it("returns sane defaults when nothing is installed or configured", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      { existsFn: existsFor([]), readFileFn: readFileFor({}) },
    );
    expect(res.ok).toBe(true);
    expect(res.cwd).toBe(CWD);
    expect(res.versions).toEqual({
      oxlint: null,
      oxfmt: null,
      quality_metrics: null,
      vitest: null,
      jest: null,
    });
    expect(res.presets).toEqual({ oxlint_fast: null, oxlint_deep: null });
    expect(res.hooks).toEqual({
      claude_post_edit_script: false,
      claude_settings_hook: false,
      husky_pre_commit: false,
      lint_staged_config: null,
    });
    expect(res.coverage.runner).toBe("none");
    expect(res.coverage.configured).toBe(false);
    expect(res.coverage.current_thresholds).toBeNull();
    expect(res.theme).toBe("linear-design-md");
  });

  it("reads installed versions from node_modules/<pkg>/package.json", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([
          "node_modules/oxlint/package.json",
          "node_modules/oxfmt/package.json",
          "node_modules/@oxc-project/quality-metrics/package.json",
          "node_modules/vitest/package.json",
        ]),
        readFileFn: readFileFor({
          "node_modules/oxlint/package.json": JSON.stringify({ version: "1.4.0" }),
          "node_modules/oxfmt/package.json": JSON.stringify({ version: "0.9.0" }),
          "node_modules/@oxc-project/quality-metrics/package.json": JSON.stringify({
            version: "0.2.1",
          }),
          "node_modules/vitest/package.json": JSON.stringify({ version: "2.0.5" }),
        }),
      },
    );
    expect(res.versions).toEqual({
      oxlint: "1.4.0",
      oxfmt: "0.9.0",
      quality_metrics: "0.2.1",
      vitest: "2.0.5",
      jest: null,
    });
  });

  it("ignores malformed installed package.json without throwing", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([
          "node_modules/oxlint/package.json",
          "node_modules/vitest/package.json",
        ]),
        readFileFn: readFileFor({
          "node_modules/oxlint/package.json": "{ not json",
          "node_modules/vitest/package.json": JSON.stringify({ version: 42 }),
        }),
      },
    );
    expect(res.versions.oxlint).toBeNull();
    expect(res.versions.vitest).toBeNull();
  });

  it("surfaces oxlint presets when fast and deep configs are present", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["oxlint.fast.json", "oxlint.deep.json"]),
        readFileFn: readFileFor({
          "oxlint.fast.json": "{}",
          "oxlint.deep.json": "{}",
        }),
      },
    );
    expect(res.presets).toEqual({
      oxlint_fast: "oxlint.fast.json",
      oxlint_deep: "oxlint.deep.json",
    });
  });

  it("only fast preset present → deep is null", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["oxlint.fast.json"]),
        readFileFn: readFileFor({ "oxlint.fast.json": "{}" }),
      },
    );
    expect(res.presets.oxlint_fast).toBe("oxlint.fast.json");
    expect(res.presets.oxlint_deep).toBeNull();
  });

  it("detects Claude post-edit script and settings hook", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".claude/hooks/post-edit.sh", ".claude/settings.json"]),
        readFileFn: readFileFor({
          ".claude/settings.json": JSON.stringify({
            hooks: {
              PostToolUse: [
                { matcher: "Edit|Write", hooks: [{ type: "command", command: ".claude/hooks/post-edit.sh" }] },
              ],
            },
          }),
        }),
      },
    );
    expect(res.hooks.claude_post_edit_script).toBe(true);
    expect(res.hooks.claude_settings_hook).toBe(true);
  });

  it("settings.json without post-edit reference does not flag the hook", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".claude/settings.json"]),
        readFileFn: readFileFor({
          ".claude/settings.json": JSON.stringify({ hooks: {} }),
        }),
      },
    );
    expect(res.hooks.claude_post_edit_script).toBe(false);
    expect(res.hooks.claude_settings_hook).toBe(false);
  });

  it("detects husky pre-commit hook", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".husky/pre-commit"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.hooks.husky_pre_commit).toBe(true);
  });

  it("detects lint-staged config from a file", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".lintstagedrc.js"]),
        readFileFn: readFileFor({}),
      },
    );
    expect(res.hooks.lint_staged_config).toBe(".lintstagedrc.js");
  });

  it("detects lint-staged config inline in package.json", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({
          "package.json": JSON.stringify({
            name: "x",
            "lint-staged": { "*.ts": "oxlint" },
          }),
        }),
      },
    );
    expect(res.hooks.lint_staged_config).toBe("package.json#lint-staged");
  });

  it("malformed package.json does not crash lint-staged probe", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({ "package.json": "{ not json" }),
      },
    );
    expect(res.hooks.lint_staged_config).toBeNull();
  });

  it("file-based lint-staged config wins over package.json key", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".lintstagedrc.json", "package.json"]),
        readFileFn: readFileFor({
          ".lintstagedrc.json": "{}",
          "package.json": JSON.stringify({ "lint-staged": {} }),
        }),
      },
    );
    expect(res.hooks.lint_staged_config).toBe(".lintstagedrc.json");
  });

  it("delegates coverage to detectTestRunner (vitest config present)", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["vitest.config.ts"]),
        readFileFn: readFileFor({ "vitest.config.ts": "export default {}\n" }),
      },
    );
    expect(res.coverage.runner).toBe("vitest");
    expect(res.coverage.configured).toBe(true);
    expect(res.coverage.current_thresholds).toBeNull();
  });

  it("delegates coverage thresholds parsing (jest with package.json#jest)", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor(["package.json"]),
        readFileFn: readFileFor({
          "package.json": JSON.stringify({
            devDependencies: { jest: "^29" },
            jest: {
              coverageThreshold: {
                global: { lines: 80, functions: 70, branches: 60, statements: 75 },
              },
            },
          }),
        }),
      },
    );
    expect(res.coverage.runner).toBe("jest");
    expect(res.coverage.configured).toBe(true);
    expect(res.coverage.current_thresholds).toEqual({
      lines: 80,
      functions: 70,
      branches: 60,
      statements: 75,
    });
    expect(res.coverage.source).toBe("package.json#jest");
  });

  it("delegates stage detection (greenfield default)", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      { existsFn: existsFor([]), readFileFn: readFileFor({}) },
    );
    expect(res.stage.detected).toBe("greenfield");
    expect(res.stage.signals).not.toBeNull();
    expect(res.stage.signals?.linter_present).toBe(false);
  });

  it("stage falls back to nulls when ls-files fails", () => {
    setGitRunner(() => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
    }));
    const res = status(
      { cwd: CWD },
      { existsFn: existsFor([]), readFileFn: readFileFor({}) },
    );
    // status itself never errors — it just reports null stage
    expect(res.ok).toBe(true);
    expect(res.stage.detected).toBeNull();
    expect(res.stage.reasoning).toBeNull();
    expect(res.stage.signals).toBeNull();
  });

  it("reads theme override from .lint-manifest.json", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".lint-manifest.json"]),
        readFileFn: readFileFor({
          ".lint-manifest.json": JSON.stringify({ theme: "midnight-mono" }),
        }),
      },
    );
    expect(res.theme).toBe("midnight-mono");
  });

  it("malformed manifest falls back to default theme", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".lint-manifest.json"]),
        readFileFn: readFileFor({ ".lint-manifest.json": "{ not json" }),
      },
    );
    expect(res.theme).toBe("linear-design-md");
  });

  it("manifest with non-string theme falls back to default", () => {
    setGitRunner(emptyRepoRunner());
    const res = status(
      { cwd: CWD },
      {
        existsFn: existsFor([".lint-manifest.json"]),
        readFileFn: readFileFor({
          ".lint-manifest.json": JSON.stringify({ theme: 42 }),
        }),
      },
    );
    expect(res.theme).toBe("linear-design-md");
  });
});

describe("parseStatusArgs", () => {
  it("returns default cwd when no flags given", () => {
    const r = parseStatusArgs([], "/x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cwd).toBe("/x");
  });

  it("resolves --cwd relative to defaultCwd", () => {
    const r = parseStatusArgs(["--cwd", "subdir"], "/x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cwd).toBe("/x/subdir");
  });

  it("rejects --cwd without value", () => {
    const r = parseStatusArgs(["--cwd"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing value/);
  });

  it("recognizes --help / -h", () => {
    expect(parseStatusArgs(["--help"], "/x")).toEqual({ ok: false, error: "help" });
    expect(parseStatusArgs(["-h"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("rejects unknown flags", () => {
    const r = parseStatusArgs(["--zonk"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag/);
  });
});

describe("runStatus (handler)", () => {
  afterEach(() => {
    setGitRunner(null);
    setStreams({ stdout: process.stdout, stderr: process.stderr });
  });

  it("emits a JSON document and exits 0 in an empty repo", () => {
    setGitRunner(emptyRepoRunner());
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = runStatus(["--cwd", process.cwd()]);
    expect(code).toBe(EXIT_CODES.OK);
    const lines = stdout.text().trim().split("\n");
    expect(lines.length).toBe(1);
    const payload = JSON.parse(lines[0] ?? "");
    expect(payload.ok).toBe(true);
    expect(payload).toHaveProperty("versions");
    expect(payload).toHaveProperty("presets");
    expect(payload).toHaveProperty("stage");
    expect(payload).toHaveProperty("hooks");
    expect(payload).toHaveProperty("coverage");
    expect(payload).toHaveProperty("theme");
  });

  it("--help returns OK and emits no stdout payload", () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    // Help is written directly to process.stderr (matches git-clean-check
    // convention). Stub it so test output stays clean.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = runStatus(["--help"]);
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("unknown flag exits with USAGE_ERROR and JSON error payload", () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = runStatus(["--zonk"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload).toEqual({
      ok: false,
      error: "usage_error",
      reason: "unknown flag: --zonk",
    });
  });
});
