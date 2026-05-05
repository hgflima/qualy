/**
 * `ignore-add` — author / update a path-only ignore entry in
 * `.harn/qualy/ignore.json`, recompile both oxlint presets, and append a
 * `ignore-add`/`ignore-update` entry to `.harn/qualy/docs/lint-decisions.md`
 * (lint-ignore SPEC §3.1, PLAN T2.4).
 *
 * Phase 2 scope: path-only entries (`rule === null`). The `--rule` flag is
 * deferred to T3.3 along with `category:*` expansion. Brownfield import
 * (auto-importing user-authored `ignorePatterns[]` outside the markers) is
 * deferred to T3.4 — until then this command assumes a greenfield manifest or
 * a manifest already authored by qualy.
 *
 * Flow:
 *   1. validate args (glob non-empty, reason non-empty, expires future-or-null)
 *   2. `--strict` pre-flight against `dirtyFiles`
 *   3. `migrateDecisionLogIfNeeded` (one-time `docs/ → .harn/qualy/docs/`)
 *   4. `loadIgnoreManifest` (corrupt → INTERNAL_ERROR exit 70)
 *   5. `upsertEntry` (`added` vs `updated` follows entry id, which is a hash of
 *      `(glob, rule)` — re-adding the same `(glob, null)` always updates in
 *      place)
 *   6. `saveIgnoreManifest`
 *   7. `compileToBothPresets` (rewrites only when drifted)
 *   8. `loadOrInitDecisions` + insert `ignore-add`/`ignore-update` entry +
 *      `safeWriteFile` decision log
 *
 * Exit codes:
 *   - OK                 — entry added or updated.
 *   - RECOVERABLE_ERROR  — invalid glob/reason/expires, preset
 *                          missing/malformed, write or decisions append failed,
 *                          migration conflict.
 *   - DIRTY_TREE         — `--strict` and the working tree is dirty.
 *   - USAGE_ERROR        — flag parser failure / missing required flag.
 *   - INTERNAL_ERROR     — manifest corrupt / unsupported version (SPEC §3.1
 *                          fatal-state path).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDecisionEntry as formatGenericEntry,
  insertEntryBetweenMarkers,
  loadOrInitDecisions,
} from "../../lib/decision-log.ts";
import {
  migrateDecisionLogIfNeeded,
  type DecisionLogMigrationDeps,
} from "../../lib/decision-log-migration.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  type SafeResult,
  safeWriteFile,
} from "../../lib/fs-safe.ts";
import { dirtyFiles } from "../../lib/git.ts";
import { compileToBothPresets } from "../../lib/ignore-compile.ts";
import {
  type IgnoreManifest,
  loadIgnoreManifest,
  saveIgnoreManifest,
  upsertEntry,
  validateExpires,
  validateGlob,
} from "../../lib/ignore-manifest.ts";
import { logger, output } from "../../lib/logger.ts";
import { DECISION_LOG_PATH } from "../../lib/paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IgnoreAddOptions {
  readonly cwd: string;
  readonly glob: string;
  readonly reason: string;
  readonly expires?: string | null;
  readonly strict?: boolean;
}

export interface IgnoreAddOk {
  readonly ok: true;
  readonly cwd: string;
  readonly glob: string;
  readonly rule: null;
  readonly action: "added" | "updated";
  readonly id: string;
  readonly expires: string | null;
  readonly files_changed: readonly string[];
  readonly decision: { readonly path: string; readonly appended: boolean };
  readonly exitCode: ExitCode;
}

export interface IgnoreAddErr {
  readonly ok: false;
  readonly error: string;
  readonly reason: string;
  readonly exitCode: ExitCode;
}

export type IgnoreAddResult = IgnoreAddOk | IgnoreAddErr;

export interface IgnoreAddDeps {
  readonly safeIO?: SafeIO;
  readonly readFileFn?: (p: string) => string | null;
  readonly authorFn?: (cwd: string) => string;
  readonly now?: () => Date;
  readonly templatePath?: string;
  readonly dirtyFilesFn?: (
    cwd: string,
  ) => { ok: true; value: readonly string[] } | { ok: false; error: string };
  readonly migrationDeps?: DecisionLogMigrationDeps;
}

// ---------------------------------------------------------------------------
// IO defaults
// ---------------------------------------------------------------------------

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultAuthor(cwd: string): string {
  try {
    const out = execFileSync("git", ["config", "user.email"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function defaultDirtyFiles(
  cwd: string,
): { ok: true; value: readonly string[] } | { ok: false; error: string } {
  const r = dirtyFiles(cwd);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

const DECISIONS_TEMPLATE_DEFAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "lint-decisions.md.tpl",
);

// ---------------------------------------------------------------------------
// Decision-log entry
// ---------------------------------------------------------------------------

function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface DecisionInputs {
  readonly action: "added" | "updated";
  readonly glob: string;
  readonly id: string;
  readonly reason: string;
  readonly expires: string | null;
  readonly author: string;
  readonly now: Date;
}

function formatIgnoreDecision(inputs: DecisionInputs): string {
  const kind = inputs.action === "added" ? "ignore-add" : "ignore-update";
  const subject = `${inputs.glob} (path-only)`;
  return formatGenericEntry({
    timestamp: isoUtc(inputs.now),
    kind,
    subject,
    bullets: [
      ["kind", kind],
      ["glob", inputs.glob],
      ["rule", "(path-only)"],
      ["id", inputs.id],
      ["expires", inputs.expires ?? "(never)"],
      ["author", inputs.author],
      ["reason", inputs.reason],
    ],
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function ignoreAdd(
  opts: IgnoreAddOptions,
  deps: IgnoreAddDeps = {},
): IgnoreAddResult {
  const now = deps.now ? deps.now() : new Date();
  const readFileFn = deps.readFileFn ?? defaultRead;

  // 1. Validate inputs.
  const globCheck = validateGlob(opts.glob);
  if (!globCheck.ok) {
    return {
      ok: false,
      error: "invalid_glob",
      reason: globCheck.error,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const reason = opts.reason.trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: "reason_required",
      reason:
        "ignore-add records exclusions as auditable tech debt; --reason <text> is mandatory and recorded in .harn/qualy/docs/lint-decisions.md",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const expires = opts.expires ?? null;
  const expiresCheck = validateExpires(expires, now);
  if (!expiresCheck.ok) {
    return {
      ok: false,
      error: "invalid_expires",
      reason: expiresCheck.error,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  // 2. --strict pre-flight.
  if (opts.strict === true) {
    const dirtyFn = deps.dirtyFilesFn ?? defaultDirtyFiles;
    const r = dirtyFn(opts.cwd);
    if (!r.ok) {
      return {
        ok: false,
        error: "git_check_failed",
        reason: r.error,
        exitCode: EXIT_CODES.RECOVERABLE_ERROR,
      };
    }
    if (r.value.length > 0) {
      return {
        ok: false,
        error: "dirty_tree",
        reason: `working tree has ${r.value.length} unstaged file(s); commit or \`git stash\` before retrying`,
        exitCode: EXIT_CODES.DIRTY_TREE,
      };
    }
  }

  // 3. Decision-log migration (one-time).
  const migration = migrateDecisionLogIfNeeded(opts.cwd, deps.migrationDeps);
  if (!migration.ok) {
    return {
      ok: false,
      error: migration.error,
      reason: migration.reason,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  // 4. Load manifest (corrupt → INTERNAL_ERROR).
  const loaded = loadIgnoreManifest(opts.cwd, deps.safeIO);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }
  const manifest: IgnoreManifest =
    loaded.manifest ?? { version: 1, entries: [] };

  // 5. Upsert entry (path-only — rule === null).
  const upserted = upsertEntry(manifest, {
    glob: opts.glob,
    rule: null,
    reason,
    expires,
    createdBy: "user",
    now,
  });

  // 6. Save manifest.
  const savedManifest: SafeResult<{ readonly path: string }> = saveIgnoreManifest(
    opts.cwd,
    upserted.manifest,
    deps.safeIO,
  );
  if (!savedManifest.ok) {
    return {
      ok: false,
      error: "manifest_write_failed",
      reason: savedManifest.error,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const filesChanged: string[] = [savedManifest.value.path];

  // 7. Compile presets.
  const compiled = compileToBothPresets(opts.cwd, upserted.manifest, deps.safeIO);
  if (!compiled.ok) {
    return {
      ok: false,
      error: compiled.error,
      reason: compiled.reason ?? "compile failed",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  for (const p of compiled.files_changed) filesChanged.push(p);

  // 8. Append decision-log entry.
  const author = (deps.authorFn ?? defaultAuthor)(opts.cwd);
  const templatePath = deps.templatePath ?? DECISIONS_TEMPLATE_DEFAULT;
  const decisionsAbs = join(opts.cwd, DECISION_LOG_PATH);
  const decisionsRaw = readFileFn(decisionsAbs);
  const loadedDecisions = loadOrInitDecisions(decisionsRaw, templatePath, readFileFn);
  if (!loadedDecisions.ok) {
    return {
      ok: false,
      error: "decisions_failed",
      reason: loadedDecisions.error,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const entryText = formatIgnoreDecision({
    action: upserted.action,
    glob: opts.glob,
    id: upserted.entry.id,
    reason,
    expires,
    author,
    now,
  });
  const appended = insertEntryBetweenMarkers(loadedDecisions.text, entryText);
  if (!appended.ok) {
    return {
      ok: false,
      error: "decisions_failed",
      reason: appended.error,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  const decisionsWrite = safeWriteFile(
    opts.cwd,
    DECISION_LOG_PATH,
    appended.text,
    { kind: "decisions", merged: decisionsRaw !== null },
    deps.safeIO,
  );
  if (!decisionsWrite.ok) {
    return {
      ok: false,
      error: "decisions_failed",
      reason: `${DECISION_LOG_PATH}: ${decisionsWrite.error}`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  filesChanged.push(decisionsWrite.value.path);

  return {
    ok: true,
    cwd: opts.cwd,
    glob: opts.glob,
    rule: null,
    action: upserted.action,
    id: upserted.entry.id,
    expires,
    files_changed: filesChanged,
    decision: { path: decisionsWrite.value.path, appended: true },
    exitCode: EXIT_CODES.OK,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly glob: string;
  readonly reason: string;
  readonly expires: string | null;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreAddArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let glob: string | null = null;
  let positional: string | null = null;
  let reason: string | null = null;
  let expires: string | null = null;
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
    if (arg === "--glob") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --glob" };
      }
      glob = value;
      i++;
      continue;
    }
    if (arg === "--reason") {
      const value = argv[i + 1];
      if (typeof value !== "string") {
        return { ok: false, error: "missing value for --reason" };
      }
      reason = value;
      i++;
      continue;
    }
    if (arg === "--expires") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --expires" };
      }
      expires = value;
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
    if (typeof arg === "string" && !arg.startsWith("-") && positional === null) {
      positional = arg;
      continue;
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }

  const resolvedGlob = glob ?? positional;
  if (resolvedGlob === null) {
    return {
      ok: false,
      error: "missing glob (use --glob <pattern> or pass as positional)",
    };
  }
  if (reason === null) {
    return { ok: false, error: "missing required flag: --reason" };
  }

  return {
    ok: true,
    value: {
      cwd,
      glob: resolvedGlob,
      reason,
      expires,
      strict,
    },
  };
}

export function runIgnoreAdd(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreAddArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-add <glob> --reason <text> [--expires <YYYY-MM-DD>]\n" +
          "                 [--strict] [--cwd <path>]\n" +
          "\n" +
          "Adds (or updates) a path-only ignore entry in .harn/qualy/ignore.json,\n" +
          "recompiles oxlint.{fast,deep}.json, and appends an `ignore-add` /\n" +
          "`ignore-update` entry to .harn/qualy/docs/lint-decisions.md.\n" +
          "\n" +
          "--reason is mandatory (SPEC §6 — exclusões são dívida técnica auditável).\n" +
          "--expires takes a future YYYY-MM-DD; past dates are rejected.\n" +
          "--strict refuses to write when the git working tree is dirty.\n" +
          "\n" +
          "Re-adding the same glob updates the entry in place (kind:ignore-update).\n" +
          "\n" +
          "Exit codes: 0 ok, 1 invalid input / preset missing / decisions failure,\n" +
          "  3 dirty tree under --strict, 4 usage, 70 ignore manifest corrupt.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "ignore-add", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreAdd({
    cwd: parsed.value.cwd,
    glob: parsed.value.glob,
    reason: parsed.value.reason,
    expires: parsed.value.expires,
    strict: parsed.value.strict,
  });

  if (!result.ok) {
    logger.error("ignore_add_failed", { reason: result.reason ?? result.error });
    output({ ok: false, error: result.error, reason: result.reason });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    glob: result.glob,
    rule: result.rule,
    action: result.action,
    id: result.id,
    expires: result.expires,
    files_changed: result.files_changed,
    decision: result.decision,
  });
  logger.info("ignore_add_ok", {
    glob: result.glob,
    action: result.action,
    id: result.id,
    files_changed: result.files_changed.length,
  });
  return result.exitCode;
}

// Re-exports for tests.
export { formatIgnoreDecision };

