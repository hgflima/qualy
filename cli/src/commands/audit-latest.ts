/**
 * `audit-latest` — read the most recent `.lint-audit/<ts>.json` payload.
 *
 * SPEC §2 `/lint:update` reads the latest audit before applying recommendations
 * (line 50: "Lê o audit mais recente em `.lint-audit/`"). PLAN §Contratos CLI
 * documents the output shape as `{ path, audit }` (line 76).
 *
 * Selection: timestamps in filenames come from `toSafeTimestamp()` which
 * preserves lexical order — `Array.sort()` descending picks the most recent.
 * Files that don't end in `.json` are ignored. The directory itself is read
 * via `readdirSync` (no glob libs); a missing dir surfaces as `audit_missing`
 * (RECOVERABLE_ERROR — `/lint:update` should suggest running `/lint:audit`
 * first instead of crashing).
 *
 * Validation: the file is parsed with `parseDefensive` then validated against
 * `auditPayloadSchema`. Schema drift between writer (`audit.ts`) and reader is
 * surfaced as `schema_validation_failed` rather than shipping a malformed
 * payload to `/lint:update`.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, path, timestamp, audit }
 *
 * `path` is project-relative (`.lint-audit/<ts>.json`) for parity with manifest
 * paths; `timestamp` is the safe-form filename stem.
 *
 * Exit codes:
 *   - OK                 — latest audit read and validated.
 *   - RECOVERABLE_ERROR  — directory missing, no `.json` files, file
 *                          unreadable, parse/schema failure.
 *   - USAGE_ERROR        — flag parser failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type AuditPayload, validateAuditPayload } from "../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { resolveSafePath } from "../lib/fs-safe.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";

import { AUDIT_DIR } from "./audit.ts";

export interface AuditLatestOptions {
  readonly cwd: string;
}

export interface AuditLatestOk {
  readonly ok: true;
  readonly cwd: string;
  /** Project-relative path (`.lint-audit/<ts>.json`). */
  readonly path: string;
  /** Filesystem-safe timestamp (filename stem). */
  readonly timestamp: string;
  readonly audit: AuditPayload;
}

export interface AuditLatestErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type AuditLatestResult = AuditLatestOk | AuditLatestErr;

export interface AuditLatestDeps {
  readonly readdirFn?: (dir: string) => readonly string[];
  readonly readFileFn?: (path: string) => string | null;
}

const JSON_SUFFIX = ".json";

function defaultReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Pick the lexically largest filename ending in `.json`. `toSafeTimestamp`
 * (used by `audit.ts`) emits monotonically sortable strings, so descending
 * lexical order = newest first.
 */
function pickLatest(entries: readonly string[]): string | null {
  let latest: string | null = null;
  for (const name of entries) {
    if (!name.endsWith(JSON_SUFFIX)) continue;
    if (latest === null || name > latest) latest = name;
  }
  return latest;
}

export function auditLatest(
  opts: AuditLatestOptions,
  deps: AuditLatestDeps = {},
): AuditLatestResult {
  const cwd = opts.cwd;
  const readdirFn = deps.readdirFn ?? defaultReaddir;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const dirRel = AUDIT_DIR;
  const safeDir = resolveSafePath(cwd, dirRel);
  if (!safeDir.ok) {
    return { ok: false, error: "path_invalid", reason: safeDir.error };
  }

  const entries = readdirFn(safeDir.value);
  const filename = pickLatest(entries);
  if (filename === null) {
    return {
      ok: false,
      error: "audit_missing",
      reason: `no audit files found under ${dirRel}/ — run /lint:audit first`,
    };
  }

  const relPath = `${dirRel}/${filename}`;
  const absPath = join(safeDir.value, filename);
  const raw = readFileFn(absPath);
  if (raw === null) {
    return {
      ok: false,
      error: "read_failed",
      reason: `${relPath}: file is unreadable`,
    };
  }

  const parsed = parseDefensive(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "parse_failed",
      reason: `${relPath}: ${parsed.error}`,
    };
  }

  const validated = validateAuditPayload(parsed.value);
  if (!validated.ok) {
    return {
      ok: false,
      error: "schema_validation_failed",
      reason: `${relPath}: ${validated.error}`,
    };
  }

  const timestamp = filename.slice(0, -JSON_SUFFIX.length);

  return {
    ok: true,
    cwd,
    path: relPath,
    timestamp,
    audit: validated.value,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseAuditLatestArgs(
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

export function runAuditLatest(argv: readonly string[]): ExitCode {
  const parsed = parseAuditLatestArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy audit-latest [--cwd <path>]\n" +
          "\n" +
          "Reads the most recent .lint-audit/<ts>.json (lexical descending)\n" +
          "and validates it against the SPEC §3 schema. Used by /lint:update\n" +
          "and /lint:report to consume the last audit without re-running it.\n" +
          "Exit codes: 0 ok, 1 missing/parse/schema failure, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "audit-latest", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = auditLatest(parsed.value);
  if (!result.ok) {
    logger.error("audit_latest_failed", { reason: result.reason ?? result.error });
    output(result);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("audit_latest_ok", {
    timestamp: result.timestamp,
    path: result.path,
    errors: result.audit.violations.summary.errors,
    warnings: result.audit.violations.summary.warnings,
  });
  return EXIT_CODES.OK;
}
