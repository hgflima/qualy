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
  parseInstallArgs,
  runHarnessInstall,
} from "../../../src/install/install.ts";
import {
  type Manifest,
  manifestPath,
  readManifest,
} from "../../../src/install/manifest.ts";
import { setStreams } from "../../../src/lib/logger.ts";
import { EXIT_CODES } from "../../../src/lib/exit-codes.ts";

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
    expect(m.entries.length).toBe(3);
    for (const e of m.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
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
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: true,
      yes: false,
      source,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dry_run).toBe(true);
    expect(result.copied).toBe(3);
    // No .claude/ created at all.
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    // No .gitignore update on dry-run, even for local scope.
    const localResult = await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: true,
      yes: false,
      source,
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
    });
    const second = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.manifest_overwritten).toBe(true);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(3);
    // Manifest still contains the full 3 entries (skipped files belong to the
    // index too — uninstall reclaims them).
    const m = readManifest(join(workspace, ".claude")) as Manifest;
    expect(m.entries.length).toBe(3);
  });

  it("--scope project without .git/ returns scope_resolution error", async () => {
    // workspace has NO .git directory.
    const result = await installHarness({
      scope: "project",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
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
    });
    const m = readManifest(join(workspace, ".claude")) as Manifest;
    const paths = m.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].toSorted((a, b) => a.localeCompare(b)));
    const kinds = new Map(m.entries.map((e) => [e.path, e.kind]));
    expect(kinds.get(join("agents", "lint-detector.md"))).toBe("agent");
    expect(kinds.get(join("commands", "lint.md"))).toBe("command");
    expect(kinds.get(join("skills", "lint", "SKILL.md"))).toBe("skill");
  });

  it("manifest file is written to ${target}/.lint-manifest.json", async () => {
    await installHarness({
      scope: "local",
      cwd: workspace,
      dryRun: false,
      yes: false,
      source,
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
