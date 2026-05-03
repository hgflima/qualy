/**
 * post-edit.sh template contract tests (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §4).
 *
 * The template at `cli/src/templates/post-edit.sh` is copied byte-for-byte
 * into `<target>/.claude/hooks/post-edit.sh` by `install-hook`. It must:
 *   - declare bash via `/usr/bin/env bash` (portable across macOS where
 *     /bin/bash is 3.2 — bash arrays + `command -v` work fine in 3.2 too,
 *     but the convention is env-resolved bash)
 *   - run under strict mode (`set -euo pipefail`)
 *   - filter `$CLAUDE_FILE_PATHS` to `.ts|.tsx|.js|.jsx` only (oxc scope)
 *   - call oxlint with `oxlint.fast.json` (PostToolUse must stay fast)
 *   - never break the agent loop: empty paths, no matches, or missing
 *     oxlint must all exit 0
 *
 * Static assertions lock the contract; runtime assertions exercise the
 * three quiet-exit paths via `bash` with a controlled PATH so no real
 * oxlint binary is invoked.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "templates",
  "post-edit.sh",
);

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

describe("templates/post-edit.sh — static contract", () => {
  it("declares bash via /usr/bin/env on the first line", () => {
    const lines = readTemplate().split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env bash");
  });

  it("enables strict mode with set -euo pipefail", () => {
    expect(readTemplate()).toMatch(/^set -euo pipefail$/m);
  });

  it("reads CLAUDE_FILE_PATHS with a safe default", () => {
    expect(readTemplate()).toMatch(/\$\{CLAUDE_FILE_PATHS:-\}/);
  });

  it("filters exactly the four oxc-supported extensions", () => {
    const text = readTemplate();
    expect(text).toMatch(/\*\.ts\|\*\.tsx\|\*\.js\|\*\.jsx/);
    expect(text).not.toMatch(/\*\.py/);
    expect(text).not.toMatch(/\*\.rs/);
    expect(text).not.toMatch(/\*\.go/);
    expect(text).not.toMatch(/\*\.vue/);
    expect(text).not.toMatch(/\*\.svelte/);
  });

  it("invokes oxlint with the fast preset config", () => {
    const text = readTemplate();
    expect(text).toMatch(/oxlint --config oxlint\.fast\.json/);
    expect(text).not.toMatch(/oxlint\.deep\.json/);
  });

  it("prefers the project-local oxlint over a global one", () => {
    const text = readTemplate();
    const localIdx = text.indexOf("./node_modules/.bin/oxlint");
    const globalIdx = text.indexOf("command -v oxlint");
    expect(localIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(localIdx);
  });

  it("exits 0 (warning to stderr) when oxlint is missing", () => {
    const text = readTemplate();
    expect(text).toMatch(/qualy\/post-edit: oxlint not found/);
    expect(text).toMatch(/exit 0/);
  });

  it("ships with the executable bit set on the source", () => {
    const mode = statSync(TEMPLATE_PATH).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });
});

describe("templates/post-edit.sh — runtime quiet-exit paths", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
        // ignore — best effort
      }
    }
  });

  function runHook(env: Record<string, string>, cwd: string) {
    return spawnSync("bash", [TEMPLATE_PATH], {
      cwd,
      env: { ...env, PATH: env.PATH ?? "" },
      encoding: "utf8",
    });
  }

  function isolatedTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "qualy-post-edit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("exits 0 silently when CLAUDE_FILE_PATHS is unset", () => {
    const cwd = isolatedTmp();
    const result = runHook({ PATH: "/usr/bin:/bin" }, cwd);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 0 silently when CLAUDE_FILE_PATHS is empty", () => {
    const cwd = isolatedTmp();
    const result = runHook({ CLAUDE_FILE_PATHS: "", PATH: "/usr/bin:/bin" }, cwd);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("exits 0 silently when no path matches the extension filter", () => {
    const cwd = isolatedTmp();
    const result = runHook(
      {
        CLAUDE_FILE_PATHS: "/some/file.py /other/README.md /a/b/script.rb",
        PATH: "/usr/bin:/bin",
      },
      cwd,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("warns and exits 0 when matches exist but oxlint is missing", () => {
    const cwd = isolatedTmp();
    const result = runHook(
      {
        CLAUDE_FILE_PATHS: "/a/foo.ts /b/bar.tsx",
        // PATH has no oxlint anywhere; cwd has no node_modules/.bin
        PATH: "/usr/bin:/bin",
      },
      cwd,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/qualy\/post-edit: oxlint not found/);
  });

  it("invokes the project-local oxlint stub with filtered paths", () => {
    const cwd = isolatedTmp();
    const binDir = join(cwd, "node_modules", ".bin");
    rmSync(binDir, { recursive: true, force: true });
    const stubLog = join(cwd, "stub.log");
    // Stub records exactly the args it received, then exits 0.
    const stubPath = join(binDir, "oxlint");
    // mkdir -p binDir
    spawnSync("mkdir", ["-p", binDir]);
    writeFileSync(
      stubPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(stubLog)}\nexit 0\n`,
    );
    chmodSync(stubPath, 0o755);

    const result = runHook(
      {
        CLAUDE_FILE_PATHS: "/a/keep.ts /b/skip.py /c/keep.jsx /d/skip.md /e/keep.tsx /f/keep.js",
        PATH: "/usr/bin:/bin",
      },
      cwd,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const recorded = readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
    expect(recorded).toEqual([
      "--config",
      "oxlint.fast.json",
      "/a/keep.ts",
      "/c/keep.jsx",
      "/e/keep.tsx",
      "/f/keep.js",
    ]);
  });
});
