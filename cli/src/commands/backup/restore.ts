/**
 * `backup-restore` — replay a snapshot taken by `backup-create`, putting each
 * file back at its original location byte-for-byte.
 *
 * SPEC §7.2 acceptance: "/lint:rollback restaura byte-a-byte os arquivos
 * pré-existentes." This command is the engine behind `/lint:rollback` and the
 * recovery half of `/lint:setup` over a brownfield project.
 *
 * Source of truth is `.lint-manifest.json` (entries with `kind: "backup"` whose
 * path begins with `.lint-backup/<timestamp>/`). The on-disk `.lint-backup/`
 * tree is the byte source — never an FS walk, mirroring `backup-list`'s rule:
 * what the manifest knows is exactly what restore can act on.
 *
 * Behavior:
 *   1. Validate `--ts` is non-empty.
 *   2. Load the manifest and gather every backup entry whose timestamp matches.
 *      No matches → `timestamp_not_found` (RECOVERABLE_ERROR).
 *   3. If `--files <json>` is provided, restrict the restore set to that subset.
 *      Subset entries that are not part of this backup → `subset_not_in_backup`.
 *   4. Validate every backup file exists on disk *up-front* (atomic-ish). One
 *      missing → `backup_file_missing`; nothing is written.
 *   5. For each entry, read bytes from `.lint-backup/<ts>/<src>` and write them
 *      to `<src>` via `safeWriteFile({skipManifest:true})` — the destination is
 *      a user-owned file, so the manifest must not claim ownership of it.
 *
 * Output:
 *   { ok, cwd, timestamp, dir, restored: [{ src, from, bytes }] }
 *
 * Exit codes:
 *   - OK                — every requested file restored.
 *   - USAGE_ERROR       — unknown flag, missing/empty `--ts`, malformed
 *                         `--files`, path escape, or subset path absent from
 *                         this backup.
 *   - RECOVERABLE_ERROR — timestamp not found, backup file missing on disk,
 *                         read failed, or generic write failure.
 *   - DIRTY_TREE        — `--strict` set and the working tree is dirty.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  loadManifest,
  resolveSafePath,
  safeWriteFile,
} from "../../lib/fs-safe.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

import { BACKUP_DIR } from "./create.ts";

export interface BackupRestoreOptions {
  readonly cwd: string;
  /** Timestamp identifier produced by `backup-create` (e.g. `2026-05-03T12-00-00-000Z`). */
  readonly timestamp: string;
  /** Optional subset of original (project-relative) paths to restore. Default: all in this backup. */
  readonly files?: readonly string[];
  /** Refuse to write if the working tree is dirty. */
  readonly strict?: boolean;
}

export interface BackupRestoreEntry {
  /** Project-relative original path that was restored, POSIX-normalized. */
  readonly src: string;
  /** Project-relative source-of-bytes path under `.lint-backup/<ts>/`, POSIX-normalized. */
  readonly from: string;
  readonly bytes: number;
}

export interface BackupRestoreOk {
  readonly ok: true;
  readonly cwd: string;
  readonly timestamp: string;
  readonly dir: string;
  readonly restored: readonly BackupRestoreEntry[];
}

export interface BackupRestoreErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type BackupRestoreResult = BackupRestoreOk | BackupRestoreErr;

export interface BackupRestoreDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly readFileFn?: (p: string) => string;
  readonly safeIO?: SafeIO;
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

const PREFIX = `${BACKUP_DIR}/`;

/**
 * Splits a manifest backup-entry path into `[timestamp, src]`. Returns `null`
 * for paths that don't match `.lint-backup/<ts>/<rest>` — defensive against
 * forward-compat changes to manifest shape (mirrors `backup-list`).
 */
function splitBackupPath(path: string): { timestamp: string; src: string } | null {
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { timestamp: rest.slice(0, slash), src: rest.slice(slash + 1) };
}

export function backupRestore(
  opts: BackupRestoreOptions,
  deps: BackupRestoreDeps = {},
): BackupRestoreResult {
  if (typeof opts.timestamp !== "string" || opts.timestamp.length === 0) {
    return { ok: false, error: "timestamp_empty" };
  }

  const safeIO = deps.safeIO ?? {};
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const manifest = loadManifest(opts.cwd, safeIO);
  if (!manifest) {
    return { ok: false, error: "timestamp_not_found", reason: opts.timestamp };
  }

  const inBackup = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "backup") continue;
    const split = splitBackupPath(entry.path);
    if (!split) continue;
    if (split.timestamp !== opts.timestamp) continue;
    inBackup.set(split.src, entry.path);
  }

  if (inBackup.size === 0) {
    return { ok: false, error: "timestamp_not_found", reason: opts.timestamp };
  }

  const requested: { src: string; from: string }[] = [];
  if (opts.files && opts.files.length > 0) {
    for (const src of opts.files) {
      if (typeof src !== "string" || src.length === 0) {
        return { ok: false, error: "files_invalid", reason: "non-empty string required" };
      }
      const fromPath = inBackup.get(src);
      if (fromPath === undefined) {
        return {
          ok: false,
          error: "subset_not_in_backup",
          reason: `${src} is not part of backup ${opts.timestamp}`,
        };
      }
      requested.push({ src, from: fromPath });
    }
  } else {
    for (const [src, from] of Array.from(inBackup.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      requested.push({ src, from });
    }
  }

  // Up-front existence check — atomic-ish, mirrors `backup-create`.
  for (const { from } of requested) {
    const resolved = resolveSafePath(opts.cwd, from);
    if (!resolved.ok) {
      // Manifest shouldn't carry escaping paths, but guard anyway.
      return { ok: false, error: "path_invalid", reason: `${from}: ${resolved.error}` };
    }
    if (!existsFn(resolved.value)) {
      return { ok: false, error: "backup_file_missing", reason: from };
    }
  }

  const restored: BackupRestoreEntry[] = [];
  for (const { src, from } of requested) {
    const fromAbs = resolveSafePath(opts.cwd, from);
    if (!fromAbs.ok) {
      return { ok: false, error: "path_invalid", reason: `${from}: ${fromAbs.error}` };
    }

    let content: string;
    try {
      content = readFileFn(fromAbs.value);
    } catch (err) {
      return {
        ok: false,
        error: "read_failed",
        reason: `${from}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const writeRes = safeWriteFile(
      opts.cwd,
      src,
      content,
      { skipManifest: true, strict: opts.strict ?? false },
      safeIO,
    );
    if (!writeRes.ok) {
      return { ok: false, error: "write_failed", reason: `${src}: ${writeRes.error}` };
    }

    restored.push({
      src: writeRes.value.path,
      from,
      bytes: writeRes.value.bytes,
    });
  }

  return {
    ok: true,
    cwd: opts.cwd,
    timestamp: opts.timestamp,
    dir: `${BACKUP_DIR}/${opts.timestamp}`,
    restored,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly timestamp: string;
  readonly files?: readonly string[];
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseBackupRestoreArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let timestamp: string | undefined;
  let files: readonly string[] | undefined;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
      cwd = resolve(defaultCwd, value);
      i++;
      continue;
    }
    if (arg === "--ts") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --ts" };
      }
      timestamp = value;
      i++;
      continue;
    }
    if (arg === "--files") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --files" };
      }
      const parsed = parseDefensive<unknown>(value);
      if (!parsed.ok) {
        return { ok: false, error: `invalid --files JSON: ${parsed.error}` };
      }
      if (!Array.isArray(parsed.value)) {
        return { ok: false, error: "--files must be a JSON array of strings" };
      }
      const list: string[] = [];
      for (const item of parsed.value) {
        if (typeof item !== "string" || item.length === 0) {
          return { ok: false, error: "--files array must contain non-empty strings" };
        }
        list.push(item);
      }
      files = list;
      i++;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  if (timestamp === undefined) {
    return { ok: false, error: "missing --ts" };
  }
  return {
    ok: true,
    value: { cwd, timestamp, ...(files !== undefined ? { files } : {}), strict },
  };
}

export function runBackupRestore(argv: readonly string[]): ExitCode {
  const parsed = parseBackupRestoreArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy backup-restore --ts <timestamp> [--cwd <path>] [--files <json>] [--strict]\n" +
          "\n" +
          "Restores files snapshotted by `backup-create` byte-for-byte to their\n" +
          "original locations. Reads `.lint-manifest.json` to discover which paths\n" +
          "belong to <timestamp>; never walks `.lint-backup/` directly.\n" +
          "--files: optional JSON array of original (project-relative) paths to limit\n" +
          "         the restore subset; default = every file in the backup.\n" +
          "Exit codes: 0 ok, 1 timestamp/file missing or read/write failure,\n" +
          "            3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "backup-restore", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = backupRestore(parsed.value);
  if (!result.ok) {
    logger.error("backup_restore_failed", { reason: result.reason ?? result.error });
    output(result);
    if (
      result.error === "timestamp_empty" ||
      result.error === "files_invalid" ||
      result.error === "path_invalid" ||
      result.error === "subset_not_in_backup"
    ) {
      return EXIT_CODES.USAGE_ERROR;
    }
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("backup_restore_ok", {
    timestamp: result.timestamp,
    files: result.restored.length,
  });
  return EXIT_CODES.OK;
}
