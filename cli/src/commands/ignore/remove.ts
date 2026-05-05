/**
 * `ignore-remove` — remove one entry from `.harn/qualy/ignore.json`, recompile
 * both oxlint presets, and append an `ignore-remove` entry to
 * `.harn/qualy/docs/lint-decisions.md` (lint-ignore SPEC §3.2, PLAN T2.5).
 *
 * Match semantics (SPEC §3.2):
 *   - Without `--rule`, all entries whose `glob` field equals the positional
 *     argument exactly are candidates. If more than one match exists, exit
 *     `1` `entry_ambiguous` instructing the caller to pass `--rule` to
 *     disambiguate (path-only is `--rule null`, but the surface accepts
 *     `--rule path` as a synonym for clarity).
 *   - With `--rule <name>`, only the entry with the matching `(glob, rule)`
 *     pair is removed. `--rule path` is treated as `rule === null`.
 *   - Zero matches → exit `1` `entry_not_found`.
 *
 * `--reason` is mandatory (SPEC §6 — toda remoção precisa de motivo
 * registrado), mirroring `rules-remove`.
 *
 * Exit codes (canonical `EXIT_CODES`):
 *   - OK                — entry removed.
 *   - RECOVERABLE_ERROR — reason missing/empty, entry not found / ambiguous,
 *                         preset write failed, decisions append failed,
 *                         migration conflict.
 *   - DIRTY_TREE        — `--strict` and the working tree is dirty.
 *   - USAGE_ERROR       — flag parser failure / missing required flag.
 *   - INTERNAL_ERROR    — manifest corrupt / unsupported version.
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
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { dirtyFiles } from "../../lib/git.ts";
import { compileToBothPresets } from "../../lib/ignore-compile.ts";
import {
  type IgnoreEntry,
  loadIgnoreManifest,
  removeEntries,
  saveIgnoreManifest,
} from "../../lib/ignore-manifest.ts";
import { logger, output } from "../../lib/logger.ts";
import { DECISION_LOG_PATH } from "../../lib/paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** `null` matches path-only entries (`rule === null`); a string matches the
 *  per-rule entry with that exact rule id; `undefined` means "no constraint" —
 *  any entry with the given glob is a candidate. */
export type RuleSelector = string | null | undefined;

export interface IgnoreRemoveOptions {
  readonly cwd: string;
  readonly glob: string;
  readonly rule?: RuleSelector;
  readonly reason: string;
  readonly strict?: boolean;
}

export interface IgnoreRemoveOk {
  readonly ok: true;
  readonly cwd: string;
  readonly glob: string;
  readonly rule: string | null;
  readonly id: string;
  readonly files_changed: readonly string[];
  readonly decision: { readonly path: string; readonly appended: boolean };
  readonly exitCode: ExitCode;
}

export interface IgnoreRemoveErr {
  readonly ok: false;
  readonly error: string;
  readonly reason: string;
  readonly exitCode: ExitCode;
  /** When `error === "entry_ambiguous"`, lists the matching entries' ids
   *  and rules so the caller can disambiguate via `--rule`. */
  readonly candidates?: ReadonlyArray<{
    readonly id: string;
    readonly rule: string | null;
  }>;
}

export type IgnoreRemoveResult = IgnoreRemoveOk | IgnoreRemoveErr;

export interface IgnoreRemoveDeps {
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
  readonly glob: string;
  readonly rule: string | null;
  readonly id: string;
  readonly reason: string;
  readonly author: string;
  readonly now: Date;
}

function formatIgnoreRemoveDecision(inputs: DecisionInputs): string {
  const ruleLabel = inputs.rule ?? "(path-only)";
  const subject = `${inputs.glob} (${ruleLabel})`;
  return formatGenericEntry({
    timestamp: isoUtc(inputs.now),
    kind: "ignore-remove",
    subject,
    bullets: [
      ["kind", "ignore-remove"],
      ["glob", inputs.glob],
      ["rule", ruleLabel],
      ["id", inputs.id],
      ["author", inputs.author],
      ["reason", inputs.reason],
    ],
  });
}

// ---------------------------------------------------------------------------
// Match resolution
// ---------------------------------------------------------------------------

/** Normalize the surface `--rule` value into the manifest's `rule` shape.
 *  `--rule path` is accepted as a synonym for `null` so the slash command can
 *  always pass an explicit selector. */
function normalizeRuleSelector(rule: RuleSelector): RuleSelector {
  if (rule === undefined) return undefined;
  if (rule === null) return null;
  if (rule === "path" || rule === "(path-only)") return null;
  return rule;
}

interface ResolvedMatch {
  readonly entry: IgnoreEntry;
}

interface AmbiguousMatch {
  readonly candidates: ReadonlyArray<{
    readonly id: string;
    readonly rule: string | null;
  }>;
}

type MatchResult =
  | { readonly kind: "found"; readonly value: ResolvedMatch }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly value: AmbiguousMatch };

function resolveMatch(
  entries: readonly IgnoreEntry[],
  glob: string,
  selector: RuleSelector,
): MatchResult {
  const byGlob = entries.filter((e) => e.glob === glob);
  if (byGlob.length === 0) return { kind: "not_found" };

  if (selector === undefined) {
    if (byGlob.length === 1) {
      return { kind: "found", value: { entry: byGlob[0]! } };
    }
    return {
      kind: "ambiguous",
      value: {
        candidates: byGlob.map((e) => ({ id: e.id, rule: e.rule })),
      },
    };
  }

  const exact = byGlob.filter((e) => e.rule === selector);
  if (exact.length === 0) return { kind: "not_found" };
  // (glob, rule) pair is unique by construction (id derives from it).
  return { kind: "found", value: { entry: exact[0]! } };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function ignoreRemove(
  opts: IgnoreRemoveOptions,
  deps: IgnoreRemoveDeps = {},
): IgnoreRemoveResult {
  const reason = opts.reason.trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: "reason_required",
      reason:
        "ignore-remove drops a recorded exclusion; --reason <text> is mandatory and recorded in .harn/qualy/docs/lint-decisions.md",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  if (typeof opts.glob !== "string" || opts.glob.trim().length === 0) {
    return {
      ok: false,
      error: "invalid_glob",
      reason: "glob is empty",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  // 1. --strict pre-flight.
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

  // 2. Decision-log migration (one-time).
  const migration = migrateDecisionLogIfNeeded(opts.cwd, deps.migrationDeps);
  if (!migration.ok) {
    return {
      ok: false,
      error: migration.error,
      reason: migration.reason,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  // 3. Load manifest.
  const loaded = loadIgnoreManifest(opts.cwd, deps.safeIO);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }
  if (loaded.manifest === null || loaded.manifest.entries.length === 0) {
    return {
      ok: false,
      error: "entry_not_found",
      reason: `no entries in .harn/qualy/ignore.json (manifest is empty)`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  const manifest = loaded.manifest;

  // 4. Resolve the target entry.
  const selector = normalizeRuleSelector(opts.rule);
  const match = resolveMatch(manifest.entries, opts.glob, selector);
  if (match.kind === "not_found") {
    return {
      ok: false,
      error: "entry_not_found",
      reason:
        selector === undefined
          ? `no entry matches glob "${opts.glob}"`
          : `no entry matches (glob: "${opts.glob}", rule: ${selector === null ? "(path-only)" : selector})`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: "entry_ambiguous",
      reason: `glob "${opts.glob}" matches ${match.value.candidates.length} entries; pass --rule to disambiguate (use "--rule path" for the path-only entry)`,
      candidates: match.value.candidates,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const target = match.value.entry;

  // 5. Drop the entry from the manifest.
  const removed = removeEntries(manifest, (e) => e.id === target.id);

  // 6. Save manifest.
  const savedManifest = saveIgnoreManifest(
    opts.cwd,
    removed.manifest,
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

  // 7. Recompile presets.
  const compiled = compileToBothPresets(opts.cwd, removed.manifest, deps.safeIO);
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
  const now = deps.now ? deps.now() : new Date();
  const author = (deps.authorFn ?? defaultAuthor)(opts.cwd);
  const templatePath = deps.templatePath ?? DECISIONS_TEMPLATE_DEFAULT;
  const readFileFn = deps.readFileFn ?? defaultRead;

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

  const entryText = formatIgnoreRemoveDecision({
    glob: target.glob,
    rule: target.rule,
    id: target.id,
    reason,
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
    glob: target.glob,
    rule: target.rule,
    id: target.id,
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
  readonly rule: RuleSelector;
  readonly reason: string;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreRemoveArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let glob: string | null = null;
  let positional: string | null = null;
  let rule: RuleSelector = undefined;
  let reason: string | null = null;
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
    if (arg === "--rule") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --rule" };
      }
      rule = value;
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
      rule,
      reason,
      strict,
    },
  };
}

export function runIgnoreRemove(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreRemoveArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-remove <glob> --reason <text> [--rule <name>|path]\n" +
          "                    [--strict] [--cwd <path>]\n" +
          "\n" +
          "Removes one entry from .harn/qualy/ignore.json, recompiles\n" +
          "oxlint.{fast,deep}.json, and appends an `ignore-remove` entry to\n" +
          ".harn/qualy/docs/lint-decisions.md.\n" +
          "\n" +
          "Without --rule, the glob must match exactly one entry; ambiguous\n" +
          "matches require --rule to disambiguate (--rule path selects the\n" +
          "path-only entry).\n" +
          "\n" +
          "--reason is mandatory (SPEC §6 — every removal records its motive).\n" +
          "--strict refuses to write when the git working tree is dirty.\n" +
          "\n" +
          "Exit codes: 0 ok, 1 entry not found / ambiguous / preset / decisions,\n" +
          "  3 dirty tree under --strict, 4 usage, 70 ignore manifest corrupt.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "ignore-remove", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreRemove({
    cwd: parsed.value.cwd,
    glob: parsed.value.glob,
    rule: parsed.value.rule,
    reason: parsed.value.reason,
    strict: parsed.value.strict,
  });

  if (!result.ok) {
    logger.error("ignore_remove_failed", { reason: result.reason ?? result.error });
    output({
      ok: false,
      error: result.error,
      reason: result.reason,
      ...(result.candidates ? { candidates: result.candidates } : {}),
    });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    glob: result.glob,
    rule: result.rule,
    id: result.id,
    files_changed: result.files_changed,
    decision: result.decision,
  });
  logger.info("ignore_remove_ok", {
    glob: result.glob,
    id: result.id,
    files_changed: result.files_changed.length,
  });
  return result.exitCode;
}

// Re-exports for tests.
export { formatIgnoreRemoveDecision };
