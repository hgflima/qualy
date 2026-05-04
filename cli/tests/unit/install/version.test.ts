import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_NODE_VERSION,
  checkNodeVersion,
  readPackageVersion,
} from "../../../src/install/version.ts";

describe("readPackageVersion", () => {
  it("returns the version field of the root qualy package.json", () => {
    // Default invocation walks up from the source file's directory and lands
    // on the repo's own package.json — i.e. the very file under test.
    const version = readPackageVersion();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("ignores intermediate package.json files whose name is not 'qualy'", () => {
    // The cli/ workspace package.json has name "@qualy/cli"; the walk must
    // skip it and reach the root. We assert by simulating the same layout
    // in a tmpdir: leaf has a non-qualy package.json, parent has qualy.
    const tmp = mkdtempSync(join(tmpdir(), "qualy-version-walk-"));
    try {
      writeFileSync(
        join(tmp, "package.json"),
        JSON.stringify({ name: "@hgflima/qualy", version: "9.9.9" }),
      );
      const inner = join(tmp, "cli", "src", "install");
      mkdirSync(inner, { recursive: true });
      writeFileSync(
        join(tmp, "cli", "package.json"),
        JSON.stringify({ name: "@qualy/cli", version: "0.0.0" }),
      );
      expect(readPackageVersion(inner)).toBe("9.9.9");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an explicit error when no qualy root is reachable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-version-norepo-"));
    try {
      // No package.json with name "@hgflima/qualy" anywhere on the path to /.
      expect(() => readPackageVersion(tmp)).toThrowError(
        /unable to locate qualy root package\.json/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws when the qualy package.json lacks a version field", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-version-noversion-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "@hgflima/qualy" }));
      expect(() => readPackageVersion(tmp)).toThrowError(
        /missing a string "version" field/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("checkNodeVersion", () => {
  it("returns ok:false when running below 22.6.0", () => {
    const result = checkNodeVersion("22.5.9");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.found).toBe("22.5.9");
      expect(result.required).toBe(REQUIRED_NODE_VERSION);
    }
  });

  it("returns ok:true at exactly 22.6.0", () => {
    expect(checkNodeVersion("22.6.0")).toEqual({ ok: true });
  });

  it("returns ok:true for a future major like 24.0.0", () => {
    expect(checkNodeVersion("24.0.0")).toEqual({ ok: true });
  });

  it("returns ok:false for older majors regardless of minor/patch", () => {
    expect(checkNodeVersion("20.99.99").ok).toBe(false);
  });

  it("strips pre-release / build suffixes when comparing", () => {
    expect(checkNodeVersion("22.6.0-nightly20260101").ok).toBe(true);
    expect(checkNodeVersion("22.5.9-rc.1").ok).toBe(false);
  });

  it("uses process.versions.node when called without arguments", () => {
    const result = checkNodeVersion();
    // The test harness itself runs on Node ≥ 22.6 (project requirement);
    // assert the call resolves without throwing and returns a discriminated
    // union we can pattern-match on.
    expect(typeof result.ok).toBe("boolean");
  });

  it("REQUIRED_NODE_VERSION is the literal pinned in the SPEC", () => {
    expect(REQUIRED_NODE_VERSION).toBe("22.6.0");
  });

  it("throws when the version string lacks a MAJOR.MINOR.PATCH triple", () => {
    expect(() => checkNodeVersion("22.6")).toThrowError(
      /expected MAJOR\.MINOR\.PATCH/,
    );
  });

  it("throws when a semver component is non-numeric", () => {
    expect(() => checkNodeVersion("22.x.0")).toThrowError(
      /non-numeric component/,
    );
  });
});

