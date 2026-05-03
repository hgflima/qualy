import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  churn90d,
  dirtyFiles,
  firstCommitDate,
  type GitRunResult,
  type GitRunner,
  isClean,
  lsFilesByExt,
  setGitRunner,
} from "../../src/lib/git.ts";

interface Call {
  cwd: string;
  args: readonly string[];
}

function makeRunner(reply: (call: Call) => GitRunResult): { runner: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: GitRunner = (cwd, args) => {
    calls.push({ cwd, args });
    return reply({ cwd, args });
  };
  return { runner, calls };
}

const ok = (stdout: string): GitRunResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 128): GitRunResult => ({
  ok: false,
  stdout: "",
  stderr,
  exitCode,
});

describe("git wrappers", () => {
  afterEach(() => {
    setGitRunner(null);
  });

  describe("isClean", () => {
    it("true when porcelain output is empty", () => {
      const { runner, calls } = makeRunner(() => ok(""));
      setGitRunner(runner);
      const res = isClean("/repo");
      expect(res).toEqual({ ok: true, value: true });
      expect(calls[0]).toEqual({ cwd: "/repo", args: ["status", "--porcelain"] });
    });

    it("false when there are pending changes", () => {
      setGitRunner(makeRunner(() => ok(" M cli/src/lib/git.ts\n?? new.ts\n")).runner);
      expect(isClean("/repo")).toEqual({ ok: true, value: false });
    });

    it("propagates git failure as ok:false", () => {
      setGitRunner(makeRunner(() => fail("fatal: not a git repository")).runner);
      const res = isClean("/tmp");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/not a git repository/);
    });
  });

  describe("firstCommitDate", () => {
    it("returns the earliest root commit ISO date as a Date", () => {
      const stdout = ["2024-03-04T10:00:00+00:00", "2023-01-01T00:00:00+00:00"].join("\n") + "\n";
      const { runner, calls } = makeRunner(() => ok(stdout));
      setGitRunner(runner);
      const res = firstCommitDate("/repo");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBeInstanceOf(Date);
        expect((res.value as Date).toISOString()).toBe("2023-01-01T00:00:00.000Z");
      }
      expect(calls[0]?.args).toEqual(["log", "--max-parents=0", "--pretty=%cI"]);
    });

    it("returns null for empty repos (no commits)", () => {
      setGitRunner(makeRunner(() => ok("")).runner);
      expect(firstCommitDate("/repo")).toEqual({ ok: true, value: null });
    });

    it("returns null when git complains the repo has no commits", () => {
      setGitRunner(
        makeRunner(() =>
          fail("fatal: your current branch 'main' does not have any commits yet"),
        ).runner,
      );
      expect(firstCommitDate("/repo")).toEqual({ ok: true, value: null });
    });

    it("propagates other git failures as ok:false", () => {
      setGitRunner(makeRunner(() => fail("fatal: not a git repository")).runner);
      const res = firstCommitDate("/repo");
      expect(res.ok).toBe(false);
    });

    it("flags unparsable date strings", () => {
      setGitRunner(makeRunner(() => ok("not-a-date\n")).runner);
      const res = firstCommitDate("/repo");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/unparsable/);
    });
  });

  describe("churn90d", () => {
    it("parses the integer count", () => {
      const { runner, calls } = makeRunner(() => ok("42\n"));
      setGitRunner(runner);
      expect(churn90d("/repo")).toEqual({ ok: true, value: 42 });
      expect(calls[0]?.args).toEqual([
        "rev-list",
        "--count",
        "--since=90 days ago",
        "HEAD",
      ]);
    });

    it("returns 0 when there are no commits yet", () => {
      setGitRunner(
        makeRunner(() => fail("fatal: bad revision 'HEAD'")).runner,
      );
      expect(churn90d("/repo")).toEqual({ ok: true, value: 0 });
    });

    it("propagates other failures", () => {
      setGitRunner(makeRunner(() => fail("fatal: not a git repository")).runner);
      const res = churn90d("/repo");
      expect(res.ok).toBe(false);
    });

    it("flags non-numeric output", () => {
      setGitRunner(makeRunner(() => ok("???\n")).runner);
      const res = churn90d("/repo");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/unparsable/);
    });
  });

  describe("lsFilesByExt", () => {
    it("forwards each extension as a *.ext pathspec", () => {
      const { runner, calls } = makeRunner(() =>
        ok(["src/a.ts", "src/b.tsx", "src/c.js"].join("\0") + "\0"),
      );
      setGitRunner(runner);
      const res = lsFilesByExt("/repo", ["ts", ".tsx", "*.js"]);
      expect(res).toEqual({
        ok: true,
        value: ["src/a.ts", "src/b.tsx", "src/c.js"],
      });
      expect(calls[0]?.args).toEqual([
        "ls-files",
        "-z",
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
      ]);
    });

    it("dedupes pathspecs", () => {
      const { runner, calls } = makeRunner(() => ok(""));
      setGitRunner(runner);
      lsFilesByExt("/repo", ["ts", "ts", ".ts"]);
      expect(calls[0]?.args).toEqual(["ls-files", "-z", "--", "*.ts"]);
    });

    it("returns empty list for empty extension list (no git call)", () => {
      const { runner, calls } = makeRunner(() => ok("garbage"));
      setGitRunner(runner);
      expect(lsFilesByExt("/repo", [])).toEqual({ ok: true, value: [] });
      expect(calls).toHaveLength(0);
    });

    it("returns empty list when git emits no files", () => {
      setGitRunner(makeRunner(() => ok("")).runner);
      expect(lsFilesByExt("/repo", ["ts"])).toEqual({ ok: true, value: [] });
    });

    it("rejects extensions with path separators or whitespace", () => {
      setGitRunner(makeRunner(() => ok("")).runner);
      const a = lsFilesByExt("/repo", ["ts/jsx"]);
      expect(a.ok).toBe(false);
      const b = lsFilesByExt("/repo", ["t s"]);
      expect(b.ok).toBe(false);
      const c = lsFilesByExt("/repo", [""]);
      expect(c.ok).toBe(false);
    });

    it("propagates git failure", () => {
      setGitRunner(makeRunner(() => fail("fatal: not a git repository")).runner);
      const res = lsFilesByExt("/repo", ["ts"]);
      expect(res.ok).toBe(false);
    });
  });

  describe("dirtyFiles", () => {
    it("returns empty list for a clean tree", () => {
      const { runner, calls } = makeRunner(() => ok(""));
      setGitRunner(runner);
      expect(dirtyFiles("/repo")).toEqual({ ok: true, value: [] });
      expect(calls[0]?.args).toEqual(["status", "--porcelain=v1", "-z"]);
    });

    it("parses NUL-terminated entries from porcelain -z", () => {
      const stdout = " M src/lib/git.ts\0?? new.ts\0";
      setGitRunner(makeRunner(() => ok(stdout)).runner);
      const res = dirtyFiles("/repo");
      expect(res).toEqual({ ok: true, value: ["src/lib/git.ts", "new.ts"] });
    });

    it("preserves paths containing spaces verbatim", () => {
      const stdout = " M path with spaces.ts\0";
      setGitRunner(makeRunner(() => ok(stdout)).runner);
      const res = dirtyFiles("/repo");
      expect(res).toEqual({ ok: true, value: ["path with spaces.ts"] });
    });

    it("handles renames (skips the original-path token)", () => {
      // R<space>new\0old\0 + an unrelated entry afterwards
      const stdout = "R  new.ts\0old.ts\0 M other.ts\0";
      setGitRunner(makeRunner(() => ok(stdout)).runner);
      const res = dirtyFiles("/repo");
      expect(res).toEqual({ ok: true, value: ["new.ts", "other.ts"] });
    });

    it("handles copies (skips the original-path token)", () => {
      const stdout = "C  copy.ts\0src.ts\0";
      setGitRunner(makeRunner(() => ok(stdout)).runner);
      const res = dirtyFiles("/repo");
      expect(res).toEqual({ ok: true, value: ["copy.ts"] });
    });

    it("propagates git failure", () => {
      setGitRunner(makeRunner(() => fail("fatal: not a git repository")).runner);
      const res = dirtyFiles("/repo");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/not a git repository/);
    });
  });

  describe("setGitRunner reset", () => {
    it("passing null restores the default runner (smoke: real git on this repo)", () => {
      setGitRunner(null);
      // The qualy repo itself is a git repo; isClean should not error out.
      const res = isClean(process.cwd());
      expect(res.ok).toBe(true);
    });
  });
});
