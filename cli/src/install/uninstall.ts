/**
 * `qualy uninstall` — remove the harness payload from a target scope.
 *
 * Pipeline (SPEC §3 + §4 + TASKS 2.2b):
 *   1. `resolveScope(scope, cwd)` → exit `RECOVERABLE_ERROR` (1) on miss.
 *   2. `readManifest(scopeRoot)` — if `null`, exit `1` ("no harness installed
 *      at scope <X>"). The harness uninstaller is a no-op without a manifest;
 *      it never tries to guess what files belong to qualy.
 *   3. For each `entry` in the manifest: `unlinkSync(${scopeRoot}/${entry.path})`.
 *      `ENOENT` is mapped to `kept[]` with reason `"already-absent"` — the user
 *      may have deleted the file manually; the uninstaller still records the
 *      intent in the JSON output. Other errors (`EACCES`, `EISDIR`, …) bubble
 *      up as `internal`. Entries with `kind: "runtime-node-modules"` point at
 *      a directory tree (`skills/lint/node_modules`) materialized by `npm
 *      install`; those are removed recursively via `rmSync(..., { recursive:
 *      true })` so the whole tree goes in a single manifest entry.
 *   4. `deleteManifest(scopeRoot)` (skip on dry-run).
 *   5. Best-effort `rmdir` on the **direct** parent directories of removed
 *      entries — only one level, no recursion. Any non-empty parent is left
 *      alone so user-authored files in `.claude/` are never collateral damage.
 *
 * `--keep-backup` is accepted for parity with `lint-uninstall` but is a no-op
 * here: the harness installer does not create `.lint-backup/` snapshots — that
 * concept belongs to `/lint:setup`. Documented in `--help`.
 *
 * `--yes` is accepted but currently has no prompt to skip; reserved for a
 * future confirmation flow.
 *
 * Output (single canonical JSON to stdout, SPEC §6):
 *   { ok, scope, target, removed: string[], kept: [{path, reason}], dry_run }
 */
import type { Writable } from "node:stream";

import { rmSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { logger, output } from "../lib/logger.ts";
import { RecoverableError } from "./errors.ts";
import { deleteManifest, readManifest } from "./manifest.ts";
import { resolveScope, type Scope } from "./scope.ts";

const HELP_TEXT = `qualy uninstall [--scope user|project|local] [--cwd <path>] [--dry-run] [--yes] [--keep-backup]

Removes the qualy harness payload from a target scope by walking the manifest
written by \`qualy install\` (\`.lint-manifest.json\` with a \`scope\` field).
Entries that point at files already gone from disk are recorded in \`kept\` with
reason \`already-absent\`; everything else is deleted. After processing the
manifest itself is removed. Direct parent directories that end up empty are
\`rmdir\`d best-effort — never recursively, so user-authored files in
\`.claude/\` are not collateral damage.

Scopes:
  user      \${HOME}/.claude (per-user, shared across projects)
  project   \${cwd}/.claude (committed; requires .git/)
  local     \${cwd}/.claude (gitignored)

Flags:
  --scope <s>     Target scope (default: project).
  --cwd <path>    cwd used for project|local scope resolution. Default: process.cwd().
  --dry-run       Plan but write nothing.
  --yes           Reserved for parity with \`update\`; no prompt is shown today.
  --keep-backup   No-op for the harness uninstaller (the harness installer does
                  not create \`.lint-backup/\` snapshots — see \`lint-uninstall\`
                  for the lint-stack uninstaller that uses this flag).
  --help, -h      Show this help.

Exit codes: 0 ok, 1 manifest missing or scope error, 4 usage, 70 internal.
`;

export type UninstallOptions = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly keepBackup: boolean;
};

export type UninstallKeptEntry = {
  readonly path: string;
  readonly reason: "already-absent";
};

export type UninstallOk = {
  readonly ok: true;
  readonly scope: Scope;
  readonly target: string;
  readonly removed: readonly string[];
  readonly kept: readonly UninstallKeptEntry[];
  readonly dry_run: boolean;
};

export type UninstallErr = {
  readonly ok: false;
  readonly error: "scope_resolution" | "manifest_missing" | "internal";
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type UninstallResult = UninstallOk | UninstallErr;

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function isENOTEMPTY(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM";
}

export async function uninstallHarness(
  opts: UninstallOptions,
): Promise<UninstallResult> {
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
      reason: `no harness installed at scope ${resolved.scope} (${resolved.root})`,
    };
  }

  const removed: string[] = [];
  const kept: UninstallKeptEntry[] = [];
  const parentDirs = new Set<string>();

  for (const entry of manifest.entries) {
    const abs = join(resolved.root, entry.path);
    parentDirs.add(dirname(abs));
    if (opts.dryRun) {
      removed.push(entry.path);
      continue;
    }
    try {
      if (entry.kind === "runtime-node-modules") {
        rmSync(abs, { recursive: true });
      } else {
        unlinkSync(abs);
      }
      removed.push(entry.path);
    } catch (err) {
      if (isENOENT(err)) {
        kept.push({ path: entry.path, reason: "already-absent" });
        continue;
      }
      return {
        ok: false,
        error: "internal",
        reason: `failed to remove ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!opts.dryRun) {
    try {
      deleteManifest(resolved.root);
    } catch (err) {
      return {
        ok: false,
        error: "internal",
        reason: `failed to delete manifest: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Best-effort empty-directory reclaim. Only the direct parents of removed
    // entries are tried, sorted longest-first so deeper dirs go before their
    // own parents. Non-empty / permission errors are swallowed — orphan files
    // legitimately keep their parent alive.
    const ordered = Array.from(parentDirs).toSorted(
      (a, b) => b.length - a.length,
    );
    for (const dir of ordered) {
      try {
        rmdirSync(dir);
      } catch (err) {
        if (isENOENT(err) || isENOTEMPTY(err)) continue;
        // Anything else (e.g. EACCES) is non-fatal here — the manifest is
        // already gone and the user's files are intact. Surface via logger
        // so it is visible without aborting the uninstall.
        logger.warn("uninstall_rmdir_failed", {
          dir,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    ok: true,
    scope: resolved.scope,
    target: resolved.root,
    removed,
    kept,
    dry_run: opts.dryRun,
  };
}

export type ParsedArgs = {
  readonly scope: Scope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly keepBackup: boolean;
};

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: "help" | string };

export function parseUninstallArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let scope: Scope = "project";
  let cwd = defaultCwd;
  let dryRun = false;
  let yes = false;
  let keepBackup = false;

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
    if (arg === "--keep-backup") {
      keepBackup = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }

  return { ok: true, value: { scope, cwd, dryRun, yes, keepBackup } };
}

function errToExit(err: UninstallErr["error"]): ExitCode {
  if (err === "internal") return EXIT_CODES.INTERNAL_ERROR;
  return EXIT_CODES.RECOVERABLE_ERROR;
}

export async function runHarnessUninstall(
  argv: readonly string[],
  deps: { readonly stderr?: Writable } = {},
): Promise<ExitCode> {
  const stderr = deps.stderr ?? process.stderr;
  const parsed = parseUninstallArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      stderr.write(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "uninstall",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = await uninstallHarness(parsed.value);
  output(result);
  if (!result.ok) {
    logger.error("uninstall_failed", {
      error: result.error,
      reason: result.reason,
    });
    return errToExit(result.error);
  }
  logger.info("uninstall_ok", {
    scope: result.scope,
    target: result.target,
    removed: result.removed.length,
    kept: result.kept.length,
    dry_run: result.dry_run,
  });
  return EXIT_CODES.OK;
}
