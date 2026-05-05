/**
 * `audit` — runs the configured oxlint preset, aggregates the diagnostic
 * stream into the SPEC §3 contract, and writes
 * `.lint-audit/<safe-timestamp>.json` for `/lint:update` and `/lint:report`
 * to consume.
 *
 * SPEC §2 `/lint:audit`: "roda fast+deep tier, avalia maturidade, e produz
 * lista acionável (...). Persiste resultado em `.lint-audit/<timestamp>.json`
 * para `/lint:update` consumir. Não modifica configs."
 *
 * Subprocess seam: oxlint is invoked via `runFn` (default
 * `child_process.execFileSync`), exactly like `install-deps`. Tests inject a
 * stub that returns canned diagnostic JSON so the unit suite can run without
 * oxlint installed in `node_modules/`.
 *
 * Composition:
 *   - tooling.{oxlint, oxfmt, quality_metrics}: read from
 *     `<cwd>/node_modules/<pkg>/package.json#version` (null = not installed).
 *   - tooling.test_runner / tooling.coverage: delegated to `detectTestRunner`.
 *   - stage / stage_signals: delegated to `detectStage`.
 *   - rules_active: parsed from `oxlint.fast.json` and `oxlint.deep.json`
 *     (`categories` + `rules`). `origin` is `preset:<stage>:<tier>` when the
 *     rule comes from a preset header (`_comment` carries the stage), or
 *     `preset:<tier>` when no stage tag is present.
 *   - violations: parsed defensively from oxlint stdout. Per-metric grouping
 *     uses the `quality-metrics/<metric>` rule prefix; non-quality-metrics
 *     diagnostics only contribute to `summary`.
 *   - recommendations: empty for now; `recs/generate` (next task) populates it.
 *
 * The payload is validated against `auditPayloadSchema` (zod) before write —
 * a schema drift surfaces as `schema_validation_failed` instead of silently
 * shipping a malformed audit file to `/lint:update`.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, path, bytes, timestamp, generated_at, payload }
 *
 * Exit codes:
 *   - OK                 — audit completed and zero error-level violations.
 *   - RECOVERABLE_ERROR  — audit completed with `summary.errors > 0`, or any
 *                          recoverable failure (preset missing, schema fail,
 *                          oxlint output unparseable).
 *   - MISSING_DEPENDENCY — `oxlint` binary not installed (and we have no way
 *                          to run the audit).
 *   - USAGE_ERROR        — flag parser failure.
 *   - DIRTY_TREE         — `--strict` set and the working tree is dirty
 *                          (defense-in-depth — audit is read-only but the
 *                          flag mirrors the rest of the CLI).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AUDIT_SCHEMA_VERSION,
  type AuditPayload,
  type MetricKey,
  type MetricViolations,
  type RuleActive,
  type RuleSeverity,
  type Stage,
  type Tooling,
  type ViolationTopEntry,
  type Violations,
  validateAuditPayload,
} from "../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { type SafeIO, type SafeResult, safeWriteFile } from "../lib/fs-safe.ts";
import { dirtyFiles as defaultDirtyFiles } from "../lib/git.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";
import {
  type DetectStageResult,
  detectStage,
} from "./detect-stage.ts";
import {
  type DetectTestRunnerResult,
  detectTestRunner,
} from "./detect-test-runner.ts";

export const AUDIT_DIR = ".lint-audit";

const TRACKED_PACKAGES = {
  oxlint: "oxlint",
  oxfmt: "oxfmt",
  quality_metrics: "quality-metrics",
} as const;

const PRESET_FILES = {
  fast: "oxlint.fast.json",
  deep: "oxlint.deep.json",
} as const;

type Tier = keyof typeof PRESET_FILES;

/**
 * Quality-metrics rule prefix → schema metric key.
 *
 * Legacy aliases (`halstead-volume`, `halstead-effort`) remain so audits
 * persisted under the old preset (separate rules per Halstead axis) still
 * aggregate into `by_metric.halstead`. The plugin's actual rule name is
 * `halstead` with `{ maxVolume, maxEffort }` options (Q1 in PLAN.md).
 */
const METRIC_RULE_TO_KEY: Record<string, MetricKey> = {
  wmc: "wmc",
  halstead: "halstead",
  "halstead-volume": "halstead",
  "halstead-effort": "halstead",
  lcom: "lcom",
  cbo: "cbo",
  dit: "dit",
};

const METRIC_KEYS: readonly MetricKey[] = ["wmc", "halstead", "lcom", "cbo", "dit"];

const TOP_PER_METRIC = 5;

// ---------------------------------------------------------------------------
// Subprocess seam
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type RunFn = (
  binary: string,
  args: readonly string[],
  cwd: string,
) => RunResult;

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
    // oxlint exits non-zero when it found error-level violations — that is a
    // *successful* run for audit (we still want the diagnostics). Treat any
    // run that produced non-empty stdout as a successful invocation; only
    // surface failure when both streams are empty (binary missing / argv
    // error).
    const ok = stdout.length > 0;
    return { ok, stdout, stderr: stderr || e.message || `${binary} failed`, exitCode };
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AuditOptions {
  readonly cwd: string;
  /** Tier to run. Default: "deep" (fast falls back when deep preset absent). */
  readonly tier?: Tier;
  /** Override timestamp (filesystem-safe form). When omitted, derived from `now`. */
  readonly timestamp?: string;
  /** Refuse to run if the working tree is dirty. */
  readonly strict?: boolean;
  /** Override oxlint binary path/name. Default `"oxlint"`. */
  readonly oxlintBin?: string;
}

export interface AuditOk {
  readonly ok: true;
  readonly cwd: string;
  readonly path: string;
  readonly bytes: number;
  readonly timestamp: string;
  readonly generated_at: string;
  readonly tier: Tier;
  readonly payload: AuditPayload;
}

export interface AuditErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type AuditResult = AuditOk | AuditErr;

export interface AuditDeps {
  readonly readFileFn?: (p: string) => string | null;
  readonly existsFn?: (p: string) => boolean;
  readonly runFn?: RunFn;
  readonly safeIO?: SafeIO;
  readonly detectStageFn?: typeof detectStage;
  readonly detectTestRunnerFn?: typeof detectTestRunner;
  readonly dirtyFilesFn?: (cwd: string) => SafeResult<readonly string[]>;
  readonly now?: () => Date;
}

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

function defaultDirtyAdapter(cwd: string): SafeResult<readonly string[]> {
  const r = defaultDirtyFiles(cwd);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

/**
 * Convert an ISO-8601 timestamp to a filesystem-safe form (mirrors
 * `backup-create.toSafeTimestamp`).
 */
export function toSafeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readInstalledVersion(
  cwd: string,
  pkgName: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): string | null {
  const p = join(cwd, "node_modules", pkgName, "package.json");
  if (!existsFn(p)) return null;
  const raw = readFileFn(p);
  if (raw === null) return null;
  const parsed = parseDefensive<{ version?: unknown }>(raw);
  if (!parsed.ok) return null;
  const v = parsed.value?.version;
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Preset → rules_active
// ---------------------------------------------------------------------------

interface PresetShape {
  readonly _comment?: unknown;
  readonly categories?: unknown;
  readonly rules?: unknown;
}

function isSeverity(s: unknown): s is RuleSeverity {
  return s === "error" || s === "warn" || s === "off";
}

/** Parse the `_comment` line for the stage tag (`stage=<name>`). */
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

/**
 * Extract `rules_active[]` entries from a single preset file. Each `rules.<id>`
 * key may carry either a bare severity (`"error"`, `"warn"`, `"off"`) or a
 * tuple `[severity, options]`. `categories.<name>` is recorded as a single
 * synthetic entry under rule `category:<name>` so downstream consumers can see
 * the bulk severity decisions.
 */
function rulesFromPreset(
  preset: PresetShape,
  origin: string,
): RuleActive[] {
  const out: RuleActive[] = [];

  // Categories first (deterministic ordering across runs).
  if (preset.categories !== null && typeof preset.categories === "object") {
    const cats = preset.categories as Record<string, unknown>;
    const keys = Object.keys(cats).sort();
    for (const cat of keys) {
      const sev = cats[cat];
      if (!isSeverity(sev)) continue;
      out.push({
        rule: `category:${cat}`,
        severity: sev,
        origin,
      });
    }
  }

  if (preset.rules !== null && typeof preset.rules === "object") {
    const rules = preset.rules as Record<string, unknown>;
    const keys = Object.keys(rules).sort();
    for (const ruleName of keys) {
      const v = rules[ruleName];
      let severity: RuleSeverity | null = null;
      let options: Record<string, unknown> | undefined;
      if (isSeverity(v)) {
        severity = v;
      } else if (Array.isArray(v) && v.length >= 1 && isSeverity(v[0])) {
        severity = v[0] as RuleSeverity;
        if (
          v.length >= 2 &&
          v[1] !== null &&
          typeof v[1] === "object" &&
          !Array.isArray(v[1])
        ) {
          options = v[1] as Record<string, unknown>;
        }
      }
      if (severity === null) continue;
      out.push({
        rule: ruleName,
        severity,
        ...(options !== undefined ? { options } : {}),
        origin,
      });
    }
  }

  return out;
}

/**
 * Read both presets, return their merged `rules_active[]`. Missing presets are
 * skipped silently (the caller already verified at least one exists).
 */
function readRulesActive(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): RuleActive[] {
  const out: RuleActive[] = [];
  for (const tier of ["fast", "deep"] as const) {
    const path = join(cwd, PRESET_FILES[tier]);
    if (!existsFn(path)) continue;
    const raw = readFileFn(path);
    if (raw === null) continue;
    const parsed = parseDefensive<PresetShape>(raw);
    if (!parsed.ok) continue;
    const preset = parsed.value;
    if (preset === null || typeof preset !== "object") continue;
    const stage = readStageFromComment(preset._comment);
    const origin = stage !== null ? `preset:${stage}:${tier}` : `preset:${tier}`;
    out.push(...rulesFromPreset(preset, origin));
  }
  return out;
}

// ---------------------------------------------------------------------------
// oxlint output → violations
// ---------------------------------------------------------------------------

interface RawDiagnostic {
  readonly severity?: unknown;
  readonly message?: unknown;
  readonly filename?: unknown;
  readonly file?: unknown;
  readonly path?: unknown;
  readonly rule?: unknown;
  readonly code?: unknown;
  readonly ruleId?: unknown;
  readonly value?: unknown;
  readonly max?: unknown;
  readonly class?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Defensive: oxlint output may be a top-level array, an `{ diagnostics: [] }`
 *  object, NDJSON (one diagnostic per line), or empty. Try each in order. */
function parseOxlintOutput(raw: string): RawDiagnostic[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const single = parseDefensive<unknown>(trimmed);
  if (single.ok) {
    const v = single.value;
    if (Array.isArray(v)) return v as RawDiagnostic[];
    if (v !== null && typeof v === "object") {
      const obj = v as { diagnostics?: unknown };
      if (Array.isArray(obj.diagnostics)) return obj.diagnostics as RawDiagnostic[];
    }
    // Single diagnostic object (rare).
    if (v !== null && typeof v === "object") return [v as RawDiagnostic];
    return [];
  }

  // Fall back to NDJSON (one JSON object per line).
  const out: RawDiagnostic[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const piece = line.trim();
    if (piece.length === 0) continue;
    const parsed = parseDefensive<unknown>(piece);
    if (!parsed.ok) continue;
    if (parsed.value !== null && typeof parsed.value === "object") {
      out.push(parsed.value as RawDiagnostic);
    }
  }
  return out;
}

interface NormalizedDiagnostic {
  readonly file: string;
  readonly severity: "error" | "warning";
  readonly rule: string | null;
  readonly value: number | undefined;
  readonly max: number | undefined;
  readonly class: string | undefined;
}

function normalizeSeverity(v: unknown): "error" | "warning" | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (s === "error") return "error";
  if (s === "warning" || s === "warn") return "warning";
  return null;
}

function normalizeDiagnostic(d: RawDiagnostic): NormalizedDiagnostic | null {
  const sev = normalizeSeverity(d.severity);
  if (sev === null) return null;
  const file =
    asString(d.filename) ?? asString(d.file) ?? asString(d.path);
  if (file === undefined) return null;
  const rule =
    asString(d.rule) ?? asString(d.code) ?? asString(d.ruleId) ?? null;
  return {
    file,
    severity: sev,
    rule,
    value: asNumber(d.value),
    max: asNumber(d.max),
    class: asString(d.class),
  };
}

/**
 * Maps an oxlint rule identifier to its canonical metric key.
 *
 * Accepts both shapes the audit pipeline encounters:
 *   - `quality-metrics/<rule>`  — slash form (legacy presets, ESLint-style outputs)
 *   - `quality-metrics(<rule>)` — parens form (oxlint 1.62.0 JSON `code` field)
 *
 * Without parens tolerance, real oxlint diagnostics never aggregate into
 * `by_metric.*` (Bug B5 in PLAN.md).
 */
export function metricKeyFromRule(rule: string | null): MetricKey | null {
  if (rule === null || rule === "") return null;
  const QM_NS = "quality-metrics";
  let tail: string | null = null;
  const slash = rule.indexOf("/");
  if (slash !== -1) {
    if (rule.slice(0, slash) !== QM_NS) return null;
    tail = rule.slice(slash + 1);
  } else if (rule.endsWith(")")) {
    const open = rule.indexOf("(");
    if (open === -1) return null;
    if (rule.slice(0, open) !== QM_NS) return null;
    tail = rule.slice(open + 1, -1);
  }
  if (tail === null || tail === "") return null;
  return METRIC_RULE_TO_KEY[tail] ?? null;
}

function emptyMetricViolations(): MetricViolations {
  return { violations: 0, top: [] };
}

function aggregateViolations(diagnostics: readonly NormalizedDiagnostic[]): Violations {
  let errors = 0;
  let warnings = 0;
  const filesAffected = new Set<string>();

  const buckets: Record<MetricKey, NormalizedDiagnostic[]> = {
    wmc: [],
    halstead: [],
    lcom: [],
    cbo: [],
    dit: [],
  };

  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else warnings++;
    filesAffected.add(d.file);
    const metric = metricKeyFromRule(d.rule);
    if (metric !== null) buckets[metric].push(d);
  }

  const by_metric = {
    wmc: emptyMetricViolations(),
    halstead: emptyMetricViolations(),
    lcom: emptyMetricViolations(),
    cbo: emptyMetricViolations(),
    dit: emptyMetricViolations(),
  };

  for (const key of METRIC_KEYS) {
    const list = buckets[key];
    if (list.length === 0) continue;
    // Sort by `value` desc so `top[]` shows the worst offenders.
    const sorted = [...list].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const top: ViolationTopEntry[] = sorted.slice(0, TOP_PER_METRIC).map((d) => ({
      file: d.file,
      ...(d.class !== undefined ? { class: d.class } : {}),
      ...(d.value !== undefined ? { value: d.value } : {}),
      ...(d.max !== undefined ? { max: d.max } : {}),
    }));
    const numericValues = list
      .map((d) => d.value)
      .filter((v): v is number => typeof v === "number");
    const max_seen = numericValues.length > 0 ? Math.max(...numericValues) : undefined;

    if (key === "halstead") {
      by_metric.halstead = {
        violations: list.length,
        ...(max_seen !== undefined ? { max_seen_volume: max_seen } : {}),
        top,
      };
    } else {
      by_metric[key] = {
        violations: list.length,
        ...(max_seen !== undefined ? { max_seen } : {}),
        top,
      };
    }
  }

  return {
    summary: { errors, warnings, files_affected: filesAffected.size },
    by_metric,
  };
}

// ---------------------------------------------------------------------------
// Tooling block
// ---------------------------------------------------------------------------

function buildTooling(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
  testRunner: DetectTestRunnerResult,
): Tooling {
  return {
    oxlint: readInstalledVersion(cwd, TRACKED_PACKAGES.oxlint, existsFn, readFileFn),
    oxfmt: readInstalledVersion(cwd, TRACKED_PACKAGES.oxfmt, existsFn, readFileFn),
    quality_metrics: readInstalledVersion(
      cwd,
      TRACKED_PACKAGES.quality_metrics,
      existsFn,
      readFileFn,
    ),
    test_runner: testRunner.runner,
    coverage: {
      configured: testRunner.coverage.configured,
      ...(testRunner.coverage.current_thresholds !== null
        ? { thresholds: thresholdsHitToObject(testRunner.coverage.current_thresholds) }
        : {}),
    },
  };
}

function thresholdsHitToObject(t: {
  lines: number | null;
  functions: number | null;
  branches: number | null;
  statements: number | null;
}): { lines?: number | null; functions?: number | null; branches?: number | null; statements?: number | null } {
  const out: {
    lines?: number | null;
    functions?: number | null;
    branches?: number | null;
    statements?: number | null;
  } = {};
  if (t.lines !== null) out.lines = t.lines;
  if (t.functions !== null) out.functions = t.functions;
  if (t.branches !== null) out.branches = t.branches;
  if (t.statements !== null) out.statements = t.statements;
  return out;
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

interface TierResolution {
  readonly tier: Tier;
  readonly configFile: string;
}

function resolveTier(
  cwd: string,
  preferred: Tier,
  existsFn: (p: string) => boolean,
): TierResolution | { ok: false; error: string; reason: string } {
  const preferredPath = join(cwd, PRESET_FILES[preferred]);
  if (existsFn(preferredPath)) {
    return { tier: preferred, configFile: PRESET_FILES[preferred] };
  }
  const fallback: Tier = preferred === "deep" ? "fast" : "deep";
  const fallbackPath = join(cwd, PRESET_FILES[fallback]);
  if (existsFn(fallbackPath)) {
    return { tier: fallback, configFile: PRESET_FILES[fallback] };
  }
  return {
    ok: false,
    error: "preset_missing",
    reason: `neither ${PRESET_FILES.fast} nor ${PRESET_FILES.deep} exists in ${cwd} — run /lint:setup first`,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function audit(opts: AuditOptions, deps: AuditDeps = {}): AuditResult {
  const cwd = opts.cwd;
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const runFn = deps.runFn ?? defaultRun;
  const detectStageFn = deps.detectStageFn ?? detectStage;
  const detectTestRunnerFn = deps.detectTestRunnerFn ?? detectTestRunner;
  const dirtyFilesFn = deps.dirtyFilesFn ?? defaultDirtyAdapter;

  // Strict gate up-front (before any subprocess).
  if (opts.strict) {
    const dirty = dirtyFilesFn(cwd);
    if (!dirty.ok) {
      return { ok: false, error: "git_check_failed", reason: dirty.error };
    }
    if (dirty.value.length > 0) {
      return {
        ok: false,
        error: "dirty_tree",
        reason: `working tree is dirty (${dirty.value.length} file(s))`,
      };
    }
  }

  const tier = resolveTier(cwd, opts.tier ?? "deep", existsFn);
  if ("ok" in tier && tier.ok === false) {
    return tier;
  }
  if (!("tier" in tier)) {
    // Unreachable in practice — TypeScript narrowing aid.
    return { ok: false, error: "preset_missing", reason: "tier resolution returned no tier" };
  }

  const stageRes: DetectStageResult = detectStageFn({ cwd }, { existsFn, readFileFn });
  if (!stageRes.ok) {
    return { ok: false, error: "stage_detection_failed", reason: stageRes.error };
  }

  const testRunner = detectTestRunnerFn({ cwd }, { existsFn, readFileFn });
  const tooling = buildTooling(cwd, existsFn, readFileFn, testRunner);
  const rules_active = readRulesActive(cwd, existsFn, readFileFn);

  // Run oxlint. Non-zero exit is OK as long as we got stdout — that's how
  // oxlint signals "found violations"; the binary-missing case has empty
  // stdout AND empty stderr-typed message.
  const oxlintBin = opts.oxlintBin ?? "oxlint";
  const args = ["--config", tier.configFile, "--format", "json", "."];
  const run = runFn(oxlintBin, args, cwd);
  if (!run.ok && run.stdout.length === 0) {
    return {
      ok: false,
      error: "oxlint_missing",
      reason: `${oxlintBin} ${args.join(" ")}: ${run.stderr.trim() || "binary not found"}`,
    };
  }

  const rawDiagnostics = parseOxlintOutput(run.stdout);
  const normalized: NormalizedDiagnostic[] = [];
  for (const d of rawDiagnostics) {
    const n = normalizeDiagnostic(d);
    if (n !== null) normalized.push(n);
  }
  const violations = aggregateViolations(normalized);

  const now = deps.now ? deps.now() : new Date();
  const generated_at = now.toISOString();
  const timestamp = opts.timestamp ?? toSafeTimestamp(now);

  const payloadCandidate: AuditPayload = {
    version: AUDIT_SCHEMA_VERSION,
    generated_at,
    stage: stageRes.stage,
    stage_signals: { ...stageRes.signals },
    tooling,
    violations,
    rules_active,
    recommendations: [],
  };

  const validated = validateAuditPayload(payloadCandidate);
  if (!validated.ok) {
    return {
      ok: false,
      error: "schema_validation_failed",
      reason: validated.error,
    };
  }

  const relPath = `${AUDIT_DIR}/${timestamp}.json`;
  const writeRes = safeWriteFile(
    cwd,
    relPath,
    // SPEC §3 example uses 2-space indent; match that for parity with
    // `stringifyPretty` so audit files are diffable across runs.
    JSON.stringify(validated.value, null, 2) + "\n",
    { skipManifest: true, strict: opts.strict ?? false },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return { ok: false, error: "write_failed", reason: `${relPath}: ${writeRes.error}` };
  }

  return {
    ok: true,
    cwd,
    path: writeRes.value.path,
    bytes: writeRes.value.bytes,
    timestamp,
    generated_at,
    tier: tier.tier,
    payload: validated.value,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

const TIERS: readonly Tier[] = ["fast", "deep"];

export interface ParsedArgs {
  readonly cwd: string;
  readonly tier?: Tier;
  readonly timestamp?: string;
  readonly strict: boolean;
  readonly oxlintBin?: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

function isTier(s: string): s is Tier {
  return (TIERS as readonly string[]).includes(s);
}

export function parseAuditArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let tier: Tier | undefined;
  let timestamp: string | undefined;
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
    if (arg === "--tier") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --tier" };
      }
      if (!isTier(value)) {
        return { ok: false, error: `invalid tier: ${value} (expected: ${TIERS.join("|")})` };
      }
      tier = value;
      i++;
      continue;
    }
    if (arg === "--ts") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --ts" };
      }
      timestamp = value;
      i++;
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
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return {
    ok: true,
    value: {
      cwd,
      ...(tier !== undefined ? { tier } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      strict,
      ...(oxlintBin !== undefined ? { oxlintBin } : {}),
    },
  };
}

export function runAudit(argv: readonly string[]): ExitCode {
  const parsed = parseAuditArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy audit [--cwd <path>] [--tier fast|deep] [--ts <safe-ts>] [--strict] [--oxlint-bin <bin>]\n" +
          "\n" +
          "Runs oxlint with the chosen tier preset, aggregates the diagnostic stream into\n" +
          "the SPEC §3 audit contract, and writes .lint-audit/<safe-ts>.json.\n" +
          "Default tier: deep (falls back to fast when oxlint.deep.json is absent).\n" +
          "Exit codes: 0 ok (no errors), 1 errors found / recoverable failure,\n" +
          "  3 dirty tree (--strict), 4 usage, 5 oxlint binary missing.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "audit", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = audit(parsed.value);
  if (!result.ok) {
    logger.error("audit_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "dirty_tree") return EXIT_CODES.DIRTY_TREE;
    if (result.error === "oxlint_missing") return EXIT_CODES.MISSING_DEPENDENCY;
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("audit_ok", {
    tier: result.tier,
    timestamp: result.timestamp,
    errors: result.payload.violations.summary.errors,
    warnings: result.payload.violations.summary.warnings,
    files: result.payload.violations.summary.files_affected,
  });
  // SPEC §lib/exit-codes.ts: RECOVERABLE_ERROR(1) is the documented signal for
  // "audit found error-level violations".
  return result.payload.violations.summary.errors > 0
    ? EXIT_CODES.RECOVERABLE_ERROR
    : EXIT_CODES.OK;
}
