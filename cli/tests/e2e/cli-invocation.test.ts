/**
 * E2E smoke for Bug 1 + Bug 2 of cli-bin-resolution (v0.3.4).
 *
 * Replicates what `materializeRuntime()` (`cli/src/install/materialize-runtime.ts`)
 * does at install time, but using a freshly packed local tarball instead of
 * the public registry — so the test exercises the *real* runtime layout
 * without requiring network and without depending on a published version.
 *
 * Pipeline per scenario:
 *   1. `npm pack` the repo once in `beforeAll` (amortized) → tarball in
 *      tmpdir.
 *   2. Per scenario, mkdtemp a clean target, create `.claude/skills/lint/`,
 *      drop the stub `package.json` (`materializeRuntime` writes the same
 *      stub), then `npm install <tarball> --prefer-offline --no-audit
 *      --no-fund` inside `.claude/skills/lint/` — equivalent to
 *      `materializeRuntime`'s spawn but offline-friendly.
 *   3. Spawn `node .claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs
 *      <subcmd> --cwd <tmp>` and assert the canonical JSON contract.
 *
 * Why this isolates Bug 1 + Bug 2:
 *   - Bug 1 (deps unresolved): every subcommand transitively imports `zod`,
 *     `fast-glob`, `ts-morph`, `esbuild`, `chart.js`, `chartjs-chart-treemap`
 *     via the `cli/src/index.ts` dispatcher. If the materialized layout is
 *     missing any of them, Node throws `ERR_MODULE_NOT_FOUND` before the
 *     subcommand even prints. We assert no `ERR_MODULE_NOT_FOUND` on stderr
 *     and assert a parseable JSON document on stdout.
 *   - Bug 2 (`../../package.json` relative path): `cli/src/index.ts:63` uses
 *     `createRequire(import.meta.url)('../../package.json')`. When the entry
 *     lives at `node_modules/@hgflima/qualy/cli/src/index.ts`, two levels up
 *     is the package root where `package.json` does exist. `--version`
 *     exercises that codepath directly — it reads `pkg.version` synchronously.
 *
 * The tarball + npm cache are scoped to the test (`npm_config_cache`) so
 * vitest parallel workers do not contend with each other or with the user's
 * global cache.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

let tarballPath: string;
let packDir: string;
let cacheDir: string;

function npmEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_cache: cacheDir };
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

function packRepo(outDir: string): string {
  const stdout = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", outDir],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: npmEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const entries = JSON.parse(stdout) as Array<{ filename: string }>;
  if (entries.length !== 1) {
    throw new Error(`npm pack expected 1 entry, got ${entries.length}`);
  }
  return resolve(outDir, entries[0]!.filename);
}

/**
 * Sets up `${target}/.claude/skills/lint/` exactly the way `materializeRuntime`
 * does — stub `package.json` + `npm install <tarball>` — and returns the
 * absolute path to the materialized `bin/qualy.mjs`.
 */
function materializeFromTarball(target: string): string {
  const runtimeDir = join(target, ".claude", "skills", "lint");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "qualy-runtime", private: true }, null, 2)}\n`,
    "utf8",
  );
  execFileSync(
    "npm",
    [
      "install",
      tarballPath,
      "--omit=dev",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ],
    {
      cwd: runtimeDir,
      env: npmEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const bin = join(
    runtimeDir,
    "node_modules",
    "@hgflima",
    "qualy",
    "bin",
    "qualy.mjs",
  );
  if (!existsSync(bin)) {
    throw new Error(`materialized bin missing: ${bin}`);
  }
  return bin;
}

function runBin(
  bin: string,
  args: readonly string[],
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [bin, ...args], {
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

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").filter(Boolean).pop();
  if (line === undefined) {
    throw new Error(`no JSON line on stdout. raw=${JSON.stringify(stdout)}`);
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe.sequential("e2e: cli-invocation (Bug 1 + Bug 2 smoke)", () => {
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "qualy-e2e-cli-inv-cache-"));
    packDir = mkdtempSync(join(tmpdir(), "qualy-e2e-cli-inv-pack-"));
    tarballPath = packRepo(packDir);
  }, 180_000);

  afterAll(() => {
    for (const dir of [packDir, cacheDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it(
    "Bug 2 — `--version` resolves ../../package.json from materialized layout",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-cli-inv-version-"));
      cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
      const bin = materializeFromTarball(tmp);

      const { stdout, stderr, exitCode } = runBin(bin, ["--version"]);
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(stderr).not.toMatch(/Cannot find module/);
      const json = lastJson(stdout);
      expect(json.name).toBe("qualy");
      expect(typeof json.version).toBe("string");
      expect(json.version as string).toMatch(/^\d+\.\d+\.\d+/);
    },
    180_000,
  );

  it(
    "Bug 1 + Bug 2 — `detect-stack` runs the dispatcher with all deps resolved",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-cli-inv-detect-"));
      cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
      // detect-stack uses `git ls-files` to enumerate sources — needs a repo.
      // An empty repo is fine: `supported: false` (exit 2, UNSUPPORTED_STACK)
      // is still a valid dispatcher run that proves all imports resolved.
      gitInit(tmp);
      const bin = materializeFromTarball(tmp);

      const { stdout, stderr, exitCode } = runBin(bin, [
        "detect-stack",
        "--cwd",
        tmp,
      ]);
      // 0 = supported, 2 = unsupported. Both prove the dispatcher ran:
      // anything else (1, 70) would mean an import or runtime crash.
      expect([0, 2]).toContain(exitCode);
      expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(stderr).not.toMatch(/Cannot find package/);
      const json = lastJson(stdout);
      expect(json.ok).toBe(true);
      expect(json).toHaveProperty("supported");
      expect(json).toHaveProperty("signals");
      expect(json).toHaveProperty("supportedLanguages");
      expect(json).toHaveProperty("blockers");
    },
    180_000,
  );

  it(
    "Bug 1 — `rules-list` loads zod (audit-schema) and fast-glob without ERR_MODULE_NOT_FOUND",
    () => {
      // rules-list returns RECOVERABLE_ERROR (exit 1) with `preset_missing`
      // when no oxlint preset is on disk — that is the *expected* domain
      // failure for an empty tmpdir. The point of this scenario is to prove
      // the dispatcher actually loaded (which transitively pulls in zod via
      // audit-schema and fast-glob via ignore/blast-radius); a stack-trace
      // exit on imports would never produce a parseable JSON line.
      const tmp = mkdtempSync(join(tmpdir(), "qualy-e2e-cli-inv-rules-"));
      cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
      const bin = materializeFromTarball(tmp);

      const { stdout, stderr, exitCode } = runBin(bin, [
        "rules-list",
        "--cwd",
        tmp,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(stderr).not.toMatch(/Cannot find package/);
      const json = lastJson(stdout);
      expect(json.ok).toBe(false);
      expect(json.error).toBe("preset_missing");
    },
    180_000,
  );
});
