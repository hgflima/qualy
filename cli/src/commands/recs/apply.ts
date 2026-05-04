/**
 * `recs-apply` — applies a single recommendation from `.lint-audit/<ts>.json`
 * to the project and appends an entry to `docs/lint-decisions.md`.
 *
 * Contract: SPEC §7.6 acceptance + §6 Always ("registrar add/remove de rules
 * em docs/lint-decisions.md com motivo capturado do usuário"); PLAN §Contratos
 * CLI line 79 (`recs-apply --rec-id <id> --audit <path>` → `{ files_changed }`).
 *
 * Per ADR 0008 the canonical input is `audit.recommendations[]` (the enriched
 * array produced by the `lint-auditor` subagent), NOT `recs-generate`'s
 * `candidates[]`. This keeps the audit→update contract single-sourced.
 *
 * Type matrix:
 *   - raise/lower-threshold, add-rule, remove-rule  → edit oxlint preset
 *   - tighten/loosen-coverage                        → edit vitest config or
 *                                                       `jest.config.json`
 *   - enable-tier, fix-tooling                       → not applicable here;
 *                                                       harness must delegate
 *                                                       to `/lint:setup` or
 *                                                       `install-deps`. We
 *                                                       return applicable:false
 *                                                       so the orchestrator can
 *                                                       branch without a hard
 *                                                       error.
 *
 * Reason capture (SPEC §6):
 *   `--reason` is REQUIRED for any change that loosens enforcement
 *   (`lower-threshold`, `remove-rule`, `loosen-coverage`). For tightening
 *   changes it is optional but still recorded when supplied.
 *
 * Output (PLAN §Contratos CLI):
 *   ok form:
 *     { ok, cwd, recommendation_id, applied: true, kind, files_changed: [..],
 *       decision: { path, appended: bool } }
 *   skipped form:
 *     { ok, cwd, recommendation_id, applied: false, reason, delegate? }
 *   error form:
 *     { ok: false, error, reason? }
 *
 * Exit codes:
 *   - OK                 — patch applied (or skipped with applicable:false).
 *   - RECOVERABLE_ERROR  — audit/preset/coverage config missing or malformed,
 *                          recommendation id not found, write failed,
 *                          missing reason for a loosening change.
 *   - DIRTY_TREE         — `--strict` set and working tree dirty.
 *   - USAGE_ERROR        — flag parser failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AuditPayload,
  type Recommendation,
  validateAuditPayload,
} from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  resolveSafePath,
  safeWriteFile,
} from "../../lib/fs-safe.ts";
import { dirtyFiles } from "../../lib/git.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";
import { applyVitestCoverage } from "../../lib/ts-config-edit.ts";

import { auditLatest } from "../audit-latest.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const APPLICABLE_TYPES = new Set<Recommendation["type"]>([
  "raise-threshold",
  "lower-threshold",
  "add-rule",
  "remove-rule",
  "tighten-coverage",
  "loosen-coverage",
]);

const REASON_REQUIRED_TYPES = new Set<Recommendation["type"]>([
  "lower-threshold",
  "remove-rule",
  "loosen-coverage",
]);

const KIND_BY_TYPE: Readonly<Record<Recommendation["type"], string>> = {
  "raise-threshold": "threshold-raise",
  "lower-threshold": "threshold-lower",
  "add-rule": "rule-add",
  "remove-rule": "rule-remove",
  "tighten-coverage": "rec-apply",
  "loosen-coverage": "coverage-lower",
  "enable-tier": "rec-apply",
  "fix-tooling": "rec-apply",
};

export const DECISIONS_REL = "docs/lint-decisions.md";
const DECISIONS_TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "lint-decisions.md.tpl",
);
const ENTRIES_START = "<!-- qualy:entries-start -->";
const ENTRIES_END = "<!-- qualy:entries-end -->";

const VITEST_CONFIG_CANDIDATES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
] as const;

const JEST_JSON_CONFIG = "jest.config.json";
const COVERAGE_KEYS = ["lines", "functions", "branches", "statements"] as const;
type CoverageKey = (typeof COVERAGE_KEYS)[number];

export interface RecsApplyOptions {
  readonly cwd: string;
  readonly audit: AuditPayload;
  readonly recId: string;
  readonly reason?: string;
  readonly strict?: boolean;
}

export interface AppliedDecision {
  readonly path: string;
  readonly appended: boolean;
}

export interface RecsApplyOk {
  readonly ok: true;
  readonly cwd: string;
  readonly recommendation_id: string;
  readonly applied: true;
  readonly kind: string;
  readonly files_changed: readonly string[];
  readonly decision: AppliedDecision;
}

export interface RecsApplySkipped {
  readonly ok: true;
  readonly cwd: string;
  readonly recommendation_id: string;
  readonly applied: false;
  readonly reason: string;
  readonly delegate?: string;
}

export interface RecsApplyErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type RecsApplyResult = RecsApplyOk | RecsApplySkipped | RecsApplyErr;

export interface RecsApplyDeps {
  readonly readFileFn?: (p: string) => string | null;
  readonly existsFn?: (p: string) => boolean;
  readonly safeIO?: SafeIO;
  readonly authorFn?: (cwd: string) => string;
  readonly now?: () => Date;
  readonly templatePath?: string;
  /** Defense-in-depth dirty check; mirrors `safeWriteFile`'s strict path. */
  readonly dirtyFilesFn?: (cwd: string) => { ok: true; value: readonly string[] } | { ok: false; error: string };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

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
// Patch helpers
// ---------------------------------------------------------------------------

interface OxlintPreset {
  rules?: Record<string, unknown>;
  plugins?: unknown;
  [key: string]: unknown;
}

interface ThresholdPatch {
  readonly rule: string;
  readonly max: number;
}

interface AddRulePatch {
  readonly rule: string;
  readonly max: number;
  readonly severity?: string;
}

interface RemoveRulePatch {
  readonly rule: string;
}

interface CoveragePatchShape {
  readonly runner: "vitest" | "jest";
  readonly key: CoverageKey;
  readonly threshold: number;
}

function readPatchField<T>(
  patch: Readonly<Record<string, unknown>>,
  field: string,
  guard: (v: unknown) => v is T,
): T | null {
  const v = patch[field];
  return guard(v) ? v : null;
}

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function parseThresholdPatch(
  patch: Readonly<Record<string, unknown>>,
): { ok: true; value: ThresholdPatch } | { ok: false; error: string } {
  const rule = readPatchField(patch, "rule", isString);
  const max = readPatchField(patch, "max", isNumber);
  if (rule === null || max === null) {
    return { ok: false, error: "patch missing string `rule` or numeric `max`" };
  }
  return { ok: true, value: { rule, max } };
}

function parseAddRulePatch(
  patch: Readonly<Record<string, unknown>>,
): { ok: true; value: AddRulePatch } | { ok: false; error: string } {
  const rule = readPatchField(patch, "rule", isString);
  const max = readPatchField(patch, "max", isNumber);
  if (rule === null || max === null) {
    return { ok: false, error: "patch missing string `rule` or numeric `max`" };
  }
  const severity = readPatchField(patch, "severity", isString) ?? undefined;
  return { ok: true, value: { rule, max, ...(severity ? { severity } : {}) } };
}

function parseRemoveRulePatch(
  patch: Readonly<Record<string, unknown>>,
): { ok: true; value: RemoveRulePatch } | { ok: false; error: string } {
  const rule = readPatchField(patch, "rule", isString);
  if (rule === null) {
    return { ok: false, error: "patch missing string `rule`" };
  }
  return { ok: true, value: { rule } };
}

function parseCoveragePatch(
  patch: Readonly<Record<string, unknown>>,
): { ok: true; value: CoveragePatchShape } | { ok: false; error: string } {
  const runner = readPatchField(patch, "runner", isString);
  const key = readPatchField(patch, "key", isString);
  const threshold = readPatchField(patch, "threshold", isNumber);
  if (runner !== "vitest" && runner !== "jest") {
    return { ok: false, error: `patch.runner must be 'vitest' or 'jest'` };
  }
  if (
    key === null ||
    !(COVERAGE_KEYS as readonly string[]).includes(key) ||
    threshold === null
  ) {
    return {
      ok: false,
      error: `patch missing valid coverage key/threshold (key in ${COVERAGE_KEYS.join("|")})`,
    };
  }
  return {
    ok: true,
    value: {
      runner: runner as "vitest" | "jest",
      key: key as CoverageKey,
      threshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Oxlint preset edits
// ---------------------------------------------------------------------------

interface PresetEdit {
  readonly content: string;
  readonly changed: boolean;
}

function applyThresholdToPreset(
  current: OxlintPreset,
  rule: string,
  newMax: number,
): { ok: true; value: PresetEdit } | { ok: false; error: string } {
  const proposed: OxlintPreset = JSON.parse(JSON.stringify(current));
  const rules: Record<string, unknown> =
    proposed.rules !== null && typeof proposed.rules === "object"
      ? (proposed.rules as Record<string, unknown>)
      : {};
  const existing = rules[rule];
  if (existing === undefined) {
    return {
      ok: false,
      error: `rule '${rule}' not present in preset — cannot adjust threshold`,
    };
  }

  let severity = "warn";
  let options: Record<string, unknown> = { max: newMax };
  if (typeof existing === "string") {
    severity = existing;
  } else if (
    Array.isArray(existing) &&
    existing.length >= 1 &&
    typeof existing[0] === "string"
  ) {
    severity = existing[0];
    if (
      existing.length >= 2 &&
      existing[1] !== null &&
      typeof existing[1] === "object" &&
      !Array.isArray(existing[1])
    ) {
      options = { ...(existing[1] as Record<string, unknown>), max: newMax };
    }
  }
  rules[rule] = [severity, options];
  proposed.rules = rules;

  const before = stringifyPretty(current);
  const after = stringifyPretty(proposed);
  return { ok: true, value: { content: after, changed: before !== after } };
}

function applyAddRuleToPreset(
  current: OxlintPreset,
  patch: AddRulePatch,
): { ok: true; value: PresetEdit } | { ok: false; error: string } {
  const proposed: OxlintPreset = JSON.parse(JSON.stringify(current));
  const rules: Record<string, unknown> =
    proposed.rules !== null && typeof proposed.rules === "object"
      ? (proposed.rules as Record<string, unknown>)
      : {};
  const severity = patch.severity ?? "warn";
  rules[patch.rule] = [severity, { max: patch.max }];
  proposed.rules = rules;

  if (patch.rule.startsWith("quality-metrics/")) {
    const plugins = Array.isArray(proposed.plugins)
      ? [...(proposed.plugins as unknown[])]
      : [];
    if (!plugins.includes("quality-metrics")) plugins.push("quality-metrics");
    proposed.plugins = plugins;
  }

  const before = stringifyPretty(current);
  const after = stringifyPretty(proposed);
  return { ok: true, value: { content: after, changed: before !== after } };
}

function applyRemoveRuleToPreset(
  current: OxlintPreset,
  rule: string,
): { ok: true; value: PresetEdit } | { ok: false; error: string } {
  const proposed: OxlintPreset = JSON.parse(JSON.stringify(current));
  const rules: Record<string, unknown> =
    proposed.rules !== null && typeof proposed.rules === "object"
      ? (proposed.rules as Record<string, unknown>)
      : {};
  if (!(rule in rules)) {
    return {
      ok: false,
      error: `rule '${rule}' not present in preset — already absent`,
    };
  }
  delete rules[rule];
  proposed.rules = rules;
  const before = stringifyPretty(current);
  const after = stringifyPretty(proposed);
  return { ok: true, value: { content: after, changed: before !== after } };
}

// ---------------------------------------------------------------------------
// Decisions log append
// ---------------------------------------------------------------------------

interface DecisionEntry {
  readonly timestamp: string;
  readonly kind: string;
  readonly subject: string;
  readonly rule?: string;
  readonly author: string;
  readonly reason: string;
  readonly recommendation_id: string;
}

function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatEntry(entry: DecisionEntry): string {
  const lines: string[] = [];
  lines.push(`### ${entry.timestamp} — ${entry.kind}: ${entry.subject}`);
  lines.push("");
  lines.push(`- **kind**: ${entry.kind}`);
  if (entry.rule !== undefined) {
    lines.push(`- **rule**: ${entry.rule}`);
  }
  lines.push(`- **author**: ${entry.author}`);
  lines.push(`- **reason**: ${entry.reason}`);
  lines.push(`- **recommendation_id**: ${entry.recommendation_id}`);
  lines.push("");
  return lines.join("\n");
}

function loadOrInitDecisions(
  current: string | null,
  templatePath: string,
  readFileFn: (p: string) => string | null,
): { ok: true; text: string } | { ok: false; error: string } {
  if (current !== null) {
    if (
      current.indexOf(ENTRIES_START) === -1 ||
      current.indexOf(ENTRIES_END) === -1 ||
      current.indexOf(ENTRIES_START) > current.indexOf(ENTRIES_END)
    ) {
      return {
        ok: false,
        error:
          "docs/lint-decisions.md present but entry markers are missing or out of order",
      };
    }
    return { ok: true, text: current };
  }
  const tpl = readFileFn(templatePath);
  if (tpl === null) {
    return {
      ok: false,
      error: `decisions template not found at ${templatePath}`,
    };
  }
  return { ok: true, text: tpl };
}

function appendEntry(
  base: string,
  entry: DecisionEntry,
): { ok: true; text: string } | { ok: false; error: string } {
  const start = base.indexOf(ENTRIES_START);
  const end = base.indexOf(ENTRIES_END);
  if (start === -1 || end === -1 || start >= end) {
    return {
      ok: false,
      error: "decisions markers missing or malformed",
    };
  }
  const startEnd = start + ENTRIES_START.length;
  const head = base.slice(0, startEnd);
  const middle = base.slice(startEnd, end);
  const tail = base.slice(end);

  // Preserve any whitespace already between markers, then append the new entry
  // followed by a blank line so the next append continues to format cleanly.
  const trimmedMiddle = middle.replace(/^\s+/, "").replace(/\s+$/, "");
  const inserted = formatEntry(entry);
  const sep = trimmedMiddle.length === 0 ? "\n\n" : "\n\n";
  const newMiddle =
    "\n" +
    (trimmedMiddle.length > 0 ? trimmedMiddle + "\n\n" : "") +
    inserted +
    sep;

  return { ok: true, text: head + newMiddle + tail };
}

// ---------------------------------------------------------------------------
// Per-type appliers
// ---------------------------------------------------------------------------

function findExisting(
  cwd: string,
  candidates: readonly string[],
  existsFn: (p: string) => boolean,
): string | null {
  for (const rel of candidates) {
    if (existsFn(join(cwd, rel))) return rel;
  }
  return null;
}

function applyOxlintPreset(
  opts: RecsApplyOptions,
  rec: Recommendation,
  deps: RecsApplyDeps,
):
  | { ok: true; subject: string; rule: string; relPath: string; content: string; changed: boolean }
  | { ok: false; error: string; reason: string } {
  const readFileFn = deps.readFileFn ?? defaultRead;
  const presetRel = rec.applies_to;
  if (!presetRel.endsWith(".json")) {
    return {
      ok: false,
      error: "applies_to_unsupported",
      reason: `expected JSON preset (oxlint.*.json) for ${rec.type}, got ${presetRel}`,
    };
  }
  const presetAbs = join(opts.cwd, presetRel);
  const raw = readFileFn(presetAbs);
  if (raw === null) {
    return {
      ok: false,
      error: "preset_missing",
      reason: `${presetRel}: file not readable under ${opts.cwd}`,
    };
  }
  const parsed = parseDefensive<OxlintPreset>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return {
      ok: false,
      error: "preset_malformed",
      reason: `${presetRel}: ${parsed.ok ? "not an object" : parsed.error}`,
    };
  }

  const patch = rec.patch as Readonly<Record<string, unknown>>;

  if (rec.type === "raise-threshold" || rec.type === "lower-threshold") {
    const t = parseThresholdPatch(patch);
    if (!t.ok) {
      return { ok: false, error: "patch_invalid", reason: t.error };
    }
    const edit = applyThresholdToPreset(parsed.value, t.value.rule, t.value.max);
    if (!edit.ok) {
      return { ok: false, error: "patch_invalid", reason: edit.error };
    }
    const subject = `${t.value.rule}: max=${t.value.max}`;
    return {
      ok: true,
      subject,
      rule: t.value.rule,
      relPath: presetRel,
      content: edit.value.content,
      changed: edit.value.changed,
    };
  }

  if (rec.type === "add-rule") {
    const t = parseAddRulePatch(patch);
    if (!t.ok) {
      return { ok: false, error: "patch_invalid", reason: t.error };
    }
    const edit = applyAddRuleToPreset(parsed.value, t.value);
    if (!edit.ok) {
      return { ok: false, error: "patch_invalid", reason: edit.error };
    }
    const subject = `${t.value.rule}: max=${t.value.max}`;
    return {
      ok: true,
      subject,
      rule: t.value.rule,
      relPath: presetRel,
      content: edit.value.content,
      changed: edit.value.changed,
    };
  }

  if (rec.type === "remove-rule") {
    const t = parseRemoveRulePatch(patch);
    if (!t.ok) {
      return { ok: false, error: "patch_invalid", reason: t.error };
    }
    const edit = applyRemoveRuleToPreset(parsed.value, t.value.rule);
    if (!edit.ok) {
      return { ok: false, error: "patch_invalid", reason: edit.error };
    }
    return {
      ok: true,
      subject: t.value.rule,
      rule: t.value.rule,
      relPath: presetRel,
      content: edit.value.content,
      changed: edit.value.changed,
    };
  }

  return {
    ok: false,
    error: "unsupported_type",
    reason: `oxlint preset path does not handle type '${rec.type}'`,
  };
}

function applyCoverage(
  opts: RecsApplyOptions,
  rec: Recommendation,
  deps: RecsApplyDeps,
):
  | { ok: true; subject: string; relPath: string; content: string; changed: boolean }
  | { ok: false; error: string; reason: string } {
  const readFileFn = deps.readFileFn ?? defaultRead;
  const existsFn = deps.existsFn ?? defaultExists;

  const cov = parseCoveragePatch(rec.patch as Readonly<Record<string, unknown>>);
  if (!cov.ok) {
    return { ok: false, error: "patch_invalid", reason: cov.error };
  }

  if (cov.value.runner === "vitest") {
    const targetRel = findExisting(opts.cwd, VITEST_CONFIG_CANDIDATES, existsFn);
    if (targetRel === null) {
      return {
        ok: false,
        error: "config_missing",
        reason: "no vitest.config.{ts,mts,cts,js,mjs,cjs} found",
      };
    }
    const raw = readFileFn(join(opts.cwd, targetRel));
    if (raw === null) {
      return {
        ok: false,
        error: "config_read_failed",
        reason: `${targetRel}: unreadable`,
      };
    }
    const applied = applyVitestCoverage(raw, {
      thresholds: { [cov.value.key]: cov.value.threshold },
    });
    if (!applied.ok) {
      return {
        ok: false,
        error: "config_edit_failed",
        reason: `${targetRel}: ${applied.error}`,
      };
    }
    const subject = `vitest.${cov.value.key}=${cov.value.threshold}%`;
    return {
      ok: true,
      subject,
      relPath: targetRel,
      content: applied.value.content,
      changed: applied.value.changed,
    };
  }

  // jest path: only `jest.config.json` is auto-editable here. JS configs and
  // package.json#jest are out of scope for v1 — surface an actionable error.
  const jsonAbs = join(opts.cwd, JEST_JSON_CONFIG);
  if (!existsFn(jsonAbs)) {
    return {
      ok: false,
      error: "config_missing",
      reason: `${JEST_JSON_CONFIG} not found — JS jest configs and package.json#jest are not auto-editable in v1`,
    };
  }
  const raw = readFileFn(jsonAbs);
  if (raw === null) {
    return {
      ok: false,
      error: "config_read_failed",
      reason: `${JEST_JSON_CONFIG}: unreadable`,
    };
  }
  const parsed = parseDefensive<Record<string, unknown>>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return {
      ok: false,
      error: "config_malformed",
      reason: `${JEST_JSON_CONFIG}: ${parsed.ok ? "not an object" : parsed.error}`,
    };
  }
  const root = { ...parsed.value };
  const ct =
    root["coverageThreshold"] !== null &&
    typeof root["coverageThreshold"] === "object"
      ? { ...(root["coverageThreshold"] as Record<string, unknown>) }
      : {};
  const global =
    ct["global"] !== null && typeof ct["global"] === "object"
      ? { ...(ct["global"] as Record<string, unknown>) }
      : {};
  const before = global[cov.value.key];
  global[cov.value.key] = cov.value.threshold;
  ct["global"] = global;
  root["coverageThreshold"] = ct;

  const content = stringifyPretty(root);
  const changed = before !== cov.value.threshold;
  return {
    ok: true,
    subject: `jest.${cov.value.key}=${cov.value.threshold}%`,
    relPath: JEST_JSON_CONFIG,
    content,
    changed,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function skip(
  cwd: string,
  recId: string,
  reason: string,
  delegate?: string,
): RecsApplySkipped {
  return {
    ok: true,
    cwd,
    recommendation_id: recId,
    applied: false,
    reason,
    ...(delegate !== undefined ? { delegate } : {}),
  };
}

export function recsApply(
  opts: RecsApplyOptions,
  deps: RecsApplyDeps = {},
): RecsApplyResult {
  const rec = opts.audit.recommendations.find((r) => r.id === opts.recId);
  if (rec === undefined) {
    return {
      ok: false,
      error: "recommendation_not_found",
      reason: `no recommendation with id '${opts.recId}' in audit`,
    };
  }

  if (!APPLICABLE_TYPES.has(rec.type)) {
    const delegate =
      rec.type === "fix-tooling"
        ? "install-deps"
        : rec.type === "enable-tier"
          ? "/lint:setup"
          : undefined;
    return skip(
      opts.cwd,
      opts.recId,
      `recommendation type '${rec.type}' is not auto-applicable; delegate to ${delegate ?? "harness"}`,
      delegate,
    );
  }

  const reason = (opts.reason ?? "").trim();
  if (REASON_REQUIRED_TYPES.has(rec.type) && reason.length === 0) {
    return {
      ok: false,
      error: "reason_required",
      reason: `recommendations of type '${rec.type}' require --reason (SPEC §6)`,
    };
  }

  if (opts.strict === true) {
    const dirtyFn = deps.dirtyFilesFn ?? defaultDirtyFiles;
    const r = dirtyFn(opts.cwd);
    if (!r.ok) {
      return { ok: false, error: "git_check_failed", reason: r.error };
    }
    if (r.value.length > 0) {
      return {
        ok: false,
        error: "dirty_tree",
        reason: `working tree has ${r.value.length} unstaged file(s)`,
      };
    }
  }

  let configEdit:
    | { relPath: string; content: string; changed: boolean; subject: string; rule?: string }
    | null = null;

  if (
    rec.type === "raise-threshold" ||
    rec.type === "lower-threshold" ||
    rec.type === "add-rule" ||
    rec.type === "remove-rule"
  ) {
    const r = applyOxlintPreset(opts, rec, deps);
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
    configEdit = {
      relPath: r.relPath,
      content: r.content,
      changed: r.changed,
      subject: r.subject,
      rule: r.rule,
    };
  } else if (rec.type === "tighten-coverage" || rec.type === "loosen-coverage") {
    const r = applyCoverage(opts, rec, deps);
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
    configEdit = {
      relPath: r.relPath,
      content: r.content,
      changed: r.changed,
      subject: r.subject,
    };
  }

  if (configEdit === null) {
    return {
      ok: false,
      error: "internal_error",
      reason: `no edit produced for type ${rec.type}`,
    };
  }

  const filesChanged: string[] = [];
  if (configEdit.changed) {
    const writeRes = safeWriteFile(
      opts.cwd,
      configEdit.relPath,
      configEdit.content,
      {
        kind:
          rec.type === "tighten-coverage" || rec.type === "loosen-coverage"
            ? "coverage"
            : "preset",
        merged: true,
      },
      deps.safeIO,
    );
    if (!writeRes.ok) {
      return {
        ok: false,
        error: "write_failed",
        reason: `${configEdit.relPath}: ${writeRes.error}`,
      };
    }
    filesChanged.push(writeRes.value.path);
  }

  const now = deps.now ? deps.now() : new Date();
  const author = (deps.authorFn ?? defaultAuthor)(opts.cwd);
  const templatePath = deps.templatePath ?? DECISIONS_TEMPLATE;
  const decisionsAbs = join(opts.cwd, DECISIONS_REL);
  const readFileFn = deps.readFileFn ?? defaultRead;
  const decisionsRaw = readFileFn(decisionsAbs);
  const loaded = loadOrInitDecisions(decisionsRaw, templatePath, readFileFn);
  if (!loaded.ok) {
    return { ok: false, error: "decisions_failed", reason: loaded.error };
  }
  const entry: DecisionEntry = {
    timestamp: isoUtc(now),
    kind: KIND_BY_TYPE[rec.type],
    subject: configEdit.subject,
    ...(configEdit.rule !== undefined ? { rule: configEdit.rule } : {}),
    author,
    reason: reason.length > 0 ? reason : "(none)",
    recommendation_id: rec.id,
  };
  const appended = appendEntry(loaded.text, entry);
  if (!appended.ok) {
    return { ok: false, error: "decisions_failed", reason: appended.error };
  }
  const decisionsWrite = safeWriteFile(
    opts.cwd,
    DECISIONS_REL,
    appended.text,
    { kind: "decisions", merged: decisionsRaw !== null },
    deps.safeIO,
  );
  if (!decisionsWrite.ok) {
    return {
      ok: false,
      error: "decisions_failed",
      reason: `${DECISIONS_REL}: ${decisionsWrite.error}`,
    };
  }
  filesChanged.push(decisionsWrite.value.path);

  return {
    ok: true,
    cwd: opts.cwd,
    recommendation_id: rec.id,
    applied: true,
    kind: KIND_BY_TYPE[rec.type],
    files_changed: filesChanged,
    decision: { path: decisionsWrite.value.path, appended: true },
  };
}

// Re-export internals for tests.
export {
  appendEntry,
  applyAddRuleToPreset,
  applyRemoveRuleToPreset,
  applyThresholdToPreset,
  APPLICABLE_TYPES,
  KIND_BY_TYPE,
  loadOrInitDecisions,
  parseAddRulePatch,
  parseCoveragePatch,
  parseRemoveRulePatch,
  parseThresholdPatch,
  REASON_REQUIRED_TYPES,
  ENTRIES_END,
  ENTRIES_START,
};

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly recId: string;
  readonly auditPath?: string;
  readonly reason?: string;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRecsApplyArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let recId: string | null = null;
  let auditPath: string | undefined;
  let reason: string | undefined;
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
    if (arg === "--rec-id") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --rec-id" };
      }
      recId = value;
      i++;
      continue;
    }
    if (arg === "--audit") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --audit" };
      }
      auditPath = value;
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
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  if (recId === null) {
    return { ok: false, error: "missing required flag: --rec-id" };
  }
  return {
    ok: true,
    value: {
      cwd,
      recId,
      strict,
      ...(auditPath !== undefined ? { auditPath } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

function loadAuditFromPath(
  cwd: string,
  relOrAbs: string,
  readFileFn: (p: string) => string | null,
):
  | { ok: true; audit: AuditPayload }
  | { ok: false; error: string; reason: string } {
  const safe = resolveSafePath(cwd, relOrAbs);
  if (!safe.ok) {
    return { ok: false, error: "audit_path_invalid", reason: safe.error };
  }
  const raw = readFileFn(safe.value);
  if (raw === null) {
    return {
      ok: false,
      error: "audit_read_failed",
      reason: `${relOrAbs}: file unreadable`,
    };
  }
  const parsed = parseDefensive(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "audit_parse_failed",
      reason: `${relOrAbs}: ${parsed.error}`,
    };
  }
  const validated = validateAuditPayload(parsed.value);
  if (!validated.ok) {
    return {
      ok: false,
      error: "audit_schema_validation_failed",
      reason: `${relOrAbs}: ${validated.error}`,
    };
  }
  return { ok: true, audit: validated.value };
}

export function runRecsApply(argv: readonly string[]): ExitCode {
  const parsed = parseRecsApplyArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy recs-apply --rec-id <id> [--audit <path>] [--reason <text>]\n" +
          "                 [--cwd <path>] [--strict]\n" +
          "\n" +
          "Applies a single recommendation from .lint-audit/<ts>.json (loaded via\n" +
          "audit-latest unless --audit is given). Supported types:\n" +
          "  raise/lower-threshold, add-rule, remove-rule (oxlint preset edits)\n" +
          "  tighten/loosen-coverage (vitest.config.ts or jest.config.json)\n" +
          "Types enable-tier and fix-tooling return applicable:false (delegate to\n" +
          "/lint:setup or install-deps).\n" +
          "\n" +
          "Loosening changes (lower-threshold, remove-rule, loosen-coverage)\n" +
          "REQUIRE --reason (SPEC §6). Every successful apply appends an entry to\n" +
          "docs/lint-decisions.md between the qualy:entries-start/end markers.\n" +
          "\n" +
          "Exit codes: 0 ok, 1 audit/preset/coverage/decisions failure,\n" +
          "  3 dirty tree under --strict, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "recs-apply", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  let audit: AuditPayload;
  if (parsed.value.auditPath !== undefined) {
    const r = loadAuditFromPath(parsed.value.cwd, parsed.value.auditPath, defaultRead);
    if (!r.ok) {
      logger.error("recs_apply_failed", { reason: r.reason });
      output({ ok: false, error: r.error, reason: r.reason });
      return EXIT_CODES.RECOVERABLE_ERROR;
    }
    audit = r.audit;
  } else {
    const latest = auditLatest({ cwd: parsed.value.cwd });
    if (!latest.ok) {
      logger.error("recs_apply_failed", { reason: latest.reason ?? latest.error });
      output(latest);
      return EXIT_CODES.RECOVERABLE_ERROR;
    }
    audit = latest.audit;
  }

  const result = recsApply({
    cwd: parsed.value.cwd,
    audit,
    recId: parsed.value.recId,
    strict: parsed.value.strict,
    ...(parsed.value.reason !== undefined ? { reason: parsed.value.reason } : {}),
  });

  if (!result.ok) {
    logger.error("recs_apply_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "dirty_tree") return EXIT_CODES.DIRTY_TREE;
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  if (result.applied) {
    logger.info("recs_apply_ok", {
      recommendation_id: result.recommendation_id,
      kind: result.kind,
      files_changed: result.files_changed.length,
    });
  } else {
    logger.info("recs_apply_skipped", {
      recommendation_id: result.recommendation_id,
      reason: result.reason,
    });
  }
  return EXIT_CODES.OK;
}
