/**
 * E2E test of the canonical preamble probe defined by SPEC §4 of
 * cli-bin-resolution (v0.3.4 — `.harn/docs/cli-bin-resolution/`).
 *
 * The probe is the bash snippet every functional `.md` file embeds
 * before invoking `node "$QUALY_BIN" <sub>`. Its job is to consult
 * `$QUALY_DEV_BIN` (dev override) → `$PWD/.claude/...` → `$HOME/.claude/...`
 * looking for the materialized lint runtime, then exit 5 with a clear
 * stderr message when nothing is on disk.
 *
 * Bash invocation uses `--noprofile --norc` and a fully-explicit `env`
 * to avoid leakage from the parent shell (HOME / PWD / random user
 * dotfiles). Both `cwd` and `PWD` are set so bash and the script see
 * the same dir.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Canonical probe (frozen by SPEC §4) with a final `echo "$QUALY_BIN"`
 * instead of the production `node "$QUALY_BIN" ...` line. Keeping the
 * probe block byte-for-byte locks this test to the same contract the
 * unit-paired `preamble-parity.test.ts` enforces across the 19
 * functional files.
 */
const PROBE_SCRIPT = [
  'QUALY_BIN=""',
  "# Dev override (uso interno do repo qualy): aponta para bin/qualy.mjs local.",
  '[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"',
  "# Lookup padrão: cópia materializada por `qualy install`.",
  'if [ -z "$QUALY_BIN" ]; then',
  '  for cand in "$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs" \\',
  '              "$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"; do',
  '    [ -f "$cand" ] && QUALY_BIN="$cand" && break',
  "  done",
  "fi",
  '[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \\`npx @hgflima/qualy install\\` first." >&2; exit 5; }',
  'echo "$QUALY_BIN"',
].join("\n");

interface ProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProbe(
  home: string,
  pwd: string,
  devBin: string | null = null,
): ProbeResult {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PWD: pwd,
    PATH: process.env["PATH"] ?? "",
  };
  if (devBin !== null) {
    env["QUALY_DEV_BIN"] = devBin;
  }
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", PROBE_SCRIPT],
    {
      cwd: pwd,
      env,
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function seedBin(root: string): string {
  const dir = join(
    root,
    ".claude",
    "skills",
    "lint",
    "node_modules",
    "@hgflima",
    "qualy",
    "bin",
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "qualy.mjs");
  writeFileSync(file, "#!/usr/bin/env node\n// stub for preamble-resolution e2e\n");
  return file;
}

describe("e2e: preamble bash probe ($QUALY_DEV_BIN → $PWD → $HOME, SPEC §4)", () => {
  let tmpRoot: string;
  let tmpHome: string;
  let tmpPwd: string;

  beforeEach(() => {
    // realpathSync normalizes macOS's `/var/folders/...` ↔ `/private/var/...`
    // symlink — bash resolves cwd to the canonical path, so we compare
    // against the same canonical form when asserting on stdout.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "qualy-preamble-")));
    tmpHome = join(tmpRoot, "home");
    tmpPwd = join(tmpRoot, "pwd");
    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(tmpPwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("scenario 1 — PWD-only: resolves to $PWD/.claude/...", () => {
    const expected = seedBin(tmpPwd);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  });

  it("scenario 2 — HOME-only: falls back to $HOME/.claude/...", () => {
    const expected = seedBin(tmpHome);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  });

  it("scenario 3 — both present: $PWD wins (precedence)", () => {
    const pwdFile = seedBin(tmpPwd);
    seedBin(tmpHome);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(pwdFile);
  });

  it("scenario 4 — neither present: exit 5, stderr names install command", () => {
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain("qualy not installed");
    expect(stderr).toContain("npx @hgflima/qualy install");
  });

  it("scenario 5 — QUALY_DEV_BIN override wins over $PWD", () => {
    seedBin(tmpPwd);
    const devBinDir = join(tmpRoot, "dev");
    mkdirSync(devBinDir, { recursive: true });
    const devBin = join(devBinDir, "qualy.mjs");
    writeFileSync(devBin, "#!/usr/bin/env node\n// dev override\n");
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd, devBin);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(devBin);
  });

  it("scenario 6 — QUALY_DEV_BIN pointing to a non-existent file is ignored", () => {
    const expected = seedBin(tmpPwd);
    const { status, stdout, stderr } = runProbe(
      tmpHome,
      tmpPwd,
      join(tmpRoot, "nonexistent", "qualy.mjs"),
    );
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  });
});
