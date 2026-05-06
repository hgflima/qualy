import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installHarness,
  type MaterializeRuntimeFn,
} from "../../../src/install/install.ts";
import {
  parseUninstallArgs,
  runHarnessUninstall,
  uninstallHarness,
} from "../../../src/install/uninstall.ts";

/**
 * Stub materialize: writes a real `skills/lint/node_modules/` tree (and a
 * placeholder file inside) without spawning npm. Mirrors what the real
 * materializer leaves on disk so the uninstaller's recursive removal of the
 * `runtime-node-modules` entry is exercised end-to-end.
 */
const fakeMaterialize: MaterializeRuntimeFn = async ({ target, dryRun }) => {
  const runtimePath = join(target, "skills", "lint");
  if (dryRun) return { ok: true, stubCreated: null, runtimePath };
  const nm = join(runtimePath, "node_modules", "@hgflima", "qualy");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "package.json"), '{"name":"@hgflima/qualy"}\n');
  return { ok: true, stubCreated: null, runtimePath };
};
import { manifestPath, readManifest } from "../../../src/install/manifest.ts";
import { setStreams } from "../../../src/lib/logger.ts";
import { EXIT_CODES } from "../../../src/lib/exit-codes.ts";

function makePayload(root: string, version = "0.1.0"): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@hgflima/qualy", version }),
    "utf8",
  );
  mkdirSync(join(root, "skills", "lint"), { recursive: true });
  writeFileSync(join(root, "skills", "lint", "SKILL.md"), "skill body\n");
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "lint.md"), "command body\n");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "lint-detector.md"), "agent body\n");
  mkdirSync(join(root, "cli", "src"), { recursive: true });
  writeFileSync(join(root, "cli", "src", "index.ts"), "export {};\n");
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

describe("parseUninstallArgs", () => {
  it("defaults to scope=project, dryRun=false, yes=false, keepBackup=false", () => {
    const r = parseUninstallArgs([], "/tmp/x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      scope: "project",
      cwd: "/tmp/x",
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
  });

  it("parses --scope, --cwd, --dry-run, --yes, --keep-backup", () => {
    const r = parseUninstallArgs(
      [
        "--scope",
        "local",
        "--cwd",
        "/elsewhere",
        "--dry-run",
        "--yes",
        "--keep-backup",
      ],
      "/tmp/x",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      scope: "local",
      cwd: "/elsewhere",
      dryRun: true,
      yes: true,
      keepBackup: true,
    });
  });

  it("rejects an invalid --scope value", () => {
    const r = parseUninstallArgs(["--scope", "global"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/--scope must be one of/);
  });

  it("rejects --cwd without a value", () => {
    const r = parseUninstallArgs(["--cwd"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing value for --cwd/);
  });

  it("recognizes --help and -h as the help sentinel", () => {
    expect(parseUninstallArgs(["--help"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseUninstallArgs(["-h"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
  });

  it("rejects an unknown flag", () => {
    const r = parseUninstallArgs(["--nope"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag: --nope/);
  });
});

describe("uninstallHarness", () => {
  let source: string;
  let workspace: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-uninstall-src-"));
    workspace = mkdtempSync(join(tmpdir(), "qualy-uninstall-ws-"));
    makePayload(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("install → uninstall round-trip leaves the scope FS clean", async () => {
    gitInit(workspace);
    const installed = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    expect(installed.ok).toBe(true);

    const target = join(workspace, ".claude");
    // Sanity: payload is on disk before uninstall.
    expect(existsSync(join(target, "skills", "lint", "SKILL.md"))).toBe(true);
    expect(existsSync(manifestPath(target))).toBe(true);

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toBe("project");
    expect(result.target).toBe(target);
    expect(result.dry_run).toBe(false);
    expect(result.removed.length).toBeGreaterThan(0);
    // The runtime-node-modules entry was recursively removed in-place, so the
    // tree never leaks into kept[].
    expect(result.kept).toEqual([]);
    expect(result.removed).toContain(join("skills", "lint", "node_modules"));

    // Manifest is gone, payload files are gone, parent directory was
    // best-effort rmdir'd. The .claude directory itself may or may not
    // remain depending on whether top-level reclaim found it empty —
    // assert the manifest and one known file are gone.
    expect(existsSync(manifestPath(target))).toBe(false);
    expect(existsSync(join(target, "skills", "lint", "SKILL.md"))).toBe(false);
    expect(existsSync(join(target, "commands", "lint.md"))).toBe(false);
    expect(existsSync(join(target, "agents", "lint-detector.md"))).toBe(false);
    expect(existsSync(join(target, "skills", "lint", "node_modules"))).toBe(
      false,
    );
  });

  it("uninstall without a manifest returns manifest_missing (exit 1)", async () => {
    gitInit(workspace);
    // Note: no install ran. No .claude/.lint-manifest.json on disk.
    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_missing");
    expect(result.reason).toMatch(/no harness installed at scope project/);
  });

  it("orphan files (user-authored) inside the scope persist after uninstall", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");
    // Orphan: a user-authored file under the scope, not tracked by manifest.
    const orphan = join(target, "user-notes.md");
    writeFileSync(orphan, "private notes\n", "utf8");
    // Orphan inside a manifest-managed directory.
    const orphanInDir = join(target, "skills", "user.md");
    writeFileSync(orphanInDir, "user skill\n", "utf8");

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);

    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(orphanInDir)).toBe(true);
    // The manifest is gone but user files still live where the user put them.
    expect(existsSync(manifestPath(target))).toBe(false);
    // Top-level scope directory still exists because orphan keeps it alive.
    expect(existsSync(target)).toBe(true);
    const survivors = readdirSync(target).toSorted();
    // skills/ survived (because of user.md inside) + user-notes.md.
    expect(survivors).toContain("user-notes.md");
    expect(survivors).toContain("skills");
  });

  it("--dry-run does not touch the FS but reports the planned removals", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: true,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dry_run).toBe(true);
    // 3 payload files + runtime-node-modules entry = 4 planned removals.
    expect(result.removed.length).toBe(4);
    // FS untouched.
    expect(existsSync(manifestPath(target))).toBe(true);
    expect(existsSync(join(target, "skills", "lint", "SKILL.md"))).toBe(true);
    // Manifest still readable + intact.
    const m = readManifest(target);
    expect(m).not.toBeNull();
    expect(m!.entries.length).toBe(4);
  });

  it("entries already deleted from disk are reported in kept[] as already-absent", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");
    // Manually delete one tracked file before uninstall.
    rmSync(join(target, "commands", "lint.md"));

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the manually-deleted lint.md is `already-absent`; the runtime
    // tree existed on disk and was removed recursively.
    expect(result.kept.map((k) => k.path)).toEqual([
      join("commands", "lint.md"),
    ]);
    expect(result.kept[0]?.reason).toBe("already-absent");
    // SKILL.md, agents/lint-detector.md, and skills/lint/node_modules were
    // removed.
    expect(result.removed.length).toBe(3);
  });

  it("rm -rf runtime-node-modules tree even when populated by npm", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");
    const nmRoot = join(target, "skills", "lint", "node_modules");
    // Sanity: the fake materialize wrote a populated node_modules tree.
    expect(existsSync(join(nmRoot, "@hgflima", "qualy", "package.json"))).toBe(
      true,
    );
    // Add nested files so a non-recursive `unlink` would fail.
    mkdirSync(join(nmRoot, "deep", "nested"), { recursive: true });
    writeFileSync(join(nmRoot, "deep", "nested", "a.js"), "module.exports={};");

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removed).toContain(join("skills", "lint", "node_modules"));
    expect(existsSync(nmRoot)).toBe(false);
  });

  it("missing runtime-node-modules tree maps to kept[] as already-absent", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");
    // Manually wipe the runtime tree before uninstall to simulate the user
    // having run `rm -rf` (or a bug having moved it). The uninstaller must
    // treat that as `already-absent`, not as an internal error.
    rmSync(join(target, "skills", "lint", "node_modules"), {
      recursive: true,
      force: true,
    });

    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kept.map((k) => k.path)).toContain(
      join("skills", "lint", "node_modules"),
    );
    for (const k of result.kept) {
      expect(k.reason).toBe("already-absent");
    }
  });

  it("scope_resolution error: --scope project without .git/", async () => {
    // workspace has NO .git directory.
    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("scope_resolution");
    expect(result.reason).toMatch(/--scope local/);
  });

  it("--keep-backup is accepted but a no-op for the harness uninstaller", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: fakeMaterialize,
    });
    const target = join(workspace, ".claude");
    const result = await uninstallHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      keepBackup: true,
    });
    expect(result.ok).toBe(true);
    // Nothing about the result changes versus keepBackup=false; the harness
    // installer doesn't write `.lint-backup/` snapshots, so the flag is inert.
    expect(existsSync(manifestPath(target))).toBe(false);
  });
});

describe("runHarnessUninstall (CLI handler)", () => {
  let source: string;
  let workspace: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-uninstall-cli-src-"));
    workspace = mkdtempSync(join(tmpdir(), "qualy-uninstall-cli-ws-"));
    makePayload(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    setStreams({ stderr: process.stderr, stdout: process.stdout });
  });

  it("--help writes help text to stderr and returns OK", async () => {
    const stderr = new PassThrough();
    const stdout = new PassThrough();
    setStreams({ stderr, stdout });
    let helpOut = "";
    stderr.on("data", (c) => {
      helpOut += String(c);
    });
    const code = await runHarnessUninstall(["--help"], { stderr });
    expect(code).toBe(EXIT_CODES.OK);
    expect(helpOut).toMatch(/qualy uninstall/);
    expect(helpOut).toMatch(/--keep-backup/);
  });

  it("unknown flag exits with USAGE_ERROR", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setStreams({ stdout, stderr });
    let stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    const code = await runHarnessUninstall(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("usage_error");
  });

  it("manifest_missing exits with RECOVERABLE_ERROR (1)", async () => {
    gitInit(workspace);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setStreams({ stdout, stderr });
    let stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    const code = await runHarnessUninstall([
      "--scope",
      "project",
      "--cwd",
      workspace,
    ]);
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("manifest_missing");
  });
});
