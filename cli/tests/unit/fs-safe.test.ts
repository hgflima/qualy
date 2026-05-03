import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  type Manifest,
  type SafeIO,
  deleteManifest,
  loadManifest,
  manifestPath,
  recordEntry,
  removeEntry,
  resolveSafePath,
  safeWriteFile,
  setManifestField,
} from "../../src/lib/fs-safe.ts";
import { stringifyPretty } from "../../src/lib/json.ts";

/**
 * In-memory IO for unit tests. Mirrors the SafeIO seam so each helper can run
 * without touching disk. Path keys are absolute (consistent with how the
 * production helpers call into io.*Fn).
 */
function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
  fixedNow: Date;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
    fixedNow,
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      files.set(p, c);
    },
    mkdirFn: () => {
      /* in-memory: nothing to create */
    },
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => fixedNow,
  };
}

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

describe("resolveSafePath", () => {
  it("rejects empty path", () => {
    const r = resolveSafePath(ROOT, "");
    expect(r.ok).toBe(false);
  });

  it("rejects absolute path", () => {
    const r = resolveSafePath(ROOT, sep === "/" ? "/etc/passwd" : "C:\\Windows\\System32");
    expect(r.ok).toBe(false);
  });

  it("rejects path that escapes cwd via ..", () => {
    const r = resolveSafePath(ROOT, "../escape.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("escape");
  });

  it("rejects path that escapes cwd via embedded ..", () => {
    const r = resolveSafePath(ROOT, "subdir/../../escape.txt");
    expect(r.ok).toBe(false);
  });

  it("rejects path resolving to cwd itself", () => {
    expect(resolveSafePath(ROOT, ".").ok).toBe(false);
    expect(resolveSafePath(ROOT, "./").ok).toBe(false);
  });

  it("accepts normal relative path", () => {
    const r = resolveSafePath(ROOT, "oxlint.fast.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ROOT, "oxlint.fast.json"));
  });

  it("accepts nested relative path", () => {
    const r = resolveSafePath(ROOT, ".claude/hooks/post-edit.sh");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ROOT, ".claude", "hooks", "post-edit.sh"));
  });
});

describe("safeWriteFile", () => {
  it("writes a file, creates manifest entry, and reports bytes", () => {
    const io = memoryIO();
    const r = safeWriteFile(ROOT, "oxlint.fast.json", '{"a":1}', { kind: "preset" }, io);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe("oxlint.fast.json");
    expect(r.value.bytes).toBe(7);
    expect(r.value.recorded).toBe(true);
    expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe('{"a":1}');

    const m = loadManifest(ROOT, io);
    expect(m).not.toBeNull();
    expect(m?.entries).toHaveLength(1);
    expect(m?.entries[0]).toEqual({
      path: "oxlint.fast.json",
      kind: "preset",
      created_at: io.fixedNow.toISOString(),
    });
  });

  it("does not record the manifest file itself", () => {
    const io = memoryIO();
    const r = safeWriteFile(
      ROOT,
      MANIFEST_FILENAME,
      stringifyPretty({ version: MANIFEST_VERSION, entries: [] }),
      {},
      io,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recorded).toBe(false);
  });

  it("normalizes nested paths to POSIX in the manifest", () => {
    const io = memoryIO();
    const r = safeWriteFile(
      ROOT,
      join(".claude", "hooks", "post-edit.sh"),
      "#!/usr/bin/env bash\n",
      { kind: "hook", mode: 0o755 },
      io,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe(".claude/hooks/post-edit.sh");
    const m = loadManifest(ROOT, io);
    expect(m?.entries[0]?.path).toBe(".claude/hooks/post-edit.sh");
  });

  it("is idempotent: re-writing the same path keeps a single entry", () => {
    const io = memoryIO();
    safeWriteFile(ROOT, "oxlint.fast.json", '{"a":1}', { kind: "preset" }, io);
    safeWriteFile(ROOT, "oxlint.fast.json", '{"a":2}', { kind: "preset" }, io);
    const m = loadManifest(ROOT, io);
    expect(m?.entries).toHaveLength(1);
    expect(io.files.get(join(ROOT, "oxlint.fast.json"))).toBe('{"a":2}');
  });

  it("records the merged flag when set", () => {
    const io = memoryIO();
    const r = safeWriteFile(
      ROOT,
      "package.json",
      '{"scripts":{"lint":"oxlint"}}',
      { kind: "scripts", merged: true },
      io,
    );
    expect(r.ok).toBe(true);
    const m = loadManifest(ROOT, io);
    expect(m?.entries[0]?.merged).toBe(true);
  });

  it("defaults kind to 'other' when not provided", () => {
    const io = memoryIO();
    safeWriteFile(ROOT, "x.txt", "hi", {}, io);
    const m = loadManifest(ROOT, io);
    expect(m?.entries[0]?.kind).toBe("other");
  });

  it("rejects writes to absolute paths without writing", () => {
    const io = memoryIO();
    const target = sep === "/" ? "/etc/oxlint.fast.json" : "C:\\Windows\\oxlint.fast.json";
    const r = safeWriteFile(ROOT, target, "x", {}, io);
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it("rejects writes that escape cwd without writing", () => {
    const io = memoryIO();
    const r = safeWriteFile(ROOT, "../outside.txt", "x", {}, io);
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it("under strict, refuses to write when working tree is dirty", () => {
    const io = memoryIO();
    const dirtyIO: SafeIO = {
      ...io,
      dirtyFilesFn: () => ({ ok: true, value: ["src/foo.ts"] }),
    };
    const r = safeWriteFile(ROOT, "oxlint.fast.json", "{}", { strict: true }, dirtyIO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("dirty");
    expect(io.files.size).toBe(0);
  });

  it("under strict, surfaces git-check failure", () => {
    const io = memoryIO();
    const failIO: SafeIO = {
      ...io,
      dirtyFilesFn: () => ({ ok: false, error: "not a git repository" }),
    };
    const r = safeWriteFile(ROOT, "oxlint.fast.json", "{}", { strict: true }, failIO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("git check failed");
  });

  it("under strict on a clean tree, writes and records", () => {
    const io = memoryIO();
    const cleanIO: SafeIO = {
      ...io,
      dirtyFilesFn: () => ({ ok: true, value: [] }),
    };
    const r = safeWriteFile(ROOT, "oxlint.fast.json", "{}", { strict: true, kind: "preset" }, cleanIO);
    expect(r.ok).toBe(true);
    expect(io.files.has(join(ROOT, "oxlint.fast.json"))).toBe(true);
  });

  it("returns an error result instead of throwing when the writer throws", () => {
    const io = memoryIO();
    const erroringIO: SafeIO = {
      ...io,
      writeFileFn: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const r = safeWriteFile(ROOT, "oxlint.fast.json", "{}", {}, erroringIO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("EACCES");
  });
});

describe("loadManifest", () => {
  it("returns null when manifest file is absent", () => {
    const io = memoryIO();
    expect(loadManifest(ROOT, io)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const io = memoryIO({ [manifestPath(ROOT)]: "{ not json" });
    expect(loadManifest(ROOT, io)).toBeNull();
  });

  it("returns null when version mismatch", () => {
    const io = memoryIO({
      [manifestPath(ROOT)]: stringifyPretty({ version: "999", entries: [] }),
    });
    expect(loadManifest(ROOT, io)).toBeNull();
  });

  it("drops entries that fail shape validation", () => {
    const raw: Manifest & { entries: unknown[] } = {
      version: MANIFEST_VERSION,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      entries: [
        { path: "good.json", kind: "preset", created_at: "2026-01-01T00:00:00.000Z" },
        { path: 42, kind: "preset", created_at: "x" },
        null,
        "string",
        { path: "missing-kind", created_at: "x" },
      ],
    };
    const io = memoryIO({ [manifestPath(ROOT)]: stringifyPretty(raw) });
    const m = loadManifest(ROOT, io);
    expect(m).not.toBeNull();
    expect(m?.entries).toHaveLength(1);
    expect(m?.entries[0]?.path).toBe("good.json");
  });

  it("preserves the theme field when string", () => {
    const raw: Manifest = {
      version: MANIFEST_VERSION,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      theme: "linear-design-md",
      entries: [],
    };
    const io = memoryIO({ [manifestPath(ROOT)]: stringifyPretty(raw) });
    expect(loadManifest(ROOT, io)?.theme).toBe("linear-design-md");
  });

  it("ignores non-string theme", () => {
    const raw = {
      version: MANIFEST_VERSION,
      created_at: "x",
      updated_at: "x",
      theme: 42,
      entries: [],
    };
    const io = memoryIO({ [manifestPath(ROOT)]: stringifyPretty(raw) });
    expect(loadManifest(ROOT, io)?.theme).toBeUndefined();
  });
});

describe("removeEntry / setManifestField / deleteManifest", () => {
  it("removeEntry removes the matching entry and updates timestamp", () => {
    const io = memoryIO();
    safeWriteFile(ROOT, "a.json", "{}", { kind: "preset" }, io);
    safeWriteFile(ROOT, "b.json", "{}", { kind: "preset" }, io);
    expect(loadManifest(ROOT, io)?.entries).toHaveLength(2);
    removeEntry(ROOT, "a.json", io);
    const m = loadManifest(ROOT, io);
    expect(m?.entries).toHaveLength(1);
    expect(m?.entries[0]?.path).toBe("b.json");
  });

  it("removeEntry is a no-op when manifest is missing or path is unknown", () => {
    const io = memoryIO();
    removeEntry(ROOT, "nope.json", io);
    expect(io.files.size).toBe(0);

    safeWriteFile(ROOT, "a.json", "{}", {}, io);
    const before = io.files.get(manifestPath(ROOT));
    removeEntry(ROOT, "nope.json", io);
    expect(io.files.get(manifestPath(ROOT))).toBe(before);
  });

  it("setManifestField creates the manifest when absent", () => {
    const io = memoryIO();
    setManifestField(ROOT, { theme: "linear-design-md" }, io);
    const m = loadManifest(ROOT, io);
    expect(m?.theme).toBe("linear-design-md");
    expect(m?.entries).toEqual([]);
  });

  it("setManifestField patches without losing entries", () => {
    const io = memoryIO();
    safeWriteFile(ROOT, "a.json", "{}", { kind: "preset" }, io);
    setManifestField(ROOT, { theme: "linear-design-md" }, io);
    const m = loadManifest(ROOT, io);
    expect(m?.theme).toBe("linear-design-md");
    expect(m?.entries).toHaveLength(1);
  });

  it("deleteManifest removes the file and is idempotent", () => {
    const io = memoryIO();
    safeWriteFile(ROOT, "a.json", "{}", {}, io);
    expect(io.files.has(manifestPath(ROOT))).toBe(true);
    deleteManifest(ROOT, io);
    expect(io.files.has(manifestPath(ROOT))).toBe(false);
    deleteManifest(ROOT, io); // no throw
    expect(io.files.has(manifestPath(ROOT))).toBe(false);
  });
});

describe("integration on real filesystem", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function makeTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "qualy-fs-safe-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("creates parent directories and writes the file under cwd", () => {
    const dir = makeTmp();
    const r = safeWriteFile(dir, ".claude/hooks/post-edit.sh", "#!/usr/bin/env bash\n", {
      kind: "hook",
      mode: 0o755,
    });
    expect(r.ok).toBe(true);
    const m = loadManifest(dir);
    expect(m?.entries[0]?.path).toBe(".claude/hooks/post-edit.sh");
    expect(m?.entries[0]?.kind).toBe("hook");
  });

  it("survives multiple writes and reflects them in the manifest", () => {
    const dir = makeTmp();
    safeWriteFile(dir, "oxlint.fast.json", "{}", { kind: "preset" });
    safeWriteFile(dir, "oxlint.deep.json", "{}", { kind: "preset" });
    const m = loadManifest(dir);
    expect(m?.entries.map((e) => e.path).sort()).toEqual([
      "oxlint.deep.json",
      "oxlint.fast.json",
    ]);
  });
});
