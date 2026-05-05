/**
 * `ignore-list` — read-only inventory of ignore manifest entries
 * (lint-ignore SPEC §3.3, PLAN T2.5).
 *
 * Prints every entry in `.harn/qualy/ignore.json` with its computed status
 * (`active` or `expired`). The output is always JSON (PLAN §Princípios — CLI
 * always emits JSON to stdout). The `--expired` flag filters to expired
 * entries and changes the exit code so CI / pre-commit hooks can gate on
 * vencidas (exit `1` when any expired present, `0` otherwise — SPEC §10 #4).
 *
 * Filters:
 *   - `--expired`        keep only expired entries; exit `1` when any present.
 *   - `--path <glob>`    keep only entries whose `glob` field equals the given
 *                        value (literal equality — picomatch-style matching is
 *                        deferred to T4.3 when `fast-glob` arrives).
 *   - `--json`           accepted for parity with SPEC §3.3 + slash command
 *                        contract; output is JSON either way.
 *
 * Empty manifest (file absent or zero entries) → `entries: []`, `expired_count: 0`,
 * exit `0` (`(no entries)` is the slash command's surface text — CLI keeps the
 * shape uniform).
 *
 * Manifest corrupt / unsupported version → exit `70` INTERNAL_ERROR (SPEC §3.1
 * fatal-state path, mirrors `ignore-add` / `ignore-compile`).
 */
import { resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO } from "../../lib/fs-safe.ts";
import {
  type IgnoreEntry,
  loadIgnoreManifest,
} from "../../lib/ignore-manifest.ts";
import { logger, output } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IgnoreListOptions {
  readonly cwd: string;
  readonly expired?: boolean;
  readonly path?: string | null;
  readonly now?: Date;
}

export type IgnoreListStatus = "active" | "expired";

export interface IgnoreListEntry {
  readonly id: string;
  readonly glob: string;
  readonly rule: string | null;
  readonly reason: string;
  readonly expires: string | null;
  readonly createdAt: string;
  readonly createdBy: IgnoreEntry["createdBy"];
  readonly status: IgnoreListStatus;
  /** Whole days `expires` is past `now` (only present when `status === "expired"`). */
  readonly days_overdue?: number;
}

export interface IgnoreListOk {
  readonly ok: true;
  readonly cwd: string;
  readonly entries: readonly IgnoreListEntry[];
  readonly expired_count: number;
  readonly exitCode: ExitCode;
}

export interface IgnoreListErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
  readonly exitCode: ExitCode;
}

export type IgnoreListResult = IgnoreListOk | IgnoreListErr;

export interface IgnoreListDeps {
  readonly safeIO?: SafeIO;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Status / decoration
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function decorateEntry(entry: IgnoreEntry, now: Date): IgnoreListEntry {
  if (entry.expires === null || !ISO_DATE_RE.test(entry.expires)) {
    return { ...entry, status: "active" };
  }
  const expiresMs = Date.parse(`${entry.expires}T00:00:00.000Z`);
  if (!Number.isFinite(expiresMs)) {
    return { ...entry, status: "active" };
  }
  const today = startOfUtcDay(now);
  if (expiresMs >= today) {
    return { ...entry, status: "active" };
  }
  const daysOverdue = Math.floor((today - expiresMs) / MS_PER_DAY);
  return { ...entry, status: "expired", days_overdue: daysOverdue };
}

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

export function ignoreList(
  opts: IgnoreListOptions,
  deps: IgnoreListDeps = {},
): IgnoreListResult {
  const now = deps.now ? deps.now() : opts.now ?? new Date();

  const loaded = loadIgnoreManifest(opts.cwd, deps.safeIO);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }

  const manifest = loaded.manifest ?? { version: 1 as const, entries: [] };
  const decorated = manifest.entries.map((e) => decorateEntry(e, now));

  // Apply filters. `--path` is literal equality; picomatch-style matching is
  // deferred (no glob library in deps yet — see T4.3 for fast-glob).
  let filtered: readonly IgnoreListEntry[] = decorated;
  if (opts.path !== null && opts.path !== undefined) {
    const target = opts.path;
    filtered = filtered.filter((e) => e.glob === target);
  }
  if (opts.expired === true) {
    filtered = filtered.filter((e) => e.status === "expired");
  }

  // Stable display order: by id ascending (matches compile output ordering).
  const sorted = [...filtered].toSorted((a, b) => a.id.localeCompare(b.id));

  const expiredCount = sorted.filter((e) => e.status === "expired").length;

  // SPEC §10 #4: --expired exits 1 if any present, 0 otherwise.
  const exitCode: ExitCode =
    opts.expired === true && expiredCount > 0
      ? EXIT_CODES.RECOVERABLE_ERROR
      : EXIT_CODES.OK;

  return {
    ok: true,
    cwd: opts.cwd,
    entries: sorted,
    expired_count: expiredCount,
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly expired: boolean;
  readonly path: string | null;
  readonly json: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreListArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let expired = false;
  let path: string | null = null;
  let json = false;

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
    if (arg === "--path") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --path" };
      }
      path = value;
      i++;
      continue;
    }
    if (arg === "--expired") {
      expired = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, expired, path, json } };
}

export function runIgnoreList(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreListArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-list [--expired] [--path <glob>] [--json] [--cwd <path>]\n" +
          "\n" +
          "Lists every entry in .harn/qualy/ignore.json with its computed\n" +
          "status (active|expired). --expired filters to expired entries and\n" +
          "exits 1 when any are present (0 otherwise). --path filters by\n" +
          "literal glob equality. Read-only.\n" +
          "\n" +
          "Exit codes: 0 ok, 1 expired entries present (with --expired),\n" +
          "  4 usage, 70 manifest corrupt/unsupported version.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "ignore-list", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreList({
    cwd: parsed.value.cwd,
    expired: parsed.value.expired,
    path: parsed.value.path,
  });

  if (!result.ok) {
    logger.error("ignore_list_failed", { reason: result.reason ?? result.error });
    output({
      ok: false,
      error: result.error,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    entries: result.entries,
    expired_count: result.expired_count,
  });
  logger.info("ignore_list_ok", {
    entries: result.entries.length,
    expired: result.expired_count,
  });
  return result.exitCode;
}
