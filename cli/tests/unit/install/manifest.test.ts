import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteManifest,
  type Manifest,
  manifestPath,
  readManifest,
  writeManifest,
} from "../../../src/install/manifest.ts";

const sampleManifest = (): Manifest => ({
  version: "1",
  scope: "local",
  harness_version: "0.1.0",
  installer: "npx",
  installed_at: "2026-05-04T00:00:00.000Z",
  entries: [
    {
      path: "skills/lint/SKILL.md",
      sha256: "a".repeat(64),
      kind: "skill",
    },
    {
      path: "commands/lint.md",
      sha256: "b".repeat(64),
      kind: "command",
    },
  ],
});

describe("manifest", () => {
  let scopeRoot: string;

  beforeEach(() => {
    scopeRoot = mkdtempSync(join(tmpdir(), "qualy-manifest-"));
  });

  afterEach(() => {
    rmSync(scopeRoot, { recursive: true, force: true });
  });

  it("round-trips read/write", () => {
    const m = sampleManifest();
    writeManifest(scopeRoot, m);
    const got = readManifest(scopeRoot);
    expect(got).toEqual(m);
  });

  it("readManifest returns null when the file is absent", () => {
    expect(readManifest(scopeRoot)).toBeNull();
  });

  it("deleteManifest is idempotent (two calls in a row do not throw)", () => {
    writeManifest(scopeRoot, sampleManifest());
    deleteManifest(scopeRoot);
    expect(() => deleteManifest(scopeRoot)).not.toThrow();
    expect(readManifest(scopeRoot)).toBeNull();
  });

  it("readManifest throws a clear error when the manifest has no scope field", () => {
    // Simulate the legacy lint-stack manifest format (no `scope` key).
    const legacy = {
      version: "1",
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T00:00:00.000Z",
      entries: [],
    };
    writeFileSync(manifestPath(scopeRoot), JSON.stringify(legacy), "utf8");
    expect(() => readManifest(scopeRoot)).toThrow(/no "scope" field/);
    expect(() => readManifest(scopeRoot)).toThrow(/lint-stack manifest/);
  });

  it("readManifest throws when the file contains invalid JSON", () => {
    writeFileSync(manifestPath(scopeRoot), "{not json", "utf8");
    expect(() => readManifest(scopeRoot)).toThrow(/not valid JSON/);
  });

  it("writeManifest surfaces the OS error when the target directory does not exist", () => {
    const missing = join(scopeRoot, "does", "not", "exist");
    expect(() => writeManifest(missing, sampleManifest())).toThrow(/ENOENT/);
  });

  it("writeManifest produces a stable JSON payload (pretty-printed, trailing newline)", () => {
    const m = sampleManifest();
    writeManifest(scopeRoot, m);
    const onDisk = readFileSync(manifestPath(scopeRoot), "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(JSON.parse(onDisk)).toEqual(m);
  });
});
