/**
 * Zod schemas for the `/lint:audit` JSON contract (`.lint-audit/<ts>.json`).
 *
 * Mirrors SPEC §3 — "Contrato de audit". Authoritative payload consumed by
 * `/lint:update` (recommendations) and `/lint:report` (visualization). Drift
 * here breaks both consumers — every field declared in SPEC §3 must round-trip
 * through `auditPayloadSchema.parse()`.
 *
 * Validation seam: callers pair this with `parseDefensive` from `lib/json.ts`
 * to read disk → JSON → typed payload without ever throwing. Use `safeParse`
 * (returns a `ZodSafeParseReturnType`) inside CLI commands so a corrupt audit
 * file never crashes the harness.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (string literals fixed by SPEC §3)
// ---------------------------------------------------------------------------

export const STAGES = ["greenfield", "brownfield-moderate", "legacy"] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const TEST_RUNNERS = ["vitest", "jest", "none"] as const;
export const testRunnerSchema = z.enum(TEST_RUNNERS);
export type TestRunner = z.infer<typeof testRunnerSchema>;

/** Per-rule severity inside `rules_active[]`. */
export const RULE_SEVERITIES = ["error", "warn", "off"] as const;
export const ruleSeveritySchema = z.enum(RULE_SEVERITIES);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

/** Per-recommendation severity (`recommendations[].severity`). */
export const REC_SEVERITIES = ["suggest", "recommend", "critical"] as const;
export const recSeveritySchema = z.enum(REC_SEVERITIES);
export type RecSeverity = z.infer<typeof recSeveritySchema>;

/** Recommendation type union (SPEC §3 line 273). */
export const REC_TYPES = [
  "raise-threshold",
  "lower-threshold",
  "add-rule",
  "remove-rule",
  "enable-tier",
  "tighten-coverage",
  "loosen-coverage",
  "fix-tooling",
] as const;
export const recTypeSchema = z.enum(REC_TYPES);
export type RecType = z.infer<typeof recTypeSchema>;

/** Metrics enumerated under `violations.by_metric`. */
export const METRIC_KEYS = ["wmc", "halstead", "lcom", "cbo", "dit"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

// ---------------------------------------------------------------------------
// `tooling`
// ---------------------------------------------------------------------------

const coverageThresholdsSchema = z
  .object({
    lines: z.number().nullable().optional(),
    functions: z.number().nullable().optional(),
    branches: z.number().nullable().optional(),
    statements: z.number().nullable().optional(),
  })
  .optional();

export const coverageSchema = z.object({
  configured: z.boolean(),
  lines: z.number().nullable().optional(),
  functions: z.number().nullable().optional(),
  branches: z.number().nullable().optional(),
  statements: z.number().nullable().optional(),
  thresholds: coverageThresholdsSchema,
});

export const toolingSchema = z.object({
  oxlint: z.string().nullable(),
  oxfmt: z.string().nullable(),
  quality_metrics: z.string().nullable(),
  test_runner: testRunnerSchema,
  coverage: coverageSchema,
});
export type Tooling = z.infer<typeof toolingSchema>;

// ---------------------------------------------------------------------------
// `violations`
// ---------------------------------------------------------------------------

/**
 * Generic shape for `violations.by_metric.<metric>.top[]`. SPEC §3 only
 * documents `{ file, class, value, max }` for WMC; other metrics share the
 * same shape but may omit `class` (Halstead is per-file, LCOM is per-class,
 * CBO/DIT are per-class). Keep all fields beyond `file` optional to allow
 * forward-compat without breaking the audit consumers.
 */
export const violationTopEntrySchema = z.object({
  file: z.string(),
  class: z.string().optional(),
  value: z.number().optional(),
  max: z.number().optional(),
});
export type ViolationTopEntry = z.infer<typeof violationTopEntrySchema>;

export const metricViolationsSchema = z.object({
  violations: z.number().int().nonnegative(),
  max_seen: z.number().optional(),
  max_seen_volume: z.number().optional(),
  max_seen_effort: z.number().optional(),
  top: z.array(violationTopEntrySchema),
});
export type MetricViolations = z.infer<typeof metricViolationsSchema>;

export const violationsSummarySchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  files_affected: z.number().int().nonnegative(),
});
export type ViolationsSummary = z.infer<typeof violationsSummarySchema>;

export const violationsByMetricSchema = z.object({
  wmc: metricViolationsSchema,
  halstead: metricViolationsSchema,
  lcom: metricViolationsSchema,
  cbo: metricViolationsSchema,
  dit: metricViolationsSchema,
});
export type ViolationsByMetric = z.infer<typeof violationsByMetricSchema>;

export const violationsSchema = z.object({
  summary: violationsSummarySchema,
  by_metric: violationsByMetricSchema,
});
export type Violations = z.infer<typeof violationsSchema>;

// ---------------------------------------------------------------------------
// `rules_active`
// ---------------------------------------------------------------------------

/**
 * Per-rule entry. `options` is loose — oxlint rules carry rule-specific
 * shapes (e.g. `{ max: 20 }` for quality-metrics rules; arbitrary objects
 * for ESLint-ported rules). `origin` is a short tag like
 * `"preset:brownfield-moderate"` or `"user-override:2026-04-12"`.
 */
export const ruleActiveSchema = z.object({
  rule: z.string().min(1),
  severity: ruleSeveritySchema,
  options: z.record(z.unknown()).optional(),
  origin: z.string().min(1),
});
export type RuleActive = z.infer<typeof ruleActiveSchema>;

// ---------------------------------------------------------------------------
// `recommendations`
// ---------------------------------------------------------------------------

export const blastRadiusSchema = z.object({
  files_newly_violating: z.number().int().nonnegative(),
  files_currently_violating: z.number().int().nonnegative(),
});
export type BlastRadius = z.infer<typeof blastRadiusSchema>;

/**
 * `patch` is the proposed change to a preset/config; shape varies per `type`.
 * Keep it as an opaque object so every `recs/*` command can tag without a
 * schema migration. The downstream applier (`recs/apply`) is responsible for
 * narrowing this against the target preset format.
 */
export const recommendationSchema = z.object({
  id: z.string().min(1),
  type: recTypeSchema,
  title: z.string().min(1),
  rationale: z.string(),
  blast_radius: blastRadiusSchema,
  patch: z.record(z.unknown()),
  severity: recSeveritySchema,
  applies_to: z.string().min(1),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ---------------------------------------------------------------------------
// `stage_signals`
// ---------------------------------------------------------------------------

/**
 * Stage detection signals — kept as a loose record because `detect-stage`
 * may add new signals over time (SPEC §3 line 248: "git age, LOC, churn,
 * autores, testes, todos/hacks" is illustrative, not exhaustive).
 */
export const stageSignalsSchema = z.record(z.unknown());

// ---------------------------------------------------------------------------
// Top-level audit payload
// ---------------------------------------------------------------------------

/**
 * `version` is locked to "1" while the schema is alpha. Bump when introducing
 * breaking changes; consumers (`/lint:update`, `/lint:report`) must gate on
 * version before reading. ISO-8601 with trailing Z (UTC) for `generated_at`.
 */
export const AUDIT_SCHEMA_VERSION = "1";

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const auditPayloadSchema = z.object({
  version: z.literal(AUDIT_SCHEMA_VERSION),
  generated_at: z.string().regex(ISO_8601_UTC, "expected ISO-8601 UTC timestamp ending in Z"),
  stage: stageSchema,
  stage_signals: stageSignalsSchema,
  tooling: toolingSchema,
  violations: violationsSchema,
  rules_active: z.array(ruleActiveSchema),
  recommendations: z.array(recommendationSchema),
});
export type AuditPayload = z.infer<typeof auditPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type AuditValidation =
  | { ok: true; value: AuditPayload }
  | { ok: false; error: string; issues: z.ZodIssue[] };

/**
 * Defensive validator. Never throws; turns zod issues into a
 * `parseDefensive`-shaped result. Use this from CLI commands so a corrupt
 * audit file becomes a `RECOVERABLE_ERROR` instead of a stack trace.
 */
export function validateAuditPayload(input: unknown): AuditValidation {
  const result = auditPayloadSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  const path = first ? first.path.join(".") || "<root>" : "<root>";
  const message = first ? first.message : "validation failed";
  return {
    ok: false,
    error: `${path}: ${message}`,
    issues: result.error.issues,
  };
}
