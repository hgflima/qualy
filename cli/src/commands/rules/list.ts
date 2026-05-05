/**
 * `rules-list` — read-only inventory of oxlint rules in the target project.
 *
 * SPEC §2 `/lint:rules:list`: "Lista todas as rules ativas com origem
 * (preset / customização do usuário), severidade e threshold. Mostra também
 * rules disponíveis e desativadas."
 *
 * Three buckets, all derived from the project's `oxlint.fast.json` and
 * `oxlint.deep.json`:
 *   - `active`   — rules with severity `"error"` or `"warn"` (carry origin,
 *                  severity, options).
 *   - `disabled` — rules with severity `"off"` (explicit opt-out).
 *   - `available` — rules from the stage's baseline preset that are absent
 *                   from both user presets (suggested via `quality-metrics/*`).
 *
 * Stage detection: read `_comment` line of the first preset file present
 * (`stage=<name>`); fallback to `null` (the harness can re-run with
 * `detect-stage` if it needs the stage for cross-references).
 *
 * Origin tags follow the same convention as `audit.ts`:
 *   - `preset:<stage>:<tier>`  — preset entry with stage tag in `_comment`.
 *   - `preset:<tier>`           — preset entry without stage tag.
 *   - `user-override:<date>`    — out of scope for v1 (the project doesn't
 *                                 distinguish user edits in the preset JSON
 *                                 itself; `rules-add`/`rules-remove` will tag
 *                                 entries via `docs/lint-decisions.md`).
 *
 * Output (PLAN §Contratos CLI shape):
 *   { ok, cwd, stage, active, disabled, available }
 *
 * Exit codes:
 *   - OK                 — at least one preset read successfully.
 *   - RECOVERABLE_ERROR  — neither preset present (`preset_missing`) or both
 *                          unparseable (`preset_malformed`).
 *   - USAGE_ERROR        — flag parser failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type RuleActive,
  type RuleSeverity,
  type Stage,
} from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { loadManifest } from "../../lib/fs-safe.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RulesListOptions {
  readonly cwd: string;
}

export interface AvailableRule {
  readonly rule: string;
  readonly suggested_severity: RuleSeverity;
  /** Single-number threshold for wmc/cbo/dit. */
  readonly suggested_max?: number;
  /** lcom-specific option key. */
  readonly suggested_max_lcom?: number;
  /** halstead pair (compound rule). */
  readonly suggested_max_volume?: number;
  readonly suggested_max_effort?: number;
  readonly source: string;
}

export interface RulesListOk {
  readonly ok: true;
  readonly cwd: string;
  readonly stage: Stage | null;
  readonly active: readonly RuleActive[];
  readonly disabled: readonly RuleActive[];
  readonly available: readonly AvailableRule[];
}

export interface RulesListErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type RulesListResult = RulesListOk | RulesListErr;

export interface RulesListDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly readFileFn?: (p: string) => string | null;
}

// ---------------------------------------------------------------------------
// Stage baseline tables — locked by `cli/src/presets/oxlint/<stage>.deep.json`.
// Used only to compute `available[]` for the detected stage.
// ---------------------------------------------------------------------------

interface BaselineRule {
  readonly rule: string;
  readonly severity: RuleSeverity;
  /** Single-axis threshold (wmc, cbo, dit). */
  readonly max?: number;
  /** lcom-specific option (the plugin schema rejects bare `max`). */
  readonly maxLcom?: number;
  /** halstead pair (compound rule). */
  readonly maxVolume?: number;
  readonly maxEffort?: number;
}

const STAGE_BASELINE_DEEP: Readonly<Record<Stage, readonly BaselineRule[]>> = {
  greenfield: [
    { rule: "quality-metrics/wmc", severity: "error", max: 15 },
    { rule: "quality-metrics/halstead", severity: "warn", maxVolume: 800, maxEffort: 300 },
    { rule: "quality-metrics/lcom", severity: "warn", maxLcom: 0 },
    { rule: "quality-metrics/cbo", severity: "error", max: 8 },
    { rule: "quality-metrics/dit", severity: "warn", max: 4 },
  ],
  "brownfield-moderate": [
    { rule: "quality-metrics/wmc", severity: "error", max: 20 },
    { rule: "quality-metrics/halstead", severity: "warn", maxVolume: 1000, maxEffort: 400 },
    { rule: "quality-metrics/lcom", severity: "warn", maxLcom: 2 },
    { rule: "quality-metrics/cbo", severity: "error", max: 10 },
    { rule: "quality-metrics/dit", severity: "warn", max: 5 },
  ],
  legacy: [
    { rule: "quality-metrics/wmc", severity: "warn", max: 40 },
    { rule: "quality-metrics/halstead", severity: "warn", maxVolume: 2000, maxEffort: 1000 },
    { rule: "quality-metrics/lcom", severity: "warn", maxLcom: 4 },
    { rule: "quality-metrics/cbo", severity: "warn", max: 20 },
    { rule: "quality-metrics/dit", severity: "warn", max: 6 },
  ],
};

// ---------------------------------------------------------------------------
// Preset reading
// ---------------------------------------------------------------------------

const PRESET_FILES = {
  fast: "oxlint.fast.json",
  deep: "oxlint.deep.json",
} as const;

type Tier = keyof typeof PRESET_FILES;

interface PresetShape {
  readonly categories?: unknown;
  readonly rules?: unknown;
}

function isSeverity(s: unknown): s is RuleSeverity {
  return s === "error" || s === "warn" || s === "off";
}

function readStageFromManifest(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): Stage | null {
  const manifest = loadManifest(cwd, { existsFn, readFileFn });
  if (!manifest || manifest.stage === undefined) return null;
  return manifest.stage;
}

function rulesFromPreset(preset: PresetShape, origin: string): RuleActive[] {
  const out: RuleActive[] = [];

  if (preset.categories !== null && typeof preset.categories === "object") {
    const cats = preset.categories as Record<string, unknown>;
    const keys = Object.keys(cats).sort();
    for (const cat of keys) {
      const sev = cats[cat];
      if (!isSeverity(sev)) continue;
      out.push({ rule: `category:${cat}`, severity: sev, origin });
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

interface PresetRead {
  readonly tier: Tier;
  readonly stage: Stage | null;
  readonly entries: readonly RuleActive[];
}

interface PresetsReadResult {
  readonly stage: Stage | null;
  readonly reads: readonly PresetRead[];
  readonly anyPresent: boolean;
  readonly malformedAll: boolean;
}

function readPresets(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): PresetsReadResult {
  const stageFromManifest = readStageFromManifest(cwd, existsFn, readFileFn);
  const reads: PresetRead[] = [];
  let anyPresent = false;
  let malformedCount = 0;
  let presentCount = 0;

  for (const tier of ["fast", "deep"] as const) {
    const path = join(cwd, PRESET_FILES[tier]);
    if (!existsFn(path)) continue;
    presentCount++;
    anyPresent = true;
    const raw = readFileFn(path);
    if (raw === null) {
      malformedCount++;
      continue;
    }
    const parsed = parseDefensive<PresetShape>(raw);
    if (!parsed.ok) {
      malformedCount++;
      continue;
    }
    const preset = parsed.value;
    if (preset === null || typeof preset !== "object") {
      malformedCount++;
      continue;
    }
    const origin =
      stageFromManifest !== null
        ? `preset:${stageFromManifest}:${tier}`
        : `preset:${tier}`;
    reads.push({ tier, stage: stageFromManifest, entries: rulesFromPreset(preset, origin) });
  }

  return {
    stage: stageFromManifest,
    reads,
    anyPresent,
    malformedAll: anyPresent && malformedCount === presentCount,
  };
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

function bucketize(reads: readonly PresetRead[]): {
  active: RuleActive[];
  disabled: RuleActive[];
} {
  const active: RuleActive[] = [];
  const disabled: RuleActive[] = [];
  for (const read of reads) {
    for (const entry of read.entries) {
      if (entry.severity === "off") disabled.push(entry);
      else active.push(entry);
    }
  }
  return { active, disabled };
}

function computeAvailable(
  stage: Stage | null,
  active: readonly RuleActive[],
  disabled: readonly RuleActive[],
): AvailableRule[] {
  if (stage === null) return [];
  const baseline = STAGE_BASELINE_DEEP[stage];
  const present = new Set<string>();
  for (const r of active) present.add(r.rule);
  for (const r of disabled) present.add(r.rule);
  const out: AvailableRule[] = [];
  for (const b of baseline) {
    if (present.has(b.rule)) continue;
    out.push({
      rule: b.rule,
      suggested_severity: b.severity,
      ...(b.max !== undefined ? { suggested_max: b.max } : {}),
      ...(b.maxLcom !== undefined ? { suggested_max_lcom: b.maxLcom } : {}),
      ...(b.maxVolume !== undefined ? { suggested_max_volume: b.maxVolume } : {}),
      ...(b.maxEffort !== undefined ? { suggested_max_effort: b.maxEffort } : {}),
      source: `baseline:${stage}:deep`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function rulesList(
  opts: RulesListOptions,
  deps: RulesListDeps = {},
): RulesListResult {
  const cwd = opts.cwd;
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const presets = readPresets(cwd, existsFn, readFileFn);

  if (!presets.anyPresent) {
    return {
      ok: false,
      error: "preset_missing",
      reason:
        "neither oxlint.fast.json nor oxlint.deep.json found — run /lint:setup first",
    };
  }

  if (presets.malformedAll) {
    return {
      ok: false,
      error: "preset_malformed",
      reason: "all preset files are unreadable or invalid JSON",
    };
  }

  const { active, disabled } = bucketize(presets.reads);
  const available = computeAvailable(presets.stage, active, disabled);

  return {
    ok: true,
    cwd,
    stage: presets.stage,
    active,
    disabled,
    available,
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

export function parseRulesListArgs(
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

export function runRulesList(argv: readonly string[]): ExitCode {
  const parsed = parseRulesListArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy rules-list [--cwd <path>]\n" +
          "\n" +
          "Lists oxlint rules in the project's presets, classified into\n" +
          "active (severity error|warn), disabled (severity off), and\n" +
          "available (rules from the stage baseline that aren't present).\n" +
          "Read-only — never writes. Exit codes: 0 ok, 1 preset missing or\n" +
          "all malformed, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "rules-list", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = rulesList(parsed.value);
  if (!result.ok) {
    logger.error("rules_list_failed", { reason: result.reason ?? result.error });
    output(result);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("rules_list_ok", {
    stage: result.stage,
    active: result.active.length,
    disabled: result.disabled.length,
    available: result.available.length,
  });
  return EXIT_CODES.OK;
}
