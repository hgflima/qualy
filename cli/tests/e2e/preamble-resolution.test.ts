/**
 * E2E test of the canonical preamble probe defined by ADR 0013 / SPEC §6
 * (`.harn/docs/fixes/scope-resolution/`).
 *
 * The probe is the bash snippet every functional `.md` file embeds before
 * invoking `node --experimental-strip-types $QUALY_CLI <sub>`. Its job is
 * to walk `$PWD/.claude` → `$HOME/.claude` looking for the lint CLI source,
 * then exit 5 with a clear stderr message when nothing is on disk.
 *
 * This file does not depend on any of the 19 functional `.md` migrations
 * (Phase 2): the snippet is exercised as a *string literal* matching the
 * frozen block in SPEC §6 — so the test goes green the moment T1 / T2 land
 * and stays green through the whole migration. The only line we substitute
 * is the trailing `node ...` invocation, replaced by `echo "$QUALY_CLI"`
 * so we can assert on the resolved path without needing Node or the CLI.
 *
 * Bash invocation uses `--noprofile --norc` and a fully-explicit `env` to
 * avoid leakage from the parent shell (HOME / PWD / random user dotfiles).
 * Both `cwd` and `PWD` are set so bash and the script see the same dir.
 *
 * Scenarios mirror SPEC §7 (the table of four resolution cases).
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
 * Canonical 5-line probe (frozen by ADR 0013 / SPEC §6) with a final
 * `echo "$QUALY_CLI"` instead of the production `node ...` line. Keeping
 * the probe block as the SPEC defines it byte-for-byte is what locks this
 * test to the same contract the unit-paired `preamble-parity.test.ts`
 * enforces across the 19 functional files.
 */
const PROBE_SCRIPT = [
  'QUALY_CLI=""',
  'for cand in "$PWD/.claude" "$HOME/.claude"; do',
  '  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break',
  "done",
  '[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found in \\$PWD/.claude or \\$HOME/.claude. Run `qualy install` first." >&2; exit 5; }',
  'echo "$QUALY_CLI"',
].join("\n");

interface ProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProbe(home: string, pwd: string): ProbeResult {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", PROBE_SCRIPT],
    {
      cwd: pwd,
      env: { HOME: home, PWD: pwd, PATH: process.env["PATH"] ?? "" },
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function seedCli(root: string): string {
  const dir = join(root, ".claude", "skills", "lint", "cli", "src");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.ts");
  writeFileSync(file, "// stub for preamble-resolution e2e\n");
  return file;
}

describe("e2e: preamble bash probe ($PWD → $HOME, ADR 0013 / SPEC §6)", () => {
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
    const expected = seedCli(tmpPwd);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  });

  it("scenario 2 — HOME-only: falls back to $HOME/.claude/...", () => {
    const expected = seedCli(tmpHome);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(expected);
  });

  it("scenario 3 — both present: $PWD wins (precedence)", () => {
    const pwdFile = seedCli(tmpPwd);
    seedCli(tmpHome);
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(pwdFile);
  });

  it("scenario 4 — neither present: exit 5, stderr names both candidates", () => {
    const { status, stdout, stderr } = runProbe(tmpHome, tmpPwd);
    expect(status).toBe(5);
    expect(stdout).toBe("");
    // Stderr contract per SPEC §7: must mention "qualy CLI not found" plus
    // both candidate roots so the user knows where the probe looked.
    expect(stderr).toContain("qualy CLI not found");
    expect(stderr).toContain("$PWD/.claude");
    expect(stderr).toContain("$HOME/.claude");
  });
});
