import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  materializeRuntime,
  type NpmInstallOutcome,
  type RunNpmInstall,
} from "../../../src/install/materialize-runtime.ts";

function fakeRun(outcome: NpmInstallOutcome): RunNpmInstall {
  return async () => outcome;
}

function ok(): NpmInstallOutcome {
  return { code: 0, stderr: "" };
}

describe("materializeRuntime", () => {
  let target: string;

  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "qualy-materialize-"));
  });

  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("dryRun returns ok with stubCreated=null and writes nothing", async () => {
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: true,
      runNpmInstall: async () => {
        throw new Error("npm must not be spawned in dryRun");
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stubCreated).toBeNull();
      expect(result.runtimePath).toBe(join(target, "skills", "lint"));
    }
    // No stub written.
    expect(existsSync(join(target, "skills", "lint", "package.json"))).toBe(
      false,
    );
  });

  it("creates skills/lint/ and writes the stub package.json when absent", async () => {
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun(ok()),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stubCreated).toBe(join("skills", "lint", "package.json"));
      expect(result.runtimePath).toBe(join(target, "skills", "lint"));
    }

    const stubAbs = join(target, "skills", "lint", "package.json");
    expect(existsSync(stubAbs)).toBe(true);
    const parsed = JSON.parse(readFileSync(stubAbs, "utf8"));
    expect(parsed).toEqual({ name: "qualy-runtime", private: true });
  });

  it("does not overwrite an existing package.json (idempotent)", async () => {
    const stubAbs = join(target, "skills", "lint", "package.json");
    const dir = join(target, "skills", "lint");
    const fs = await import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    const existing = `${JSON.stringify({ name: "user-owned", version: "9.9.9" }, null, 2)}\n`;
    writeFileSync(stubAbs, existing, "utf8");

    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun(ok()),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stubCreated).toBeNull();
    }
    expect(readFileSync(stubAbs, "utf8")).toBe(existing);
  });

  it("invokes npm with cwd=skills/lint and the exact packageSpec", async () => {
    const calls: { cwd: string; packageSpec: string }[] = [];
    const run: RunNpmInstall = async (input) => {
      calls.push(input);
      return ok();
    };

    await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: run,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(join(target, "skills", "lint"));
    expect(calls[0]?.packageSpec).toBe("@hgflima/qualy@0.3.4");
  });

  it("maps non-zero exit with network stderr to EQUALY_INSTALL_NETWORK", async () => {
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun({
        code: 1,
        stderr: "npm ERR! code ENOTFOUND\nnpm ERR! errno ENOTFOUND\n",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EQUALY_INSTALL_NETWORK");
      expect(result.reason).toContain("ENOTFOUND");
    }
  });

  it("maps non-zero exit with EACCES stderr to EQUALY_INSTALL_FS", async () => {
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun({
        code: 1,
        stderr: "npm ERR! code EACCES\nnpm ERR! permission denied\n",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EQUALY_INSTALL_FS");
    }
  });

  it("maps non-zero exit with unrelated stderr to EQUALY_INSTALL_UNKNOWN", async () => {
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun({
        code: 1,
        stderr: "some unexpected failure\n",
      }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EQUALY_INSTALL_UNKNOWN");
    }
  });

  it("maps spawnError ENOENT (npm not on PATH) to EQUALY_INSTALL_UNKNOWN", async () => {
    const enoent = new Error("spawn npm ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun({ code: null, stderr: "", spawnError: enoent }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EQUALY_INSTALL_UNKNOWN");
      expect(result.reason).toMatch(/npm CLI not found/);
    }
  });

  it("maps spawnError EACCES to EQUALY_INSTALL_FS", async () => {
    const eacces = new Error("permission denied") as NodeJS.ErrnoException;
    eacces.code = "EACCES";
    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun({ code: null, stderr: "", spawnError: eacces }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EQUALY_INSTALL_FS");
    }
  });

  it("succeeds when npm exits 0 and stub already existed (stubCreated stays null)", async () => {
    const stubAbs = join(target, "skills", "lint", "package.json");
    const fs = await import("node:fs");
    fs.mkdirSync(join(target, "skills", "lint"), { recursive: true });
    writeFileSync(
      stubAbs,
      `${JSON.stringify({ name: "qualy-runtime", private: true }, null, 2)}\n`,
      "utf8",
    );

    const result = await materializeRuntime({
      target,
      packageSpec: "@hgflima/qualy@0.3.4",
      dryRun: false,
      runNpmInstall: fakeRun(ok()),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stubCreated).toBeNull();
    }
  });
});
