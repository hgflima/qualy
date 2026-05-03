/**
 * Contract tests for `backup-restore` (IMPLEMENTATION_PLAN.md Phase 3).
 *
 * What is locked:
 *   - Restores byte-for-byte from `.lint-backup/<ts>/<src>` to `<src>`
 *     (SPEC §7.2 acceptance — "/lint:rollback restaura byte-a-byte").
 *   - Source of truth is `.lint-manifest.json`; restore only acts on entries
 *     with `kind:"backup"` and matching timestamp.
 *   - Restored destinations are NOT recorded in the manifest (they are
 *     user-owned files; manifest tracks only qualy-owned writes).
 *   - `--files` subset filters to a subset of the backup; subset paths not
 *     in this backup → `subset_not_in_backup`.
 *   - Timestamp without backup entries → `timestamp_not_found`.
 *   - All backup files validated up-front; one missing → `backup_file_missing`
 *     and nothing is written (atomic-ish).
 *   - `--strict` propagates to `safeWriteFile` (DIRTY_TREE).
 *   - Argument parser rejects malformed input via USAGE_ERROR.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { backupCreate } from "../../src/commands/backup/create.ts";
import {
  backupRestore,
  parseBackupRestoreArgs,
} from "../../src/commands/backup/restore.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
  recordEntry,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function joinAbs(...parts: string[]): string {
  return [ROOT, ...parts].join(sep);
}

function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      files.set(p, c);
    },
    mkdirFn: () => {
      /* in-memory */
    },
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => fixedNow,
  };
}

function fakeNow(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

function loadManifestFromMemory(io: { files: Map<string, string> }): Manifest | null {
  const raw = io.files.get(joinAbs(MANIFEST_FILENAME));
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

function seedBackup(
  io: ReturnType<typeof memoryIO>,
  files: Record<string, string>,
  timestamp: string,
): void {
  for (const [path, content] of Object.entries(files)) {
    io.files.set(joinAbs(path), content);
  }
  const r = backupCreate(
    { cwd: ROOT, files: Object.keys(files), timestamp },
    {
      existsFn: io.existsFn,
      readFileFn: (p) => io.files.get(p) ?? "",
      safeIO: io,
      now: fakeNow("2026-05-03T12:00:00.000Z"),
    },
  );
  if (!r.ok) throw new Error(`seedBackup failed: ${r.error}`);
}

describe("backupRestore — happy path", () => {
  it("restores a single file byte-for-byte to its original location", () => {
    const io = memoryIO();
    seedBackup(io, { ".eslintrc.json": '{"foo":1}' }, "ts1");
    // Simulate the user mutating the original after the backup.
    io.files.set(joinAbs(".eslintrc.json"), '{"foo":2}');

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timestamp).toBe("ts1");
    expect(r.dir).toBe(".lint-backup/ts1");
    expect(r.restored).toHaveLength(1);
    expect(r.restored[0]?.src).toBe(".eslintrc.json");
    expect(r.restored[0]?.from).toBe(".lint-backup/ts1/.eslintrc.json");
    expect(r.restored[0]?.bytes).toBe(Buffer.byteLength('{"foo":1}', "utf8"));

    // Original location now carries the backed-up bytes.
    expect(io.files.get(joinAbs(".eslintrc.json"))).toBe('{"foo":1}');
  });

  it("preserves nested directory structure when restoring", () => {
    const io = memoryIO();
    seedBackup(
      io,
      { "config/lint/rules.json": '{"k":"v"}', "package.json": '{"n":"d"}' },
      "ts1",
    );
    // Wipe originals.
    io.files.delete(joinAbs("config", "lint", "rules.json"));
    io.files.delete(joinAbs("package.json"));

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored.map((e) => e.src).sort()).toEqual([
      "config/lint/rules.json",
      "package.json",
    ]);
    expect(io.files.get(joinAbs("config", "lint", "rules.json"))).toBe('{"k":"v"}');
    expect(io.files.get(joinAbs("package.json"))).toBe('{"n":"d"}');
  });

  it("does NOT add manifest entries for restored destinations", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B" }, "ts1");
    const before = loadManifestFromMemory(io);
    expect(before).not.toBeNull();
    const beforeEntries = before!.entries.map((e) => `${e.kind}:${e.path}`).sort();

    io.files.set(joinAbs("a.txt"), "MUTATED");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);

    const after = loadManifestFromMemory(io);
    expect(after).not.toBeNull();
    const afterEntries = after!.entries.map((e) => `${e.kind}:${e.path}`).sort();
    // Manifest contents are unchanged: only the two `kind:"backup"` entries
    // remain; no `kind:"other"` was written for the restored destinations.
    expect(afterEntries).toEqual(beforeEntries);
    for (const e of after!.entries) {
      expect(e.kind).toBe("backup");
      expect(e.path.startsWith(".lint-backup/")).toBe(true);
    }
  });

  it("picks the right backup when multiple timestamps exist", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "OLD" }, "ts1");
    seedBackup(io, { "a.txt": "NEW" }, "ts2");
    io.files.set(joinAbs("a.txt"), "MUTATED");

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored).toHaveLength(1);
    expect(io.files.get(joinAbs("a.txt"))).toBe("OLD");
  });

  it("ignores manifest entries with non-backup kinds and other timestamps", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "ts1");
    // Decoy entries — none should influence the restore.
    recordEntry(
      ROOT,
      { path: "oxlint.fast.json", kind: "preset", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: ".lint-backup/ts2/a.txt",
        kind: "backup",
        created_at: "2026-05-03T12:00:00.000Z",
      },
      io,
    );

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored).toHaveLength(1);
    expect(r.restored[0]?.src).toBe("a.txt");
  });

  it("orders restored entries deterministically by src", () => {
    const io = memoryIO();
    seedBackup(io, { "z.txt": "Z", "a.txt": "A", "m.txt": "M" }, "ts1");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored.map((e) => e.src)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});

describe("backupRestore — --files subset", () => {
  it("restores only the requested subset", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B", "c.txt": "C" }, "ts1");
    io.files.set(joinAbs("a.txt"), "MUT_A");
    io.files.set(joinAbs("b.txt"), "MUT_B");
    io.files.set(joinAbs("c.txt"), "MUT_C");

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1", files: ["a.txt", "c.txt"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored.map((e) => e.src)).toEqual(["a.txt", "c.txt"]);
    expect(io.files.get(joinAbs("a.txt"))).toBe("A");
    expect(io.files.get(joinAbs("b.txt"))).toBe("MUT_B"); // not restored
    expect(io.files.get(joinAbs("c.txt"))).toBe("C");
  });

  it("preserves the order of --files in the response", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B" }, "ts1");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1", files: ["b.txt", "a.txt"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored.map((e) => e.src)).toEqual(["b.txt", "a.txt"]);
  });

  it("rejects subset paths not in the backup (subset_not_in_backup)", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "ts1");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1", files: ["a.txt", "missing.txt"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("subset_not_in_backup");
    expect(r.reason).toContain("missing.txt");
    // Nothing was written — the up-front check happens before any restore.
    // (a.txt original is whatever seed wrote; we just confirm there's no
    // write for missing.txt.)
    expect(io.files.has(joinAbs("missing.txt"))).toBe(false);
  });

  it("treats empty --files array as 'restore all' (matches default)", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B" }, "ts1");
    io.files.set(joinAbs("a.txt"), "M");
    io.files.set(joinAbs("b.txt"), "M");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1", files: [] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restored.map((e) => e.src)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("backupRestore — error paths", () => {
  it("fails timestamp_empty on empty string", () => {
    const io = memoryIO();
    const r = backupRestore({ cwd: ROOT, timestamp: "" }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("timestamp_empty");
  });

  it("fails timestamp_not_found when manifest is absent", () => {
    const io = memoryIO();
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      { existsFn: io.existsFn, safeIO: io },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("timestamp_not_found");
    expect(r.reason).toBe("ts1");
  });

  it("fails timestamp_not_found when manifest exists but no matching backup entries", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "ts1");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "tsX" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("timestamp_not_found");
  });

  it("fails backup_file_missing if a backed-up file was deleted from disk", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B" }, "ts1");
    // Manually delete the on-disk backup for a.txt.
    io.files.delete(joinAbs(".lint-backup", "ts1", "a.txt"));

    io.files.set(joinAbs("a.txt"), "MUT_A");
    io.files.set(joinAbs("b.txt"), "MUT_B");

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("backup_file_missing");
    expect(r.reason).toBe(".lint-backup/ts1/a.txt");
    // Nothing was restored — atomic-ish guard.
    expect(io.files.get(joinAbs("a.txt"))).toBe("MUT_A");
    expect(io.files.get(joinAbs("b.txt"))).toBe("MUT_B");
  });

  it("surfaces read_failed when readFileFn throws", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "ts1");
    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1" },
      {
        existsFn: io.existsFn,
        readFileFn: () => {
          throw new Error("EACCES");
        },
        safeIO: io,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("read_failed");
    expect(r.reason).toContain("EACCES");
  });

  it("surfaces write_failed (DIRTY_TREE) when --strict and tree is dirty", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "ts1");
    // Override dirtyFilesFn after seeding so the seedBackup itself doesn't fail.
    io.dirtyFilesFn = () => ({ ok: true, value: ["src/x.ts"] });

    const r = backupRestore(
      { cwd: ROOT, timestamp: "ts1", strict: true },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });
});

describe("parseBackupRestoreArgs", () => {
  it("requires --ts", () => {
    const r = parseBackupRestoreArgs([], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("missing --ts");
  });

  it("parses --ts alone", () => {
    const r = parseBackupRestoreArgs(["--ts", "ts1"], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.timestamp).toBe("ts1");
    expect(r.value.cwd).toBe("/wd");
    expect(r.value.strict).toBe(false);
    expect(r.value.files).toBeUndefined();
  });

  it("parses --cwd, --ts, --files, --strict in any order", () => {
    const r = parseBackupRestoreArgs(
      [
        "--strict",
        "--files",
        '["a.txt"]',
        "--ts",
        "ts1",
        "--cwd",
        "/proj",
      ],
      "/wd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
    expect(r.value.timestamp).toBe("ts1");
    expect(r.value.strict).toBe(true);
    expect(r.value.files).toEqual(["a.txt"]);
  });

  it("rejects malformed --files JSON", () => {
    const r = parseBackupRestoreArgs(["--ts", "t", "--files", "not json"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid --files JSON");
  });

  it("rejects --files non-array", () => {
    const r = parseBackupRestoreArgs(["--ts", "t", "--files", '{"a":"b"}'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("must be a JSON array of strings");
  });

  it("rejects --files array with non-string element", () => {
    const r = parseBackupRestoreArgs(["--ts", "t", "--files", '["a", 1]'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects --files array with empty string", () => {
    const r = parseBackupRestoreArgs(["--ts", "t", "--files", '["a", ""]'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects missing values for --cwd / --ts / --files", () => {
    expect(parseBackupRestoreArgs(["--cwd"], "/wd").ok).toBe(false);
    expect(parseBackupRestoreArgs(["--ts"], "/wd").ok).toBe(false);
    expect(parseBackupRestoreArgs(["--files"], "/wd").ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseBackupRestoreArgs(["--ts", "t", "--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseBackupRestoreArgs(["--help"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseBackupRestoreArgs(["-h"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
  });
});
