/**
 * `recs-blast-radius` — fills in `blast_radius.files_newly_violating` for a
 * single candidate by running oxlint twice (current preset vs. proposed
 * preset) and comparing the sets of violating files.
 *
 * Contract: SPEC §6 Always — "mostrar blast_radius antes de aplicar". Heuristics
 * §3 line 50 declares `files_newly_violating: null` is the stub form filled by
 * this command.
 *
 * Strategy:
 *   1. Read the latest audit and re-run `recsGenerate` to get the candidate set
 *      (deterministic: same audit → same candidates).
 *   2. Look up the candidate by `--candidate-id`.
 *   3. Skip candidate types that don't translate to an oxlint config diff:
 *      `fix-tooling` (package.json), `tighten-coverage`/`loosen-coverage`
 *      (vitest/jest config), `enable-tier` (cross-preset, requires write).
 *      For those, return `{ applicable: false, reason }`.
 *   4. For applicable candidates (`raise-threshold`, `lower-threshold`,
 *      `add-rule`): clone the current preset, apply the patch in-memory, write
 *      the proposed preset to a tmp file, run oxlint with both configs, count
 *      unique violating files in each, compute the deltas.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, candidate_id, applicable: true, applies_to,
 *     blast_radius: { files_currently_violating, files_newly_violating,
 *                     files_no_longer_violating } }
 *
 *   or
 *
 *   { ok, cwd, candidate_id, applicable: false, reason }
 *
 * Exit codes:
 *   - OK                 — measurement completed (or skipped with `applicable:false`).
 *   - RECOVERABLE_ERROR  — audit missing/malformed, preset missing/malformed,
 *                          candidate id not found, oxlint output unparseable.
 *   - MISSING_DEPENDENCY — `oxlint` binary not available.
 *   - USAGE_ERROR        — flag parser failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AuditPayload, RecType } from "../../lib/audit-schema.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

import { auditLatest } from "../audit-latest.ts";
import { type RunFn, type RunResult } from "../audit.ts";
import { type Candidate, recsGenerate } from "./generate.ts";

// ---------------------------------------------------------------------------
// Types — public API
// ---------------------------------------------------------------------------

const APPLICABLE_TYPES: ReadonlySet<RecType> = new Set<RecType>([
  "raise-threshold",
  "lower-threshold",
  "add-rule",
]);

const APPLICABLE_PRESET_FILES: ReadonlySet<string> = new Set([
  "oxlint.fast.json",
  "oxlint.deep.json",
]);

export interface BlastRadiusOptions {
  readonly cwd: string;
  readonly audit: AuditPayload;
  readonly candidate: Candidate;
  /** Override oxlint binary. Defaults to `"oxlint"`. */
  readonly oxlintBin?: string;
}

export interface BlastRadiusMeasurement {
  readonly files_currently_violating: number;
  readonly files_newly_violating: number;
  readonly files_no_longer_violating: number;
}

export interface BlastRadiusOk {
  readonly ok: true;
  readonly cwd: string;
  readonly candidate_id: string;
  readonly applicable: true;
  readonly applies_to: string;
  readonly blast_radius: BlastRadiusMeasurement;
}

export interface BlastRadiusSkipped {
  readonly ok: true;
  readonly cwd: string;
  readonly candidate_id: string;
  readonly applicable: false;
  readonly reason: string;
}

export interface BlastRadiusErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type BlastRadiusResult = BlastRadiusOk | BlastRadiusSkipped | BlastRadiusErr;

export interface BlastRadiusDeps {
  readonly runFn?: RunFn;
  readonly readFileFn?: (p: string) => string | null;
  readonly writeFileFn?: (p: string, content: string) => void;
  readonly mkdtempFn?: (prefix: string) => string;
  readonly removeFn?: (p: string) => void;
}

// ---------------------------------------------------------------------------
// Default IO seams
// ---------------------------------------------------------------------------

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
    // Mirror audit.ts: oxlint exits non-zero when violations exist — that's a
    // *successful* invocation as far as we're concerned.
    const ok = stdout.length > 0;
    return { ok, stdout, stderr: stderr || e.message || `${binary} failed`, exitCode };
  }
};

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultWrite(p: string, content: string): void {
  writeFileSync(p, content);
}

function defaultMkdtemp(prefix: string): string {
  return mkdtempSync(prefix);
}

function defaultRemove(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

interface PresetShape {
  rules?: Record<string, unknown>;
  plugins?: unknown;
  [key: string]: unknown;
}

type PatchResult =
  | { ok: true; value: PresetShape }
  | { ok: false; error: string; reason: string };

/**
 * Apply a candidate's `suggested_change` to a deep-cloned copy of the current
 * preset. Returns the proposed preset object. Does NOT mutate `current`.
 *
 * Supported types (mirrors `APPLICABLE_TYPES`):
 *   - raise-threshold / lower-threshold: rewrite `rules[rule]` to carry the
 *     proposed `max`; preserve the existing severity and other options.
 *   - add-rule: insert `rules[rule] = ["warn", { max }]` and ensure
 *     `plugins[]` includes `"quality-metrics"` when the rule lives in that
 *     namespace. Default severity is "warn" — blast-radius only counts files,
 *     not severity, so warn is the safe choice (won't promote a measurement
 *     into an audit-blocker).
 */
function applyPatch(current: PresetShape, candidate: Candidate): PatchResult {
  const proposed: PresetShape = JSON.parse(JSON.stringify(current));
  const change = candidate.suggested_change as Record<string, unknown>;
  const rule = typeof change["rule"] === "string" ? change["rule"] : null;
  const max = typeof change["max"] === "number" ? change["max"] : null;

  if (rule === null || max === null) {
    return {
      ok: false,
      error: "patch_invalid",
      reason: `candidate ${candidate.id} suggested_change missing rule/max`,
    };
  }

  const rules: Record<string, unknown> =
    proposed.rules !== null && typeof proposed.rules === "object"
      ? { ...(proposed.rules as Record<string, unknown>) }
      : {};

  if (candidate.type === "raise-threshold" || candidate.type === "lower-threshold") {
    const existing = rules[rule];
    let severity: string = "warn";
    let options: Record<string, unknown> = { max };
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
        options = { ...(existing[1] as Record<string, unknown>), max };
      }
    } else {
      // Threshold change but rule absent — treat as patch_invalid; heuristic
      // only emits these for preset-active rules.
      return {
        ok: false,
        error: "patch_invalid",
        reason: `candidate ${candidate.id} targets ${rule} but rule is absent from preset`,
      };
    }
    rules[rule] = [severity, options];
    proposed.rules = rules;
    return { ok: true, value: proposed };
  }

  if (candidate.type === "add-rule") {
    rules[rule] = ["warn", { max }];
    proposed.rules = rules;
    if (rule.startsWith("quality-metrics/")) {
      const plugins = Array.isArray(proposed.plugins)
        ? [...(proposed.plugins as unknown[])]
        : [];
      if (!plugins.includes("quality-metrics")) plugins.push("quality-metrics");
      proposed.plugins = plugins;
    }
    return { ok: true, value: proposed };
  }

  // Unreachable — caller filters by APPLICABLE_TYPES.
  return {
    ok: false,
    error: "patch_invalid",
    reason: `candidate type ${candidate.type} is not supported by blast-radius`,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic parsing — minimal "set of violating files"
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

/**
 * Extract the set of unique file paths with at least one diagnostic. Mirrors
 * the defensive parser in audit.ts: tries top-level array → `{ diagnostics }`
 * → NDJSON. Empty stdout = empty set.
 */
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

  // NDJSON fallback.
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

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function skip(
  cwd: string,
  candidateId: string,
  reason: string,
): BlastRadiusSkipped {
  return { ok: true, cwd, candidate_id: candidateId, applicable: false, reason };
}

export function blastRadius(
  opts: BlastRadiusOptions,
  deps: BlastRadiusDeps = {},
): BlastRadiusResult {
  const { cwd, candidate } = opts;

  if (!APPLICABLE_TYPES.has(candidate.type)) {
    return skip(
      cwd,
      candidate.id,
      `candidate type '${candidate.type}' is not measurable via oxlint dry-run`,
    );
  }

  const presetFile = candidate.applies_to;
  if (!APPLICABLE_PRESET_FILES.has(presetFile)) {
    return skip(
      cwd,
      candidate.id,
      `candidate applies_to '${presetFile}' is not an oxlint preset file`,
    );
  }

  const readFileFn = deps.readFileFn ?? defaultRead;
  const presetPath = join(cwd, presetFile);
  const currentRaw = readFileFn(presetPath);
  if (currentRaw === null) {
    return {
      ok: false,
      error: "preset_missing",
      reason: `${presetFile}: file not readable under ${cwd}`,
    };
  }

  const parsed = parseDefensive<PresetShape>(currentRaw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return {
      ok: false,
      error: "preset_malformed",
      reason: `${presetFile}: ${parsed.ok ? "not an object" : parsed.error}`,
    };
  }

  const patchRes = applyPatch(parsed.value, candidate);
  if (!patchRes.ok) {
    return { ok: false, error: patchRes.error, reason: patchRes.reason };
  }

  const mkdtempFn = deps.mkdtempFn ?? defaultMkdtemp;
  const writeFileFn = deps.writeFileFn ?? defaultWrite;
  const removeFn = deps.removeFn ?? defaultRemove;
  const runFn = deps.runFn ?? defaultRun;
  const oxlintBin = opts.oxlintBin ?? "oxlint";

  let tmp: string | null = null;
  try {
    tmp = mkdtempFn(join(tmpdir(), "qualy-blast-"));
    const proposedPath = join(tmp, presetFile);
    try {
      writeFileFn(proposedPath, JSON.stringify(patchRes.value, null, 2) + "\n");
    } catch (err) {
      return {
        ok: false,
        error: "write_failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const args = (cfg: string): readonly string[] => [
      "--config",
      cfg,
      "--format",
      "json",
      ".",
    ];

    const currentRun: RunResult = runFn(oxlintBin, args(presetPath), cwd);
    if (!currentRun.ok && currentRun.stdout.length === 0) {
      return {
        ok: false,
        error: "oxlint_missing",
        reason: `${oxlintBin}: ${currentRun.stderr.trim() || "binary not found"}`,
      };
    }

    const proposedRun: RunResult = runFn(oxlintBin, args(proposedPath), cwd);
    if (!proposedRun.ok && proposedRun.stdout.length === 0) {
      return {
        ok: false,
        error: "oxlint_missing",
        reason: `${oxlintBin}: ${proposedRun.stderr.trim() || "binary not found"}`,
      };
    }

    const currentFiles = violatingFiles(currentRun.stdout);
    const proposedFiles = violatingFiles(proposedRun.stdout);

    let newly = 0;
    for (const f of proposedFiles) if (!currentFiles.has(f)) newly++;
    let noLonger = 0;
    for (const f of currentFiles) if (!proposedFiles.has(f)) noLonger++;

    return {
      ok: true,
      cwd,
      candidate_id: candidate.id,
      applicable: true,
      applies_to: presetFile,
      blast_radius: {
        files_currently_violating: currentFiles.size,
        files_newly_violating: newly,
        files_no_longer_violating: noLonger,
      },
    };
  } finally {
    if (tmp !== null) {
      try {
        removeFn(tmp);
      } catch {
        // best-effort cleanup; never mask the primary result
      }
    }
  }
}

// Re-export internals for tests.
export { applyPatch, violatingFiles, APPLICABLE_TYPES, APPLICABLE_PRESET_FILES };

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly candidateId: string;
  readonly oxlintBin?: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseRecsBlastRadiusArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let candidateId: string | null = null;
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
    if (arg === "--candidate-id") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --candidate-id" };
      }
      candidateId = value;
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
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  if (candidateId === null) {
    return { ok: false, error: "missing required flag: --candidate-id" };
  }
  return {
    ok: true,
    value: {
      cwd,
      candidateId,
      ...(oxlintBin !== undefined ? { oxlintBin } : {}),
    },
  };
}

export function runRecsBlastRadius(argv: readonly string[]): ExitCode {
  const parsed = parseRecsBlastRadiusArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy recs-blast-radius --candidate-id <id> [--cwd <path>] [--oxlint-bin <bin>]\n" +
          "\n" +
          "Reads the latest .lint-audit/<ts>.json, regenerates candidates, locates\n" +
          "the candidate by id, and runs oxlint twice (current preset vs. proposed)\n" +
          "to fill blast_radius.{files_currently_violating, files_newly_violating,\n" +
          "files_no_longer_violating}. Non-applicable candidate types\n" +
          "(fix-tooling, tighten/loosen-coverage, enable-tier) return\n" +
          "applicable:false with a reason.\n" +
          "Exit codes: 0 ok, 1 audit/preset/candidate failure, 4 usage,\n" +
          "  5 oxlint binary missing.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "recs-blast-radius", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const latest = auditLatest({ cwd: parsed.value.cwd });
  if (!latest.ok) {
    logger.error("recs_blast_radius_failed", {
      reason: latest.reason ?? latest.error,
    });
    output(latest);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  const recs = recsGenerate({ cwd: parsed.value.cwd, audit: latest.audit });
  if (!recs.ok) {
    logger.error("recs_blast_radius_failed", { reason: recs.reason ?? recs.error });
    output(recs);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  const candidate = recs.candidates.find((c) => c.id === parsed.value.candidateId);
  if (candidate === undefined) {
    const err = {
      ok: false as const,
      error: "candidate_not_found",
      reason: `no candidate with id '${parsed.value.candidateId}' in latest audit`,
    };
    logger.error("recs_blast_radius_failed", { reason: err.reason });
    output(err);
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  const result = blastRadius({
    cwd: parsed.value.cwd,
    audit: latest.audit,
    candidate,
    ...(parsed.value.oxlintBin !== undefined ? { oxlintBin: parsed.value.oxlintBin } : {}),
  });

  if (!result.ok) {
    logger.error("recs_blast_radius_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "oxlint_missing") return EXIT_CODES.MISSING_DEPENDENCY;
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  if (result.applicable) {
    logger.info("recs_blast_radius_ok", {
      candidate_id: result.candidate_id,
      applies_to: result.applies_to,
      currently: result.blast_radius.files_currently_violating,
      newly: result.blast_radius.files_newly_violating,
      no_longer: result.blast_radius.files_no_longer_violating,
    });
  } else {
    logger.info("recs_blast_radius_skipped", {
      candidate_id: result.candidate_id,
      reason: result.reason,
    });
  }
  return EXIT_CODES.OK;
}
