/**
 * `recs-generate` — derives the deterministic `candidates[]` list that feeds
 * `lint-auditor` (subagent) and `/lint:update`.
 *
 * Contract: `docs/recs-heuristics.md` (single source of truth for triggers,
 * formulas, IDs, ordering). Every numeric decision lives there — this module
 * only mechanises it. Drift between heuristics doc and code is locked by the
 * unit tests next door.
 *
 * Output is `{ candidates }` where each candidate is the **stub** form
 * (carries `rationale_stub`, `evidence`, `suggested_change`,
 * `blast_radius.files_newly_violating: null`). The subagent enriches the stub
 * into the final `recommendations[]` shape (ADR 0008); blast-radius command
 * fills `files_newly_violating` later.
 *
 * Determinism guarantee: same audit → byte-identical candidate JSON. Order
 * follows §7 of the heuristics doc; IDs follow §4.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  AuditPayload,
  MetricKey,
  RecSeverity,
  RecType,
  RuleActive,
  Stage,
  TestRunner,
} from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { logger, output } from "../../lib/logger.ts";

import { auditLatest } from "../audit-latest.ts";

// ---------------------------------------------------------------------------
// Public types — Candidate (stub form) & generator API
// ---------------------------------------------------------------------------

export interface CandidateBlastRadius {
  readonly files_currently_violating: number;
  /** `null` until `recs-blast-radius` measures the dry-run delta. */
  readonly files_newly_violating: number | null;
}

export interface Candidate {
  readonly id: string;
  readonly type: RecType;
  readonly title: string;
  readonly rationale_stub: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly suggested_change: Readonly<Record<string, unknown>>;
  readonly blast_radius: CandidateBlastRadius;
  readonly severity: RecSeverity;
  readonly applies_to: string;
}

export interface RecsGenerateOptions {
  readonly cwd: string;
  /** Audit payload to derive recs from. Caller is responsible for loading it. */
  readonly audit: AuditPayload;
}

export interface RecsGenerateOk {
  readonly ok: true;
  readonly cwd: string;
  readonly candidates: readonly Candidate[];
}

export interface RecsGenerateErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type RecsGenerateResult = RecsGenerateOk | RecsGenerateErr;

export interface RecsGenerateDeps {
  /** FS seam for `enable-tier` (checks `oxlint.deep.json`). */
  readonly existsFn?: (p: string) => boolean;
}

// ---------------------------------------------------------------------------
// Stage tables — locked by `cli/src/presets/oxlint/<stage>.<tier>.json` and
// `cli/src/presets/coverage/{vitest,jest}.<stage>.*`. Drift breaks the
// preset round-trip tests; if those tests change, this table must too.
// ---------------------------------------------------------------------------

const STAGES: readonly Stage[] = ["greenfield", "brownfield-moderate", "legacy"];

interface MetricTier {
  readonly wmc: number;
  readonly halstead: number;
  readonly lcom: number;
  readonly cbo: number;
  readonly dit: number;
}

const STAGE_METRIC_THRESHOLDS: Readonly<Record<Stage, MetricTier>> = {
  greenfield: { wmc: 15, halstead: 800, lcom: 0, cbo: 8, dit: 4 },
  "brownfield-moderate": { wmc: 20, halstead: 1000, lcom: 2, cbo: 10, dit: 5 },
  legacy: { wmc: 40, halstead: 2000, lcom: 4, cbo: 20, dit: 6 },
};

interface CoverageTier {
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
  readonly statements: number;
}

const STAGE_COVERAGE_THRESHOLDS: Readonly<Record<Stage, CoverageTier>> = {
  greenfield: { lines: 90, functions: 90, branches: 80, statements: 90 },
  "brownfield-moderate": { lines: 70, functions: 70, branches: 60, statements: 70 },
  legacy: { lines: 40, functions: 40, branches: 30, statements: 40 },
};

const COVERAGE_KEYS = ["lines", "functions", "branches", "statements"] as const;
type CoverageKey = (typeof COVERAGE_KEYS)[number];

const METRIC_KEYS: readonly MetricKey[] = ["cbo", "dit", "halstead", "lcom", "wmc"];

const METRIC_RULE_NAME: Readonly<Record<MetricKey, string>> = {
  wmc: "quality-metrics/wmc",
  halstead: "quality-metrics/halstead",
  lcom: "quality-metrics/lcom",
  cbo: "quality-metrics/cbo",
  dit: "quality-metrics/dit",
};

type Tier = "fast" | "deep";

// ---------------------------------------------------------------------------
// Origin / tier helpers
// ---------------------------------------------------------------------------

function isPresetOrigin(origin: string): boolean {
  return origin.startsWith("preset:");
}

function isUserOverride(origin: string): boolean {
  return origin.startsWith("user-override:");
}

function tierFromOrigin(origin: string): Tier | null {
  if (origin.endsWith(":deep") || origin === "preset:deep") return "deep";
  if (origin.endsWith(":fast") || origin === "preset:fast") return "fast";
  return null;
}

function presetFile(tier: Tier): string {
  return tier === "deep" ? "oxlint.deep.json" : "oxlint.fast.json";
}

function slugify(name: string): string {
  return name
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Rule entry pickers
// ---------------------------------------------------------------------------

interface RulePick {
  readonly entry: RuleActive;
  readonly tier: Tier;
  readonly currentMax: number;
}

/**
 * Map metric → the option key that holds the user-facing threshold for the
 * `quality-metrics/<metric>` rule. Halstead uses `maxVolume` (the larger axis;
 * `max_seen_volume` is the parallel field on the audit side). Lcom uses
 * `maxLcom`. The rest use the bare `max`.
 */
const METRIC_OPTION_KEY: Readonly<Record<MetricKey, string>> = {
  wmc: "max",
  halstead: "maxVolume",
  lcom: "maxLcom",
  cbo: "max",
  dit: "max",
};

/**
 * Pick the preset entry for `rule`. If both fast and deep carry it, prefer
 * deep (heuristics §6.1). Skips user-override entries (heuristics §7.2).
 * Returns `null` when the rule isn't preset-active or carries no threshold
 * option (under the metric-specific option key).
 */
function pickPresetRule(
  rules: readonly RuleActive[],
  rule: string,
  metric: MetricKey,
): RulePick | null {
  let fastPick: RulePick | null = null;
  let deepPick: RulePick | null = null;

  for (const entry of rules) {
    if (entry.rule !== rule) continue;
    if (!isPresetOrigin(entry.origin)) continue;
    const tier = tierFromOrigin(entry.origin);
    if (tier === null) continue;
    const max = readMaxOption(entry, metric);
    if (max === null) continue;
    const pick: RulePick = { entry, tier, currentMax: max };
    if (tier === "deep") {
      if (deepPick === null) deepPick = pick;
    } else if (fastPick === null) {
      fastPick = pick;
    }
  }

  return deepPick ?? fastPick;
}

function readMaxOption(entry: RuleActive, metric: MetricKey): number | null {
  const key = METRIC_OPTION_KEY[metric];
  const raw = entry.options?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function activeQualityMetricsCount(rules: readonly RuleActive[]): number {
  let n = 0;
  for (const r of rules) if (r.rule.startsWith("quality-metrics/")) n++;
  return n;
}

// ---------------------------------------------------------------------------
// 6.8 fix-tooling
// ---------------------------------------------------------------------------

function generateFixTooling(audit: AuditPayload): Candidate[] {
  const out: Candidate[] = [];
  const t = audit.tooling;

  if (t.oxlint === null) {
    out.push({
      id: "rec-fix-tooling-oxlint",
      type: "fix-tooling",
      title: "oxlint não está instalado — instalar via install-deps",
      rationale_stub: "oxlint ausente em node_modules/; instalar via install-deps.",
      evidence: { package: "oxlint", installed: false },
      suggested_change: { applies_to: "package.json", package: "oxlint" },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "critical",
      applies_to: "package.json",
    });
  }

  if (t.oxfmt === null) {
    out.push({
      id: "rec-fix-tooling-oxfmt",
      type: "fix-tooling",
      title: "oxfmt não está instalado — instalar via install-deps",
      rationale_stub: "oxfmt ausente em node_modules/; instalar via install-deps.",
      evidence: { package: "oxfmt", installed: false },
      suggested_change: { applies_to: "package.json", package: "oxfmt" },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "critical",
      applies_to: "package.json",
    });
  }

  if (t.quality_metrics === null && activeQualityMetricsCount(audit.rules_active) > 0) {
    out.push({
      id: "rec-fix-tooling-quality-metrics",
      type: "fix-tooling",
      title: "@oxc-project/quality-metrics não está instalado — instalar via install-deps",
      rationale_stub:
        "quality-metrics ausente em node_modules/; instalar via install-deps.",
      evidence: {
        package: "@oxc-project/quality-metrics",
        installed: false,
        active_rules: activeQualityMetricsCount(audit.rules_active),
      },
      suggested_change: {
        applies_to: "package.json",
        package: "@oxc-project/quality-metrics",
      },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "critical",
      applies_to: "package.json",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 6.5 enable-tier
// ---------------------------------------------------------------------------

function generateEnableTier(
  audit: AuditPayload,
  cwd: string,
  existsFn: (p: string) => boolean,
): Candidate[] {
  const deepPath = join(cwd, "oxlint.deep.json");
  const deepMissing = !existsFn(deepPath);
  const qmMissing = audit.tooling.quality_metrics === null;
  if (!deepMissing && !qmMissing) return [];

  return [
    {
      id: "rec-enable-tier-deep",
      type: "enable-tier",
      title: "Tier deep não está habilitado — habilitar via /lint:setup",
      rationale_stub:
        "Tier deep ausente — preset deep não escrito ou quality_metrics não instalado.",
      evidence: {
        tier: "deep",
        deep_preset_present: !deepMissing,
        quality_metrics_installed: !qmMissing,
      },
      suggested_change: { applies_to: "oxlint.deep.json" },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "recommend",
      applies_to: "oxlint.deep.json",
    },
  ];
}

// ---------------------------------------------------------------------------
// 6.3 add-rule
// ---------------------------------------------------------------------------

function generateAddRule(audit: AuditPayload): Candidate[] {
  const baseline = STAGE_METRIC_THRESHOLDS[audit.stage];
  const out: Candidate[] = [];
  for (const metric of METRIC_KEYS) {
    const ruleName = METRIC_RULE_NAME[metric];
    const present = audit.rules_active.some((r) => r.rule === ruleName);
    if (present) continue;
    const proposed = baseline[metric];
    out.push({
      id: `rec-add-rule-${slugify(ruleName)}-deep`,
      type: "add-rule",
      title: `Adicionar regra ${ruleName} (max=${proposed}) ao preset deep`,
      rationale_stub: `Stage ${audit.stage} habilita ${ruleName} no preset; ausente em deep — adicionar com max=${proposed}.`,
      evidence: {
        rule: ruleName,
        stage: audit.stage,
        proposed_value: proposed,
      },
      suggested_change: {
        applies_to: "oxlint.deep.json",
        rule: ruleName,
        max: proposed,
      },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "recommend",
      applies_to: "oxlint.deep.json",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6.1 raise-threshold / 6.2 lower-threshold
// ---------------------------------------------------------------------------

function readMetricStats(audit: AuditPayload, metric: MetricKey): {
  violations: number;
  max_seen: number | null;
} {
  const m = audit.violations.by_metric[metric];
  const violations = m.violations;
  const max_seen =
    metric === "halstead"
      ? typeof m.max_seen_volume === "number"
        ? m.max_seen_volume
        : null
      : typeof m.max_seen === "number"
        ? m.max_seen
        : null;
  return { violations, max_seen };
}

function generateRaiseThreshold(audit: AuditPayload): Candidate[] {
  const out: Candidate[] = [];
  const legacyTable = STAGE_METRIC_THRESHOLDS.legacy;
  const greenTable = STAGE_METRIC_THRESHOLDS.greenfield;

  for (const metric of METRIC_KEYS) {
    const ruleName = METRIC_RULE_NAME[metric];
    const pick = pickPresetRule(audit.rules_active, ruleName, metric);
    if (pick === null) continue;
    const { violations, max_seen } = readMetricStats(audit, metric);
    if (violations !== 0) continue;
    if (max_seen === null) continue;
    if (!(max_seen < 0.7 * pick.currentMax)) continue;

    let proposed = Math.max(1, Math.round(max_seen * 1.2));
    // Clamp to [greenfield, legacy] ceiling/floor (heuristics §7.3).
    proposed = Math.max(proposed, greenTable[metric]);
    proposed = Math.min(proposed, legacyTable[metric]);
    if (proposed >= pick.currentMax) continue;

    const severity: RecSeverity =
      pick.currentMax - proposed >= 5 ? "recommend" : "suggest";

    out.push({
      id: `rec-raise-threshold-${metric}-${pick.tier}`,
      type: "raise-threshold",
      title: `${metric} max está em ${pick.currentMax} — apertar para ${proposed}`,
      rationale_stub: `${metric} max=${pick.currentMax} mas max_seen=${max_seen} (${audit.stage}); apertar para round(max_seen × 1.2)=${proposed}.`,
      evidence: {
        metric,
        rule: ruleName,
        tier: pick.tier,
        stage: audit.stage,
        current_max: pick.currentMax,
        max_seen,
        violations,
        proposed_value: proposed,
      },
      suggested_change: {
        applies_to: presetFile(pick.tier),
        rule: ruleName,
        max: proposed,
      },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity,
      applies_to: presetFile(pick.tier),
    });
  }

  return out;
}

function generateLowerThreshold(audit: AuditPayload): Candidate[] {
  const out: Candidate[] = [];
  const legacyTable = STAGE_METRIC_THRESHOLDS.legacy;
  const greenTable = STAGE_METRIC_THRESHOLDS.greenfield;

  for (const metric of METRIC_KEYS) {
    const ruleName = METRIC_RULE_NAME[metric];
    const pick = pickPresetRule(audit.rules_active, ruleName, metric);
    if (pick === null) continue;
    const { violations, max_seen } = readMetricStats(audit, metric);
    if (violations < 5) continue;
    if (max_seen === null) continue;
    if (!(max_seen > 1.5 * pick.currentMax)) continue;

    let proposed = Math.round(max_seen * 0.9);
    // Floor: never propose above legacy ceiling, never below greenfield floor.
    proposed = Math.min(proposed, legacyTable[metric]);
    proposed = Math.max(proposed, greenTable[metric]);
    if (proposed <= pick.currentMax) continue;

    const severity: RecSeverity = violations >= 20 ? "critical" : "recommend";

    const stagedFiles = audit.violations.by_metric[metric].top.length;

    out.push({
      id: `rec-lower-threshold-${metric}-${pick.tier}`,
      type: "lower-threshold",
      title: `${metric} max está em ${pick.currentMax} — afrouxar para ${proposed}`,
      rationale_stub: `${metric} max=${pick.currentMax} com ${violations} violações (max_seen=${max_seen}); afrouxar para round(max_seen × 0.9)=${proposed}.`,
      evidence: {
        metric,
        rule: ruleName,
        tier: pick.tier,
        stage: audit.stage,
        current_max: pick.currentMax,
        max_seen,
        violations,
        proposed_value: proposed,
      },
      suggested_change: {
        applies_to: presetFile(pick.tier),
        rule: ruleName,
        max: proposed,
      },
      blast_radius: {
        files_currently_violating: stagedFiles,
        files_newly_violating: null,
      },
      severity,
      applies_to: presetFile(pick.tier),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 6.6 tighten-coverage / 6.7 loosen-coverage
// ---------------------------------------------------------------------------

function nextStrictStage(stage: Stage): Stage | null {
  if (stage === "legacy") return "brownfield-moderate";
  if (stage === "brownfield-moderate") return "greenfield";
  return null;
}

function readCoverageActual(
  audit: AuditPayload,
  key: CoverageKey,
): number | null {
  const v = audit.tooling.coverage[key];
  return typeof v === "number" ? v : null;
}

function readCoverageThreshold(
  audit: AuditPayload,
  key: CoverageKey,
): number | null {
  const t = audit.tooling.coverage.thresholds;
  if (!t) return null;
  const v = t[key];
  return typeof v === "number" ? v : null;
}

function readRunner(t: TestRunner): "vitest" | "jest" | null {
  if (t === "vitest") return "vitest";
  if (t === "jest") return "jest";
  return null;
}

function generateTightenCoverage(audit: AuditPayload): Candidate[] {
  if (!audit.tooling.coverage.configured) return [];
  const runner = readRunner(audit.tooling.test_runner);
  if (runner === null) return [];
  const next = nextStrictStage(audit.stage);
  if (next === null) return [];
  const proposedTable = STAGE_COVERAGE_THRESHOLDS[next];

  const out: Candidate[] = [];
  for (const key of COVERAGE_KEYS) {
    const actual = readCoverageActual(audit, key);
    if (actual === null) continue;
    const proposed = proposedTable[key];
    if (actual < proposed) continue;
    const currentThreshold = readCoverageThreshold(audit, key);
    if (currentThreshold !== null && proposed <= currentThreshold) continue;

    out.push({
      id: `rec-tighten-coverage-${runner}-${key}`,
      type: "tighten-coverage",
      title: `${runner}.${key}=${actual}% acima do threshold — apertar para ${proposed}%`,
      rationale_stub: `${runner}.${key}=${actual}% acima do threshold (${proposed}%); apertar para ${proposed}%.`,
      evidence: {
        runner,
        key,
        stage: audit.stage,
        next_stage: next,
        current_value: actual,
        current_threshold: currentThreshold,
        proposed_value: proposed,
      },
      suggested_change: {
        applies_to: runner === "vitest" ? "vitest.config.ts" : "jest.config.js",
        runner,
        key,
        threshold: proposed,
      },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "suggest",
      applies_to: runner === "vitest" ? "vitest.config.ts" : "jest.config.js",
    });
  }
  return out;
}

function generateLoosenCoverage(audit: AuditPayload): Candidate[] {
  if (!audit.tooling.coverage.configured) return [];
  const runner = readRunner(audit.tooling.test_runner);
  if (runner === null) return [];
  const legacyTable = STAGE_COVERAGE_THRESHOLDS.legacy;

  const out: Candidate[] = [];
  for (const key of COVERAGE_KEYS) {
    const actual = readCoverageActual(audit, key);
    if (actual === null) continue;
    const threshold = readCoverageThreshold(audit, key);
    if (threshold === null) continue;
    if (!(actual < threshold)) continue;
    const proposed = Math.floor(actual);
    if (proposed < legacyTable[key]) continue;

    out.push({
      id: `rec-loosen-coverage-${runner}-${key}`,
      type: "loosen-coverage",
      title: `${runner}.${key}=${actual}% abaixo do threshold (${threshold}%) — afrouxar para ${proposed}%`,
      rationale_stub: `${runner}.${key}=${actual}% abaixo do threshold (${threshold}%); afrouxar para ${proposed}% (registrar motivo em lint-decisions.md — SPEC §6 Never).`,
      evidence: {
        runner,
        key,
        stage: audit.stage,
        current_value: actual,
        current_threshold: threshold,
        proposed_value: proposed,
      },
      suggested_change: {
        applies_to: runner === "vitest" ? "vitest.config.ts" : "jest.config.js",
        runner,
        key,
        threshold: proposed,
      },
      blast_radius: { files_currently_violating: 0, files_newly_violating: null },
      severity: "recommend",
      applies_to: runner === "vitest" ? "vitest.config.ts" : "jest.config.js",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function defaultExists(p: string): boolean {
  return existsSync(p);
}

export function recsGenerate(
  opts: RecsGenerateOptions,
  deps: RecsGenerateDeps = {},
): RecsGenerateResult {
  const existsFn = deps.existsFn ?? defaultExists;
  const audit = opts.audit;

  // §7 ordering: fix-tooling → enable-tier → add-rule → lower-threshold →
  // raise-threshold → (remove-rule, no-op v1) → loosen-coverage → tighten-coverage.
  const candidates: Candidate[] = [
    ...generateFixTooling(audit),
    ...generateEnableTier(audit, opts.cwd, existsFn),
    ...generateAddRule(audit),
    ...generateLowerThreshold(audit),
    ...generateRaiseThreshold(audit),
    ...generateLoosenCoverage(audit),
    ...generateTightenCoverage(audit),
  ];

  // Defensive uniqueness check — colliding IDs would mask bugs in heuristic
  // grouping. Heuristics §4 calls collisions "bug" outright.
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.id)) {
      return {
        ok: false,
        error: "duplicate_candidate_id",
        reason: `duplicate id ${c.id} — heuristic grouping bug`,
      };
    }
    seen.add(c.id);
  }

  return { ok: true, cwd: opts.cwd, candidates };
}

// Re-export the user-override helper for tests / future commands.
export { isUserOverride };

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRecsGenerateArgs(
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

export function runRecsGenerate(argv: readonly string[]): ExitCode {
  const parsed = parseRecsGenerateArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy recs-generate [--cwd <path>]\n" +
          "\n" +
          "Reads the latest .lint-audit/<ts>.json and emits a deterministic\n" +
          "candidates[] list (heuristics in docs/recs-heuristics.md). Output\n" +
          "is the stub form (rationale_stub, evidence, suggested_change);\n" +
          "the lint-auditor subagent enriches it into recommendations[].\n" +
          "Exit codes: 0 ok, 1 audit missing/invalid, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "recs-generate", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const latest = auditLatest({ cwd: parsed.value.cwd });
  if (!latest.ok) {
    logger.error("recs_generate_failed", { reason: latest.reason ?? latest.error });
    output(latest);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  const result = recsGenerate({ cwd: parsed.value.cwd, audit: latest.audit });
  if (!result.ok) {
    logger.error("recs_generate_failed", { reason: result.reason ?? result.error });
    output(result);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("recs_generate_ok", {
    audit: latest.path,
    candidates: result.candidates.length,
  });
  return EXIT_CODES.OK;
}
