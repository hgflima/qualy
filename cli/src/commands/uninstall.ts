/**
 * `uninstall` — remove every artifact tracked in `.lint-manifest.json`.
 *
 * SPEC §2 `/lint:uninstall`: "Remove tudo que `/lint:setup` instalou (linter,
 * formatter, hooks, coverage, report)." PLAN §Contratos CLI: input
 * `--keep-backup`, output `{ removed: string[], kept_backup: bool }`.
 *
 * Manifest entries are partitioned into three handling classes:
 *
 *   - **Owned files** — `kind ∈ {preset, hook, husky, lintstaged, decisions,
 *     template, other}` and `merged !== true`. The file at `entry.path` is
 *     deleted via `safeIO.removeFn`. These are qualy-authored files; uninstall
 *     reclaims them in full.
 *   - **Backup snapshots** — `kind === "backup"`. Default: deleted (the
 *     snapshot's purpose ends with `/lint:rollback`). With `--keep-backup`,
 *     the file and its manifest entry are preserved so a future
 *     `backup-restore` still has the bytes — the harness offers this when the
 *     user might still want to revert.
 *   - **Merged / virtual entries** — `merged === true` (settings, scripts,
 *     coverage merges into pre-existing user files) or `kind === "dep"`
 *     (virtual `package.json#devDependencies/<name>` paths). Neither is
 *     deleted by this command; v1 surfaces them in `merged_kept` so the
 *     harness can route the user to a dedicated cleanup path
 *     (`pkg-manager remove` for deps; surgical key removal for merges).
 *     Their manifest entries stay in place so a follow-up uninstall can
 *     still see them.
 *
 * After processing, the manifest is rewritten with whatever entries remain
 * (kept-backups + merged + deps). When everything was removed, the manifest
 * file itself is deleted via `deleteManifest` — a clean uninstall leaves no
 * trace.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, removed: string[], kept_backup: bool,
 *     merged_kept: [{ path, kind }] }
 *
 * Exit codes:
 *   - OK                — uninstall succeeded (including no-op when manifest
 *                         is empty after load).
 *   - USAGE_ERROR       — unknown flag.
 *   - RECOVERABLE_ERROR — manifest absent or a delete failed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import {
  type Manifest,
  type ManifestEntry,
  type ManifestEntryKind,
  type SafeIO,
  deleteManifest,
  loadManifest,
  manifestPath,
  resolveSafePath,
} from "../lib/fs-safe.ts";
import { stringifyPretty } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";

export interface UninstallOptions {
  readonly cwd: string;
  /** Preserve `kind:"backup"` files (and their manifest entries). */
  readonly keepBackup?: boolean;
}

export interface UninstallMergedKept {
  readonly path: string;
  readonly kind: ManifestEntryKind;
}

export interface UninstallOk {
  readonly ok: true;
  readonly cwd: string;
  readonly removed: readonly string[];
  readonly kept_backup: boolean;
  readonly merged_kept: readonly UninstallMergedKept[];
}

export interface UninstallErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type UninstallResult = UninstallOk | UninstallErr;

export interface UninstallDeps {
  readonly safeIO?: SafeIO;
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultRemove(p: string): void {
  rmSync(p, { force: true });
}

/** Entries that point at a real file on disk we own (delete on uninstall). */
function isOwnedFile(entry: ManifestEntry): boolean {
  if (entry.merged === true) return false;
  if (entry.kind === "dep") return false;
  if (entry.kind === "backup") return false;
  return true;
}

export function uninstall(
  opts: UninstallOptions,
  deps: UninstallDeps = {},
): UninstallResult {
  const safeIO = deps.safeIO ?? {};
  const existsFn = safeIO.existsFn ?? defaultExists;
  const removeFn = safeIO.removeFn ?? defaultRemove;
  const writeFileFn = safeIO.writeFileFn;

  const manifest = loadManifest(opts.cwd, safeIO);
  if (!manifest) {
    return { ok: false, error: "manifest_missing", reason: opts.cwd };
  }

  const keepBackup = opts.keepBackup ?? false;
  const removed: string[] = [];
  const mergedKept: UninstallMergedKept[] = [];
  const remaining: ManifestEntry[] = [];

  for (const entry of manifest.entries) {
    if (entry.kind === "backup") {
      if (keepBackup) {
        remaining.push(entry);
        continue;
      }
      const resolved = resolveSafePath(opts.cwd, entry.path);
      if (!resolved.ok) {
        return {
          ok: false,
          error: "path_invalid",
          reason: `${entry.path}: ${resolved.error}`,
        };
      }
      try {
        if (existsFn(resolved.value)) {
          removeFn(resolved.value);
        }
      } catch (err) {
        return {
          ok: false,
          error: "remove_failed",
          reason: `${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      removed.push(entry.path);
      continue;
    }

    if (!isOwnedFile(entry)) {
      mergedKept.push({ path: entry.path, kind: entry.kind });
      remaining.push(entry);
      continue;
    }

    const resolved = resolveSafePath(opts.cwd, entry.path);
    if (!resolved.ok) {
      return {
        ok: false,
        error: "path_invalid",
        reason: `${entry.path}: ${resolved.error}`,
      };
    }
    try {
      if (existsFn(resolved.value)) {
        removeFn(resolved.value);
      }
    } catch (err) {
      return {
        ok: false,
        error: "remove_failed",
        reason: `${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    removed.push(entry.path);
  }

  if (remaining.length === 0) {
    deleteManifest(opts.cwd, safeIO);
  } else {
    const now = safeIO.now ? safeIO.now() : new Date();
    const next: Manifest = {
      ...manifest,
      updated_at: now.toISOString(),
      entries: remaining,
    };
    const path = manifestPath(opts.cwd);
    if (writeFileFn !== undefined) {
      const mkdirFn = safeIO.mkdirFn ?? ((p: string) => mkdirSync(p, { recursive: true }));
      mkdirFn(dirname(path));
      writeFileFn(path, stringifyPretty(next));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stringifyPretty(next));
    }
  }

  return {
    ok: true,
    cwd: opts.cwd,
    removed,
    kept_backup: keepBackup && remaining.some((e) => e.kind === "backup"),
    merged_kept: mergedKept,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly keepBackup: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseUninstallArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let keepBackup = false;
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
    if (arg === "--keep-backup") {
      keepBackup = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, keepBackup } };
}

export function runUninstall(argv: readonly string[]): ExitCode {
  const parsed = parseUninstallArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy uninstall [--cwd <path>] [--keep-backup]\n" +
          "\n" +
          "Removes every artifact tracked in `.lint-manifest.json`. By default,\n" +
          "snapshots under `.lint-backup/` are also deleted; pass --keep-backup to\n" +
          "preserve them (their manifest entries are preserved too).\n" +
          "Merged/virtual entries (settings, scripts, coverage, deps) are NOT\n" +
          "deleted by this command — they're surfaced in `merged_kept` for the\n" +
          "harness to clean up via the package manager / surgical edits.\n" +
          "Exit codes: 0 ok, 1 manifest missing or remove failure, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "uninstall", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = uninstall(parsed.value);
  if (!result.ok) {
    logger.error("uninstall_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "path_invalid") {
      return EXIT_CODES.USAGE_ERROR;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("uninstall_ok", {
    removed: result.removed.length,
    kept_backup: result.kept_backup,
    merged_kept: result.merged_kept.length,
  });
  return EXIT_CODES.OK;
}
