/**
 * E2E for the published binary post-`npm install` (SPEC tsx-runtime-fix §7).
 *
 * Earlier suites (`install-scopes.test.ts`, `pack-contents.test.ts`, etc.)
 * either spawn the CLI from the source checkout or assert the tarball's
 * file list — neither exercises the `node_modules/` codepath. This suite
 * does: it `npm pack`s the repo, `npm install`s the tarball into a
 * synthetic project, and runs the published `./node_modules/.bin/qualy`.
 *
 * That codepath is exactly what broke in @hgflima/qualy@0.1.0
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Failing here means the
 * shim's runtime resolution regressed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

let tarballPath: string;
let cacheDir: string;
let plainProject: string;
let gitProject: string;

function packRepo(outDir: string): string {
  const stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const entries = JSON.parse(stdout) as Array<{ filename: string }>;
  if (entries.length !== 1) {
    throw new Error(`npm pack expected 1 entry, got ${entries.length}`);
  }
  return resolve(outDir, entries[0]!.filename);
}

function npmEnv(): NodeJS.ProcessEnv {
  // Isolate the npm cache so vitest's parallel runners do not contend with
  // the user's `~/.npm` (or each other). `npm_config_cache` overrides the
  // resolved cache path for both `pack` and `install`.
  return { ...process.env, npm_config_cache: cacheDir };
}

function installTarball(targetDir: string): void {
  execFileSync("npm", ["init", "-y"], {
    cwd: targetDir,
    env: npmEnv(),
    stdio: "ignore",
  });
  execFileSync("npm", ["install", tarballPath], {
    cwd: targetDir,
    env: npmEnv(),
    stdio: "ignore",
  });
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

function runQualy(
  cwd: string,
  args: readonly string[],
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("./node_modules/.bin/qualy", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

describe.sequential("e2e: installed tarball is executable", () => {
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "qualy-e2e-tarball-cache-"));
    const packOut = mkdtempSync(join(tmpdir(), "qualy-e2e-tarball-pack-"));
    tarballPath = packRepo(packOut);

    plainProject = mkdtempSync(join(tmpdir(), "qualy-e2e-tarball-plain-"));
    installTarball(plainProject);

    gitProject = mkdtempSync(join(tmpdir(), "qualy-e2e-tarball-git-"));
    gitInit(gitProject);
    installTarball(gitProject);
  }, 180_000);

  afterAll(() => {
    for (const dir of [plainProject, gitProject, dirname(tarballPath), cacheDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`qualy --version` exits 0 and prints a version", () => {
    const { stdout, stderr, exitCode } = runQualy(plainProject, ["--version"]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/ERR_UNSUPPORTED/);
    const json = JSON.parse(stdout.trim());
    expect(json.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`qualy install --scope local --dry-run` exits 0 in a git repo", () => {
    const { stdout, stderr, exitCode } = runQualy(gitProject, [
      "install",
      "--scope",
      "local",
      "--dry-run",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/ERR_UNSUPPORTED/);
    const lastLine = stdout.split("\n").filter(Boolean).pop()!;
    const json = JSON.parse(lastLine);
    expect(json.dry_run).toBe(true);
    expect(json.scope).toBe("local");
    expect(json.copied).toBeGreaterThan(0);
    // dry-run must not have written anything into the project.
    expect(readdirSync(gitProject)).not.toContain(".claude");
  });
});
