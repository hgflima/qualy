/**
 * `rules-add` — enable an oxlint rule in the project's preset (one tier at a
 * time) and append a `rule-add` entry to `docs/lint-decisions.md`.
 *
 * SPEC §2 `/lint:rules:add <rule>`: "Adiciona uma rule específica ao preset
 * ativo. Pergunta severidade e threshold. Faz dry-run para mostrar quantos
 * arquivos passariam a falhar antes de aplicar."
 * SPEC §7.9 acceptance: "Add: dry-run mostra arquivos novos violando; pergunta
 * severidade e threshold; aplica."
 * SPEC §6 Always (line 389): every add/remove of a rule must be recorded in
 * `docs/lint-decisions.md` with the user's reason.
 *
 * Tier resolution:
 *   - `quality-metrics/*`  → `deep`  (deep is the only preset that loads the
 *                                     `quality-metrics` plugin).
 *   - `category:<name>`    → `fast`  (categories live in both tiers; fast is
 *                                     the cheaper default).
 *   - everything else      → `fast`.
 * Override with `--tier fast|deep`.
 *
 * Severity / max defaults (used when the user does not pass `--severity` /
 * `--max`):
 *   - `quality-metrics/*`: severity + max read from the stage baseline of the
 *     target tier (greenfield/brownfield-moderate/legacy). Both fields are
 *     required for these rules — if the stage cannot be detected and no
 *     `--severity` (or `--max`) is supplied, we return `severity_required` /
 *     `max_required` with a remediation hint.
 *   - `category:<name>`: no `max`. Severity defaults to the existing entry in
 *     the target preset (so `rules-add` can tighten correctness from `warn`
 *     to `error`); falls back to `warn` when the category is absent.
 *   - other oxlint rules: no `max` unless `--max` is supplied. Severity
 *     defaults to `warn`.
 *
 * Idempotency: when the rule is already present in the target tier with the
 * same severity and (where applicable) the same `max`, the command returns
 * `action: "already-present"` with `applied: false` — no preset write, no
 * decision append.
 *
 * Dry-run (`--dry-run`):
 *   - Never writes to disk.
 *   - When a `runFn` is injected (or `oxlintBin` resolves to a usable
 *     binary), measures `blast_radius` exactly the way `recs-blast-radius`
 *     does: oxlint with current preset vs. oxlint with proposed preset, count
 *     unique violating files, return `{ files_currently_violating,
 *     files_newly_violating, files_no_longer_violating }`.
 *   - Without `runFn`/`oxlintBin`, `blast_radius` is `null` — the harness can
 *     still surface the proposed patch.
 *
 * Output (PLAN §Contratos CLI shape):
 *   applied form:
 *     { ok, cwd, rule, tier, applies_to, action, severity, max?,
 *       files_changed, decision: { path, appended } }
 *   dry-run form:
 *     { ok, cwd, rule, tier, applies_to, action: "would-add"|"would-update",
 *       severity, max?, blast_radius, files_changed: [], decision: null,
 *       dry_run: true }
 *   error form:
 *     { ok: false, error, reason? }
 *
 * Exit codes:
 *   - OK                 — applied (or dry-run completed; or already present).
 *   - RECOVERABLE_ERROR  — preset missing/malformed, unknown rule, severity/
 *                          max missing for a quality-metrics rule, write fail,
 *                          decisions append failed.
 *   - DIRTY_TREE         — `--strict` and the working tree is dirty.
 *   - MISSING_DEPENDENCY — `--dry-run` with `--measure-blast-radius` and
 *                          oxlint is not on PATH.
 *   - USAGE_ERROR        — flag parser failure / missing required flag.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type RuleSeverity,
  type Stage,
} from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type SafeIO,
  safeWriteFile,
} from "../../lib/fs-safe.ts";
import { dirtyFiles } from "../../lib/git.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

import {
  ENTRIES_END,
  ENTRIES_START,
  formatDecisionEntry as formatGenericEntry,
  insertEntryBetweenMarkers as insertEntryBetweenMarkersFromLib,
  loadOrInitDecisions,
} from "../../lib/decision-log.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Tier = "fast" | "deep";

export interface RulesAddOptions {
  readonly cwd: string;
  readonly rule: string;
  readonly severity?: RuleSeverity;
  readonly max?: number;
  readonly tier?: Tier;
  readonly reason?: string;
  readonly dryRun?: boolean;
  readonly measureBlastRadius?: boolean;
  readonly strict?: boolean;
  readonly oxlintBin?: string;
}

export interface BlastRadiusMeasurement {
  readonly files_currently_violating: number;
  readonly files_newly_violating: number;
  readonly files_no_longer_violating: number;
}

export interface RulesAddApplied {
  readonly ok: true;
  readonly cwd: string;
  readonly rule: string;
  readonly tier: Tier;
  readonly applies_to: string;
  readonly action: "added" | "updated" | "already-present";
  readonly severity: RuleSeverity;
  readonly max?: number;
  readonly applied: boolean;
  readonly files_changed: readonly string[];
  readonly decision: { readonly path: string; readonly appended: boolean } | null;
  readonly dry_run: false;
}

export interface RulesAddDryRun {
  readonly ok: true;
  readonly cwd: string;
  readonly rule: string;
  readonly tier: Tier;
  readonly applies_to: string;
  readonly action: "would-add" | "would-update" | "already-present";
  readonly severity: RuleSeverity;
  readonly max?: number;
  readonly applied: false;
  readonly files_changed: readonly [];
  readonly decision: null;
  readonly blast_radius: BlastRadiusMeasurement | null;
  readonly dry_run: true;
}

export interface RulesAddErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type RulesAddResult = RulesAddApplied | RulesAddDryRun | RulesAddErr;

export type RunFn = (
  binary: string,
  args: readonly string[],
  cwd: string,
) => { ok: boolean; stdout: string; stderr: string; exitCode: number };

export interface RulesAddDeps {
  readonly readFileFn?: (p: string) => string | null;
  readonly existsFn?: (p: string) => boolean;
  readonly safeIO?: SafeIO;
  readonly authorFn?: (cwd: string) => string;
  readonly now?: () => Date;
  readonly templatePath?: string;
  readonly dirtyFilesFn?: (
    cwd: string,
  ) => { ok: true; value: readonly string[] } | { ok: false; error: string };
  /** Used in --dry-run to measure blast radius. When omitted, defaults to a
   *  real oxlint invocation; tests inject a fake. */
  readonly runFn?: RunFn;
  readonly mkdtempFn?: (prefix: string) => string;
  readonly writeTmpFn?: (p: string, content: string) => void;
  readonly removeFn?: (p: string) => void;
}

// ---------------------------------------------------------------------------
// Stage baseline — kept in lockstep with rules-list.STAGE_BASELINE_DEEP and
// rules-explain.STAGE_BASELINE_DEEP (same source, three copies — drift here
// breaks the contract the user reads from `rules-explain` before calling
// `rules-add`).
// ---------------------------------------------------------------------------

interface BaselineRule {
  readonly severity: RuleSeverity;
  readonly max: number;
}

/**
 * Baseline thresholds for rules `rules-add` can write a `{max: N}` entry for.
 * Halstead is intentionally absent because the plugin requires a compound
 * `{ maxVolume, maxEffort }` option object — the rules-add UX only gathers a
 * single `--max <n>`. Halstead is always part of the preset by default
 * (install-oxlint), so users normally don't need to add it; tightening a
 * single axis must be done via direct preset edit until rules-add gains
 * compound-option support.
 */
const STAGE_BASELINE_DEEP: Readonly<
  Record<Stage, Readonly<Record<string, BaselineRule>>>
> = {
  greenfield: {
    "quality-metrics/wmc": { severity: "error", max: 15 },
    "quality-metrics/lcom": { severity: "warn", max: 0 },
    "quality-metrics/cbo": { severity: "error", max: 8 },
    "quality-metrics/dit": { severity: "warn", max: 4 },
  },
  "brownfield-moderate": {
    "quality-metrics/wmc": { severity: "error", max: 20 },
    "quality-metrics/lcom": { severity: "warn", max: 2 },
    "quality-metrics/cbo": { severity: "error", max: 10 },
    "quality-metrics/dit": { severity: "warn", max: 5 },
  },
  legacy: {
    "quality-metrics/wmc": { severity: "warn", max: 40 },
    "quality-metrics/lcom": { severity: "warn", max: 4 },
    "quality-metrics/cbo": { severity: "warn", max: 20 },
    "quality-metrics/dit": { severity: "warn", max: 6 },
  },
};

/** Catalog of rules `rules-add` knows how to validate against. Halstead is
 *  intentionally omitted (compound options — see STAGE_BASELINE_DEEP doc). */
const KNOWN_RULES: ReadonlySet<string> = new Set<string>([
  "quality-metrics/wmc",
  "quality-metrics/lcom",
  "quality-metrics/cbo",
  "quality-metrics/dit",
  "category:correctness",
  "category:suspicious",
]);

const PRESET_FILES: Readonly<Record<Tier, string>> = {
  fast: "oxlint.fast.json",
  deep: "oxlint.deep.json",
};

const DECISIONS_REL = "docs/lint-decisions.md";
const DECISIONS_TEMPLATE_DEFAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "lint-decisions.md.tpl",
);

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

function defaultExists(p: string): boolean {
  return existsSync(p);
}
// keep defaultExists referenced for parity with rules-remove (symmetric DI
// surface — `existsFn` is in the deps interface even though `rulesAdd` only
// consumes `readFileFn` for now).
void defaultExists;

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

const defaultRun: RunFn = (binary, args, cwd) => {
  try {
    const stdout = execFileSync(binary, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
    };
    const stdout =
      typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const exitCode = typeof e.status === "number" ? e.status : -1;
    // oxlint exits non-zero when it finds violations — that's a success here.
    const ok = stdout.length > 0;
    return { ok, stdout, stderr: stderr || e.message || `${binary} failed`, exitCode };
  }
};

// ---------------------------------------------------------------------------
// Tier / severity / max resolution
// ---------------------------------------------------------------------------

export function defaultTierForRule(rule: string): Tier {
  if (rule.startsWith("quality-metrics/")) return "deep";
  return "fast";
}

function readStageFromComment(raw: unknown): Stage | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/stage=([a-z-]+)/i);
  if (!m) return null;
  const candidate = m[1];
  if (
    candidate === "greenfield" ||
    candidate === "brownfield-moderate" ||
    candidate === "legacy"
  ) {
    return candidate;
  }
  return null;
}

interface PresetShape {
  _comment?: unknown;
  categories?: unknown;
  rules?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
}

interface ExistingEntry {
  readonly severity: RuleSeverity;
  readonly max?: number;
}

function isSeverity(s: unknown): s is RuleSeverity {
  return s === "error" || s === "warn" || s === "off";
}

/** Look up an existing severity (and `max`, when present) for `rule` in
 * `preset`. Categories live under `preset.categories`; named rules live under
 * `preset.rules`. Returns `null` when the rule is absent or the entry shape is
 * unrecognized. */
function readExistingEntry(preset: PresetShape, rule: string): ExistingEntry | null {
  if (rule.startsWith("category:")) {
    const cat = rule.slice("category:".length);
    if (preset.categories === null || typeof preset.categories !== "object") {
      return null;
    }
    const cats = preset.categories as Record<string, unknown>;
    const v = cats[cat];
    if (!isSeverity(v)) return null;
    return { severity: v };
  }
  if (preset.rules === null || typeof preset.rules !== "object") return null;
  const rules = preset.rules as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rules, rule)) return null;
  const v = rules[rule];
  if (isSeverity(v)) return { severity: v };
  if (Array.isArray(v) && v.length >= 1 && isSeverity(v[0])) {
    const severity = v[0] as RuleSeverity;
    if (
      v.length >= 2 &&
      v[1] !== null &&
      typeof v[1] === "object" &&
      !Array.isArray(v[1])
    ) {
      const opts = v[1] as Record<string, unknown>;
      const max = typeof opts["max"] === "number" ? opts["max"] : undefined;
      return max !== undefined ? { severity, max } : { severity };
    }
    return { severity };
  }
  return null;
}

interface ResolvedSettings {
  readonly severity: RuleSeverity;
  readonly max?: number;
}

interface ResolveErr {
  readonly error: string;
  readonly reason: string;
}

function resolveSettings(
  rule: string,
  tier: Tier,
  stage: Stage | null,
  existing: ExistingEntry | null,
  userSeverity: RuleSeverity | undefined,
  userMax: number | undefined,
): { ok: true; value: ResolvedSettings } | { ok: false; error: ResolveErr } {
  const isQM = rule.startsWith("quality-metrics/");

  let severity: RuleSeverity | undefined = userSeverity;
  let max: number | undefined = userMax;

  if (severity === undefined) {
    if (isQM && tier === "deep" && stage !== null) {
      const baseline = STAGE_BASELINE_DEEP[stage][rule];
      if (baseline !== undefined) severity = baseline.severity;
    }
    if (severity === undefined && existing !== null) {
      severity = existing.severity;
    }
    if (severity === undefined && !isQM) {
      severity = "warn";
    }
    if (severity === undefined) {
      return {
        ok: false,
        error: {
          error: "severity_required",
          reason: `cannot infer severity for '${rule}' in tier '${tier}' (stage unknown and no --severity given)`,
        },
      };
    }
  }

  if (max === undefined) {
    if (isQM && tier === "deep" && stage !== null) {
      const baseline = STAGE_BASELINE_DEEP[stage][rule];
      if (baseline !== undefined) max = baseline.max;
    }
    if (max === undefined && isQM && existing !== null && existing.max !== undefined) {
      max = existing.max;
    }
    if (max === undefined && isQM) {
      return {
        ok: false,
        error: {
          error: "max_required",
          reason: `quality-metrics rule '${rule}' needs a numeric --max (stage unknown and no baseline match)`,
        },
      };
    }
  }

  return { ok: true, value: max !== undefined ? { severity, max } : { severity } };
}

// ---------------------------------------------------------------------------
// Preset edits
// ---------------------------------------------------------------------------

interface PresetEdit {
  readonly content: string;
  readonly proposed: PresetShape;
  readonly action: "added" | "updated" | "already-present";
}

function applyAddRule(
  current: PresetShape,
  rule: string,
  settings: ResolvedSettings,
  existing: ExistingEntry | null,
): PresetEdit {
  const proposed: PresetShape = JSON.parse(JSON.stringify(current));

  if (rule.startsWith("category:")) {
    const cat = rule.slice("category:".length);
    const cats: Record<string, unknown> =
      proposed.categories !== null && typeof proposed.categories === "object"
        ? (proposed.categories as Record<string, unknown>)
        : {};
    cats[cat] = settings.severity;
    proposed.categories = cats;
  } else {
    const rules: Record<string, unknown> =
      proposed.rules !== null && typeof proposed.rules === "object"
        ? (proposed.rules as Record<string, unknown>)
        : {};
    if (settings.max !== undefined) {
      rules[rule] = [settings.severity, { max: settings.max }];
    } else {
      rules[rule] = settings.severity;
    }
    proposed.rules = rules;

    if (rule.startsWith("quality-metrics/")) {
      const plugins = Array.isArray(proposed.plugins)
        ? [...(proposed.plugins as unknown[])]
        : [];
      if (!plugins.includes("quality-metrics")) plugins.push("quality-metrics");
      proposed.plugins = plugins;
    }
  }

  const before = stringifyPretty(current);
  const after = stringifyPretty(proposed);
  let action: "added" | "updated" | "already-present";
  if (existing === null) action = "added";
  else if (
    existing.severity === settings.severity &&
    (settings.max === undefined || existing.max === settings.max) &&
    before === after
  ) {
    action = "already-present";
  } else {
    action = "updated";
  }

  return { content: after, proposed, action };
}

// ---------------------------------------------------------------------------
// Decisions log entry
// ---------------------------------------------------------------------------

interface DecisionFields {
  readonly timestamp: string;
  readonly kind: "rule-add";
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
  settings: ResolvedSettings,
  author: string,
  reason: string,
  now: Date,
): DecisionFields {
  const subject =
    settings.max !== undefined
      ? `${rule}: severity=${settings.severity}, max=${settings.max}`
      : `${rule}: severity=${settings.severity}`;
  return {
    timestamp: isoUtc(now),
    kind: "rule-add",
    subject,
    rule,
    author,
    reason,
  };
}

/** Adapter that preserves the `DecisionFields` shape used by rules-add tests
 *  while delegating to the generic formatter in `lib/decision-log.ts`. */
function formatDecisionEntry(fields: DecisionFields): string {
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

/** Re-exported as a local binding so existing imports (`rules/remove.ts`,
 *  `rules-decisions-format` test) keep their call site unchanged. */
const insertEntryBetweenMarkers = insertEntryBetweenMarkersFromLib;

// ---------------------------------------------------------------------------
// Blast radius (dry-run only)
// ---------------------------------------------------------------------------

interface RawDiagnostic {
  filename?: unknown;
  file?: unknown;
  path?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function fileFromDiagnostic(d: RawDiagnostic): string | undefined {
  return asString(d.filename) ?? asString(d.file) ?? asString(d.path);
}

function violatingFiles(raw: string): Set<string> {
  const out = new Set<string>();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return out;

  const single = parseDefensive<unknown>(trimmed);
  if (single.ok) {
    const v = single.value;
    if (Array.isArray(v)) {
      for (const d of v) addFile(out, d);
      return out;
    }
    if (v !== null && typeof v === "object") {
      const obj = v as { diagnostics?: unknown };
      if (Array.isArray(obj.diagnostics)) {
        for (const d of obj.diagnostics) addFile(out, d);
        return out;
      }
      addFile(out, v);
    }
    return out;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const piece = line.trim();
    if (piece.length === 0) continue;
    const parsed = parseDefensive<unknown>(piece);
    if (!parsed.ok) continue;
    if (parsed.value !== null && typeof parsed.value === "object") {
      addFile(out, parsed.value);
    }
  }
  return out;
}

function addFile(out: Set<string>, raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  const file = fileFromDiagnostic(raw as RawDiagnostic);
  if (file !== undefined) out.add(file);
}

function oxlintArgs(cfg: string): readonly string[] {
  return ["--config", cfg, "--format", "json", "."];
}

interface BlastRadiusInputs {
  readonly cwd: string;
  readonly presetRel: string;
  readonly currentPresetAbs: string;
  readonly proposed: PresetShape;
  readonly oxlintBin: string;
  readonly runFn: RunFn;
  readonly mkdtempFn: (prefix: string) => string;
  readonly writeTmpFn: (p: string, content: string) => void;
  readonly removeFn: (p: string) => void;
}

function measureBlast(
  inputs: BlastRadiusInputs,
):
  | { ok: true; value: BlastRadiusMeasurement }
  | { ok: false; error: string; reason: string } {
  let tmp: string | null = null;
  try {
    tmp = inputs.mkdtempFn(join(tmpdir(), "qualy-rules-add-"));
    const proposedPath = join(tmp, inputs.presetRel);
    try {
      inputs.writeTmpFn(proposedPath, JSON.stringify(inputs.proposed, null, 2) + "\n");
    } catch (err) {
      return {
        ok: false,
        error: "write_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const oxlintMissing = (
      r: ReturnType<RunFn>,
    ): { ok: false; error: string; reason: string } | null =>
      !r.ok && r.stdout.length === 0
        ? {
            ok: false,
            error: "oxlint_missing",
            reason: `${inputs.oxlintBin}: ${r.stderr.trim() || "binary not found"}`,
          }
        : null;
    const cur = inputs.runFn(inputs.oxlintBin, oxlintArgs(inputs.currentPresetAbs), inputs.cwd);
    const curErr = oxlintMissing(cur);
    if (curErr !== null) return curErr;
    const prop = inputs.runFn(inputs.oxlintBin, oxlintArgs(proposedPath), inputs.cwd);
    const propErr = oxlintMissing(prop);
    if (propErr !== null) return propErr;
    const curFiles = violatingFiles(cur.stdout);
    const propFiles = violatingFiles(prop.stdout);
    let newly = 0;
    for (const f of propFiles) if (!curFiles.has(f)) newly++;
    let noLonger = 0;
    for (const f of curFiles) if (!propFiles.has(f)) noLonger++;
    return {
      ok: true,
      value: {
        files_currently_violating: curFiles.size,
        files_newly_violating: newly,
        files_no_longer_violating: noLonger,
      },
    };
  } finally {
    if (tmp !== null) {
      try {
        inputs.removeFn(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function rulesAdd(
  opts: RulesAddOptions,
  deps: RulesAddDeps = {},
): RulesAddResult {
  if (!KNOWN_RULES.has(opts.rule)) {
    return {
      ok: false,
      error: "unknown_rule",
      reason: `rule '${opts.rule}' is not in the qualy catalog (run \`qualy rules-list\` to see catalog rules)`,
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
  const stage = readStageFromComment(preset._comment);
  const existing = readExistingEntry(preset, opts.rule);

  const resolved = resolveSettings(
    opts.rule,
    tier,
    stage,
    existing,
    opts.severity,
    opts.max,
  );
  if (!resolved.ok) {
    return { ok: false, error: resolved.error.error, reason: resolved.error.reason };
  }

  const edit = applyAddRule(preset, opts.rule, resolved.value, existing);

  // strict pre-flight (only meaningful for actual writes; skip for dry-run).
  if (opts.dryRun !== true && opts.strict === true) {
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

  // Dry-run — no writes; optionally measure blast radius.
  if (opts.dryRun === true) {
    let measurement: BlastRadiusMeasurement | null = null;
    if (opts.measureBlastRadius === true && edit.action !== "already-present") {
      const m = measureBlast({
        cwd: opts.cwd,
        presetRel,
        currentPresetAbs: presetAbs,
        proposed: edit.proposed,
        oxlintBin: opts.oxlintBin ?? "oxlint",
        runFn: deps.runFn ?? defaultRun,
        mkdtempFn: deps.mkdtempFn ?? ((prefix) => mkdtempSync(prefix)),
        writeTmpFn: deps.writeTmpFn ?? ((p, c) => writeFileSync(p, c)),
        removeFn: deps.removeFn ?? ((p) => rmSync(p, { recursive: true, force: true })),
      });
      if (!m.ok) {
        return { ok: false, error: m.error, reason: m.reason };
      }
      measurement = m.value;
    }
    const action: RulesAddDryRun["action"] =
      edit.action === "added"
        ? "would-add"
        : edit.action === "updated"
          ? "would-update"
          : "already-present";
    return {
      ok: true,
      cwd: opts.cwd,
      rule: opts.rule,
      tier,
      applies_to: presetRel,
      action,
      severity: resolved.value.severity,
      ...(resolved.value.max !== undefined ? { max: resolved.value.max } : {}),
      applied: false,
      files_changed: [],
      decision: null,
      blast_radius: measurement,
      dry_run: true,
    };
  }

  // Idempotent no-op when the rule is already present with the same shape —
  // never write the preset and never append a decision.
  if (edit.action === "already-present") {
    return {
      ok: true,
      cwd: opts.cwd,
      rule: opts.rule,
      tier,
      applies_to: presetRel,
      action: "already-present",
      severity: resolved.value.severity,
      ...(resolved.value.max !== undefined ? { max: resolved.value.max } : {}),
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
  const decisionsAbs = join(opts.cwd, DECISIONS_REL);
  const decisionsRaw = readFileFn(decisionsAbs);
  const loaded = loadOrInitDecisions(decisionsRaw, templatePath, readFileFn);
  if (!loaded.ok) {
    return { ok: false, error: "decisions_failed", reason: loaded.error };
  }
  const reason = (opts.reason ?? "").trim();
  const fields = buildDecisionFields(
    opts.rule,
    resolved.value,
    author,
    reason.length > 0 ? reason : "(none)",
    now,
  );

  const entryText = formatDecisionEntry(fields);
  const appended = insertEntryBetweenMarkers(loaded.text, entryText);
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
    rule: opts.rule,
    tier,
    applies_to: presetRel,
    action: edit.action,
    severity: resolved.value.severity,
    ...(resolved.value.max !== undefined ? { max: resolved.value.max } : {}),
    applied: true,
    files_changed: filesChanged,
    decision: { path: decisionsWrite.value.path, appended: true },
    dry_run: false,
  };
}

// Re-export helpers for tests.
export {
  applyAddRule,
  ENTRIES_END,
  ENTRIES_START,
  formatDecisionEntry,
  insertEntryBetweenMarkers,
  KNOWN_RULES,
  PRESET_FILES,
  readExistingEntry,
  resolveSettings,
  STAGE_BASELINE_DEEP,
};

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly rule: string;
  readonly severity?: RuleSeverity;
  readonly max?: number;
  readonly tier?: Tier;
  readonly reason?: string;
  readonly dryRun: boolean;
  readonly measureBlastRadius: boolean;
  readonly strict: boolean;
  readonly oxlintBin?: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRulesAddArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let rule: string | null = null;
  let positional: string | null = null;
  let severity: RuleSeverity | undefined;
  let max: number | undefined;
  let tier: Tier | undefined;
  let reason: string | undefined;
  let dryRun = false;
  let measureBlastRadius = false;
  let strict = false;
  let oxlintBin: string | undefined;

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
    if (arg === "--severity") {
      const value = argv[i + 1];
      if (value !== "error" && value !== "warn" && value !== "off") {
        return { ok: false, error: "missing value for --severity (expected error|warn|off)" };
      }
      severity = value;
      i++;
      continue;
    }
    if (arg === "--max") {
      const value = argv[i + 1];
      const num = typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(num)) {
        return { ok: false, error: "missing numeric value for --max" };
      }
      max = num;
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
    if (arg === "--reason") {
      const value = argv[i + 1];
      if (typeof value !== "string") {
        return { ok: false, error: "missing value for --reason" };
      }
      reason = value;
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--measure-blast-radius") {
      measureBlastRadius = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--oxlint-bin") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --oxlint-bin" };
      }
      oxlintBin = value;
      i++;
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
      ...(severity !== undefined ? { severity } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(reason !== undefined ? { reason } : {}),
      dryRun,
      measureBlastRadius,
      strict,
      ...(oxlintBin !== undefined ? { oxlintBin } : {}),
    },
  };
}

export function runRulesAdd(argv: readonly string[]): ExitCode {
  const parsed = parseRulesAddArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy rules-add <rule> [--severity <error|warn|off>] [--max <n>]\n" +
          "                [--tier <fast|deep>] [--reason <text>] [--cwd <path>]\n" +
          "                [--dry-run] [--measure-blast-radius] [--oxlint-bin <bin>]\n" +
          "                [--strict]\n" +
          "\n" +
          "Enables a rule in the project's oxlint preset (one tier at a time).\n" +
          "Defaults the tier from the rule namespace (quality-metrics/* → deep,\n" +
          "category:* and oxlint built-ins → fast). Severity and max default to\n" +
          "the stage baseline for quality-metrics rules; --severity / --max\n" +
          "override.\n" +
          "\n" +
          "On success, writes the preset and appends a `rule-add` entry to\n" +
          "docs/lint-decisions.md (SPEC §6 line 389). With --dry-run, prints the\n" +
          "proposed action without writing; add --measure-blast-radius to also\n" +
          "run oxlint twice (current vs. proposed) and report the file delta.\n" +
          "\n" +
          "Exit codes: 0 ok, 1 preset/decisions/unknown-rule failure,\n" +
          "  3 dirty tree under --strict, 4 usage, 5 oxlint binary missing\n" +
          "  (only with --dry-run --measure-blast-radius).\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "rules-add", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = rulesAdd({
    cwd: parsed.value.cwd,
    rule: parsed.value.rule,
    dryRun: parsed.value.dryRun,
    measureBlastRadius: parsed.value.measureBlastRadius,
    strict: parsed.value.strict,
    ...(parsed.value.severity !== undefined ? { severity: parsed.value.severity } : {}),
    ...(parsed.value.max !== undefined ? { max: parsed.value.max } : {}),
    ...(parsed.value.tier !== undefined ? { tier: parsed.value.tier } : {}),
    ...(parsed.value.reason !== undefined ? { reason: parsed.value.reason } : {}),
    ...(parsed.value.oxlintBin !== undefined ? { oxlintBin: parsed.value.oxlintBin } : {}),
  });

  if (!result.ok) {
    logger.error("rules_add_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "dirty_tree") return EXIT_CODES.DIRTY_TREE;
    if (result.error === "oxlint_missing") return EXIT_CODES.MISSING_DEPENDENCY;
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  if (result.dry_run) {
    logger.info("rules_add_dry_run", {
      rule: result.rule,
      tier: result.tier,
      action: result.action,
      blast_radius: result.blast_radius !== null,
    });
  } else {
    logger.info("rules_add_ok", {
      rule: result.rule,
      tier: result.tier,
      action: result.action,
      applied: result.applied,
      files_changed: result.files_changed.length,
    });
  }
  return EXIT_CODES.OK;
}
