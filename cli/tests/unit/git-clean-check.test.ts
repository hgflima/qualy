import { afterEach, describe, expect, it } from "vitest";
import {
  gitCleanCheck,
  parseGitCleanCheckArgs,
  runGitCleanCheck,
} from "../../src/commands/git-clean-check.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import {
  type GitRunResult,
  type GitRunner,
  setGitRunner,
} from "../../src/lib/git.ts";
import { setStreams } from "../../src/lib/logger.ts";
import { Writable } from "node:stream";

function gitOk(stdout: string): GitRunResult {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}
function gitFail(stderr: string): GitRunResult {
  return { ok: false, stdout: "", stderr, exitCode: 128 };
}

function constRunner(reply: GitRunResult): GitRunner {
  return () => reply;
}

class StringSink extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

describe("gitCleanCheck (pure)", () => {
  afterEach(() => {
    setGitRunner(null);
  });

  it("returns clean:true on empty porcelain output", () => {
    setGitRunner(constRunner(gitOk("")));
    const res = gitCleanCheck({ cwd: "/repo" });
    expect(res).toEqual({
      ok: true,
      cwd: "/repo",
      clean: true,
      dirtyFiles: [],
    });
  });

  it("returns clean:false with the list of dirty paths", () => {
    setGitRunner(constRunner(gitOk(" M a.ts\0?? b.ts\0")));
    const res = gitCleanCheck({ cwd: "/repo" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.clean).toBe(false);
    expect(res.dirtyFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("propagates git failure as ok:false", () => {
    setGitRunner(constRunner(gitFail("fatal: not a git repository")));
    const res = gitCleanCheck({ cwd: "/x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/);
  });
});

describe("parseGitCleanCheckArgs", () => {
  it("default cwd when no flags", () => {
    const res = parseGitCleanCheckArgs([], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/default" } });
  });

  it("--cwd absolute", () => {
    const res = parseGitCleanCheckArgs(["--cwd", "/abs"], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/abs" } });
  });

  it("--cwd relative resolves against default", () => {
    const res = parseGitCleanCheckArgs(["--cwd", "sub"], "/base");
    expect(res).toEqual({ ok: true, value: { cwd: "/base/sub" } });
  });

  it("rejects --cwd with no value", () => {
    const res = parseGitCleanCheckArgs(["--cwd"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing value/);
  });

  it("rejects unknown flags", () => {
    const res = parseGitCleanCheckArgs(["--bogus"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown flag/);
  });

  it("recognizes --help", () => {
    const res = parseGitCleanCheckArgs(["--help"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("help");
  });
});

describe("runGitCleanCheck (handler)", () => {
  let stdout: StringSink;
  let stderr: StringSink;

  function withStreams() {
    stdout = new StringSink();
    stderr = new StringSink();
    setStreams({ stdout, stderr });
  }

  afterEach(() => {
    setGitRunner(null);
    setStreams({ stdout: process.stdout, stderr: process.stderr });
  });

  it("returns OK and emits {clean:true,dirty_files:[]} on a clean tree", () => {
    withStreams();
    setGitRunner(constRunner(gitOk("")));
    const code = runGitCleanCheck(["--cwd", "/repo"]);
    expect(code).toBe(EXIT_CODES.OK);
    const payload = JSON.parse(stdout.text());
    expect(payload).toEqual({ clean: true, dirty_files: [] });
  });

  it("returns DIRTY_TREE and lists dirty files when changes are present", () => {
    withStreams();
    setGitRunner(constRunner(gitOk(" M a.ts\0?? b.ts\0")));
    const code = runGitCleanCheck(["--cwd", "/repo"]);
    expect(code).toBe(EXIT_CODES.DIRTY_TREE);
    const payload = JSON.parse(stdout.text());
    expect(payload).toEqual({ clean: false, dirty_files: ["a.ts", "b.ts"] });
  });

  it("returns RECOVERABLE_ERROR when git itself fails", () => {
    withStreams();
    setGitRunner(constRunner(gitFail("fatal: not a git repository")));
    const code = runGitCleanCheck([]);
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text());
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("git_clean_check_failed");
  });

  it("returns OK on --help and emits no stdout payload", () => {
    withStreams();
    // Help text is intentionally written to the real process.stderr (matches
    // the convention used by detect-stack); we only assert exit code and
    // that no canonical JSON was emitted.
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = runGitCleanCheck(["--help"]);
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("returns USAGE_ERROR on unknown flag", () => {
    withStreams();
    const code = runGitCleanCheck(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text());
    expect(payload.error).toBe("usage_error");
  });
});
