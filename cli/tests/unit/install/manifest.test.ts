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

  it("readManifest throws when the JSON payload is `null`", () => {
    writeFileSync(manifestPath(scopeRoot), "null", "utf8");
    expect(() => readManifest(scopeRoot)).toThrow(/not a JSON object/);
  });

  it("readManifest throws when the JSON payload is a primitive (string)", () => {
    writeFileSync(manifestPath(scopeRoot), JSON.stringify("plain"), "utf8");
    expect(() => readManifest(scopeRoot)).toThrow(/not a JSON object/);
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

  it("round-trips a manifest entry with kind=runtime-node-modules", () => {
    const m: Manifest = {
      ...sampleManifest(),
      entries: [
        {
          path: "skills/lint/node_modules",
          sha256: "",
          kind: "runtime-node-modules",
        },
      ],
    };
    writeManifest(scopeRoot, m);
    const got = readManifest(scopeRoot);
    expect(got).toEqual(m);
    expect(got?.entries[0]?.kind).toBe("runtime-node-modules");
  });

  it("reads a legacy v0.3.3 manifest with no runtime entry without throwing", () => {
    const legacy = {
      version: "1",
      scope: "local",
      harness_version: "0.3.3",
      installer: "npx",
      installed_at: "2026-04-01T00:00:00.000Z",
      entries: [
        {
          path: "skills/lint/SKILL.md",
          sha256: "a".repeat(64),
          kind: "skill",
        },
      ],
    };
    writeFileSync(manifestPath(scopeRoot), JSON.stringify(legacy), "utf8");
    const got = readManifest(scopeRoot);
    expect(got?.harness_version).toBe("0.3.3");
    expect(got?.entries).toHaveLength(1);
    expect(
      got?.entries.some((e) => e.kind === "runtime-node-modules"),
    ).toBe(false);
  });

  it("readManifest tolerates an entry with an unknown kind without throwing", () => {
    // Locks in the forward-compat invariant: future kinds added in newer
    // versions must not break older CLIs that read the same manifest. The
    // reader does not validate the `kind` field — it returns the parsed
    // payload as-is.
    const future = {
      version: "1",
      scope: "local",
      harness_version: "9.9.9",
      installer: "npx",
      installed_at: "2030-01-01T00:00:00.000Z",
      entries: [
        {
          path: "skills/lint/future-thing",
          sha256: "c".repeat(64),
          kind: "future-unknown-kind",
        },
      ],
    };
    writeFileSync(manifestPath(scopeRoot), JSON.stringify(future), "utf8");
    expect(() => readManifest(scopeRoot)).not.toThrow();
    const got = readManifest(scopeRoot);
    expect(got?.entries[0]?.kind).toBe(
      "future-unknown-kind" as unknown as Manifest["entries"][number]["kind"],
    );
  });
});
