/**
 * `qualy install` — copies the harness payload into a target scope and
 * records every file in `.lint-manifest.json`.
 *
 * Pipeline (SPEC §3 + §4 + TASKS 2.1):
 *   1. `checkNodeVersion()` → exit `MISSING_DEPENDENCY` (5) on miss.
 *   2. `resolveScope(scope, cwd)` → exit `RECOVERABLE_ERROR` (1) on miss
 *      (HOME unset, missing `.git`, traversal, `/`).
 *   3. `readManifest(scopeRoot)` — if present, log "overwriting" (SPEC §6
 *      "Sobrescrever sempre"; we do not prompt).
 *   4. `findQualyRoot()` to locate the payload source, `copyPayload()` to
 *      mirror it into the scope, gated by `--dry-run`.
 *   5. For `--scope local`: `appendIgnoreLine(cwd, ".claude/")` so the
 *      experiment does not leak into commits.
 *   6. Build manifest = `{ ...copied, ...skipped }` (skipped files were
 *      already byte-equal in the target — they belong in the index so the
 *      future harness uninstaller (Task 2.2b) reclaims them).
 *
 * Output (single canonical JSON to stdout, SPEC §6):
 *   { ok, scope, version, target, copied, skipped, dry_run, manifest_overwritten,
 *     gitignore: { action } }
 *
 * Why pass `source` as an option: tests need to point the installer at a
 * synthetic payload tree without copying the real qualy repo. In production
 * `source` defaults to `findQualyRoot()`.
 */
import { join } from "node:path";
import type { Writable } from "node:stream";

import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { logger, output } from "../lib/logger.ts";
import { copyPayload, type CopyResult, sha256File } from "./copy.ts";
import { RecoverableError } from "./errors.ts";
import { appendIgnoreLine, type IgnoreAction } from "./gitignore.ts";
import {
  type Manifest,
  type ManifestEntry,
  MANIFEST_VERSION,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import {
  materializeRuntime as defaultMaterializeRuntime,
  type MaterializeRuntimeResult,
} from "./materialize-runtime.ts";
import { resolveScope, type Scope } from "./scope.ts";
import {
  checkNodeVersion,
  findQualyRoot,
  readPackageVersion,
  REQUIRED_NODE_VERSION,
} from "./version.ts";

/**
 * Validates that a `packageSpec` is one of:
 *   - `@hgflima/qualy@<semver-ish>` (canonical registry spec)
 *   - `file:<path-to-tgz>` (local tarball, used by CI/test pre-publish via
 *     `QUALY_PACKAGE_SPEC` to avoid the chicken-and-egg of `npm install`-ing
 *     a version that hasn't been published yet)
 *
 * No shell metacharacters, no whitespace in either case. Defense in depth:
 * the spec is eventually handed to `npm install` and we want a hard guard
 * at the boundary (TASKS Task 3 critério #6).
 */
const REGISTRY_SPEC_RE = /^@hgflima\/qualy@[A-Za-z0-9.+-]+$/;
const FILE_SPEC_RE = /^file:[A-Za-z0-9._/+-]+\.tgz$/;

function isValidPackageSpec(spec: string): boolean {
  if (!REGISTRY_SPEC_RE.test(spec) && !FILE_SPEC_RE.test(spec)) return false;
  return !/[;&|\s]/.test(spec);
}

export type MaterializeRuntimeFn = (input: {
  readonly target: string;
  readonly packageSpec: string;
  readonly dryRun: boolean;
}) => Promise<MaterializeRuntimeResult>;

const HELP_TEXT = `qualy install [--scope user|project|local] [--cwd <path>] [--dry-run] [--yes]

Copies the qualy harness (skills/lint, commands/, agents/, cli/) into a target
scope and writes .lint-manifest.json so the harness uninstaller can reverse
it byte-for-byte (Task 2.2b).

Scopes:
  user      \${HOME}/.claude (per-user, shared across projects)
  project   \${cwd}/.claude (committed; requires .git/)
  local     \${cwd}/.claude (gitignored — installer adds .claude/ to .gitignore)

Flags:
  --scope <s>    Target scope (default: project).
  --cwd <path>   cwd used for project|local scope resolution. Default: process.cwd().
  --dry-run      Plan but write nothing.
  --yes          Reserved for parity with \`update\`/\`uninstall\`. \`install\`
                 already overwrites without prompting (SPEC §6).
  --help, -h     Show this help.

Exit codes: 0 ok, 1 recoverable error, 4 usage, 5 Node too old.
`;

export type InstallOptions = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  /** Override the payload source (test seam). Defaults to `findQualyRoot()`. */
  readonly source?: string;
  /** Override `materializeRuntime` (test seam). Defaults to the real one. */
  readonly materialize?: MaterializeRuntimeFn;
};

export type InstallOk = {
  readonly ok: true;
  readonly scope: Scope;
  readonly version: string;
  readonly target: string;
  readonly copied: number;
  readonly skipped: number;
  readonly dry_run: boolean;
  readonly manifest_overwritten: boolean;
  readonly gitignore: { readonly action: IgnoreAction | "skipped" };
  readonly runtime: {
    readonly action: "materialized" | "skipped" | "dry-run";
  };
};

export type InstallErr = {
  readonly ok: false;
  readonly error:
    | "node_too_old"
    | "scope_resolution"
    | "payload_missing"
    | "runtime_install_network"
    | "runtime_install_fs"
    | "runtime_install_unknown"
    | "internal";
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type InstallResult = InstallOk | InstallErr;

export async function installHarness(
  opts: InstallOptions,
): Promise<InstallResult> {
  const node = checkNodeVersion();
  if (!node.ok) {
    return {
      ok: false,
      error: "node_too_old",
      reason: `Node ${node.found} is below required ${REQUIRED_NODE_VERSION}`,
      detail: { found: node.found, required: node.required },
    };
  }

  let resolved: { root: string; scope: Scope };
  try {
    resolved = resolveScope(opts.scope, opts.cwd);
  } catch (err) {
    if (err instanceof RecoverableError) {
      return { ok: false, error: "scope_resolution", reason: err.message };
    }
    throw err;
  }

  let source: string;
  let version: string;
  try {
    source = opts.source ?? findQualyRoot();
    version = readPackageVersion(source);
  } catch (err) {
    return {
      ok: false,
      error: "payload_missing",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const prior = readManifest(resolved.root);
  const manifestOverwritten = prior !== null;
  if (manifestOverwritten) {
    logger.warn("install_overwriting", {
      target: resolved.root,
      prior_scope: prior.scope,
      prior_version: prior.harness_version,
    });
  }

  let copyResult: CopyResult;
  try {
    copyResult = await copyPayload({
      source,
      target: resolved.root,
      dryRun: opts.dryRun,
    });
  } catch (err) {
    return {
      ok: false,
      error: "internal",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // QUALY_PACKAGE_SPEC override: lets pre-publish CI / e2e bypass the
  // registry by passing a packed local tarball (e.g. `file:/abs/qualy.tgz`).
  // Production users never set this; the canonical
  // `@hgflima/qualy@<version>` is used by default.
  const packageSpec =
    process.env.QUALY_PACKAGE_SPEC ?? `@hgflima/qualy@${version}`;
  if (!isValidPackageSpec(packageSpec)) {
    return {
      ok: false,
      error: "internal",
      reason: `invalid packageSpec derived from version: ${packageSpec}`,
    };
  }

  const materialize = opts.materialize ?? defaultMaterializeRuntime;
  const matResult = await materialize({
    target: resolved.root,
    packageSpec,
    dryRun: opts.dryRun,
  });
  if (!matResult.ok) {
    return {
      ok: false,
      error: matErrorToInstallError(matResult.error),
      reason: matResult.reason,
    };
  }

  let gitignoreAction: IgnoreAction | "skipped" = "skipped";
  if (resolved.scope === "local" && !opts.dryRun) {
    gitignoreAction = appendIgnoreLine(opts.cwd, ".claude/");
  }

  const payloadEntries: ManifestEntry[] = [
    ...copyResult.copied,
    ...copyResult.skipped,
  ].map((e) => ({ path: e.rel, sha256: e.sha256, kind: e.kind }));

  const runtimeEntries: ManifestEntry[] = [];
  if (!opts.dryRun) {
    runtimeEntries.push({
      path: join("skills", "lint", "node_modules"),
      sha256: "",
      kind: "runtime-node-modules",
    });
    if (matResult.stubCreated !== null) {
      const stubAbs = join(resolved.root, matResult.stubCreated);
      const stubSha = await sha256File(stubAbs);
      runtimeEntries.push({
        path: matResult.stubCreated,
        sha256: stubSha,
        kind: "other",
      });
    }
  }

  const entries: ManifestEntry[] = [
    ...payloadEntries,
    ...runtimeEntries,
  ].toSorted((a, b) => a.path.localeCompare(b.path));

  if (!opts.dryRun) {
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      scope: resolved.scope,
      harness_version: version,
      installer: "npx",
      installed_at: new Date().toISOString(),
      entries,
    };
    writeManifest(resolved.root, manifest);
  }

  return {
    ok: true,
    scope: resolved.scope,
    version,
    target: resolved.root,
    copied: copyResult.copied.length,
    skipped: copyResult.skipped.length,
    dry_run: opts.dryRun,
    manifest_overwritten: manifestOverwritten,
    gitignore: { action: gitignoreAction },
    runtime: { action: opts.dryRun ? "dry-run" : "materialized" },
  };
}

function matErrorToInstallError(
  code: "EQUALY_INSTALL_NETWORK" | "EQUALY_INSTALL_FS" | "EQUALY_INSTALL_UNKNOWN",
): InstallErr["error"] {
  if (code === "EQUALY_INSTALL_NETWORK") return "runtime_install_network";
  if (code === "EQUALY_INSTALL_FS") return "runtime_install_fs";
  return "runtime_install_unknown";
}

export type ParsedArgs = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
};

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: "help" | string };

export function parseInstallArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let scope: Scope = "project";
  let cwd = defaultCwd;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scope") {
      const value = argv[i + 1];
      if (value !== "user" && value !== "project" && value !== "local") {
        return {
          ok: false,
          error: `--scope must be one of user|project|local (got: ${String(value)})`,
        };
      }
      scope = value;
      i++;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
      cwd = value;
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }

  return { ok: true, value: { scope, cwd, dryRun, yes } };
}

function errToExit(err: InstallErr["error"]): ExitCode {
  if (err === "node_too_old") return EXIT_CODES.MISSING_DEPENDENCY;
  if (err === "internal") return EXIT_CODES.INTERNAL_ERROR;
  return EXIT_CODES.RECOVERABLE_ERROR;
}

export async function runHarnessInstall(
  argv: readonly string[],
  deps: { readonly stderr?: Writable } = {},
): Promise<ExitCode> {
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseInstallArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      stderr.write(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = await installHarness(parsed.value);
  output(result);
  if (!result.ok) {
    logger.error("install_failed", { error: result.error, reason: result.reason });
    return errToExit(result.error);
  }
  logger.info("install_ok", {
    scope: result.scope,
    version: result.version,
    target: result.target,
    copied: result.copied,
    skipped: result.skipped,
    dry_run: result.dry_run,
  });
  return EXIT_CODES.OK;
}
