/**
 * `backup-create` — snapshot files into `.lint-backup/<timestamp>/` before any
 * destructive change to pre-existing linter/formatter configs.
 *
 * SPEC §6 Always: "Sempre criar `.lint-backup/<ISO-timestamp>/` antes de
 * remover/sobrescrever qualquer arquivo de configuração de linter
 * pré-existente." This is the only authorized writer for `.lint-backup/`.
 *
 * Behavior:
 *   1. Resolve a filesystem-safe timestamp (ISO-8601 with `:` / `.` replaced
 *      by `-`). Caller may override via `--ts` (deterministic e2e tests).
 *   2. For each `--files` entry, validate the path is relative + under cwd,
 *      assert the source exists, read its bytes, and write a byte-for-byte
 *      copy to `.lint-backup/<timestamp>/<source-rel>` via `safeWriteFile`.
 *      The directory tree under `<source-rel>` is preserved so a future
 *      `backup-restore --ts <timestamp>` can put each file back at its
 *      original location.
 *   3. Each backup entry is recorded in `.lint-manifest.json` with
 *      `kind: "backup"` so uninstall can clean the directory (or skip it
 *      under `--keep-backup`).
 *
 * Idempotency: each invocation defaults to a unique timestamp, so backups
 * accumulate (one snapshot per migration attempt). Re-running with an explicit
 * `--ts` overwrites the prior snapshot byte-for-byte.
 *
 * Output (PLAN §Contratos CLI – backup commands):
 *   { ok, cwd, timestamp, dir, backed_up: [{ src, dest, bytes }] }
 *
 * Exit codes:
 *   - OK                — every file backed up.
 *   - USAGE_ERROR       — unknown flag, malformed `--files`, empty list,
 *                         non-string entries, or path escape.
 *   - RECOVERABLE_ERROR — a source file is missing, unreadable, or write
 *                         failed for a non-strict reason.
 *   - DIRTY_TREE        — `--strict` set and the working tree is dirty.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  resolveSafePath,
  safeWriteFile,
} from "../../lib/fs-safe.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

export const BACKUP_DIR = ".lint-backup";

export interface BackupCreateOptions {
  readonly cwd: string;
  /** Project-relative paths to back up (validated as relative + under cwd). */
  readonly files: readonly string[];
  /** Override timestamp (filesystem-safe form). When omitted, derived from `now`. */
  readonly timestamp?: string;
  /** Refuse to write if the working tree is dirty. */
  readonly strict?: boolean;
}

export interface BackupCreateEntry {
  /** Project-relative source path, POSIX-normalized. */
  readonly src: string;
  /** Project-relative dest path under `.lint-backup/<ts>/`, POSIX-normalized. */
  readonly dest: string;
  readonly bytes: number;
}

export interface BackupCreateOk {
  readonly ok: true;
  readonly cwd: string;
  readonly timestamp: string;
  readonly dir: string;
  readonly backed_up: readonly BackupCreateEntry[];
}

export interface BackupCreateErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type BackupCreateResult = BackupCreateOk | BackupCreateErr;

export interface BackupCreateDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly readFileFn?: (p: string) => string;
  readonly safeIO?: SafeIO;
  readonly now?: () => Date;
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

/**
 * Convert an ISO-8601 timestamp to a filesystem-safe form by replacing
 * the colons (time separator) and the dot (ms separator) with hyphens.
 * Output: `2026-05-03T12-30-45-123Z` — unambiguous, sorts lexically, and
 * works on every common filesystem (including Windows where `:` is invalid).
 */
export function toSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** POSIX-normalize a path that may be in mixed separators (test-friendly). */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

export function backupCreate(
  opts: BackupCreateOptions,
  deps: BackupCreateDeps = {},
): BackupCreateResult {
  if (opts.files.length === 0) {
    return { ok: false, error: "files_empty" };
  }

  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const now = deps.now ? deps.now() : new Date();
  const timestamp = opts.timestamp ?? toSafeTimestamp(now);

  // Validate every source path up-front before writing anything — keeps the
  // operation atomic in the common case (all-or-nothing in invalid input).
  const sources: { rel: string; abs: string }[] = [];
  for (const rel of opts.files) {
    if (typeof rel !== "string" || rel.length === 0) {
      return { ok: false, error: "files_invalid", reason: "non-empty string required" };
    }
    const resolved = resolveSafePath(opts.cwd, rel);
    if (!resolved.ok) {
      return { ok: false, error: "path_invalid", reason: `${rel}: ${resolved.error}` };
    }
    if (!existsFn(resolved.value)) {
      return { ok: false, error: "file_not_found", reason: rel };
    }
    sources.push({ rel, abs: resolved.value });
  }

  const dir = `${BACKUP_DIR}/${timestamp}`;
  const backed_up: BackupCreateEntry[] = [];

  for (const { rel, abs } of sources) {
    let content: string;
    try {
      content = readFileFn(abs);
    } catch (err) {
      return {
        ok: false,
        error: "read_failed",
        reason: `${rel}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const destRel = `${dir}/${toPosix(rel)}`;
    const writeRes = safeWriteFile(
      opts.cwd,
      destRel,
      content,
      { kind: "backup", strict: opts.strict ?? false },
      deps.safeIO,
    );
    if (!writeRes.ok) {
      return { ok: false, error: "write_failed", reason: `${destRel}: ${writeRes.error}` };
    }
    backed_up.push({
      src: toPosix(rel),
      dest: writeRes.value.path,
      bytes: writeRes.value.bytes,
    });
  }

  return { ok: true, cwd: opts.cwd, timestamp, dir, backed_up };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly timestamp?: string;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseBackupCreateArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let files: readonly string[] | undefined;
  let timestamp: string | undefined;
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
    if (arg === "--ts") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --ts" };
      }
      timestamp = value;
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
  if (files === undefined) {
    return { ok: false, error: "missing --files" };
  }
  return {
    ok: true,
    value: { cwd, files, ...(timestamp !== undefined ? { timestamp } : {}), strict },
  };
}

export function runBackupCreate(argv: readonly string[]): ExitCode {
  const parsed = parseBackupCreateArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy backup-create --files <json> [--cwd <path>] [--ts <timestamp>] [--strict]\n" +
          "\n" +
          "Snapshots each file under .lint-backup/<timestamp>/ preserving the directory tree.\n" +
          "--files: JSON array of project-relative paths (e.g. '[\".eslintrc.json\",\"package.json\"]').\n" +
          "--ts:    override the auto-generated filesystem-safe ISO timestamp.\n" +
          "Exit codes: 0 ok, 1 file missing/read/write failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "backup-create", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = backupCreate(parsed.value);
  if (!result.ok) {
    logger.error("backup_create_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "files_empty" || result.error === "files_invalid" || result.error === "path_invalid") {
      return EXIT_CODES.USAGE_ERROR;
    }
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("backup_create_ok", {
    timestamp: result.timestamp,
    files: result.backed_up.length,
  });
  return EXIT_CODES.OK;
}
