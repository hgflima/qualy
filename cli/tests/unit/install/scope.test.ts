import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoverableError } from "../../../src/install/errors.ts";
import { resolveScope } from "../../../src/install/scope.ts";

describe("resolveScope", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = originalHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("returns ${HOME}/.claude for --scope user", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "qualy-scope-home-"));
    try {
      process.env.HOME = fakeHome;
      const got = resolveScope("user", "/some/irrelevant/cwd");
      expect(got).toEqual({
        root: join(fakeHome, ".claude"),
        scope: "user",
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns ${cwd}/.claude for --scope project when .git/ exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-scope-project-"));
    try {
      mkdirSync(join(tmp, ".git"));
      const got = resolveScope("project", tmp);
      expect(got).toEqual({
        root: join(tmp, ".claude"),
        scope: "project",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns ${cwd}/.claude for --scope local without requiring .git/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-scope-local-"));
    try {
      const got = resolveScope("local", tmp);
      expect(got).toEqual({
        root: join(tmp, ".claude"),
        scope: "local",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws RecoverableError when HOME is undefined for --scope user", () => {
    delete process.env.HOME;
    expect(() => resolveScope("user", "/tmp")).toThrowError(RecoverableError);
    process.env.HOME = originalHome;
  });

  it("throws RecoverableError when HOME is the empty string for --scope user", () => {
    process.env.HOME = "";
    expect(() => resolveScope("user", "/tmp")).toThrow(
      /HOME undefined.*--scope user/,
    );
  });

  it("rejects cwd that resolves to filesystem root '/'", () => {
    expect(() => resolveScope("local", sep)).toThrowError(RecoverableError);
    expect(() => resolveScope("local", sep)).toThrow(
      /refusing to install at filesystem root/,
    );
  });

  it("rejects cwd containing '..' segments", () => {
    expect(() => resolveScope("local", "../../etc")).toThrowError(
      RecoverableError,
    );
    expect(() => resolveScope("local", "../../etc")).toThrow(
      /must not contain "\.\." segments/,
    );
  });

  it("--scope project without .git/ surfaces the --scope local suggestion", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-scope-nogit-"));
    try {
      const fail = () => resolveScope("project", tmp);
      expect(fail).toThrowError(RecoverableError);
      expect(fail).toThrow(/--scope local/);
      expect(fail).toThrow(/requires a git repo/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
