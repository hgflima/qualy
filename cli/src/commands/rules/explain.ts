/**
 * `rules-explain` — read-only explanation of a single oxlint rule.
 *
 * SPEC §2 `/lint:rules:explain <rule>`: "Mostra descrição da rule, racional
 * empírico, threshold atual, links para docs do `quality-metrics` ou oxlint."
 *
 * Inputs:
 *   --rule <name>   the rule name (e.g. "quality-metrics/wmc",
 *                   "category:correctness"). May also be passed positionally
 *                   as the first non-flag argument so the harness can mirror
 *                   the SPEC `/lint:rules:explain <rule>` shape.
 *   --cwd <path>    project root (defaults to process.cwd()); used to read
 *                   the project's `oxlint.fast.json` / `oxlint.deep.json` for
 *                   the `current` block.
 *
 * Output (one canonical JSON to stdout):
 *   {
 *     ok: true,
 *     rule, category, title, description, rationale,
 *     current: { stage, tier, severity, options?, origin } | null,
 *     default_for_stage: { stage, severity, max } | null,
 *     links: [string, ...]
 *   }
 *
 * Exit codes:
 *   - OK                  — rule found in the static catalog.
 *   - RECOVERABLE_ERROR   — rule unknown to the catalog (`unknown_rule`).
 *   - USAGE_ERROR         — flag parser failure or missing rule argument.
 *
 * Read-only: never writes; preset I/O failures are surfaced as `current=null`
 * with a `current_source` field set to the diagnostic — the rule explanation
 * is still emitted so the user can learn about the rule without a preset
 * installed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type RuleSeverity,
  type Stage,
} from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RulesExplainOptions {
  readonly cwd: string;
  readonly rule: string;
}

export interface CurrentRuleState {
  readonly stage: Stage | null;
  readonly tier: "fast" | "deep";
  readonly severity: RuleSeverity;
  readonly options?: Record<string, unknown>;
  readonly origin: string;
}

export interface DefaultForStage {
  readonly stage: Stage;
  readonly severity: RuleSeverity;
  readonly max: number;
}

export interface RulesExplainOk {
  readonly ok: true;
  readonly rule: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly current: CurrentRuleState | null;
  readonly current_source: string | null;
  readonly default_for_stage: DefaultForStage | null;
  readonly links: readonly string[];
}

export interface RulesExplainErr {
  readonly ok: false;
  readonly error: string;
  readonly rule?: string;
  readonly reason?: string;
}

export type RulesExplainResult = RulesExplainOk | RulesExplainErr;

export interface RulesExplainDeps {
  readonly existsFn?: (p: string) => boolean;
  readonly readFileFn?: (p: string) => string | null;
}

// ---------------------------------------------------------------------------
// Static catalog
// ---------------------------------------------------------------------------

interface CatalogEntry {
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly links: readonly string[];
}

const QM_REPO = "https://github.com/hgflima/quality-metrics";
const OXLINT_DOCS = "https://oxc.rs/docs/guide/usage/linter.html";

const QM_LINKS: readonly string[] = [QM_REPO, OXLINT_DOCS];

const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  "quality-metrics/wmc": {
    category: "quality-metrics",
    title: "Weighted Methods per Class (WMC)",
    description:
      "Sum of cyclomatic complexities of all methods in a class. Captures the total decision complexity owned by a single class.",
    rationale:
      "Empirical studies (Basili, Briand & Melo 1996; Subramanyam & Krishnan 2003) link WMC > ~20 to a 2–3× increase in defect density. The greenfield threshold (15) is conservative; brownfield (20) accepts existing code; legacy (40, warn) signals without blocking.",
    links: QM_LINKS,
  },
  "quality-metrics/halstead-volume": {
    category: "quality-metrics",
    title: "Halstead Volume",
    description:
      "Program size derived from operator/operand counts: V = (N1+N2) * log2(n1+n2). Larger volume means more tokens to read.",
    rationale:
      "Halstead's information-theoretic measure correlates with reading effort. Volume > 1000 in a single function or module begins to exceed working-memory budgets typical in code review (Miller's 7±2, scaled).",
    links: QM_LINKS,
  },
  "quality-metrics/halstead-effort": {
    category: "quality-metrics",
    title: "Halstead Effort",
    description:
      "Estimated mental effort to comprehend a unit: E = D * V (difficulty × volume). Approximates programmer time.",
    rationale:
      "Halstead's effort metric tracks comprehension cost. Greenfield caps at 300 to keep functions reviewable in a single pass; legacy at 1000 flags units that should be a refactor target rather than blocked.",
    links: QM_LINKS,
  },
  "quality-metrics/lcom": {
    category: "quality-metrics",
    title: "Lack of Cohesion in Methods (LCOM)",
    description:
      "Counts pairs of methods that do not share instance fields. High LCOM = the class does multiple unrelated things.",
    rationale:
      "Chidamber & Kemerer's LCOM is a structural smell: classes with LCOM > 0 in greenfield often hide split responsibilities. Brownfield tolerates 2 to allow legitimate facade classes; legacy keeps it as a warn-only diagnostic.",
    links: QM_LINKS,
  },
  "quality-metrics/cbo": {
    category: "quality-metrics",
    title: "Coupling Between Objects (CBO)",
    description:
      "Count of distinct classes a class references (calls, fields, parameters, return types).",
    rationale:
      "Strong empirical correlation with fault-proneness (Basili et al. 1996). Greenfield enforces 8 (encourages dependency injection); brownfield 10 (realistic in feature-rich codebases); legacy 20 as warn — high CBO is a refactor signal, not a blocker.",
    links: QM_LINKS,
  },
  "quality-metrics/dit": {
    category: "quality-metrics",
    title: "Depth of Inheritance Tree (DIT)",
    description:
      "Length of the longest path from a class to the root of its inheritance hierarchy.",
    rationale:
      "Deep hierarchies make behavior harder to predict (Liskov substitution risk grows with depth). Caps tightened to 4–6 across stages discourage deep frameworks-style inheritance in favor of composition.",
    links: QM_LINKS,
  },
  "category:correctness": {
    category: "category",
    title: "oxlint correctness category",
    description:
      "Rules that catch code that is provably incorrect (e.g. `no-debugger`, `no-empty`, `no-async-promise-executor`).",
    rationale:
      "Bulk severity for the entire correctness family. Greenfield/brownfield set this to `error` (block CI on bugs); legacy lowers to `warn` so existing code can ship while teams burn down findings.",
    links: [OXLINT_DOCS],
  },
  "category:suspicious": {
    category: "category",
    title: "oxlint suspicious category",
    description:
      "Rules that flag patterns that are usually wrong but occasionally intentional (e.g. `no-implicit-coercion`).",
    rationale:
      "Default severity is `warn` across all stages: too noisy to fail builds, too useful to silence. Promote individual rules to `error` via `/lint:rules:add` once the team agrees a pattern is unacceptable.",
    links: [OXLINT_DOCS],
  },
};

// ---------------------------------------------------------------------------
// Stage baseline (mirror of `rules-list` STAGE_BASELINE_DEEP — keep in sync)
// ---------------------------------------------------------------------------

const STAGE_BASELINE_DEEP: Readonly<
  Record<Stage, Readonly<Record<string, { severity: RuleSeverity; max: number }>>>
> = {
  greenfield: {
    "quality-metrics/wmc": { severity: "error", max: 15 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 800 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 300 },
    "quality-metrics/lcom": { severity: "warn", max: 0 },
    "quality-metrics/cbo": { severity: "error", max: 8 },
    "quality-metrics/dit": { severity: "warn", max: 4 },
  },
  "brownfield-moderate": {
    "quality-metrics/wmc": { severity: "error", max: 20 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 1000 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 500 },
    "quality-metrics/lcom": { severity: "warn", max: 2 },
    "quality-metrics/cbo": { severity: "error", max: 10 },
    "quality-metrics/dit": { severity: "warn", max: 5 },
  },
  legacy: {
    "quality-metrics/wmc": { severity: "warn", max: 40 },
    "quality-metrics/halstead-volume": { severity: "warn", max: 2000 },
    "quality-metrics/halstead-effort": { severity: "warn", max: 1000 },
    "quality-metrics/lcom": { severity: "warn", max: 4 },
    "quality-metrics/cbo": { severity: "warn", max: 20 },
    "quality-metrics/dit": { severity: "warn", max: 6 },
  },
};

// ---------------------------------------------------------------------------
// Preset reading (subset of rules-list logic — only what `current` needs)
// ---------------------------------------------------------------------------

const PRESET_FILES = {
  fast: "oxlint.fast.json",
  deep: "oxlint.deep.json",
} as const;

type Tier = keyof typeof PRESET_FILES;

interface PresetShape {
  readonly _comment?: unknown;
  readonly categories?: unknown;
  readonly rules?: unknown;
}

function isSeverity(s: unknown): s is RuleSeverity {
  return s === "error" || s === "warn" || s === "off";
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

interface FoundEntry {
  readonly tier: Tier;
  readonly stage: Stage | null;
  readonly severity: RuleSeverity;
  readonly options?: Record<string, unknown>;
}

function lookupRuleInPreset(
  preset: PresetShape,
  rule: string,
): { severity: RuleSeverity; options?: Record<string, unknown> } | null {
  if (rule.startsWith("category:")) {
    const cat = rule.slice("category:".length);
    if (preset.categories === null || typeof preset.categories !== "object") return null;
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
      return { severity, options: v[1] as Record<string, unknown> };
    }
    return { severity };
  }
  return null;
}

interface PresetScanResult {
  readonly stage: Stage | null;
  readonly found: FoundEntry | null;
  /** Diagnostic when no entry was found despite presets being present. */
  readonly source: string;
}

function scanPresets(
  cwd: string,
  rule: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): PresetScanResult {
  let anyPresent = false;
  let presentCount = 0;
  let malformedCount = 0;
  let detectedStage: Stage | null = null;
  let found: FoundEntry | null = null;

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
    const stage = readStageFromComment(preset._comment);
    if (detectedStage === null && stage !== null) detectedStage = stage;
    if (found === null) {
      const hit = lookupRuleInPreset(preset, rule);
      if (hit !== null) {
        found = { tier, stage, severity: hit.severity, ...(hit.options ? { options: hit.options } : {}) };
      }
    }
  }

  if (!anyPresent) {
    return { stage: null, found: null, source: "preset_missing" };
  }
  if (anyPresent && malformedCount === presentCount) {
    return { stage: null, found: null, source: "preset_malformed" };
  }
  if (found === null) {
    return { stage: detectedStage, found: null, source: "rule_absent_from_presets" };
  }
  return { stage: detectedStage, found, source: "preset_lookup_ok" };
}

function buildCurrent(found: FoundEntry): CurrentRuleState {
  const origin =
    found.stage !== null
      ? `preset:${found.stage}:${found.tier}`
      : `preset:${found.tier}`;
  return {
    stage: found.stage,
    tier: found.tier,
    severity: found.severity,
    ...(found.options !== undefined ? { options: found.options } : {}),
    origin,
  };
}

function defaultForStage(rule: string, stage: Stage | null): DefaultForStage | null {
  if (stage === null) return null;
  const baseline = STAGE_BASELINE_DEEP[stage][rule];
  if (baseline === undefined) return null;
  return { stage, severity: baseline.severity, max: baseline.max };
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

export function rulesExplain(
  opts: RulesExplainOptions,
  deps: RulesExplainDeps = {},
): RulesExplainResult {
  const cwd = opts.cwd;
  const rule = opts.rule;
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;

  const entry = CATALOG[rule];
  if (entry === undefined) {
    return {
      ok: false,
      error: "unknown_rule",
      rule,
      reason: `rule "${rule}" is not in the qualy catalog (run \`/lint:rules:list\` to see catalog rules)`,
    };
  }

  const scan = scanPresets(cwd, rule, existsFn, readFileFn);
  const current = scan.found !== null ? buildCurrent(scan.found) : null;
  const stageForDefault =
    scan.found !== null ? scan.found.stage : scan.stage;
  const def = defaultForStage(rule, stageForDefault);

  return {
    ok: true,
    rule,
    category: entry.category,
    title: entry.title,
    description: entry.description,
    rationale: entry.rationale,
    current,
    current_source: scan.source,
    default_for_stage: def,
    links: entry.links,
  };
}

/** Catalog accessor for tests + future tooling (e.g. rules-add validation). */
export function catalogedRules(): readonly string[] {
  return Object.keys(CATALOG).sort();
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly rule: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRulesExplainArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let rule: string | null = null;
  let positional: string | null = null;

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
    return { ok: false, error: "missing rule (use --rule <name> or pass as positional)" };
  }
  return { ok: true, value: { cwd, rule: resolvedRule } };
}

export function runRulesExplain(argv: readonly string[]): ExitCode {
  const parsed = parseRulesExplainArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy rules-explain <rule> [--cwd <path>]\n" +
          "qualy rules-explain --rule <rule> [--cwd <path>]\n" +
          "\n" +
          "Explains a rule from the qualy catalog: title, description, empirical\n" +
          "rationale, current severity/threshold from the project's preset (if\n" +
          "any), the stage default, and documentation links. Read-only — never\n" +
          "writes. Exit codes: 0 ok, 1 unknown rule, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "rules-explain", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = rulesExplain(parsed.value);
  if (!result.ok) {
    logger.error("rules_explain_failed", {
      rule: result.rule,
      reason: result.reason ?? result.error,
    });
    output(result);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("rules_explain_ok", {
    rule: result.rule,
    has_current: result.current !== null,
    has_default: result.default_for_stage !== null,
  });
  return EXIT_CODES.OK;
}
