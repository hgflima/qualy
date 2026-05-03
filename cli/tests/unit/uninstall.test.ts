/**
 * Contract tests for `uninstall` (IMPLEMENTATION_PLAN.md Phase 3).
 *
 * What is locked:
 *   - Manifest is the source of truth: only entries listed there are touched.
 *   - Owned files (kind ∈ {preset, hook, husky, lintstaged, decisions,
 *     template, other} with merged !== true) are deleted.
 *   - Backup files are deleted by default; `--keep-backup` preserves them
 *     and their manifest entries.
 *   - Merged files (merged === true) and virtual `dep` entries are NOT
 *     deleted; they are surfaced in `merged_kept` and remain in the
 *     rewritten manifest so a follow-up uninstall can still see them.
 *   - Manifest file is deleted when nothing remains; otherwise rewritten
 *     with the surviving entries.
 *   - `manifest_missing` (RECOVERABLE_ERROR) when the manifest is absent.
 *   - Argument parser accepts `--cwd` / `--keep-backup`, rejects unknown.
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseUninstallArgs,
  uninstall,
} from "../../src/commands/uninstall.ts";
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

function loadManifestFromMemory(io: { files: Map<string, string> }): Manifest | null {
  const raw = io.files.get(joinAbs(MANIFEST_FILENAME));
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

function seedFile(io: { files: Map<string, string> }, rel: string, content: string): void {
  io.files.set(joinAbs(...rel.split("/")), content);
}

const ISO = "2026-05-03T12:00:00.000Z";

describe("uninstall — happy path", () => {
  it("deletes owned files and removes the manifest when nothing remains", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    seedFile(io, ".claude/hooks/post-edit.sh", "#!/bin/sh");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    recordEntry(
      ROOT,
      { path: ".claude/hooks/post-edit.sh", kind: "hook", created_at: ISO },
      io,
    );

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed.sort()).toEqual([
      ".claude/hooks/post-edit.sh",
      "oxlint.fast.json",
    ]);
    expect(r.kept_backup).toBe(false);
    expect(r.merged_kept).toEqual([]);

    expect(io.files.has(joinAbs("oxlint.fast.json"))).toBe(false);
    expect(io.files.has(joinAbs(".claude", "hooks", "post-edit.sh"))).toBe(false);
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });

  it("removes manifest when it was empty (no entries) but present", () => {
    const io = memoryIO();
    // Force-create an empty manifest by recording then removing nothing.
    io.files.set(
      joinAbs(MANIFEST_FILENAME),
      JSON.stringify({
        version: "1",
        created_at: ISO,
        updated_at: ISO,
        entries: [],
      }),
    );

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual([]);
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });

  it("deletes every kind of owned file", () => {
    const io = memoryIO();
    const owned = [
      ["oxlint.fast.json", "preset"],
      [".claude/hooks/post-edit.sh", "hook"],
      [".husky/pre-commit", "husky"],
      [".lintstagedrc.js", "lintstaged"],
      ["docs/lint-decisions.md", "decisions"],
      ["templates/foo.md", "template"],
      ["misc.txt", "other"],
    ] as const;
    for (const [path] of owned) {
      seedFile(io, path, "x");
    }
    for (const [path, kind] of owned) {
      recordEntry(ROOT, { path, kind, created_at: ISO }, io);
    }

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed.sort()).toEqual(owned.map(([p]) => p).sort());
    for (const [path] of owned) {
      expect(io.files.has(joinAbs(...path.split("/")))).toBe(false);
    }
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });

  it("ignores files that are already absent (idempotent)", () => {
    const io = memoryIO();
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    // Note: no seedFile — the file is missing on disk.

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual(["oxlint.fast.json"]);
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });
});

describe("uninstall — backup handling", () => {
  it("deletes backup files by default", () => {
    const io = memoryIO();
    seedFile(io, ".lint-backup/ts1/.eslintrc.json", '{"a":1}');
    seedFile(io, ".lint-backup/ts1/package.json", '{"n":"d"}');
    recordEntry(
      ROOT,
      { path: ".lint-backup/ts1/.eslintrc.json", kind: "backup", created_at: ISO },
      io,
    );
    recordEntry(
      ROOT,
      { path: ".lint-backup/ts1/package.json", kind: "backup", created_at: ISO },
      io,
    );

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed.sort()).toEqual([
      ".lint-backup/ts1/.eslintrc.json",
      ".lint-backup/ts1/package.json",
    ]);
    expect(r.kept_backup).toBe(false);
    expect(io.files.has(joinAbs(".lint-backup", "ts1", ".eslintrc.json"))).toBe(false);
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });

  it("--keep-backup preserves backup files and their manifest entries", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    seedFile(io, ".lint-backup/ts1/.eslintrc.json", '{"a":1}');
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    recordEntry(
      ROOT,
      { path: ".lint-backup/ts1/.eslintrc.json", kind: "backup", created_at: ISO },
      io,
    );

    const r = uninstall({ cwd: ROOT, keepBackup: true }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual(["oxlint.fast.json"]);
    expect(r.kept_backup).toBe(true);

    // Backup file is still on disk.
    expect(io.files.get(joinAbs(".lint-backup", "ts1", ".eslintrc.json"))).toBe('{"a":1}');
    // Manifest still exists with only the backup entry.
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    expect(m!.entries).toHaveLength(1);
    expect(m!.entries[0]?.path).toBe(".lint-backup/ts1/.eslintrc.json");
    expect(m!.entries[0]?.kind).toBe("backup");
  });

  it("--keep-backup with no backup entries reports kept_backup=false", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);

    const r = uninstall({ cwd: ROOT, keepBackup: true }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept_backup).toBe(false);
    expect(io.files.has(joinAbs(MANIFEST_FILENAME))).toBe(false);
  });
});

describe("uninstall — merged / dep entries", () => {
  it("preserves merged entries (settings, scripts, coverage) and surfaces them in merged_kept", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    seedFile(io, "package.json", '{"scripts":{"lint":"oxlint"}}');
    seedFile(io, ".claude/settings.json", "{}");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    recordEntry(
      ROOT,
      { path: "package.json", kind: "scripts", created_at: ISO, merged: true },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: ".claude/settings.json",
        kind: "settings",
        created_at: ISO,
        merged: true,
      },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: "vitest.config.ts",
        kind: "coverage",
        created_at: ISO,
        merged: true,
      },
      io,
    );

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual(["oxlint.fast.json"]);
    expect(r.merged_kept.map((m) => `${m.kind}:${m.path}`).sort()).toEqual([
      "coverage:vitest.config.ts",
      "scripts:package.json",
      "settings:.claude/settings.json",
    ]);

    // Merged files NOT deleted.
    expect(io.files.get(joinAbs("package.json"))).toBe('{"scripts":{"lint":"oxlint"}}');
    expect(io.files.has(joinAbs(".claude", "settings.json"))).toBe(true);

    // Manifest rewritten with the three merged entries surviving.
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    expect(m!.entries).toHaveLength(3);
    expect(m!.entries.map((e) => e.kind).sort()).toEqual([
      "coverage",
      "scripts",
      "settings",
    ]);
  });

  it("preserves dep entries (virtual paths) — never tries to delete them", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    recordEntry(
      ROOT,
      {
        path: "package.json#devDependencies/oxlint",
        kind: "dep",
        created_at: ISO,
        merged: true,
      },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: "package.json#devDependencies/oxfmt",
        kind: "dep",
        created_at: ISO,
        merged: true,
      },
      io,
    );

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual(["oxlint.fast.json"]);
    expect(r.merged_kept.map((m) => m.path).sort()).toEqual([
      "package.json#devDependencies/oxfmt",
      "package.json#devDependencies/oxlint",
    ]);

    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    expect(m!.entries).toHaveLength(2);
    for (const e of m!.entries) expect(e.kind).toBe("dep");
  });

  it("handles a mixed manifest: owned + backup + merged + dep", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    seedFile(io, ".lint-backup/ts1/.eslintrc.json", '{"x":1}');
    seedFile(io, "package.json", "{}");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    recordEntry(
      ROOT,
      { path: ".lint-backup/ts1/.eslintrc.json", kind: "backup", created_at: ISO },
      io,
    );
    recordEntry(
      ROOT,
      { path: "package.json", kind: "scripts", created_at: ISO, merged: true },
      io,
    );
    recordEntry(
      ROOT,
      {
        path: "package.json#devDependencies/oxlint",
        kind: "dep",
        created_at: ISO,
        merged: true,
      },
      io,
    );

    const r = uninstall({ cwd: ROOT, keepBackup: true }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toEqual(["oxlint.fast.json"]);
    expect(r.kept_backup).toBe(true);
    expect(r.merged_kept.map((m) => m.path).sort()).toEqual([
      "package.json",
      "package.json#devDependencies/oxlint",
    ]);

    expect(io.files.has(joinAbs("oxlint.fast.json"))).toBe(false);
    expect(io.files.get(joinAbs(".lint-backup", "ts1", ".eslintrc.json"))).toBe('{"x":1}');
    expect(io.files.get(joinAbs("package.json"))).toBe("{}");

    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    expect(m!.entries).toHaveLength(3); // backup + scripts + dep
  });
});

describe("uninstall — error paths", () => {
  it("returns manifest_missing when the manifest is absent", () => {
    const io = memoryIO();
    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_missing");
  });

  it("surfaces remove_failed when removeFn throws", () => {
    const io = memoryIO();
    seedFile(io, "oxlint.fast.json", "{}");
    recordEntry(ROOT, { path: "oxlint.fast.json", kind: "preset", created_at: ISO }, io);
    io.removeFn = () => {
      throw new Error("EACCES");
    };

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("remove_failed");
    expect(r.reason).toContain("EACCES");
  });

  it("surfaces remove_failed when a backup remove throws", () => {
    const io = memoryIO();
    seedFile(io, ".lint-backup/ts1/a.txt", "A");
    recordEntry(
      ROOT,
      { path: ".lint-backup/ts1/a.txt", kind: "backup", created_at: ISO },
      io,
    );
    io.removeFn = () => {
      throw new Error("EBUSY");
    };

    const r = uninstall({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("remove_failed");
    expect(r.reason).toContain("EBUSY");
  });
});

describe("parseUninstallArgs", () => {
  it("returns defaults when called with no args", () => {
    const r = parseUninstallArgs([], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ cwd: "/wd", keepBackup: false });
  });

  it("parses --keep-backup", () => {
    const r = parseUninstallArgs(["--keep-backup"], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.keepBackup).toBe(true);
  });

  it("parses --cwd", () => {
    const r = parseUninstallArgs(["--cwd", "/proj"], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
  });

  it("parses both --cwd and --keep-backup in either order", () => {
    const a = parseUninstallArgs(["--cwd", "/proj", "--keep-backup"], "/wd");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value).toEqual({ cwd: "/proj", keepBackup: true });

    const b = parseUninstallArgs(["--keep-backup", "--cwd", "/proj"], "/wd");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value).toEqual({ cwd: "/proj", keepBackup: true });
  });

  it("rejects missing value for --cwd", () => {
    const r = parseUninstallArgs(["--cwd"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("missing value for --cwd");
  });

  it("rejects unknown flag", () => {
    const r = parseUninstallArgs(["--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseUninstallArgs(["--help"], "/wd")).toEqual({ ok: false, error: "help" });
    expect(parseUninstallArgs(["-h"], "/wd")).toEqual({ ok: false, error: "help" });
  });
});
