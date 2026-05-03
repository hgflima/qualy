/**
 * Contract tests for `backup-list` (IMPLEMENTATION_PLAN.md Phase 3).
 *
 * What is locked:
 *   - Source of truth is `.lint-manifest.json` entries with `kind === "backup"`.
 *   - Output groups files by timestamp (extracted from `.lint-backup/<ts>/<src>`).
 *   - Backups are sorted most-recent first (lexical descending on the safe
 *     timestamp produced by `toSafeTimestamp`).
 *   - Files inside a single backup are sorted by `src` for deterministic output.
 *   - `present` reflects an FS check on the backup destination — robust to
 *     manual deletion under `.lint-backup/`.
 *   - Missing or malformed manifest → `{ok:true, backups:[]}` (read-only never
 *     fails on absence).
 *   - Non-backup manifest entries (preset/hook/scripts/...) are ignored.
 *   - Argument parser rejects unknown flags via USAGE_ERROR.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { backupCreate } from "../../src/commands/backup/create.ts";
import {
  backupList,
  parseBackupListArgs,
} from "../../src/commands/backup/list.ts";
import {
  type SafeIO,
  recordEntry,
} from "../../src/lib/fs-safe.ts";

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

describe("backupList — empty / absent manifest", () => {
  it("returns ok with empty backups when no manifest exists", () => {
    const io = memoryIO();
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.cwd).toBe(ROOT);
    expect(r.backups).toEqual([]);
  });

  it("returns empty when manifest exists but has no backup entries", () => {
    const io = memoryIO();
    recordEntry(
      ROOT,
      { path: "oxlint.fast.json", kind: "preset", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups).toEqual([]);
  });

  it("returns empty when manifest is malformed", () => {
    const io = memoryIO({ [joinAbs(".lint-manifest.json")]: "{ not json" });
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups).toEqual([]);
  });
});

describe("backupList — happy path", () => {
  it("groups files of one backup by timestamp", () => {
    const io = memoryIO();
    seedBackup(
      io,
      { ".eslintrc.json": "{}", ".prettierrc": "x" },
      "2026-05-03T12-00-00-000Z",
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups).toHaveLength(1);
    const [b] = r.backups;
    expect(b?.timestamp).toBe("2026-05-03T12-00-00-000Z");
    expect(b?.dir).toBe(".lint-backup/2026-05-03T12-00-00-000Z");
    expect(b?.files.map((f) => f.src)).toEqual([".eslintrc.json", ".prettierrc"]);
    for (const f of b!.files) {
      expect(f.dest).toBe(`.lint-backup/2026-05-03T12-00-00-000Z/${f.src}`);
      expect(f.present).toBe(true);
    }
  });

  it("preserves nested directory structure in src", () => {
    const io = memoryIO();
    seedBackup(
      io,
      { "config/lint/rules.json": '{"foo":1}', "package.json": '{"name":"demo"}' },
      "2026-05-03T12-00-00-000Z",
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups[0]?.files.map((f) => f.src)).toEqual([
      "config/lint/rules.json",
      "package.json",
    ]);
  });

  it("sorts backups most-recent first across multiple timestamps", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A1" }, "2026-05-03T12-00-00-000Z");
    seedBackup(io, { "a.txt": "A2" }, "2026-05-04T08-15-00-000Z");
    seedBackup(io, { "a.txt": "A3" }, "2026-05-03T18-30-00-000Z");
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups.map((b) => b.timestamp)).toEqual([
      "2026-05-04T08-15-00-000Z",
      "2026-05-03T18-30-00-000Z",
      "2026-05-03T12-00-00-000Z",
    ]);
  });

  it("sorts files within a backup by src", () => {
    const io = memoryIO();
    seedBackup(
      io,
      { "z.txt": "Z", "a.txt": "A", "m.txt": "M" },
      "2026-05-03T12-00-00-000Z",
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups[0]?.files.map((f) => f.src)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });

  it("ignores non-backup manifest entries", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A" }, "2026-05-03T12-00-00-000Z");
    recordEntry(
      ROOT,
      { path: "oxlint.fast.json", kind: "preset", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: "package.json",
        kind: "scripts",
        merged: true,
        created_at: "2026-05-03T12:00:00.000Z",
      },
      io,
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups).toHaveLength(1);
    expect(r.backups[0]?.files).toHaveLength(1);
    expect(r.backups[0]?.files[0]?.src).toBe("a.txt");
  });
});

describe("backupList — FS presence check", () => {
  it("reports present:false when the backup file was deleted from disk", () => {
    const io = memoryIO();
    seedBackup(io, { "a.txt": "A", "b.txt": "B" }, "2026-05-03T12-00-00-000Z");
    // Manually remove one of the backup files from the in-memory FS.
    io.files.delete(joinAbs(".lint-backup", "2026-05-03T12-00-00-000Z", "a.txt"));
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    const files = r.backups[0]?.files ?? [];
    expect(files.find((f) => f.src === "a.txt")?.present).toBe(false);
    expect(files.find((f) => f.src === "b.txt")?.present).toBe(true);
  });
});

describe("backupList — defensive splitter", () => {
  it("ignores backup-kind entries with malformed paths", () => {
    const io = memoryIO();
    // Inject manifest entries with kind:"backup" but bogus paths.
    recordEntry(
      ROOT,
      { path: "not-under-prefix.txt", kind: "backup", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    recordEntry(
      ROOT,
      { path: ".lint-backup/", kind: "backup", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    recordEntry(
      ROOT,
      { path: ".lint-backup/onlydir/", kind: "backup", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    recordEntry(
      ROOT,
      { path: ".lint-backup/no-slash-after-ts", kind: "backup", created_at: "2026-05-03T12:00:00.000Z" },
      io,
    );
    const r = backupList({ cwd: ROOT }, { safeIO: io, existsFn: io.existsFn });
    expect(r.ok).toBe(true);
    expect(r.backups).toEqual([]);
  });
});

describe("parseBackupListArgs", () => {
  it("defaults cwd to defaultCwd when no flags", () => {
    const r = parseBackupListArgs([], "/default/cwd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/default/cwd");
  });

  it("parses --cwd", () => {
    const r = parseBackupListArgs(["--cwd", "/proj"], "/default");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
  });

  it("rejects unknown flag", () => {
    const r = parseBackupListArgs(["--zonk"], "/default");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("rejects --cwd missing value", () => {
    const r = parseBackupListArgs(["--cwd"], "/default");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("missing value for --cwd");
  });

  it("returns help sentinel on --help and -h", () => {
    expect(parseBackupListArgs(["--help"], "/d").ok).toBe(false);
    expect(parseBackupListArgs(["-h"], "/d").ok).toBe(false);
  });
});
