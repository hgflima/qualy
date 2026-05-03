/**
 * `backup-list` — enumerate snapshots taken by `backup-create`.
 *
 * PLAN §Contratos CLI (`backup-list`): "lista timestamps + arquivos". Used by
 * the harness ahead of `/lint:rollback` (most-recent backup) and `/lint:audit`
 * audits to show the user which restore points exist.
 *
 * Source of truth is `.lint-manifest.json` (entries with `kind: "backup"`),
 * never an FS walk of `.lint-backup/`. Reasons:
 *   - The manifest is the only thing `uninstall` honors, so listing what the
 *     manifest knows about matches what rollback / restore can act on.
 *   - A user who hand-rotated backups or copied an unrelated tree into
 *     `.lint-backup/` should not have those entries surfaced as "qualy backups".
 *
 * As a sanity check, each file's presence on disk is reported (`present: bool`)
 * so the harness can warn before pointing the user at a half-deleted backup.
 *
 * Output (canonical JSON on stdout):
 *   {
 *     "ok": true,
 *     "cwd": "...",
 *     "backups": [
 *       {
 *         "timestamp": "2026-05-03T12-30-45-123Z",
 *         "dir": ".lint-backup/2026-05-03T12-30-45-123Z",
 *         "files": [{ "src": ".eslintrc.json", "dest": "...", "present": true }]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Backups are sorted descending by `timestamp` (most-recent first) so the
 * harness can default to `backups[0]` for `/lint:rollback`.
 *
 * Exit codes: `OK` always (read-only); `USAGE_ERROR` on unknown flags.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  loadManifest,
  resolveSafePath,
} from "../../lib/fs-safe.ts";
import { logger, output } from "../../lib/logger.ts";

import { BACKUP_DIR } from "./create.ts";

export interface BackupListOptions {
  readonly cwd: string;
}

export interface BackupListFile {
  /** Original project-relative path (the part after `.lint-backup/<ts>/`). */
  readonly src: string;
  /** Manifest path (`.lint-backup/<ts>/<src>`). */
  readonly dest: string;
  /** Whether the backed-up file currently exists on disk. */
  readonly present: boolean;
}

export interface BackupListEntry {
  readonly timestamp: string;
  readonly dir: string;
  readonly files: readonly BackupListFile[];
}

export interface BackupListOk {
  readonly ok: true;
  readonly cwd: string;
  readonly backups: readonly BackupListEntry[];
}

export type BackupListResult = BackupListOk;

export interface BackupListDeps {
  readonly safeIO?: SafeIO;
  readonly existsFn?: (p: string) => boolean;
}

const PREFIX = `${BACKUP_DIR}/`;

/**
 * Splits a manifest backup-entry path into `[timestamp, src]`.
 * Returns `null` for paths that don't match `.lint-backup/<ts>/<rest>` —
 * defensive against forward-compat changes to manifest shape.
 */
function splitBackupPath(path: string): { timestamp: string; src: string } | null {
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { timestamp: rest.slice(0, slash), src: rest.slice(slash + 1) };
}

export function backupList(
  opts: BackupListOptions,
  deps: BackupListDeps = {},
): BackupListResult {
  const manifest = loadManifest(opts.cwd, deps.safeIO ?? {});
  if (!manifest) {
    return { ok: true, cwd: opts.cwd, backups: [] };
  }

  const existsFn = deps.existsFn ?? existsSync;

  const grouped = new Map<string, BackupListFile[]>();
  for (const entry of manifest.entries) {
    if (entry.kind !== "backup") continue;
    const split = splitBackupPath(entry.path);
    if (!split) continue;
    const resolved = resolveSafePath(opts.cwd, entry.path);
    const present = resolved.ok ? existsFn(resolved.value) : false;
    const file: BackupListFile = {
      src: split.src,
      dest: entry.path,
      present,
    };
    const list = grouped.get(split.timestamp);
    if (list) {
      list.push(file);
    } else {
      grouped.set(split.timestamp, [file]);
    }
  }

  const backups: BackupListEntry[] = Array.from(grouped.entries())
    .map(([timestamp, files]) => ({
      timestamp,
      dir: `${BACKUP_DIR}/${timestamp}`,
      files: files.slice().sort((a, b) => a.src.localeCompare(b.src)),
    }))
    // Most-recent first — `toSafeTimestamp` produces lexically sortable strings.
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  return { ok: true, cwd: opts.cwd, backups };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseBackupListArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
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
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd } };
}

export function runBackupList(argv: readonly string[]): ExitCode {
  const parsed = parseBackupListArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy backup-list [--cwd <path>]\n" +
          "\n" +
          "Lists every backup taken by `backup-create`, grouped by timestamp.\n" +
          "Reads `.lint-manifest.json` (entries with kind=backup) and reports\n" +
          "`present: bool` per file by stating the backup destination.\n" +
          "Sorted most-recent first (lexical descending on the safe timestamp).\n" +
          "Exit codes: 0 ok, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "backup-list", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = backupList(parsed.value);
  output(result);
  logger.info("backup_list_ok", { count: result.backups.length });
  return EXIT_CODES.OK;
}
