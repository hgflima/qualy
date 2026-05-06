/**
 * `qualy update` — detect a newer harness version on npm and re-install it.
 *
 * Pipeline (SPEC §3 + §4 + TASKS 2.3):
 *   1. `resolveScope(scope, cwd)` → exit `RECOVERABLE_ERROR` (1) on miss.
 *   2. `readManifest(scopeRoot)` — if `null`, exit `1` ("no harness installed;
 *      run `qualy install` first"). The update path needs an installed-version
 *      anchor; without it, comparison is impossible.
 *   3. `fetchLatestVersion({ timeoutMs: 5000 })` — wraps `npm view` and maps
 *      registry failures to 4 named error kinds. All four exit `1` with a
 *      kind-specific message (TASKS 2.3 — "cobertura cobre as 4 classes").
 *   4. Compare `manifest.harness_version` vs `latest`:
 *        - equal or installed-greater → `up-to-date`, exit `0`. `applyInstall`
 *          is NOT invoked, which means the runtime `node_modules/` is left
 *          untouched (no needless `npm install` on a no-op update).
 *        - latest > installed         → log `installed → latest`. On a major
 *          bump without `--yes` (and not `--dry-run`) prompt y/N via readline.
 *        - apply via `npx @hgflima/qualy@<latest> install --scope <X> --cwd <Y> --yes`
 *          unless `--dry-run` (which returns `would-update`).
 *
 * Runtime re-materialization (T6 / cli-bin-resolution):
 *   The bump path delegates the entire reinstall to `npx @hgflima/qualy@<latest>
 *   install`, which re-enters `installHarness` in the new package and runs
 *   `materializeRuntime()` as part of the install pipeline. That spawns
 *   `npm install --omit=dev --no-save @hgflima/qualy@<latest>` inside
 *   `<scopeRoot>/skills/lint/`, refreshing the runtime tree to match the new
 *   harness version. We intentionally do NOT duplicate that `npm install` here
 *   — keeping it in `installHarness` means a single source of truth for
 *   payload + runtime materialization (see `cli/src/install/install.ts` and
 *   `cli/src/install/materialize-runtime.ts`).
 *
 * Output (single canonical JSON to stdout, SPEC §6):
 *   { ok, status: "up-to-date"|"updated"|"would-update", scope, target,
 *     installed_before, installed_after, dry_run }
 *
 * `fetchLatestVersion`, `applyInstall`, and `prompt` are exposed as test
 * seams: unit tests inject fakes instead of hitting the registry, spawning
 * `npx`, or reading stdin.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Writable } from "node:stream";

import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { logger, output } from "../lib/logger.ts";
import { RecoverableError } from "./errors.ts";
import { readManifest } from "./manifest.ts";
import {
  fetchLatestVersion as defaultFetch,
  type RegistryFetchErr,
  type RegistryFetchResult,
} from "./registry.ts";
import { resolveScope, type Scope } from "./scope.ts";

const HELP_TEXT = `qualy update [--scope user|project|local] [--cwd <path>] [--dry-run] [--yes]

Detects the latest \`qualy\` version on the npm registry and re-installs the
harness payload at the chosen scope. Compares against \`harness_version\` from
\`.lint-manifest.json\` written by \`qualy install\`.

Scopes:
  user      \${HOME}/.claude
  project   \${cwd}/.claude (committed; requires .git/)
  local     \${cwd}/.claude (gitignored)

Flags:
  --scope <s>    Target scope (default: project).
  --cwd <path>   cwd used for project|local scope resolution. Default: process.cwd().
  --dry-run      Resolve + compare versions but do not apply.
  --yes          Skip the major-bump confirmation prompt (required for CI).
  --help, -h     Show this help.

Exit codes: 0 ok, 1 recoverable (manifest missing, registry error, user
  declined major bump, apply failed), 4 usage, 70 internal.
`;

const REGISTRY_TIMEOUT_MS = 5000;
const NPX_BIN = "npx";

export type UpdateOptions = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  /** Test seam — defaults to `registry.ts#fetchLatestVersion`. */
  readonly fetchLatestVersion?: typeof defaultFetch;
  /** Test seam — defaults to `npx @hgflima/qualy@<v> install --scope <X> --yes`. */
  readonly applyInstall?: ApplyInstall;
  /** Test seam — defaults to a `readline`-based y/N prompt on stderr. */
  readonly prompt?: PromptFn;
};

export type ApplyInstallArgs = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly version: string;
};

export type ApplyInstallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type ApplyInstall = (
  args: ApplyInstallArgs,
) => Promise<ApplyInstallResult>;

export type PromptFn = (question: string) => Promise<boolean>;

export type UpdateOk = {
  readonly ok: true;
  readonly status: "up-to-date" | "updated" | "would-update";
  readonly scope: Scope;
  readonly target: string;
  readonly installed_before: string;
  readonly installed_after: string;
  readonly dry_run: boolean;
};

export type UpdateErr = {
  readonly ok: false;
  readonly error:
    | "scope_resolution"
    | "manifest_missing"
    | "registry_network"
    | "registry_auth"
    | "registry_mirror"
    | "registry_unknown"
    | "user_aborted"
    | "apply_failed"
    | "internal";
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type UpdateResult = UpdateOk | UpdateErr;

export async function updateHarness(
  opts: UpdateOptions,
): Promise<UpdateResult> {
  let resolved: { root: string; scope: Scope };
  try {
    resolved = resolveScope(opts.scope, opts.cwd);
  } catch (err) {
    if (err instanceof RecoverableError) {
      return { ok: false, error: "scope_resolution", reason: err.message };
    }
    throw err;
  }

  let manifest;
  try {
    manifest = readManifest(resolved.root);
  } catch (err) {
    return {
      ok: false,
      error: "internal",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (manifest === null) {
    return {
      ok: false,
      error: "manifest_missing",
      reason:
        `no harness installed at scope ${resolved.scope} (${resolved.root}); ` +
        `run \`qualy install\` first`,
    };
  }

  const fetch = opts.fetchLatestVersion ?? defaultFetch;
  const fetched = await fetch({ timeoutMs: REGISTRY_TIMEOUT_MS });
  if (!fetched.ok) {
    return {
      ok: false,
      error: kindToError(fetched.kind),
      reason: kindToMessage(fetched),
    };
  }

  const installed = manifest.harness_version;
  const latest = fetched.version;

  let installedTriple: SemverTriple;
  let latestTriple: SemverTriple;
  try {
    installedTriple = parseSemverTriple(installed);
    latestTriple = parseSemverTriple(latest);
  } catch (err) {
    return {
      ok: false,
      error: "internal",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (compareSemverTriple(installedTriple, latestTriple) >= 0) {
    return {
      ok: true,
      status: "up-to-date",
      scope: resolved.scope,
      target: resolved.root,
      installed_before: installed,
      installed_after: installed,
      dry_run: opts.dryRun,
    };
  }

  logger.info("update_diff", { installed, latest });

  const isMajorBump = installedTriple[0] !== latestTriple[0];
  if (isMajorBump && !opts.yes && !opts.dryRun) {
    const ask = opts.prompt ?? defaultPrompt;
    const confirmed = await ask(
      `Major version bump: ${installed} → ${latest}. Proceed? [y/N] `,
    );
    if (!confirmed) {
      return {
        ok: false,
        error: "user_aborted",
        reason: `user declined major bump ${installed} → ${latest}`,
      };
    }
  }

  if (opts.dryRun) {
    return {
      ok: true,
      status: "would-update",
      scope: resolved.scope,
      target: resolved.root,
      installed_before: installed,
      installed_after: latest,
      dry_run: true,
    };
  }

  const apply = opts.applyInstall ?? defaultApplyInstall;
  const applied = await apply({
    scope: resolved.scope,
    cwd: opts.cwd,
    version: latest,
  });
  if (!applied.ok) {
    return { ok: false, error: "apply_failed", reason: applied.reason };
  }

  return {
    ok: true,
    status: "updated",
    scope: resolved.scope,
    target: resolved.root,
    installed_before: installed,
    installed_after: latest,
    dry_run: false,
  };
}

function kindToError(kind: RegistryFetchErr["kind"]): UpdateErr["error"] {
  if (kind === "network") return "registry_network";
  if (kind === "auth") return "registry_auth";
  if (kind === "mirror") return "registry_mirror";
  return "registry_unknown";
}

function kindToMessage(r: RegistryFetchErr): string {
  if (r.kind === "network") {
    return `cannot reach npm registry (network or DNS issue): ${r.message}`;
  }
  if (r.kind === "auth") {
    return (
      `registry rejected request (check ~/.npmrc auth or use a public ` +
      `registry): ${r.message}`
    );
  }
  if (r.kind === "mirror") {
    return (
      `registry returned no version for "@hgflima/qualy" — your registry may be a ` +
      `private mirror without this package: ${r.message}`
    );
  }
  return `npm view failed (${r.message}); retry with \`qualy update --dry-run\``;
}

type SemverTriple = readonly [number, number, number];

function parseSemverTriple(v: string): SemverTriple {
  const core = v.split("-")[0]!.split("+")[0]!;
  const parts = core.split(".");
  if (parts.length < 3) {
    throw new Error(`invalid semver: "${v}" (expected MAJOR.MINOR.PATCH)`);
  }
  const triple: SemverTriple = [
    Number.parseInt(parts[0]!, 10),
    Number.parseInt(parts[1]!, 10),
    Number.parseInt(parts[2]!, 10),
  ];
  for (const n of triple) {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`invalid semver: "${v}" (non-numeric component)`);
    }
  }
  return triple;
}

function compareSemverTriple(a: SemverTriple, b: SemverTriple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

async function defaultPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const defaultApplyInstall: ApplyInstall = (args) =>
  new Promise<ApplyInstallResult>((resolve) => {
    let resolved = false;
    const finish = (r: ApplyInstallResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const pkgSpec = `@hgflima/qualy@${args.version}`;
    const child = spawn(
      NPX_BIN,
      [
        pkgSpec,
        "install",
        "--scope",
        args.scope,
        "--cwd",
        args.cwd,
        "--yes",
      ],
      { stdio: "inherit" },
    );
    child.on("error", (err) => {
      finish({ ok: false, reason: err.message });
    });
    child.on("exit", (code) => {
      if (code === 0) finish({ ok: true });
      else
        finish({
          ok: false,
          reason: `\`npx ${pkgSpec} install\` exited with code ${String(code)}`,
        });
    });
  });

export type ParsedArgs = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
};

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: "help" | string };

export function parseUpdateArgs(
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

function errToExit(err: UpdateErr["error"]): ExitCode {
  if (err === "internal") return EXIT_CODES.INTERNAL_ERROR;
  return EXIT_CODES.RECOVERABLE_ERROR;
}

export async function runHarnessUpdate(
  argv: readonly string[],
  deps: { readonly stderr?: Writable } = {},
): Promise<ExitCode> {
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseUpdateArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      stderr.write(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "update", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = await updateHarness(parsed.value);
  output(result);
  if (!result.ok) {
    logger.error("update_failed", {
      error: result.error,
      reason: result.reason,
    });
    return errToExit(result.error);
  }
  logger.info("update_ok", {
    status: result.status,
    scope: result.scope,
    installed_before: result.installed_before,
    installed_after: result.installed_after,
    dry_run: result.dry_run,
  });
  return EXIT_CODES.OK;
}

export type { RegistryFetchResult };
