import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  parseInstallArgs,
  runHarnessInstall,
} from "../../../src/install/install.ts";
import {
  type Manifest,
  manifestPath,
  readManifest,
} from "../../../src/install/manifest.ts";
import type { MaterializeRuntimeResult } from "../../../src/install/materialize-runtime.ts";
import { setStreams } from "../../../src/lib/logger.ts";
import { EXIT_CODES } from "../../../src/lib/exit-codes.ts";

/**
 * Default test seam for `materializeRuntime`: physically writes the stub
 * `package.json` (so `sha256File` succeeds in install.ts) but never spawns
 * `npm`. Mirrors the real materializer's idempotency: if a `package.json`
 * already exists, returns `stubCreated: null`.
 */
function makeFakeMaterialize(
  log?: { calls: { target: string; packageSpec: string; dryRun: boolean }[] },
): MaterializeRuntimeFn {
  return async ({ target, packageSpec, dryRun }) => {
    log?.calls.push({ target, packageSpec, dryRun });
    const runtimePath = join(target, "skills", "lint");
    if (dryRun) {
      return { ok: true, stubCreated: null, runtimePath };
    }
    mkdirSync(runtimePath, { recursive: true });
    const stubAbs = join(runtimePath, "package.json");
    let stubCreated: string | null = null;
    if (!existsSync(stubAbs)) {
      writeFileSync(
        stubAbs,
        `${JSON.stringify({ name: "qualy-runtime", private: true }, null, 2)}\n`,
        "utf8",
      );
      stubCreated = join("skills", "lint", "package.json");
    }
    // Materialize a placeholder node_modules so manifest invariants
    // exercised by uninstall-style tests downstream still hold.
    mkdirSync(join(runtimePath, "node_modules"), { recursive: true });
    return { ok: true, stubCreated, runtimePath };
  };
}

const failingMaterialize =
  (
    error:
      | "EQUALY_INSTALL_NETWORK"
      | "EQUALY_INSTALL_FS"
      | "EQUALY_INSTALL_UNKNOWN",
    reason: string,
  ): MaterializeRuntimeFn =>
  async () => ({ ok: false, error, reason }) satisfies MaterializeRuntimeResult;

/**
 * Build a synthetic qualy distribution rooted at `root` with the four
 * top-level payload directories (`skills/`, `commands/`, `agents/`, `cli/`)
 * plus a `package.json` whose `name === "@hgflima/qualy"`. The harness installer must
 * be able to point its `source` here without copying the real repo.
 */
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

describe("parseInstallArgs", () => {
  it("defaults to scope=project, dryRun=false, yes=false", () => {
    const r = parseInstallArgs([], "/tmp/x");
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
    const r = parseInstallArgs(
      ["--scope", "local", "--cwd", "/elsewhere", "--dry-run", "--yes"],
      "/tmp/x",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      scope: "local",
      cwd: "/elsewhere",
      dryRun: true,
      yes: true,
    });
  });

  it("rejects an invalid --scope value", () => {
    const r = parseInstallArgs(["--scope", "global"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/--scope must be one of/);
  });

  it("rejects --cwd without a value", () => {
    const r = parseInstallArgs(["--cwd"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing value for --cwd/);
  });

  it("recognizes --help and -h as the help sentinel", () => {
    expect(parseInstallArgs(["--help"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseInstallArgs(["-h"], "/x")).toEqual({
      ok: false,
      error: "help",
    });
  });

  it("rejects an unknown flag", () => {
    const r = parseInstallArgs(["--nope"], "/tmp/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag: --nope/);
  });
});

describe("installHarness", () => {
  let source: string;
  let workspace: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-install-src-"));
    workspace = mkdtempSync(join(tmpdir(), "qualy-install-ws-"));
    makePayload(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("--scope project copies the payload and writes a manifest with scope:project", async () => {
    gitInit(workspace);
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toBe("project");
    expect(result.version).toBe("0.1.0");
    expect(result.target).toBe(join(workspace, ".claude"));
    expect(result.copied).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.dry_run).toBe(false);
    expect(result.manifest_overwritten).toBe(false);
    expect(result.gitignore.action).toBe("skipped");
    expect(result.runtime.action).toBe("materialized");

    expect(
      readFileSync(
        join(workspace, ".claude", "skills", "lint", "SKILL.md"),
        "utf8",
      ),
    ).toBe("skill body\n");
    expect(
      readFileSync(join(workspace, ".claude", "commands", "lint.md"), "utf8"),
    ).toBe("command body\n");

    const m = readManifest(join(workspace, ".claude")) as Manifest;
    expect(m).not.toBeNull();
    expect(m.scope).toBe("project");
    expect(m.harness_version).toBe("0.1.0");
    expect(m.installer).toBe("npx");
    // 3 payload files + runtime-node-modules entry + stub package.json entry.
    expect(m.entries.length).toBe(5);
    for (const e of m.entries) {
      if (e.kind === "runtime-node-modules") {
        expect(e.sha256).toBe("");
      } else {
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    const runtime = m.entries.filter(
      (e) => e.kind === "runtime-node-modules",
    );
    expect(runtime).toHaveLength(1);
    expect(runtime[0]?.path).toBe(join("skills", "lint", "node_modules"));
    const stub = m.entries.filter(
      (e) => e.path === join("skills", "lint", "package.json"),
    );
    expect(stub).toHaveLength(1);
    expect(stub[0]?.kind).toBe("other");
    // .gitignore must NOT have been touched in project scope.
    expect(existsSync(join(workspace, ".gitignore"))).toBe(false);
  });

  it("--scope local appends .claude/ to .gitignore", async () => {
    const result = await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toBe("local");
    expect(result.gitignore.action).toBe("created");
    expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
      ".claude/\n",
    );
  });

  it("--scope local with pre-existing .gitignore appends only when missing", async () => {
    writeFileSync(join(workspace, ".gitignore"), ".claude/\n", "utf8");
    const result = await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gitignore.action).toBe("already-present");
  });

  it("--scope user resolves to ${HOME}/.claude", async () => {
    const fakeHome = workspace;
    const prev = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = await installHarness({
        scope: "user",
        cwd: process.cwd(),
        dryRun: false,
        yes: false,
        source,
        materialize: makeFakeMaterialize(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.target).toBe(join(fakeHome, ".claude"));
      expect(
        existsSync(join(fakeHome, ".claude", "skills", "lint", "SKILL.md")),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  it("--dry-run reports the plan without touching the FS", async () => {
    gitInit(workspace);
    const log = { calls: [] as { dryRun: boolean }[] };
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: true,
      yes: false,
      source,
      materialize: makeFakeMaterialize(log),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dry_run).toBe(true);
    expect(result.copied).toBe(3);
    expect(result.runtime.action).toBe("dry-run");
    // materialize was invoked but with dryRun=true — fake never wrote anything.
    expect(log.calls.every((c) => c.dryRun)).toBe(true);
    // No .claude/ created at all.
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    // No .gitignore update on dry-run, even for local scope.
    const localResult = await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: true,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    expect(localResult.ok).toBe(true);
    if (!localResult.ok) return;
    expect(localResult.gitignore.action).toBe("skipped");
    expect(existsSync(join(workspace, ".gitignore"))).toBe(false);
  });

  it("a second install reports manifest_overwritten and reuses skipped entries", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    const second = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.manifest_overwritten).toBe(true);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(3);
    // 3 payload entries + runtime-node-modules entry. Stub already exists
    // from first install so materialize returns stubCreated:null and we do
    // not duplicate the "other" entry.
    const m = readManifest(join(workspace, ".claude")) as Manifest;
    expect(m.entries.length).toBe(4);
    expect(
      m.entries.filter((e) => e.kind === "runtime-node-modules"),
    ).toHaveLength(1);
    expect(
      m.entries.filter((e) => e.path === join("skills", "lint", "package.json")),
    ).toHaveLength(0);
  });

  it("propagates materializeRuntime errors as runtime_install_* and skips manifest write", async () => {
    gitInit(workspace);
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: failingMaterialize(
        "EQUALY_INSTALL_NETWORK",
        "ENOTFOUND registry.npmjs.org",
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("runtime_install_network");
    expect(result.reason).toMatch(/ENOTFOUND/);
    // Manifest must not exist — materialize failed before write.
    expect(existsSync(manifestPath(join(workspace, ".claude")))).toBe(false);
  });

  it.each([
    ["EQUALY_INSTALL_FS" as const, "runtime_install_fs" as const],
    ["EQUALY_INSTALL_UNKNOWN" as const, "runtime_install_unknown" as const],
  ])("maps %s to %s", async (matErr, installErr) => {
    gitInit(workspace);
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: failingMaterialize(matErr, "boom"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(installErr);
  });

  it("calls copy → materialize → manifest write in order", async () => {
    gitInit(workspace);
    const order: string[] = [];
    const materialize: MaterializeRuntimeFn = async ({ target, dryRun }) => {
      order.push("materialize");
      // The payload must already exist on disk by the time we run.
      expect(
        existsSync(
          join(workspace, ".claude", "skills", "lint", "SKILL.md"),
        ),
      ).toBe(true);
      // The manifest must NOT yet have been written.
      expect(existsSync(manifestPath(target))).toBe(false);
      const runtimePath = join(target, "skills", "lint");
      mkdirSync(runtimePath, { recursive: true });
      const stubAbs = join(runtimePath, "package.json");
      let stubCreated: string | null = null;
      if (!existsSync(stubAbs)) {
        writeFileSync(
          stubAbs,
          `${JSON.stringify({ name: "qualy-runtime", private: true }, null, 2)}\n`,
          "utf8",
        );
        stubCreated = join("skills", "lint", "package.json");
      }
      void dryRun;
      return { ok: true, stubCreated, runtimePath };
    };
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize,
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(["materialize"]);
    expect(existsSync(manifestPath(join(workspace, ".claude")))).toBe(true);
  });

  it("--scope project without .git/ returns scope_resolution error", async () => {
    // workspace has NO .git directory.
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("scope_resolution");
    expect(result.reason).toMatch(/--scope local/);
    // Nothing got written.
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
  });

  it("--scope user with HOME unset returns scope_resolution error", async () => {
    const prev = process.env.HOME;
    delete process.env.HOME;
    try {
      const result = await installHarness({
        scope: "user",
        cwd: process.cwd(),
        dryRun: false,
        yes: false,
        source,
        materialize: makeFakeMaterialize(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("scope_resolution");
      expect(result.reason).toMatch(/HOME undefined/);
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
    }
  });

  it("returns payload_missing when the source has no qualy package.json on the path", async () => {
    // tmpdirs sit under /var/folders or /tmp — walking up never reaches a
    // qualy package.json, so readPackageVersion throws and the installer
    // surfaces it as a recoverable payload_missing error.
    const bogus = mkdtempSync(join(tmpdir(), "qualy-install-bogus-"));
    try {
      const result = await installHarness({
        scope: "local",
        cwd: workspace,
        dryRun: false,
        yes: false,
        source: bogus,
        materialize: makeFakeMaterialize(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("payload_missing");
      expect(result.reason).toMatch(/unable to locate qualy root/);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});

describe("runHarnessInstall (CLI handler)", () => {
  let source: string;
  let workspace: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-install-cli-src-"));
    workspace = mkdtempSync(join(tmpdir(), "qualy-install-cli-ws-"));
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
    const code = await runHarnessInstall(["--help"], { stderr });
    expect(code).toBe(EXIT_CODES.OK);
    expect(helpOut).toMatch(/qualy install/);
  });

  it("unknown flag exits with USAGE_ERROR", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setStreams({ stdout, stderr });
    let stdoutBuf = "";
    stdout.on("data", (c) => {
      stdoutBuf += String(c);
    });
    const code = await runHarnessInstall(["--bogus"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const json = JSON.parse(stdoutBuf.split("\n").filter(Boolean).pop()!);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("usage_error");
  });
});

describe("manifest entries from install reflect copyPayload output", () => {
  let source: string;
  let workspace: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-install-meta-src-"));
    workspace = mkdtempSync(join(tmpdir(), "qualy-install-meta-ws-"));
    makePayload(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("entries are sorted by path and use kinds derived from copy.ts", async () => {
    gitInit(workspace);
    await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    const m = readManifest(join(workspace, ".claude")) as Manifest;
    const paths = m.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].toSorted((a, b) => a.localeCompare(b)));
    const kinds = new Map(m.entries.map((e) => [e.path, e.kind]));
    expect(kinds.get(join("agents", "lint-detector.md"))).toBe("agent");
    expect(kinds.get(join("commands", "lint.md"))).toBe("command");
    expect(kinds.get(join("skills", "lint", "SKILL.md"))).toBe("skill");
    expect(kinds.get(join("skills", "lint", "node_modules"))).toBe(
      "runtime-node-modules",
    );
    expect(kinds.get(join("skills", "lint", "package.json"))).toBe("other");
  });

  it("manifest file is written to ${target}/.lint-manifest.json", async () => {
    await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
      materialize: makeFakeMaterialize(),
    });
    expect(existsSync(manifestPath(join(workspace, ".claude")))).toBe(true);
    // Sanity: target directory has skills/, commands/, agents/, plus manifest.
    const top = readdirSync(join(workspace, ".claude")).toSorted();
    expect(top).toEqual([
      ".lint-manifest.json",
      "agents",
      "commands",
      "skills",
    ]);
  });
});
