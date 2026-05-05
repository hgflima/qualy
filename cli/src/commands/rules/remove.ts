/**
 * `rules-remove` — disable an oxlint rule in the project's preset (one tier at
 * a time) and append a `rule-remove` entry to `.harn/qualy/docs/lint-decisions.md`.
 *
 * SPEC §2 `/lint:rules:remove <rule>`: "Remove uma rule específica do preset
 * ativo. Pergunta o motivo (registrado em `.harn/qualy/docs/lint-decisions.md` no
 * projeto-alvo) e confirma."
 * SPEC §6 Always (line 389): every add/remove of a rule must be recorded in
 * `.harn/qualy/docs/lint-decisions.md` with the user's reason — `--reason` is therefore
 * mandatory and must be non-empty.
 *
 * Tier resolution (mirrors `rules-add`):
 *   - `quality-metrics/*`  → `deep`.
 *   - `category:<name>`    → `fast`.
 *   - everything else      → `fast`.
 * Override with `--tier fast|deep`.
 *
 * Idempotency: when the rule is absent in the target tier, return
 * `action: "already-absent"` with `applied: false` — no preset write, no
 * decision append.
 *
 * Dry-run (`--dry-run`):
 *   - Never writes to disk.
 *   - Returns `action: "would-remove"` (or `already-absent`) plus the previous
 *     severity/max so the harness can preview the change.
 *
 * Output (PLAN §Contratos CLI shape):
 *   applied form:
 *     { ok, cwd, rule, tier, applies_to, action: "removed",
 *       previous: { severity, max? }, applied: true,
 *       files_changed, decision: { path, appended }, dry_run: false }
 *   already-absent form:
 *     { ok, cwd, rule, tier, applies_to, action: "already-absent",
 *       previous: null, applied: false, files_changed: [],
 *       decision: null, dry_run: false }
 *   dry-run form:
 *     { ok, cwd, rule, tier, applies_to,
 *       action: "would-remove" | "already-absent",
 *       previous: { severity, max? } | null, applied: false,
 *       files_changed: [], decision: null, dry_run: true }
 *   error form:
 *     { ok: false, error, reason? }
 *
 * Exit codes:
 *   - OK                 — applied (or dry-run completed; or already absent).
 *   - RECOVERABLE_ERROR  — preset missing/malformed, unknown rule, missing or
 *                          empty `--reason`, write fail, decisions append fail.
 *   - DIRTY_TREE         — `--strict` and the working tree is dirty.
 *   - USAGE_ERROR        — flag parser failure / missing required flag.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type RuleSeverity } from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { dirtyFiles } from "../../lib/git.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

import {
  KNOWN_RULES,
  PRESET_FILES,
  readExistingEntry,
  type Tier,
} from "./add.ts";
import {
  formatDecisionEntry as formatGenericEntry,
  insertEntryBetweenMarkers,
  loadOrInitDecisions,
} from "../../lib/decision-log.ts";
import {
  migrateDecisionLogIfNeeded,
  type DecisionLogMigrationDeps,
} from "../../lib/decision-log-migration.ts";
import { DECISION_LOG_PATH } from "../../lib/paths.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RulesRemoveOptions {
  readonly cwd: string;
  readonly rule: string;
  readonly reason?: string;
  readonly tier?: Tier;
  readonly dryRun?: boolean;
  readonly strict?: boolean;
}

export interface PreviousEntry {
  readonly severity: RuleSeverity;
  readonly max?: number;
}

export interface RulesRemoveApplied {
  readonly ok: true;
  readonly cwd: string;
  readonly rule: string;
  readonly tier: Tier;
  readonly applies_to: string;
  readonly action: "removed" | "already-absent";
  readonly previous: PreviousEntry | null;
  readonly applied: boolean;
  readonly files_changed: readonly string[];
  readonly decision: { readonly path: string; readonly appended: boolean } | null;
  readonly dry_run: false;
}

export interface RulesRemoveDryRun {
  readonly ok: true;
  readonly cwd: string;
  readonly rule: string;
  readonly tier: Tier;
  readonly applies_to: string;
  readonly action: "would-remove" | "already-absent";
  readonly previous: PreviousEntry | null;
  readonly applied: false;
  readonly files_changed: readonly [];
  readonly decision: null;
  readonly dry_run: true;
}

export interface RulesRemoveErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type RulesRemoveResult =
  | RulesRemoveApplied
  | RulesRemoveDryRun
  | RulesRemoveErr;

export interface RulesRemoveDeps {
  readonly readFileFn?: (p: string) => string | null;
  readonly existsFn?: (p: string) => boolean;
  readonly safeIO?: SafeIO;
  readonly authorFn?: (cwd: string) => string;
  readonly now?: () => Date;
  readonly templatePath?: string;
  readonly dirtyFilesFn?: (
    cwd: string,
  ) => { ok: true; value: readonly string[] } | { ok: false; error: string };
  /** Optional override for the one-time decision-log migration helper. */
  readonly migrationDeps?: DecisionLogMigrationDeps;
}

// ---------------------------------------------------------------------------
// IO defaults
// ---------------------------------------------------------------------------

const DECISIONS_TEMPLATE_DEFAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "lint-decisions.md.tpl",
);

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultExists(p: string): boolean {
  return existsSync(p);
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

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export function defaultTierForRule(rule: string): Tier {
  if (rule.startsWith("quality-metrics/")) return "deep";
  return "fast";
}

interface PresetShape {
  _comment?: unknown;
  categories?: unknown;
  rules?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Preset edits
// ---------------------------------------------------------------------------

interface PresetRemoveEdit {
  readonly content: string;
  readonly proposed: PresetShape;
  readonly action: "removed" | "already-absent";
}

export function applyRemoveRule(
  current: PresetShape,
  rule: string,
  existing: PreviousEntry | null,
): PresetRemoveEdit {
  const proposed: PresetShape = JSON.parse(JSON.stringify(current));

  if (existing === null) {
    return {
      content: stringifyPretty(proposed),
      proposed,
      action: "already-absent",
    };
  }

  if (rule.startsWith("category:")) {
    const cat = rule.slice("category:".length);
    if (proposed.categories !== null && typeof proposed.categories === "object") {
      const cats = proposed.categories as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(cats, cat)) {
        delete cats[cat];
        proposed.categories = cats;
      }
    }
  } else {
    if (proposed.rules !== null && typeof proposed.rules === "object") {
      const rules = proposed.rules as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(rules, rule)) {
        delete rules[rule];
        proposed.rules = rules;
      }
    }
  }

  return {
    content: stringifyPretty(proposed),
    proposed,
    action: "removed",
  };
}

// ---------------------------------------------------------------------------
// Decisions log entry
// ---------------------------------------------------------------------------

interface DecisionFields {
  readonly timestamp: string;
  readonly kind: "rule-remove";
  readonly subject: string;
  readonly rule: string;
  readonly author: string;
  readonly reason: string;
}

function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildDecisionFields(
  rule: string,
  previous: PreviousEntry,
  author: string,
  reason: string,
  now: Date,
): DecisionFields {
  const subject =
    previous.max !== undefined
      ? `${rule} (was severity=${previous.severity}, max=${previous.max})`
      : `${rule} (was severity=${previous.severity})`;
  return {
    timestamp: isoUtc(now),
    kind: "rule-remove",
    subject,
    rule,
    author,
    reason,
  };
}

/** Adapter over the generic formatter in `lib/decision-log.ts` — preserves
 *  the byte-exact bullet order pinned by `rules-decisions-format` tests. */
export function formatDecisionEntry(fields: DecisionFields): string {
  return formatGenericEntry({
    timestamp: fields.timestamp,
    kind: fields.kind,
    subject: fields.subject,
    bullets: [
      ["kind", fields.kind],
      ["rule", fields.rule],
      ["author", fields.author],
      ["reason", fields.reason],
    ],
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function rulesRemove(
  opts: RulesRemoveOptions,
  deps: RulesRemoveDeps = {},
): RulesRemoveResult {
  if (!KNOWN_RULES.has(opts.rule)) {
    return {
      ok: false,
      error: "unknown_rule",
      reason: `rule '${opts.rule}' is not in the qualy catalog (run \`qualy rules-list\` to see catalog rules)`,
    };
  }

  const reason = (opts.reason ?? "").trim();
  if (opts.dryRun !== true && reason.length === 0) {
    return {
      ok: false,
      error: "reason_required",
      reason:
        "rules-remove loosens enforcement; --reason <text> is mandatory and recorded in .harn/qualy/docs/lint-decisions.md",
    };
  }

  const tier: Tier = opts.tier ?? defaultTierForRule(opts.rule);
  const presetRel = PRESET_FILES[tier];
  const presetAbs = join(opts.cwd, presetRel);
  const readFileFn = deps.readFileFn ?? defaultRead;

  const raw = readFileFn(presetAbs);
  if (raw === null) {
    return {
      ok: false,
      error: "preset_missing",
      reason: `${presetRel} not found under ${opts.cwd} — run /lint:setup first`,
    };
  }
  const parsed = parseDefensive<PresetShape>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return {
      ok: false,
      error: "preset_malformed",
      reason: `${presetRel}: ${parsed.ok ? "not an object" : parsed.error}`,
    };
  }
  const preset = parsed.value;
  const existing = readExistingEntry(preset, opts.rule);
  const edit = applyRemoveRule(preset, opts.rule, existing);

  // Strict pre-flight (only meaningful for actual writes; skip for dry-run).
  if (opts.dryRun !== true && opts.strict === true && edit.action === "removed") {
    const dirtyFn = deps.dirtyFilesFn ?? defaultDirtyFiles;
    const r = dirtyFn(opts.cwd);
    if (!r.ok) return { ok: false, error: "git_check_failed", reason: r.error };
    if (r.value.length > 0) {
      return {
        ok: false,
        error: "dirty_tree",
        reason: `working tree has ${r.value.length} unstaged file(s)`,
      };
    }
  }

  // Dry-run — no writes.
  if (opts.dryRun === true) {
    const action: RulesRemoveDryRun["action"] =
      edit.action === "removed" ? "would-remove" : "already-absent";
    return {
      ok: true,
      cwd: opts.cwd,
      rule: opts.rule,
      tier,
      applies_to: presetRel,
      action,
      previous: existing,
      applied: false,
      files_changed: [],
      decision: null,
      dry_run: true,
    };
  }

  // Idempotent no-op when the rule is already absent — never write the preset
  // and never append a decision.
  if (edit.action === "already-absent") {
    return {
      ok: true,
      cwd: opts.cwd,
      rule: opts.rule,
      tier,
      applies_to: presetRel,
      action: "already-absent",
      previous: null,
      applied: false,
      files_changed: [],
      decision: null,
      dry_run: false,
    };
  }

  // Write the preset.
  const filesChanged: string[] = [];
  const writeRes = safeWriteFile(
    opts.cwd,
    presetRel,
    edit.content,
    { kind: "preset", merged: true },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return {
      ok: false,
      error: "write_failed",
      reason: `${presetRel}: ${writeRes.error}`,
    };
  }
  filesChanged.push(writeRes.value.path);

  // Append the decision.
  const now = deps.now ? deps.now() : new Date();
  const author = (deps.authorFn ?? defaultAuthor)(opts.cwd);
  const templatePath = deps.templatePath ?? DECISIONS_TEMPLATE_DEFAULT;

  const migration = migrateDecisionLogIfNeeded(opts.cwd, deps.migrationDeps);
  if (!migration.ok) {
    return { ok: false, error: migration.error, reason: migration.reason };
  }

  const decisionsAbs = join(opts.cwd, DECISION_LOG_PATH);
  const decisionsRaw = readFileFn(decisionsAbs);
  const loaded = loadOrInitDecisions(decisionsRaw, templatePath, readFileFn);
  if (!loaded.ok) {
    return { ok: false, error: "decisions_failed", reason: loaded.error };
  }
  const fields = buildDecisionFields(
    opts.rule,
    existing as PreviousEntry,
    author,
    reason,
    now,
  );
  const entryText = formatDecisionEntry(fields);
  const appended = insertEntryBetweenMarkers(loaded.text, entryText);
  if (!appended.ok) {
    return { ok: false, error: "decisions_failed", reason: appended.error };
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
    };
  }
  filesChanged.push(decisionsWrite.value.path);

  return {
    ok: true,
    cwd: opts.cwd,
    rule: opts.rule,
    tier,
    applies_to: presetRel,
    action: "removed",
    previous: existing,
    applied: true,
    files_changed: filesChanged,
    decision: { path: decisionsWrite.value.path, appended: true },
    dry_run: false,
  };
}

// keep defaultExists referenced for parity with rules-add (even though
// rules-remove only consumes readFileFn for now — symmetric DI surface).
void defaultExists;

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly rule: string;
  readonly reason?: string;
  readonly tier?: Tier;
  readonly dryRun: boolean;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRulesRemoveArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let rule: string | null = null;
  let positional: string | null = null;
  let reason: string | undefined;
  let tier: Tier | undefined;
  let dryRun = false;
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
    if (arg === "--tier") {
      const value = argv[i + 1];
      if (value !== "fast" && value !== "deep") {
        return { ok: false, error: "missing value for --tier (expected fast|deep)" };
      }
      tier = value;
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
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

  const resolvedRule = rule ?? positional;
  if (resolvedRule === null) {
    return {
      ok: false,
      error: "missing rule (use --rule <name> or pass as positional)",
    };
  }

  return {
    ok: true,
    value: {
      cwd,
      rule: resolvedRule,
      ...(reason !== undefined ? { reason } : {}),
      ...(tier !== undefined ? { tier } : {}),
      dryRun,
      strict,
    },
  };
}

export function runRulesRemove(argv: readonly string[]): ExitCode {
  const parsed = parseRulesRemoveArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy rules-remove <rule> --reason <text> [--tier <fast|deep>]\n" +
          "                   [--cwd <path>] [--dry-run] [--strict]\n" +
          "\n" +
          "Disables a rule in the project's oxlint preset (one tier at a time).\n" +
          "Defaults the tier from the rule namespace (quality-metrics/* → deep,\n" +
          "category:* and oxlint built-ins → fast).\n" +
          "\n" +
          "--reason is mandatory (SPEC §6 line 389): rule removal loosens\n" +
          "enforcement and the rationale is appended to .harn/qualy/docs/lint-decisions.md\n" +
          "as an audit trail entry.\n" +
          "\n" +
          "On success, writes the preset and appends a `rule-remove` entry to\n" +
          ".harn/qualy/docs/lint-decisions.md. With --dry-run, prints the proposed action\n" +
          "without writing (and without requiring --reason).\n" +
          "\n" +
          "Exit codes: 0 ok, 1 preset/decisions/unknown-rule/missing-reason,\n" +
          "  3 dirty tree under --strict, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "rules-remove", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = rulesRemove({
    cwd: parsed.value.cwd,
    rule: parsed.value.rule,
    dryRun: parsed.value.dryRun,
    strict: parsed.value.strict,
    ...(parsed.value.reason !== undefined ? { reason: parsed.value.reason } : {}),
    ...(parsed.value.tier !== undefined ? { tier: parsed.value.tier } : {}),
  });

  if (!result.ok) {
    logger.error("rules_remove_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "dirty_tree") return EXIT_CODES.DIRTY_TREE;
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  if (result.dry_run) {
    logger.info("rules_remove_dry_run", {
      rule: result.rule,
      tier: result.tier,
      action: result.action,
    });
  } else {
    logger.info("rules_remove_ok", {
      rule: result.rule,
      tier: result.tier,
      action: result.action,
      applied: result.applied,
      files_changed: result.files_changed.length,
    });
  }
  return EXIT_CODES.OK;
}
