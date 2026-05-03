/**
 * `install-scripts` — idempotently merge qualy's npm scripts into the target
 * project's `package.json#scripts`.
 *
 * SPEC §7.1 acceptance: project-level scripts (`lint`, `lint:deep`, `format`,
 * `coverage`) must be present after `/lint:setup`. PLAN §Contratos CLI:
 * subcommand input is `--scripts <json>` and output is `{ added, skipped }`.
 *
 * Behavior:
 *   1. Resolve the desired scripts object — either from `--scripts <json>`
 *      (caller-composed override) or by selecting from the bundled template at
 *      `cli/src/templates/package-scripts.json`. The template carries the
 *      runner-agnostic trio (`lint`, `lint:deep`, `format`); when `--runner`
 *      ∈ {vitest, jest} a `coverage` entry is appended from
 *      `coverage_by_runner`. With `--runner none` no `coverage` key is added.
 *   2. Read `<cwd>/package.json` (must exist and be a JSON object).
 *   3. Three-way diff against `package.json#scripts`:
 *        - key absent          → added
 *        - key present, equal  → skipped (already correct)
 *        - key present, differ → conflict (NEVER overwrite the user's value)
 *      Conflicts surface in the output so the harness can present them via
 *      `AskUserQuestion`; the CLI itself never makes that call (PLAN §3).
 *   4. If `added.length === 0` and no conflicts modify state, the file is
 *      left untouched (`action: "noop"`, `recorded: false`). Otherwise we
 *      rewrite `package.json` preserving every other top-level field and
 *      record a manifest entry with `kind: "scripts"`, `merged: true`
 *      (uninstall must not delete the user's package.json — Phase 3 will
 *      surgically remove only qualy-added keys).
 *
 * Idempotency: re-running with the same desired set after a successful first
 * run produces `added: []`, `skipped: [..all..]`, `action: "noop"`.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, path, added: string[], skipped: string[],
 *     conflicts: [{ name, existing, proposed }],
 *     recorded: boolean, action: "noop" | "updated" }
 *
 * Exit codes:
 *   - OK                — merge succeeded (added or noop). Conflicts alone
 *                         do not fail; the harness decides whether to ask.
 *   - USAGE_ERROR       — unknown/malformed flag, invalid `--scripts` JSON,
 *                         invalid `--runner`.
 *   - RECOVERABLE_ERROR — package.json missing/malformed, template missing,
 *                         write failed.
 *   - DIRTY_TREE        — `--strict` set and working tree dirty.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "package-scripts.json",
);

const PACKAGE_JSON_REL = "package.json";

export type Runner = "vitest" | "jest" | "none";
const RUNNERS: readonly Runner[] = ["vitest", "jest", "none"];

interface PackageScriptsTemplate {
  readonly _comment?: unknown;
  readonly scripts?: unknown;
  readonly coverage_by_runner?: unknown;
}

interface PackageJsonRoot {
  scripts?: unknown;
  [key: string]: unknown;
}

export interface InstallScriptsOptions {
  readonly cwd: string;
  /** Complete override of the desired scripts map. When set, the template is ignored. */
  readonly scripts?: Record<string, string>;
  /** Selects the `coverage` value from the template's `coverage_by_runner`. Default: "none". */
  readonly runner?: Runner;
  readonly strict?: boolean;
}

export interface InstallScriptsConflict {
  readonly name: string;
  readonly existing: string;
  readonly proposed: string;
}

export interface InstallScriptsOk {
  readonly ok: true;
  readonly cwd: string;
  readonly path: string;
  readonly added: readonly string[];
  readonly skipped: readonly string[];
  readonly conflicts: readonly InstallScriptsConflict[];
  readonly recorded: boolean;
  readonly action: "noop" | "updated";
}

export interface InstallScriptsErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallScriptsResult = InstallScriptsOk | InstallScriptsErr;

export interface InstallScriptsDeps {
  readonly templatePath?: string;
  readonly readFileFn?: (path: string) => string;
  readonly existsFn?: (path: string) => boolean;
  readonly safeIO?: SafeIO;
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

/**
 * Resolves the desired scripts map.
 *
 * `override` (from `--scripts <json>`) wins outright. Otherwise we read the
 * template and pick `coverage` based on `runner`. With `runner === "none"` the
 * trio (lint, lint:deep, format) is the full payload — no coverage script.
 */
export function resolveDesiredScripts(
  template: PackageScriptsTemplate,
  runner: Runner,
  override: Record<string, string> | undefined,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (override !== undefined) return { ok: true, value: { ...override } };

  if (!isStringRecord(template.scripts)) {
    return { ok: false, error: "template missing or malformed `scripts` field" };
  }
  const out: Record<string, string> = { ...(template.scripts as Record<string, string>) };

  if (runner !== "none") {
    if (!isStringRecord(template.coverage_by_runner)) {
      return { ok: false, error: "template missing or malformed `coverage_by_runner` field" };
    }
    const cov = (template.coverage_by_runner as Record<string, string>)[runner];
    if (typeof cov !== "string" || cov.length === 0) {
      return { ok: false, error: `template lacks coverage_by_runner.${runner}` };
    }
    out.coverage = cov;
  }

  return { ok: true, value: out };
}

interface MergeOutcome {
  readonly nextScripts: Record<string, unknown>;
  readonly added: readonly string[];
  readonly skipped: readonly string[];
  readonly conflicts: readonly InstallScriptsConflict[];
}

/**
 * Three-way merge: existing scripts on the left, desired on the right.
 * Conflicts (different non-empty value already present) are surfaced but
 * never overwrite — the harness owns the user-facing decision.
 */
export function mergeScripts(
  existing: Record<string, unknown>,
  desired: Record<string, string>,
): MergeOutcome {
  const added: string[] = [];
  const skipped: string[] = [];
  const conflicts: InstallScriptsConflict[] = [];
  const next: Record<string, unknown> = { ...existing };

  for (const [name, proposed] of Object.entries(desired)) {
    const cur = existing[name];
    if (cur === undefined) {
      next[name] = proposed;
      added.push(name);
      continue;
    }
    if (typeof cur === "string" && cur === proposed) {
      skipped.push(name);
      continue;
    }
    conflicts.push({
      name,
      existing: typeof cur === "string" ? cur : JSON.stringify(cur),
      proposed,
    });
  }
  return { nextScripts: next, added, skipped, conflicts };
}

export function installScripts(
  opts: InstallScriptsOptions,
  deps: InstallScriptsDeps = {},
): InstallScriptsResult {
  const templatePath = deps.templatePath ?? TEMPLATE_PATH;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const existsFn = deps.existsFn ?? defaultExists;
  const runner: Runner = opts.runner ?? "none";

  let template: PackageScriptsTemplate;
  if (opts.scripts === undefined) {
    let raw: string;
    try {
      raw = readFileFn(templatePath);
    } catch (err) {
      return {
        ok: false,
        error: "template_read_failed",
        reason: `${templatePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const parsedT = parseDefensive<PackageScriptsTemplate>(raw);
    if (!parsedT.ok) {
      return { ok: false, error: "template_malformed", reason: parsedT.error };
    }
    if (parsedT.value === null || typeof parsedT.value !== "object" || Array.isArray(parsedT.value)) {
      return { ok: false, error: "template_malformed", reason: "template root is not an object" };
    }
    template = parsedT.value;
  } else {
    template = { scripts: {}, coverage_by_runner: {} };
  }

  const desiredRes = resolveDesiredScripts(template, runner, opts.scripts);
  if (!desiredRes.ok) {
    return { ok: false, error: "template_malformed", reason: desiredRes.error };
  }
  const desired = desiredRes.value;

  const pkgAbs = join(opts.cwd, PACKAGE_JSON_REL);
  if (!existsFn(pkgAbs)) {
    return {
      ok: false,
      error: "package_json_missing",
      reason: `no package.json at ${opts.cwd}`,
    };
  }

  let pkgRaw: string;
  try {
    pkgRaw = readFileFn(pkgAbs);
  } catch (err) {
    return {
      ok: false,
      error: "package_json_read_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = parseDefensive<PackageJsonRoot>(pkgRaw);
  if (!parsed.ok) {
    return { ok: false, error: "package_json_malformed", reason: parsed.error };
  }
  const root = parsed.value;
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: "package_json_malformed", reason: "root is not a JSON object" };
  }

  const existingScripts =
    typeof root.scripts === "object" && root.scripts !== null && !Array.isArray(root.scripts)
      ? (root.scripts as Record<string, unknown>)
      : {};

  const merge = mergeScripts(existingScripts, desired);

  if (merge.added.length === 0) {
    return {
      ok: true,
      cwd: opts.cwd,
      path: PACKAGE_JSON_REL,
      added: [],
      skipped: merge.skipped,
      conflicts: merge.conflicts,
      recorded: false,
      action: "noop",
    };
  }

  const nextRoot: PackageJsonRoot = { ...root, scripts: merge.nextScripts };
  const writeRes = safeWriteFile(
    opts.cwd,
    PACKAGE_JSON_REL,
    stringifyPretty(nextRoot),
    { kind: "scripts", merged: true, strict: opts.strict ?? false },
    deps.safeIO,
  );
  if (!writeRes.ok) {
    return { ok: false, error: "write_failed", reason: `${PACKAGE_JSON_REL}: ${writeRes.error}` };
  }

  return {
    ok: true,
    cwd: opts.cwd,
    path: writeRes.value.path,
    added: merge.added,
    skipped: merge.skipped,
    conflicts: merge.conflicts,
    recorded: writeRes.value.recorded,
    action: "updated",
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly scripts?: Record<string, string>;
  readonly runner: Runner;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

function isRunner(s: string): s is Runner {
  return (RUNNERS as readonly string[]).includes(s);
}

export function parseInstallScriptsArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let scripts: Record<string, string> | undefined;
  let runner: Runner = "none";
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
    if (arg === "--runner") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --runner" };
      }
      if (!isRunner(value)) {
        return {
          ok: false,
          error: `invalid runner: ${value} (expected: ${RUNNERS.join("|")})`,
        };
      }
      runner = value;
      i++;
      continue;
    }
    if (arg === "--scripts") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --scripts" };
      }
      const parsed = parseDefensive<unknown>(value);
      if (!parsed.ok) {
        return { ok: false, error: `invalid --scripts JSON: ${parsed.error}` };
      }
      if (!isStringRecord(parsed.value)) {
        return { ok: false, error: "--scripts must be a JSON object of string→string" };
      }
      scripts = parsed.value;
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
    value: { cwd, ...(scripts !== undefined ? { scripts } : {}), runner, strict },
  };
}

export function runInstallScripts(argv: readonly string[]): ExitCode {
  const parsed = parseInstallScriptsArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-scripts [--cwd <path>] [--runner <vitest|jest|none>] [--scripts <json>] [--strict]\n" +
          "\n" +
          "Idempotently merges qualy npm scripts into <cwd>/package.json#scripts.\n" +
          "Default scripts come from cli/src/templates/package-scripts.json; pass\n" +
          "--scripts <json> to override the entire desired set. Conflicts (existing\n" +
          "key with a different value) are reported but never overwritten.\n" +
          "Exit codes: 0 ok, 1 read/write failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-scripts", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installScripts(parsed.value);
  if (!result.ok) {
    logger.error("install_scripts_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_scripts_ok", {
    action: result.action,
    added: result.added.length,
    skipped: result.skipped.length,
    conflicts: result.conflicts.length,
  });
  return EXIT_CODES.OK;
}
