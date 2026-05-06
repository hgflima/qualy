import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installHarness,
  type MaterializeRuntimeFn,
} from "../../../src/install/install.ts";

const fakeMaterialize: MaterializeRuntimeFn = async ({ target, dryRun }) => {
  const runtimePath = join(target, "skills", "lint");
  if (dryRun) return { ok: true, stubCreated: null, runtimePath };
  return { ok: true, stubCreated: null, runtimePath };
};
import {
  type ApplyInstall,
  type ApplyInstallArgs,
  parseUpdateArgs,
  type PromptFn,
  runHarnessUpdate,
  updateHarness,
} from "../../../src/install/update.ts";
import {
  fetchLatestVersion,
  type RegistryFetchResult,
  type RunNpmView,
} from "../../../src/install/registry.ts";
import { writeManifest } from "../../../src/install/manifest.ts";
import { setStreams } from "../../../src/lib/logger.ts";
import { EXIT_CODES } from "../../../src/lib/exit-codes.ts";

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

async function seedManifest(
  workspace: string,
  version: string,
): Promise<string> {
  // Run the real installer once with a synthetic payload to plant a manifest.
  const payload = mkdtempSync(join(tmpdir(), "qualy-update-payload-"));
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(
      join(payload, "package.json"),
      JSON.stringify({ name: "@hgflima/qualy", version }),
      "utf8",
    );
    fs.mkdirSync(join(payload, "skills", "lint"), { recursive: true });
    fs.writeFileSync(join(payload, "skills", "lint", "SKILL.md"), "x\n");
    fs.mkdirSync(join(payload, "commands"), { recursive: true });
    fs.writeFileSync(join(payload, "commands", "lint.md"), "x\n");
    fs.mkdirSync(join(payload, "agents"), { recursive: true });
    fs.writeFileSync(join(payload, "agents", "lint-detector.md"), "x\n");
    fs.mkdirSync(join(payload, "cli", "src"), { recursive: true });
    fs.writeFileSync(join(payload, "cli", "src", "index.ts"), "export {};\n");

    const r = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source: payload,
      materialize: fakeMaterialize,
    });
    if (!r.ok) throw new Error(`install seed failed: ${r.reason}`);
    return r.target;
  } finally {
    rmSync(payload, { recursive: true, force: true });
  }
}

function fakeFetch(result: RegistryFetchResult): typeof fetchLatestVersion {
  return async () => result;
}

const applyExplodes: ApplyInstall = async () => {
  throw new Error("apply must not run in this case");
};

function fakeRun(outcome: Awaited<ReturnType<RunNpmView>>): RunNpmView {
  return async () => outcome;
}

describe("parseUpdateArgs", () => {
  it("defaults to scope=project, dryRun=false, yes=false", () => {
    const r = parseUpdateArgs([], "/tmp/x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      scope: "project",
      cwd: "/tmp/x",
      dryRun: false,
      yes: false,
    });
  });

  it("parses --scope, --cwd, --dry-run, --yes", () => {
    const r = parseUpdateArgs(
      ["--scope", "user", "--cwd", "/elsewhere", "--dry-run", "--yes"],
      "/tmp/x",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      scope: "user",
      cwd: "/elsewhere",
      dryRun: true,
      yes: true,
    });
  });

  it("rejects an invalid --scope value", () => {
    const r = parseUpdateArgs(["--scope", "global"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/--scope must be one of/);
  });

  it("rejects --cwd without a value", () => {
    const r = parseUpdateArgs(["--cwd"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing value for --cwd/);
  });

  it("recognizes --help and -h as the help sentinel", () => {
    expect(parseUpdateArgs(["--help"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseUpdateArgs(["-h"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
  });

  it("rejects an unknown flag", () => {
    const r = parseUpdateArgs(["--bogus"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag: --bogus/);
  });
});

describe("updateHarness", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "qualy-update-ws-"));
    gitInit(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns up-to-date when installed === latest", async () => {
    await seedManifest(workspace, "0.1.0");
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.1.0" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("up-to-date");
    expect(result.installed_before).toBe("0.1.0");
    expect(result.installed_after).toBe("0.1.0");
  });

  it("installed > latest is reported as up-to-date (no downgrade)", async () => {
    await seedManifest(workspace, "0.2.0");
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.1.0" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("up-to-date");
  });

  it("minor bump auto-applies without a prompt and reports updated", async () => {
    await seedManifest(workspace, "0.1.0");
    const calls: ApplyInstallArgs[] = [];
    const apply: ApplyInstall = async (args) => {
      calls.push(args);
      return { ok: true };
    };
    const promptCalls: string[] = [];
    const prompt: PromptFn = async (q) => {
      promptCalls.push(q);
      return false;
    };
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.2.0" }),
      applyInstall: apply,
      prompt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("updated");
    expect(result.installed_before).toBe("0.1.0");
    expect(result.installed_after).toBe("0.2.0");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      scope: "project",
      cwd: workspace,
      version: "0.2.0",
    });
    expect(promptCalls).toEqual([]);
  });

  it("major bump without --yes prompts and aborts on N", async () => {
    await seedManifest(workspace, "0.5.0");
    let asked = "";
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "1.0.0" }),
      applyInstall: applyExplodes,
      prompt: async (q) => {
        asked = q;
        return false;
      },
    });
    expect(asked).toMatch(/Major version bump: 0\.5\.0 → 1\.0\.0/);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("user_aborted");
  });

  it("major bump with --yes skips the prompt and applies", async () => {
    await seedManifest(workspace, "0.5.0");
    let prompted = false;
    let applied = false;
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: true,
      fetchLatestVersion: fakeFetch({ ok: true, version: "1.0.0" }),
      prompt: async () => {
        prompted = true;
        return true;
      },
      applyInstall: async () => {
        applied = true;
        return { ok: true };
      },
    });
    expect(prompted).toBe(false);
    expect(applied).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("updated");
    expect(result.installed_after).toBe("1.0.0");
  });

  it("--dry-run with newer version returns would-update and does not apply", async () => {
    await seedManifest(workspace, "0.1.0");
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: true,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.2.0" }),
      applyInstall: applyExplodes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("would-update");
    expect(result.dry_run).toBe(true);
    expect(result.installed_after).toBe("0.2.0");
  });

  it("manifest_missing exits with kind=manifest_missing and a clear reason", async () => {
    // No install has been seeded — workspace has .git/ but no .claude.
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "9.9.9" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_missing");
    expect(result.reason).toMatch(/run `qualy install` first/);
  });

  it("scope_resolution failure (e.g. project without .git/) bubbles up", async () => {
    const noGit = mkdtempSync(join(tmpdir(), "qualy-update-nogit-"));
    try {
      const result = await updateHarness({
        scope: "project",
        cwd: noGit,
        dryRun: false,
        yes: false,
        fetchLatestVersion: fakeFetch({ ok: true, version: "0.2.0" }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("scope_resolution");
      expect(result.reason).toMatch(/--scope local/);
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  describe("registry error mapping (4 kinds — TASKS 2.3)", () => {
    beforeEach(async () => {
      await seedManifest(workspace, "0.1.0");
    });

    it("network error → registry_network with DNS hint", async () => {
      const result = await updateHarness({
        scope: "project",
        cwd: workspace,
        dryRun: false,
        yes: false,
        fetchLatestVersion: fakeFetch({
          ok: false,
          kind: "network",
          message: "ENOTFOUND registry.npmjs.org",
        }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("registry_network");
      expect(result.reason).toMatch(/network or DNS issue/);
      expect(result.reason).toMatch(/ENOTFOUND/);
    });

    it("auth error → registry_auth with .npmrc hint", async () => {
      const result = await updateHarness({
        scope: "project",
        cwd: workspace,
        dryRun: false,
        yes: false,
        fetchLatestVersion: fakeFetch({
          ok: false,
          kind: "auth",
          message: "ENEEDAUTH",
        }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("registry_auth");
      expect(result.reason).toMatch(/~\/\.npmrc/);
    });

    it("mirror error → registry_mirror flagging the private mirror", async () => {
      const result = await updateHarness({
        scope: "project",
        cwd: workspace,
        dryRun: false,
        yes: false,
        fetchLatestVersion: fakeFetch({
          ok: false,
          kind: "mirror",
          message: "registry returned empty output",
        }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("registry_mirror");
      expect(result.reason).toMatch(/private mirror/);
    });

    it("unknown error → registry_unknown with retry hint", async () => {
      const result = await updateHarness({
        scope: "project",
        cwd: workspace,
        dryRun: false,
        yes: false,
        fetchLatestVersion: fakeFetch({
          ok: false,
          kind: "unknown",
          message: "npm view exited with code 7",
        }),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("registry_unknown");
      expect(result.reason).toMatch(/qualy update --dry-run/);
    });
  });

  it("apply_failed when the spawned npx install reports non-zero", async () => {
    await seedManifest(workspace, "0.1.0");
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.2.0" }),
      applyInstall: async () => ({
        ok: false,
        reason: "npx exited with code 7",
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("apply_failed");
    expect(result.reason).toMatch(/npx exited with code 7/);
  });

  it("invalid manifest version triggers internal error with the parser hint", async () => {
    const target = await seedManifest(workspace, "0.1.0");
    // Re-write the manifest with a non-semver harness_version. writeManifest
    // doesn't validate the version field, so this is a realistic bad-state.
    writeManifest(target, {
      version: "1",
      scope: "project",
      harness_version: "garbage",
      installer: "npx",
      installed_at: new Date().toISOString(),
      entries: [],
    });
    const result = await updateHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      fetchLatestVersion: fakeFetch({ ok: true, version: "0.2.0" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("internal");
    expect(result.reason).toMatch(/invalid semver/);
  });
});

describe("runHarnessUpdate (CLI handler)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "qualy-update-cli-"));
    gitInit(workspace);
  });

  afterEach(() => {
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
    const code = await runHarnessUpdate(["--help"], { stderr });
    expect(code).toBe(EXIT_CODES.OK);
    expect(helpOut).toMatch(/qualy update/);
    expect(helpOut).toMatch(/--scope/);
  });

  it("unknown flag exits with USAGE_ERROR", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setStreams({ stdout, stderr });
    let stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    const code = await runHarnessUpdate(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("usage_error");
  });

  it("manifest missing exits with RECOVERABLE_ERROR (1)", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setStreams({ stdout, stderr });
    let stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    const code = await runHarnessUpdate([
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

describe("registry.fetchLatestVersion (mapping logic)", () => {
  it("maps a clean stdout to ok:true", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 0,
        stdout: "0.4.2\n",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r).toEqual({ ok: true, version: "0.4.2" });
  });

  it("maps timedOut → kind:network", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("network");
    expect(r.message).toMatch(/timed out/);
  });

  it("maps stderr ENOTFOUND → kind:network", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 1,
        stdout: "",
        stderr: "npm ERR! code ENOTFOUND",
        timedOut: false,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("network");
  });

  it("maps stderr E401 → kind:auth", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 1,
        stdout: "",
        stderr: "npm ERR! code E401\nnpm ERR! 401 Unauthorized",
        timedOut: false,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("auth");
  });

  it("maps empty stdout with code 0 → kind:mirror", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("mirror");
  });

  it("maps non-semver stdout → kind:mirror", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 0,
        stdout: "garbage",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("mirror");
  });

  it("maps non-zero exit with quiet stderr → kind:unknown", async () => {
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: 7,
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unknown");
  });

  it("maps spawnError ENOENT → kind:network (npm not on PATH)", async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
      code: "ENOENT",
    });
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: enoent,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("network");
    expect(r.message).toMatch(/npm CLI not found/);
  });

  it("maps spawnError other → kind:unknown", async () => {
    const eacces: NodeJS.ErrnoException = Object.assign(new Error("denied"), {
      code: "EACCES",
    });
    const r = await fetchLatestVersion({
      timeoutMs: 100,
      runNpmView: fakeRun({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: eacces,
      }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unknown");
    expect(r.message).toBe("denied");
  });
});
