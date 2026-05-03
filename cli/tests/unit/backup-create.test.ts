/**
 * Contract tests for `backup-create` (IMPLEMENTATION_PLAN.md Phase 3).
 *
 * What is locked:
 *   - `.lint-backup/<timestamp>/` layout with the source's directory tree
 *     preserved underneath (so `backup-restore` can put each file back
 *     byte-for-byte at its original location — SPEC §7.2 acceptance).
 *   - Timestamp is filesystem-safe (`:` and `.` replaced by `-`) so the
 *     directory name works on Windows too.
 *   - Manifest entries recorded with `kind: "backup"` (one per file).
 *   - Sources are validated up-front: missing source → `file_not_found`
 *     before any write hits the disk (atomic-ish in the common case).
 *   - `--strict` propagates to `safeWriteFile` (DIRTY_TREE).
 *   - Argument parser rejects malformed `--files` JSON.
 *   - Idempotency: re-running with the same `--ts` overwrites byte-for-byte
 *     and the manifest still has one entry per backup path.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  backupCreate,
  parseBackupCreateArgs,
  toSafeTimestamp,
} from "../../src/commands/backup/create.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function joinAbs(...parts: string[]): string {
  return [ROOT, ...parts].join(sep);
}

function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
} {
  // Keys are absolute paths in OS-native separator form (matches what
  // safeWriteFile / backupCreate produce).
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.123Z");
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

function loadManifestFromMemory(io: { files: Map<string, string> }): Manifest | null {
  const raw = io.files.get(joinAbs(MANIFEST_FILENAME));
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

function fakeNow(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

describe("toSafeTimestamp", () => {
  it("replaces colons and dots in the ISO string", () => {
    expect(toSafeTimestamp(new Date("2026-05-03T12:30:45.123Z"))).toBe(
      "2026-05-03T12-30-45-123Z",
    );
  });

  it("is sortable lexically across hours/days", () => {
    const earlier = toSafeTimestamp(new Date("2026-05-03T12:00:00.000Z"));
    const later = toSafeTimestamp(new Date("2026-05-03T12:00:01.000Z"));
    expect(later > earlier).toBe(true);
  });

  it("contains no characters invalid on Windows", () => {
    const ts = toSafeTimestamp(new Date("2026-05-03T12:30:45.123Z"));
    expect(ts).not.toContain(":");
    expect(ts).not.toContain(".");
    // `-T-Z` are all valid on every common filesystem.
    expect(ts).toMatch(/^[\w-]+Z$/);
  });
});

describe("backupCreate — happy path", () => {
  it("snapshots a single file into .lint-backup/<ts>/", () => {
    const io = memoryIO({
      [joinAbs(".eslintrc.json")]: '{"extends":["eslint:recommended"]}',
    });
    const r = backupCreate(
      { cwd: ROOT, files: [".eslintrc.json"] },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:00.123Z") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timestamp).toBe("2026-05-03T12-00-00-123Z");
    expect(r.dir).toBe(".lint-backup/2026-05-03T12-00-00-123Z");
    expect(r.backed_up).toHaveLength(1);
    expect(r.backed_up[0]?.src).toBe(".eslintrc.json");
    expect(r.backed_up[0]?.dest).toBe(".lint-backup/2026-05-03T12-00-00-123Z/.eslintrc.json");
    expect(r.backed_up[0]?.bytes).toBe(
      Buffer.byteLength('{"extends":["eslint:recommended"]}', "utf8"),
    );

    const written = io.files.get(
      joinAbs(".lint-backup", "2026-05-03T12-00-00-123Z", ".eslintrc.json"),
    );
    expect(written).toBe('{"extends":["eslint:recommended"]}');
  });

  it("preserves nested directory structure", () => {
    const io = memoryIO({
      [joinAbs("config", "lint", "rules.json")]: '{"foo":1}',
      [joinAbs("package.json")]: '{"name":"demo"}',
    });
    const r = backupCreate(
      { cwd: ROOT, files: ["config/lint/rules.json", "package.json"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
        now: fakeNow("2026-05-03T12:00:00.000Z"),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backed_up.map((e) => e.dest).sort()).toEqual([
      ".lint-backup/2026-05-03T12-00-00-000Z/config/lint/rules.json",
      ".lint-backup/2026-05-03T12-00-00-000Z/package.json",
    ]);
    expect(
      io.files.get(
        joinAbs(".lint-backup", "2026-05-03T12-00-00-000Z", "config", "lint", "rules.json"),
      ),
    ).toBe('{"foo":1}');
  });

  it("records a manifest entry per file with kind=backup", () => {
    const io = memoryIO({
      [joinAbs(".eslintrc.json")]: "a",
      [joinAbs(".prettierrc")]: "b",
    });
    backupCreate(
      { cwd: ROOT, files: [".eslintrc.json", ".prettierrc"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
        now: fakeNow("2026-05-03T12:00:00.000Z"),
      },
    );
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual([
      ".lint-backup/2026-05-03T12-00-00-000Z/.eslintrc.json",
      ".lint-backup/2026-05-03T12-00-00-000Z/.prettierrc",
    ]);
    for (const e of m.entries) {
      expect(e.kind).toBe("backup");
      expect(e.merged).toBeUndefined();
    }
  });

  it("honors an explicit --ts override", () => {
    const io = memoryIO({ [joinAbs("a.txt")]: "A" });
    const r = backupCreate(
      { cwd: ROOT, files: ["a.txt"], timestamp: "fixed-ts" },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:00.000Z") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timestamp).toBe("fixed-ts");
    expect(r.dir).toBe(".lint-backup/fixed-ts");
    expect(io.files.get(joinAbs(".lint-backup", "fixed-ts", "a.txt"))).toBe("A");
  });

  it("derives a fresh timestamp from now when no override is given", () => {
    const io = memoryIO({ [joinAbs("a.txt")]: "A" });
    const r = backupCreate(
      { cwd: ROOT, files: ["a.txt"] },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-12-31T23:59:59.999Z") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.timestamp).toBe("2026-12-31T23-59-59-999Z");
  });
});

describe("backupCreate — error paths", () => {
  it("fails files_empty when no files are passed", () => {
    const io = memoryIO();
    const r = backupCreate({ cwd: ROOT, files: [] }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("files_empty");
    expect(io.files.size).toBe(0);
  });

  it("fails files_invalid on a non-string entry", () => {
    const io = memoryIO();
    const r = backupCreate(
      // Force-cast to exercise runtime guard (typing forbids this in TS).
      { cwd: ROOT, files: ["", "a.txt"] as readonly string[] },
      { existsFn: io.existsFn, safeIO: io },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("files_invalid");
  });

  it("rejects path escapes (path_invalid) without writing anything", () => {
    const io = memoryIO();
    const r = backupCreate(
      { cwd: ROOT, files: ["../outside.txt"] },
      { existsFn: io.existsFn, safeIO: io },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("path_invalid");
    expect(r.reason).toContain("../outside.txt");
    expect(io.files.size).toBe(0);
  });

  it("rejects absolute paths (path_invalid)", () => {
    const io = memoryIO();
    const r = backupCreate(
      { cwd: ROOT, files: [sep === "/" ? "/etc/passwd" : "C:\\Windows\\System32"] },
      { existsFn: io.existsFn, safeIO: io },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("path_invalid");
  });

  it("fails file_not_found before any write when a source is missing", () => {
    const io = memoryIO({ [joinAbs("present.txt")]: "x" });
    const r = backupCreate(
      { cwd: ROOT, files: ["present.txt", "missing.txt"] },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
        now: fakeNow("2026-05-03T12:00:00.000Z"),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("file_not_found");
    expect(r.reason).toBe("missing.txt");
    // No backup file was written for the present source either — the
    // up-front validation guarantees all-or-nothing.
    expect(
      io.files.has(joinAbs(".lint-backup", "2026-05-03T12-00-00-000Z", "present.txt")),
    ).toBe(false);
  });

  it("surfaces read_failed when readFileFn throws", () => {
    const io = memoryIO({ [joinAbs("a.txt")]: "x" });
    const r = backupCreate(
      { cwd: ROOT, files: ["a.txt"] },
      {
        existsFn: io.existsFn,
        readFileFn: () => {
          throw new Error("EACCES");
        },
        safeIO: io,
        now: fakeNow("2026-05-03T12:00:00.000Z"),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("read_failed");
    expect(r.reason).toContain("EACCES");
  });

  it("surfaces write_failed (DIRTY_TREE) when --strict and tree is dirty", () => {
    const io: SafeIO & { files: Map<string, string> } = {
      ...memoryIO({ [joinAbs("a.txt")]: "x" }),
      dirtyFilesFn: () => ({ ok: true, value: ["src/a.ts"] }),
    };
    const r = backupCreate(
      { cwd: ROOT, files: ["a.txt"], strict: true },
      {
        existsFn: io.existsFn,
        readFileFn: (p) => io.files.get(p) ?? "",
        safeIO: io,
        now: fakeNow("2026-05-03T12:00:00.000Z"),
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });
});

describe("backupCreate — idempotency", () => {
  it("re-running with the same --ts replaces bytes and keeps one manifest entry per path", () => {
    const io = memoryIO({ [joinAbs("a.txt")]: "v1" });
    backupCreate(
      { cwd: ROOT, files: ["a.txt"], timestamp: "ts1" },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:00.000Z") },
    );
    // Mutate the source and re-run with the same --ts.
    io.files.set(joinAbs("a.txt"), "v2");
    backupCreate(
      { cwd: ROOT, files: ["a.txt"], timestamp: "ts1" },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:00.000Z") },
    );

    expect(io.files.get(joinAbs(".lint-backup", "ts1", "a.txt"))).toBe("v2");
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const matching = m.entries.filter((e) => e.path === ".lint-backup/ts1/a.txt");
    expect(matching).toHaveLength(1);
    expect(matching[0]?.kind).toBe("backup");
  });

  it("default timestamps differ across calls, so backups accumulate", () => {
    const io = memoryIO({ [joinAbs("a.txt")]: "x" });
    backupCreate(
      { cwd: ROOT, files: ["a.txt"] },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:00.000Z") },
    );
    backupCreate(
      { cwd: ROOT, files: ["a.txt"] },
      { existsFn: io.existsFn, readFileFn: (p) => io.files.get(p) ?? "", safeIO: io, now: fakeNow("2026-05-03T12:00:01.000Z") },
    );
    expect(io.files.has(joinAbs(".lint-backup", "2026-05-03T12-00-00-000Z", "a.txt"))).toBe(true);
    expect(io.files.has(joinAbs(".lint-backup", "2026-05-03T12-00-01-000Z", "a.txt"))).toBe(true);

    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const backupEntries = m.entries.filter((e) => e.kind === "backup");
    expect(backupEntries).toHaveLength(2);
  });
});

describe("parseBackupCreateArgs", () => {
  it("requires --files", () => {
    const r = parseBackupCreateArgs([], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("missing --files");
  });

  it("parses --files JSON array of strings", () => {
    const r = parseBackupCreateArgs(
      ["--files", '[".eslintrc.json","package.json"]'],
      "/wd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files).toEqual([".eslintrc.json", "package.json"]);
    expect(r.value.cwd).toBe("/wd");
    expect(r.value.strict).toBe(false);
    expect(r.value.timestamp).toBeUndefined();
  });

  it("parses --cwd, --ts, --strict in any order", () => {
    const r = parseBackupCreateArgs(
      [
        "--strict",
        "--ts",
        "fixed-ts",
        "--cwd",
        "/proj",
        "--files",
        '["a.txt"]',
      ],
      "/wd",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
    expect(r.value.timestamp).toBe("fixed-ts");
    expect(r.value.strict).toBe(true);
    expect(r.value.files).toEqual(["a.txt"]);
  });

  it("rejects malformed --files JSON", () => {
    const r = parseBackupCreateArgs(["--files", "not json"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("invalid --files JSON");
  });

  it("rejects --files non-array", () => {
    const r = parseBackupCreateArgs(["--files", '{"a":"b"}'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("must be a JSON array of strings");
  });

  it("rejects --files array with non-string element", () => {
    const r = parseBackupCreateArgs(["--files", '["a", 1]'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects --files array with empty string", () => {
    const r = parseBackupCreateArgs(["--files", '["a", ""]'], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("non-empty strings");
  });

  it("rejects missing values for --cwd / --files / --ts", () => {
    expect(parseBackupCreateArgs(["--cwd"], "/wd").ok).toBe(false);
    expect(parseBackupCreateArgs(["--files"], "/wd").ok).toBe(false);
    expect(parseBackupCreateArgs(["--ts"], "/wd").ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseBackupCreateArgs(["--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseBackupCreateArgs(["--help"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
    expect(parseBackupCreateArgs(["-h"], "/wd")).toEqual({
      ok: false,
      error: "help",
    });
  });
});
