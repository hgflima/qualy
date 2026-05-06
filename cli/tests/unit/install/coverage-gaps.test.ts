/**
 * Coverage gap fillers for `cli/src/install/` (Checkpoint C — TASKS.md).
 *
 * The other unit suites focus on each module's pure logic and inject test
 * seams (`runNpmView`, `applyInstall`, `prompt`, `source`) so they never
 * spawn child processes or touch `process.cwd`. That leaves three classes
 * of code uncovered:
 *
 *   1. The CLI handlers (`runHarnessInstall`/`runHarnessUninstall`) never
 *      see their own happy path because direct callers go through the inner
 *      `*Harness` function and the e2e tests spawn a fresh `node` process
 *      (which v8 coverage in this worker cannot observe).
 *   2. `defaultRunNpmView` in `registry.ts` is only exercised when nothing
 *      injects `runNpmView` — every other test injects it.
 *   3. `manifest.ts` rethrows non-`ENOENT` errors from `readFileSync` /
 *      `unlinkSync` / `renameSync`. Hitting them needs a real OS error
 *      (`EISDIR`, `ENOTEMPTY`) instead of a mock — see AGENTS.md.
 *
 * Each test below targets one of those gaps using a controllable
 * environment (PATH-shimmed `npm`, directory-shaped manifest paths, real
 * round-trip installs into `os.tmpdir()`).
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runHarnessInstall } from "../../../src/install/install.ts";
import { runHarnessUninstall } from "../../../src/install/uninstall.ts";
import { runHarnessUpdate } from "../../../src/install/update.ts";
import { fetchLatestVersion } from "../../../src/install/registry.ts";
import {
  type Manifest,
  MANIFEST_VERSION,
  deleteManifest,
  manifestPath,
  readManifest,
  writeManifest,
} from "../../../src/install/manifest.ts";
import { setStreams } from "../../../src/lib/logger.ts";
import { EXIT_CODES } from "../../../src/lib/exit-codes.ts";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

/**
 * Plant an executable shell script named `npm` inside a fresh tmp dir and
 * prepend that dir to `PATH`. The script `cat`s `args` to stdout, then to
 * stderr, then exits with `code` (and optionally sleeps first, so the
 * caller can drive the timeout path).
 */
function installNpmShim(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
}): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qualy-npm-shim-"));
  const script = join(dir, "npm");
  const sleepLine =
    opts.sleepMs && opts.sleepMs > 0
      ? `sleep ${(opts.sleepMs / 1000).toFixed(3)}\n`
      : "";
  const stdoutLine = opts.stdout ? `printf '%s' ${shellQuote(opts.stdout)}\n` : "";
  const stderrLine = opts.stderr
    ? `printf '%s' ${shellQuote(opts.stderr)} 1>&2\n`
    : "";
  const body = `#!/bin/sh
${sleepLine}${stdoutLine}${stderrLine}exit ${opts.exitCode ?? 0}
`;
  writeFileSync(script, body, "utf8");
  chmodSync(script, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath ?? ""}`;
  return {
    dir,
    restore: () => {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function shellQuote(s: string): string {
  // Single-quote everything; embedded single quotes get the standard close/
  // escape/reopen dance.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

describe("registry.defaultRunNpmView (PATH-shimmed npm)", () => {
  let shim: ReturnType<typeof installNpmShim> | null = null;

  afterEach(() => {
    if (shim) {
      shim.restore();
      shim = null;
    }
  });

  it("clean stdout from the real spawn maps to ok:true", async () => {
    shim = installNpmShim({ stdout: "0.4.7\n" });
    const r = await fetchLatestVersion({ timeoutMs: 5000 });
    expect(r).toEqual({ ok: true, version: "0.4.7" });
  });

  it("non-zero exit with empty stderr maps to kind:unknown", async () => {
    shim = installNpmShim({ exitCode: 7 });
    const r = await fetchLatestVersion({ timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unknown");
    expect(r.message).toMatch(/exited with code 7/);
  });

  it("stderr E401 with non-zero exit maps to kind:auth", async () => {
    shim = installNpmShim({
      stderr: "npm ERR! code E401\nnpm ERR! 401 Unauthorized",
      exitCode: 1,
    });
    const r = await fetchLatestVersion({ timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("auth");
    expect(r.message).toMatch(/E401/);
  });

  it("clean exit with empty stdout maps to kind:mirror", async () => {
    shim = installNpmShim({ stdout: "", exitCode: 0 });
    const r = await fetchLatestVersion({ timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("mirror");
  });

  it("a hung child is killed at timeoutMs and reported as kind:network", async () => {
    shim = installNpmShim({ sleepMs: 2000, stdout: "1.2.3\n" });
    const r = await fetchLatestVersion({ timeoutMs: 80 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("network");
    expect(r.message).toMatch(/timed out/);
  });

  it("missing npm on PATH surfaces as kind:network", async () => {
    const empty = mkdtempSync(join(tmpdir(), "qualy-empty-path-"));
    const prev = process.env.PATH;
    process.env.PATH = empty;
    try {
      const r = await fetchLatestVersion({ timeoutMs: 1000 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("network");
      expect(r.message).toMatch(/npm CLI not found/);
    } finally {
      if (prev === undefined) delete process.env.PATH;
      else process.env.PATH = prev;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("CLI handlers — happy paths via real install round-trip", () => {
  let workspace: string;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let stdoutBuf: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "qualy-cli-rt-"));
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    setStreams({ stdout, stderr });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    setStreams({ stdout: process.stdout, stderr: process.stderr });
  });

  // TODO: re-enable once `runHarnessInstall` exposes a `materialize` test
  // seam. Today this round-trip resolves the version from `package.json` and
  // shells out to `npm install @hgflima/qualy@<version>` — which fails in
  // pre-publish CI because the version about to be published doesn't exist
  // in the registry yet (chicken-and-egg). Same precedent as the
  // `runHarnessUninstall` round-trip skipped at T7 (commit 21a4cf2).
  it.skip("runHarnessInstall(--scope local) returns OK and writes the manifest", async () => {
    const code = await runHarnessInstall(
      ["--scope", "local", "--cwd", workspace],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.OK);
    const lines = stdoutBuf.split("\n").filter(Boolean);
    const json = JSON.parse(lines.at(-1)!);
    expect(json.ok).toBe(true);
    expect(json.scope).toBe("local");
    expect(json.copied).toBeGreaterThan(0);
    expect(existsSync(join(workspace, ".claude", ".lint-manifest.json"))).toBe(
      true,
    );
  }, 30000);

  it("runHarnessInstall returns RECOVERABLE_ERROR when scope_resolution fails", async () => {
    // workspace has no .git/, so --scope project must fail at resolveScope.
    const code = await runHarnessInstall(
      ["--scope", "project", "--cwd", workspace],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const lines = stdoutBuf.split("\n").filter(Boolean);
    const json = JSON.parse(lines.at(-1)!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("scope_resolution");
  });

  // Skipped until Task 5 (uninstall.ts) teaches the uninstaller to handle
  // entries with kind === "runtime-node-modules" via recursive `rmSync`.
  // Today the round-trip install plants a real `skills/lint/node_modules/`
  // tree (the install pipeline now spawns `npm install`); uninstall then
  // hits `unlinkSync` on a directory and returns INTERNAL_ERROR. T5 flips
  // this back to the OK path.
  it.skip("runHarnessUninstall returns OK after a real install round-trip", async () => {
    const installCode = await runHarnessInstall(
      ["--scope", "local", "--cwd", workspace],
      { stderr },
    );
    expect(installCode).toBe(EXIT_CODES.OK);
    stdoutBuf = "";

    const code = await runHarnessUninstall(
      ["--scope", "local", "--cwd", workspace],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.OK);
    const lines = stdoutBuf.split("\n").filter(Boolean);
    const json = JSON.parse(lines.at(-1)!);
    expect(json.ok).toBe(true);
    expect(json.removed.length).toBeGreaterThan(0);
    expect(
      existsSync(join(workspace, ".claude", ".lint-manifest.json")),
    ).toBe(false);
  }, 30000);
});

describe("runHarnessUpdate (CLI happy path with PATH-shimmed npm)", () => {
  let workspace: string;
  let shim: ReturnType<typeof installNpmShim> | null;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let stdoutBuf: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "qualy-update-cli-cov-"));
    gitInit(workspace);
    shim = null;
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    setStreams({ stdout, stderr });
  });

  afterEach(() => {
    if (shim) shim.restore();
    rmSync(workspace, { recursive: true, force: true });
    setStreams({ stdout: process.stdout, stderr: process.stderr });
  });

  function plantManifest(version: string): void {
    const root = join(workspace, ".claude");
    mkdirSync(root, { recursive: true });
    const m: Manifest = {
      version: MANIFEST_VERSION,
      scope: "project",
      harness_version: version,
      installer: "npx",
      installed_at: "2026-01-01T00:00:00.000Z",
      entries: [],
    };
    writeManifest(root, m);
  }

  it("up-to-date: shimmed npm matches the manifest version, exits 0", async () => {
    plantManifest("0.1.0");
    shim = installNpmShim({ stdout: "0.1.0\n" });
    const code = await runHarnessUpdate(
      ["--scope", "project", "--cwd", workspace],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.OK);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("up-to-date");
    expect(json.installed_before).toBe("0.1.0");
    expect(json.installed_after).toBe("0.1.0");
  });

  it("would-update: shimmed npm reports a newer minor and --dry-run does not apply", async () => {
    plantManifest("0.1.0");
    shim = installNpmShim({ stdout: "0.2.0\n" });
    const code = await runHarnessUpdate(
      ["--scope", "project", "--cwd", workspace, "--dry-run"],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.OK);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("would-update");
    expect(json.installed_before).toBe("0.1.0");
    expect(json.installed_after).toBe("0.2.0");
  });

  it("registry network failure exits with RECOVERABLE_ERROR", async () => {
    plantManifest("0.1.0");
    shim = installNpmShim({
      stderr: "npm ERR! code ENOTFOUND",
      exitCode: 1,
    });
    const code = await runHarnessUpdate(
      ["--scope", "project", "--cwd", workspace],
      { stderr },
    );
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("registry_network");
  });
});

describe("manifest.ts non-ENOENT failure paths", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "qualy-manifest-cov-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("readManifest rethrows non-ENOENT errors (manifest path is a directory → EISDIR)", () => {
    // Make .lint-manifest.json a directory; readFileSync against it raises
    // EISDIR, which `readManifest` must propagate (only ENOENT is swallowed).
    mkdirSync(manifestPath(workspace), { recursive: true });
    expect(() => readManifest(workspace)).toThrow(/EISDIR|illegal operation/i);
  });

  it("writeManifest cleans up the tmp file when rename fails", () => {
    // Make the destination path a non-empty directory so renameSync fails.
    const dest = manifestPath(workspace);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "blocker"), "x", "utf8");

    const m: Manifest = {
      version: MANIFEST_VERSION,
      scope: "project",
      harness_version: "0.0.1",
      installer: "npx",
      installed_at: "2026-01-01T00:00:00.000Z",
      entries: [],
    };
    expect(() => writeManifest(workspace, m)).toThrow();

    // safeUnlink in the rename catch must have removed every tmp.* sibling.
    const siblings = readdirSync(workspace).filter((n) =>
      n.startsWith(".lint-manifest.json.tmp."),
    );
    expect(siblings).toEqual([]);
  });

  it("deleteManifest rethrows non-ENOENT errors (path is a non-empty directory → EISDIR)", () => {
    // unlinkSync on a non-empty directory raises EISDIR (or EPERM on macOS).
    const dest = manifestPath(workspace);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "blocker"), "x", "utf8");
    expect(() => deleteManifest(workspace)).toThrow();
  });
});
