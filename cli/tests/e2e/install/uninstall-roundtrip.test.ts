/**
 * E2E for `qualy uninstall` (TASKS.md 2.2b — "install→uninstall round-trip,
 * FS limpo").
 *
 * Spawns the real CLI (`node --experimental-strip-types cli/src/index.ts ...`)
 * for both `install` and `uninstall` so the roundtrip exercises argv parsing,
 * the dispatcher in `cli/src/index.ts`, and the manifest contract end-to-end.
 *
 * All targets live under `os.tmpdir()` and are deleted in `afterEach` — this
 * suite never leaves bytes on the project tree.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").filter(Boolean).pop();
  if (line === undefined) {
    throw new Error("no JSON line on stdout");
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe("e2e: qualy install → qualy uninstall roundtrip", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("--scope project: install then uninstall removes manifest + payload", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-uninstall-project-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    const installRes = runCli([
      "install",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(installRes.exitCode).toBe(0);
    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(true);

    const uninstallRes = runCli([
      "uninstall",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(uninstallRes.exitCode).toBe(0);
    const json = lastJson(uninstallRes.stdout);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("project");
    expect(Array.isArray(json.removed)).toBe(true);
    expect((json.removed as unknown[]).length).toBeGreaterThan(0);
    expect(json.kept).toEqual([]);
    expect(json.dry_run).toBe(false);

    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(false);
    expect(existsSync(join(tmp, ".claude", "skills", "lint", "SKILL.md"))).toBe(
      false,
    );
  });

  it("--dry-run plans the removals but writes nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-uninstall-dry-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    runCli(["install", "--scope", "project", "--cwd", tmp]);
    const before = existsSync(join(tmp, ".claude", ".lint-manifest.json"));
    expect(before).toBe(true);

    const res = runCli([
      "uninstall",
      "--scope",
      "project",
      "--cwd",
      tmp,
      "--dry-run",
    ]);
    expect(res.exitCode).toBe(0);
    const json = lastJson(res.stdout);
    expect(json.ok).toBe(true);
    expect(json.dry_run).toBe(true);
    expect((json.removed as unknown[]).length).toBeGreaterThan(0);
    // FS still intact.
    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(true);
  });

  it("uninstall without prior install exits 1 with manifest_missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-uninstall-empty-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    const res = runCli([
      "uninstall",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(res.exitCode).toBe(1);
    const json = lastJson(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("manifest_missing");
  });

  it("orphan files survive: user-authored content under .claude/ is preserved", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-uninstall-orphan-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    gitInit(tmp);

    runCli(["install", "--scope", "project", "--cwd", tmp]);
    const orphan = join(tmp, ".claude", "user-notes.md");
    writeFileSync(orphan, "private notes\n");

    const res = runCli([
      "uninstall",
      "--scope",
      "project",
      "--cwd",
      tmp,
    ]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(tmp, ".claude", ".lint-manifest.json"))).toBe(false);
  });

  it("--scope user round-trips under a synthetic HOME", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "qualy-e2e-uninstall-user-"));
    cleanups.push(() => rmSync(fakeHome, { recursive: true, force: true }));

    runCli(["install", "--scope", "user"], { HOME: fakeHome });
    expect(existsSync(join(fakeHome, ".claude", ".lint-manifest.json"))).toBe(
      true,
    );

    const res = runCli(["uninstall", "--scope", "user"], { HOME: fakeHome });
    expect(res.exitCode).toBe(0);
    const json = lastJson(res.stdout);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("user");
    expect(existsSync(join(fakeHome, ".claude", ".lint-manifest.json"))).toBe(
      false,
    );
  });
});
