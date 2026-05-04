/**
 * E2E for `qualy install` (TASKS.md 2.1 — "Spawn do CLI compilado em tmpdir;
 * assertar arquivos no FS pós-install").
 *
 * Each case spawns the real CLI (`node --experimental-strip-types
 * cli/src/index.ts install ...`) so this exercises argv parsing, the
 * `findQualyRoot` walk, the canonical JSON contract, and the actual file
 * copy — regressions in any of those surfaces escape the unit tests.
 *
 * The synthetic targets stay in `os.tmpdir()` and are deleted in `afterEach`,
 * so this suite never leaves artifacts behind.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "..", "..", "src", "index.ts");

function runCli(args: readonly string[], env?: NodeJS.ProcessEnv): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync(
      "node",
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

describe("e2e: qualy install", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("--scope local --dry-run reports a plan and writes nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-install-dry-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const { stdout, exitCode } = runCli([
      "install",
      "--scope",
      "local",
      "--cwd",
      tmp,
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("local");
    expect(json.dry_run).toBe(true);
    expect(json.copied).toBeGreaterThan(0);
    expect(json.target).toBe(join(tmp, ".claude"));
    expect(json.gitignore.action).toBe("skipped");

    // No bytes touched in tmp.
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
    expect(existsSync(join(tmp, ".gitignore"))).toBe(false);
  });

  it("--scope local writes the payload and adds .claude/ to .gitignore", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-install-local-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const { stdout, exitCode } = runCli([
      "install",
      "--scope",
      "local",
      "--cwd",
      tmp,
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("local");
    expect(json.dry_run).toBe(false);
    expect(json.copied).toBeGreaterThan(0);
    expect(json.gitignore.action).toBe("created");

    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(true);
    expect(readFileSync(join(tmp, ".gitignore"), "utf8")).toBe(".claude/\n");
    // Skill payload landed.
    const top = readdirSync(join(tmp, ".claude"));
    expect(top).toContain("skills");
    expect(top).toContain("commands");
    expect(top).toContain("agents");
  });

  it("--scope project requires .git/ — without it, exit 1", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-install-nogit-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const { stdout, exitCode } = runCli([
      "install",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("scope_resolution");
    expect(json.reason).toMatch(/--scope local/);
    expect(existsSync(join(tmp, ".claude"))).toBe(false);
  });

  it("--scope project after `git init` succeeds and skips .gitignore", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-install-project-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    const { stdout, exitCode } = runCli([
      "install",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("project");
    expect(json.gitignore.action).toBe("skipped");
    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(true);
    // project scope must NOT touch .gitignore (meant for commit).
    expect(existsSync(join(tmp, ".gitignore"))).toBe(false);
  });

  it("--scope user resolves to ${HOME}/.claude under a synthetic HOME", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "qualy-e2e-install-user-"));
    cleanups.push(() => rmSync(fakeHome, { recursive: true, force: true }));

    const { stdout, exitCode } = runCli(
      ["install", "--scope", "user"],
      { HOME: fakeHome },
    );
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("user");
    expect(json.target).toBe(join(fakeHome, ".claude"));
    expect(existsSync(join(fakeHome, ".claude", ".lint-manifest.json"))).toBe(
      true,
    );
  });

  it("a second install reports manifest_overwritten and most files skipped", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-install-twice-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    runCli(["install", "--scope", "project", "--cwd", tmp]);
    const { stdout, exitCode } = runCli([
      "install",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.manifest_overwritten).toBe(true);
    expect(json.copied).toBe(0);
    expect(json.skipped).toBeGreaterThan(0);
  });
});
