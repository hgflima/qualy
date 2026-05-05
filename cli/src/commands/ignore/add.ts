/**
 * `ignore-add` — author / update an ignore entry in `.harn/qualy/ignore.json`,
 * recompile both oxlint presets, and append a `ignore-add`/`ignore-update`
 * entry to `.harn/qualy/docs/lint-decisions.md` (lint-ignore SPEC §3.1, PLAN
 * T2.4 + T3.3).
 *
 * Scope:
 *   - path-only entries (`--rule` omitted) → `ignorePatterns[]` exclusion.
 *   - per-rule entries (`--rule quality-metrics/wmc`, `--rule eslint/no-debugger`,
 *     etc.) → managed override block silencing the named rule on the glob.
 *   - category entries (`--rule category:correctness`) → managed override block
 *     silencing every rule in the category. Requires
 *     `--i-know-this-disables-many` to acknowledge the blast radius
 *     (SPEC §3.1.1). The slash command `/lint:ignore:add` injects this flag
 *     after surfacing the category size via `AskUserQuestion`.
 *
 * Validation:
 *   - `quality-metrics/<name>` must be a known qualy metric rule
 *     (wmc/halstead/lcom/cbo/dit). Unknown QM names fail fast with
 *     `unknown_rule` so typos do not silently land an opaque entry.
 *   - `category:<name>` must be in `KNOWN_CATEGORIES` from the static catalog.
 *   - All other rule strings are accepted opaque (third-party plugins, future
 *     oxlint rules) — oxlint will surface its own error if the rule does not
 *     exist at lint time.
 *
 * Brownfield import (auto-importing user-authored `ignorePatterns[]` outside
 * the markers) is deferred to T3.4 — until then this command assumes a
 * greenfield manifest or a manifest already authored by qualy.
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

import { METRIC_KEYS } from "../../lib/audit-schema.ts";
import {
  getCategorySize,
  isKnownCategory,
  KNOWN_CATEGORIES,
} from "../../lib/category-catalog.ts";
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
  applyImportToPresets,
  importBrownfieldIgnores,
  type ImportedPattern,
  IMPORT_REASON,
} from "../../lib/ignore-import.ts";
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
  readonly rule?: string | null;
  readonly expires?: string | null;
  readonly strict?: boolean;
  /** Required when `rule` is `category:<name>` — acknowledges that the
   *  exclusion silences every rule in the category on the glob (SPEC §3.1.1).
   *  Slash commands inject this after `AskUserQuestion` confirmation. */
  readonly acknowledgeCategory?: boolean;
}

export interface IgnoreAddOk {
  readonly ok: true;
  readonly cwd: string;
  readonly glob: string;
  readonly rule: string | null;
  readonly action: "added" | "updated";
  readonly id: string;
  readonly expires: string | null;
  readonly files_changed: readonly string[];
  readonly decision: { readonly path: string; readonly appended: boolean };
  /** Brownfield patterns imported on the first mutation (T3.4). Empty on
   *  greenfield manifests, on subsequent mutations, and when neither preset
   *  has user-authored `ignorePatterns[]` outside the qualy markers. */
  readonly imported: readonly ImportedPattern[];
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
// Rule validation
// ---------------------------------------------------------------------------

/** Set of `quality-metrics/<name>` rule ids that qualy ships and audits.
 *  An ignore-add for a typo'd QM rule (e.g. `quality-metrics/wcm`) would
 *  silently land in the manifest without ever silencing anything — so we
 *  validate against this set up-front. Source of truth: `audit-schema.ts`
 *  `METRIC_KEYS`. */
const KNOWN_QUALITY_METRICS_RULES: ReadonlySet<string> = new Set(
  METRIC_KEYS.map((k) => `quality-metrics/${k}`),
);

const QM_PREFIX = "quality-metrics/";
const CATEGORY_PREFIX = "category:";

interface RuleValidationOk {
  readonly ok: true;
  /** Normalised rule string, or `null` for path-only entries. */
  readonly rule: string | null;
}

interface RuleValidationErr {
  readonly ok: false;
  readonly error: "unknown_rule" | "unknown_category" | "category_requires_ack";
  readonly reason: string;
}

type RuleValidationResult = RuleValidationOk | RuleValidationErr;

function validateRule(
  raw: string | null | undefined,
  acknowledgeCategory: boolean,
): RuleValidationResult {
  if (raw === null || raw === undefined) return { ok: true, rule: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, rule: null };

  if (trimmed.startsWith(CATEGORY_PREFIX)) {
    const name = trimmed.slice(CATEGORY_PREFIX.length);
    if (!isKnownCategory(name)) {
      return {
        ok: false,
        error: "unknown_category",
        reason: `category '${name}' is not in the qualy catalog (known: ${KNOWN_CATEGORIES.join(", ")})`,
      };
    }
    if (!acknowledgeCategory) {
      const size = getCategorySize(name);
      return {
        ok: false,
        error: "category_requires_ack",
        reason: `--rule ${trimmed} silences ${size} rules on this glob; pass --i-know-this-disables-many to acknowledge`,
      };
    }
    return { ok: true, rule: trimmed };
  }

  if (trimmed.startsWith(QM_PREFIX)) {
    if (!KNOWN_QUALITY_METRICS_RULES.has(trimmed)) {
      const known = [...KNOWN_QUALITY_METRICS_RULES].sort().join(", ");
      return {
        ok: false,
        error: "unknown_rule",
        reason: `rule '${trimmed}' is not a known quality-metrics rule (known: ${known})`,
      };
    }
    return { ok: true, rule: trimmed };
  }

  // Opaque rule (third-party plugin, future oxlint rule). Accept as-is —
  // oxlint surfaces its own error if the rule doesn't exist at lint time.
  return { ok: true, rule: trimmed };
}

// ---------------------------------------------------------------------------
// Decision-log entry
// ---------------------------------------------------------------------------

function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface DecisionInputs {
  readonly action: "added" | "updated";
  readonly glob: string;
  readonly rule: string | null;
  readonly id: string;
  readonly reason: string;
  readonly expires: string | null;
  readonly author: string;
  readonly now: Date;
}

function formatIgnoreDecision(inputs: DecisionInputs): string {
  const kind = inputs.action === "added" ? "ignore-add" : "ignore-update";
  const ruleLabel = inputs.rule ?? "(path-only)";
  const subject = `${inputs.glob} ${inputs.rule === null ? "(path-only)" : `(${inputs.rule})`}`;
  return formatGenericEntry({
    timestamp: isoUtc(inputs.now),
    kind,
    subject,
    bullets: [
      ["kind", kind],
      ["glob", inputs.glob],
      ["rule", ruleLabel],
      ["id", inputs.id],
      ["expires", inputs.expires ?? "(never)"],
      ["author", inputs.author],
      ["reason", inputs.reason],
    ],
  });
}

interface ImportDecisionInputs {
  readonly imported: readonly ImportedPattern[];
  readonly author: string;
  readonly now: Date;
}

/** Single batch entry recording every pattern brownfield-imported on the
 *  first mutation (SPEC §2.4). The pattern list and id list are rendered as
 *  comma-joined strings so the decision log stays one-line-per-bullet —
 *  matches the existing rules-add / rec-apply shape. */
function formatImportDecision(inputs: ImportDecisionInputs): string {
  const count = inputs.imported.length;
  const subject = `${count} ${count === 1 ? "pattern" : "patterns"} imported from oxlint preset`;
  return formatGenericEntry({
    timestamp: isoUtc(inputs.now),
    kind: "ignore-import",
    subject,
    bullets: [
      ["kind", "ignore-import"],
      ["count", String(count)],
      ["patterns", inputs.imported.map((p) => p.glob).join(", ")],
      ["ids", inputs.imported.map((p) => p.id).join(", ")],
      ["author", inputs.author],
      ["reason", IMPORT_REASON],
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

  // Validate optional `--rule` (path-only when null/empty; quality-metrics/*
  // and category:* are gated against the static catalog; everything else is
  // opaque per SPEC §3.1).
  const ruleCheck = validateRule(
    opts.rule ?? null,
    opts.acknowledgeCategory === true,
  );
  if (!ruleCheck.ok) {
    return {
      ok: false,
      error: ruleCheck.error,
      reason: ruleCheck.reason,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  const rule = ruleCheck.rule;

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

  // 4a. Brownfield import (T3.4): on the first mutation, scoop up any
  //    user-authored `ignorePatterns[]` outside the qualy markers and turn
  //    them into `createdBy: "imported"` entries. No-op when manifest already
  //    has entries OR no non-marker patterns exist.
  const importResult = importBrownfieldIgnores(
    opts.cwd,
    manifest,
    now,
    deps.safeIO,
  );
  const enrichedManifest = importResult.manifest;
  const imported = importResult.imported;

  // 5. Upsert entry. `rule` is null for path-only, otherwise the validated
  // rule string (quality-metrics/<name>, category:<name>, or opaque).
  const upserted = upsertEntry(enrichedManifest, {
    glob: opts.glob,
    rule,
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

  // 6a. Strip imported patterns from outside the markers so the next compile
  //    can re-emit them inside the managed block without leaving duplicates.
  if (imported.length > 0) {
    const stripped = applyImportToPresets(
      opts.cwd,
      imported.map((p) => p.glob),
      deps.safeIO,
    );
    if (!stripped.ok) {
      return {
        ok: false,
        error: stripped.error,
        reason: stripped.reason,
        exitCode: EXIT_CODES.RECOVERABLE_ERROR,
      };
    }
    for (const p of stripped.files_changed) {
      if (!filesChanged.includes(p)) filesChanged.push(p);
    }
  }

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

  // Order matters: the brownfield import happened before the user's add/
  // update, so the decision log records `ignore-import` first when present.
  let pendingText = loadedDecisions.text;
  if (imported.length > 0) {
    const importEntry = formatImportDecision({ imported, author, now });
    const r = insertEntryBetweenMarkers(pendingText, importEntry);
    if (!r.ok) {
      return {
        ok: false,
        error: "decisions_failed",
        reason: r.error,
        exitCode: EXIT_CODES.RECOVERABLE_ERROR,
      };
    }
    pendingText = r.text;
  }

  const entryText = formatIgnoreDecision({
    action: upserted.action,
    glob: opts.glob,
    rule,
    id: upserted.entry.id,
    reason,
    expires,
    author,
    now,
  });
  const appended = insertEntryBetweenMarkers(pendingText, entryText);
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
    rule,
    action: upserted.action,
    id: upserted.entry.id,
    expires,
    files_changed: filesChanged,
    decision: { path: decisionsWrite.value.path, appended: true },
    imported,
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
  readonly rule: string | null;
  readonly expires: string | null;
  readonly strict: boolean;
  readonly acknowledgeCategory: boolean;
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
  let rule: string | null = null;
  let expires: string | null = null;
  let strict = false;
  let acknowledgeCategory = false;

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
    if (arg === "--rule") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --rule" };
      }
      rule = value;
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
    if (arg === "--i-know-this-disables-many") {
      acknowledgeCategory = true;
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
      rule,
      expires,
      strict,
      acknowledgeCategory,
    },
  };
}

export function runIgnoreAdd(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreAddArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-add <glob> --reason <text> [--rule <rule-id>]\n" +
          "                 [--expires <YYYY-MM-DD>] [--strict]\n" +
          "                 [--i-know-this-disables-many] [--cwd <path>]\n" +
          "\n" +
          "Adds (or updates) an ignore entry in .harn/qualy/ignore.json,\n" +
          "recompiles oxlint.{fast,deep}.json, and appends an `ignore-add` /\n" +
          "`ignore-update` entry to .harn/qualy/docs/lint-decisions.md.\n" +
          "\n" +
          "--reason is mandatory (SPEC §6 — exclusões são dívida técnica auditável).\n" +
          "--rule scopes the exclusion to a single rule (e.g. quality-metrics/wmc,\n" +
          "  eslint/no-debugger) or a whole category (category:correctness). Omit\n" +
          "  for a path-only exclusion.\n" +
          "--expires takes a future YYYY-MM-DD; past dates are rejected.\n" +
          "--strict refuses to write when the git working tree is dirty.\n" +
          "--i-know-this-disables-many is required when --rule category:* is set\n" +
          "  (SPEC §3.1.1 — categories silence dozens of rules at once).\n" +
          "\n" +
          "Re-adding the same (glob, rule) updates the entry in place\n" +
          "(kind:ignore-update).\n" +
          "\n" +
          "Exit codes: 0 ok, 1 invalid input / unknown rule / category without\n" +
          "  ack / preset missing / decisions failure, 3 dirty tree under\n" +
          "  --strict, 4 usage, 70 ignore manifest corrupt.\n",
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
    rule: parsed.value.rule,
    expires: parsed.value.expires,
    strict: parsed.value.strict,
    acknowledgeCategory: parsed.value.acknowledgeCategory,
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
    imported: result.imported,
  });
  logger.info("ignore_add_ok", {
    glob: result.glob,
    action: result.action,
    id: result.id,
    files_changed: result.files_changed.length,
    imported: result.imported.length,
  });
  return result.exitCode;
}

// Re-exports for tests.
export { formatImportDecision, formatIgnoreDecision };

