import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectStack,
  parseDetectStackArgs,
} from "../../src/commands/detect-stack.ts";
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

/** Build a runner that returns a NUL-separated `ls-files -z` stdout. */
function lsFilesRunner(files: readonly string[]): GitRunner {
  const stdout = files.length === 0 ? "" : files.join("\0") + "\0";
  return () => gitOk(stdout);
}

/** Mock `existsFn` that flags listed basenames as present at `<cwd>/<name>`. */
function existsFor(present: readonly string[], cwd = "/repo") {
  const set = new Set(present.map((p) => join(cwd, p)));
  return (path: string) => set.has(path);
}

describe("detectStack", () => {
  afterEach(() => {
    setGitRunner(null);
  });

  it("classifies a TS-only repo as supported", () => {
    setGitRunner(lsFilesRunner(["src/a.ts", "src/b.ts", "src/c.tsx"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["package.json"]) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.supported).toBe(true);
    expect(res.signals.tsFiles).toBe(2);
    expect(res.signals.tsxFiles).toBe(1);
    expect(res.signals.jsFiles).toBe(0);
    expect(res.signals.hasPackageJson).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.supportedLanguages).toEqual(["ts", "tsx"]);
  });

  it("classifies a JS-only repo as supported", () => {
    setGitRunner(lsFilesRunner(["index.js", "lib/util.jsx"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["package.json"]) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.supported).toBe(true);
    expect(res.supportedLanguages).toEqual(["js", "jsx"]);
  });

  it("blocks Python projects via pyproject.toml", () => {
    setGitRunner(lsFilesRunner([]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["pyproject.toml"]) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.supported).toBe(false);
    expect(res.blockers).toEqual([{ kind: "python", file: "pyproject.toml" }]);
  });

  it("blocks Go projects via go.mod even with TS files present", () => {
    setGitRunner(lsFilesRunner(["scripts/build.ts"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["go.mod"]) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.supported).toBe(false);
    expect(res.blockers.map((b) => b.kind)).toContain("go");
  });

  it("blocks Rust projects via Cargo.toml", () => {
    setGitRunner(lsFilesRunner([]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["Cargo.toml"]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.supported).toBe(false);
    expect(res.blockers[0]?.kind).toBe("rust");
  });

  it("blocks Vue SFC projects via .vue files", () => {
    setGitRunner(lsFilesRunner(["src/App.vue", "src/main.ts"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor(["package.json"]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.supported).toBe(false);
    expect(res.signals.vueFiles).toBe(1);
    expect(res.blockers.some((b) => b.kind === "vue-sfc")).toBe(true);
  });

  it("blocks Svelte SFC projects via .svelte files", () => {
    setGitRunner(lsFilesRunner(["src/App.svelte", "src/main.ts"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor([]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.supported).toBe(false);
    expect(res.signals.svelteFiles).toBe(1);
    expect(res.blockers.some((b) => b.kind === "svelte-sfc")).toBe(true);
  });

  it("reports unsupported when there are zero TS/JS files and no blockers", () => {
    setGitRunner(lsFilesRunner([]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor([]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.supported).toBe(false);
    expect(res.blockers).toEqual([]);
    expect(res.signals.tsFiles).toBe(0);
  });

  it("collects multiple blockers when several markers exist", () => {
    setGitRunner(lsFilesRunner(["src/App.vue"]));
    const res = detectStack(
      { cwd: "/repo" },
      { existsFn: existsFor(["pyproject.toml", "Cargo.toml"]) },
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.blockers.map((b) => b.kind).sort()).toEqual(
      ["python", "rust", "vue-sfc"].sort(),
    );
  });

  it("propagates git failure as ok:false", () => {
    setGitRunner(() => gitFail("fatal: not a git repository"));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor([]) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a git repository/);
  });

  it("does not double-count .tsx as .ts", () => {
    setGitRunner(lsFilesRunner(["a.ts", "b.tsx", "c.tsx"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor([]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.tsFiles).toBe(1);
    expect(res.signals.tsxFiles).toBe(2);
  });

  it("hasPackageJson is false when no package.json exists", () => {
    setGitRunner(lsFilesRunner(["src/a.ts"]));
    const res = detectStack({ cwd: "/repo" }, { existsFn: existsFor([]) });
    if (!res.ok) throw new Error("expected ok");
    expect(res.signals.hasPackageJson).toBe(false);
    expect(res.supported).toBe(true);
  });
});

describe("parseDetectStackArgs", () => {
  it("returns the default cwd when no flags are provided", () => {
    const res = parseDetectStackArgs([], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/default" } });
  });

  it("resolves --cwd against the default", () => {
    const res = parseDetectStackArgs(["--cwd", "/abs/path"], "/default");
    expect(res).toEqual({ ok: true, value: { cwd: "/abs/path" } });
  });

  it("resolves a relative --cwd against the default", () => {
    const res = parseDetectStackArgs(["--cwd", "sub"], "/base");
    expect(res).toEqual({ ok: true, value: { cwd: "/base/sub" } });
  });

  it("rejects --cwd with no value", () => {
    const res = parseDetectStackArgs(["--cwd"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing value/);
  });

  it("rejects unknown flags", () => {
    const res = parseDetectStackArgs(["--bogus"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown flag/);
  });

  it("recognizes --help", () => {
    const res = parseDetectStackArgs(["--help"], "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("help");
  });
});
