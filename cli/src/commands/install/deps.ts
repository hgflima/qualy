/**
 * `install-deps` — install qualy's runtime dependencies into the target
 * project's `package.json#devDependencies` using whichever package manager the
 * project already uses (detected from its lockfile).
 *
 * SPEC §1.18: "Instala oxlint, oxfmt, quality-metrics (com ts-morph para tier
 * deep)". PLAN §Contratos CLI: input `--deps <json>`, output `{ installed:
 * string[] }`, side effect `roda npm/pnpm/yarn/bun add (detecta lockfile)`.
 *
 * Behavior:
 *   1. Resolve the desired set — `--deps <json>` (caller-composed array of
 *      `"name"` or `"name@version"` strings) wins outright; otherwise we use
 *      the bundled `DEFAULT_DEPS` list (oxlint, oxfmt, quality-metrics,
 *      ts-morph). The package manager understands the `name@spec` syntax for
 *      every supported tool.
 *   2. Read `<cwd>/package.json` to compute idempotency: any name already
 *      present in `dependencies` or `devDependencies` is `skipped` and not
 *      re-installed (the package manager would re-resolve and rewrite the
 *      lockfile, defeating idempotency for `/lint:setup`).
 *   3. If nothing to install → `action: "noop"`, no subprocess, no manifest
 *      write. The file is left untouched.
 *   4. Detect the package manager via `pkg-manager.ts` (lockfile-driven) and
 *      shell out via `runFn` (default: `child_process.execFileSync`, no
 *      shell — we never expand globs through `/bin/sh`).
 *   5. On non-zero exit, surface `pkg_install_failed` with the captured
 *      stderr; `package.json` may have been partially written by the package
 *      manager — this command does NOT roll back.
 *   6. On success, record one manifest entry per installed package with
 *      `path: "package.json#devDependencies/<name>"`, `kind: "dep"`,
 *      `merged: true`. Phase 3 `uninstall` reads these to know which packages
 *      to remove.
 *
 * Why virtual paths: `package.json` is owned by the user (we only merge into
 * it), so `safeWriteFile` is the wrong tool — the package manager is the
 * writer here. We use `recordEntry` directly with a sentinel
 * `package.json#devDependencies/<name>` path. The `#` prefix is stable
 * (matches the convention in `detect-existing-linter` for inline configs)
 * and preserves the per-package granularity uninstall needs.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, pkg_manager, source, installed: string[], skipped: string[],
 *     action: "installed" | "noop", recorded: number }
 *
 * Exit codes:
 *   - OK                — install succeeded or noop.
 *   - USAGE_ERROR       — unknown flag, malformed `--deps` JSON, empty deps,
 *                         non-string entries.
 *   - RECOVERABLE_ERROR — package.json missing/malformed, package manager
 *                         missing or returned non-zero.
 *   - DIRTY_TREE        — `--strict` set and working tree dirty.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import {
  type ManifestEntryKind,
  type SafeIO,
  type SafeResult,
  recordEntry,
} from "../../lib/fs-safe.ts";
import { dirtyFiles as defaultDirtyFiles } from "../../lib/git.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";
import {
  type DetectionResult,
  type PackageManager,
  detectPackageManager,
} from "../../lib/pkg-manager.ts";

/**
 * Default devDependencies installed when `--deps` is omitted. Order matters
 * only for determinism in CLI output and manifest recording — the package
 * manager itself receives them as a single batched `add` call.
 *
 * - oxlint, oxfmt: oxc family (linter + formatter), used by both fast and deep tiers.
 * - quality-metrics: peer dep of the deep tier (PLAN §Critical files).
 * - ts-morph: peer dep of quality-metrics (SPEC §1.18 "com ts-morph para tier deep").
 */
export const DEFAULT_DEPS: readonly string[] = [
  "oxlint",
  "oxfmt",
  "quality-metrics",
  "ts-morph",
];

const PACKAGE_JSON_REL = "package.json";
const DEP_KIND: ManifestEntryKind = "dep";

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Test seam: invoked once per `installDeps` call. Should not throw. */
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
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const exitCode = typeof e.status === "number" ? e.status : -1;
    const message = e.message ?? stderr ?? `${binary} failed`;
    return { ok: false, stdout, stderr: stderr || message, exitCode };
  }
};

export interface InstallDepsOptions {
  readonly cwd: string;
  /** Override of the desired install set. When set, `DEFAULT_DEPS` is ignored. */
  readonly deps?: readonly string[];
  readonly strict?: boolean;
}

export interface InstallDepsOk {
  readonly ok: true;
  readonly cwd: string;
  readonly pkg_manager: PackageManager;
  readonly source: DetectionResult["source"];
  readonly installed: readonly string[];
  readonly skipped: readonly string[];
  readonly action: "installed" | "noop";
  readonly recorded: number;
}

export interface InstallDepsErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallDepsResult = InstallDepsOk | InstallDepsErr;

export interface InstallDepsDeps {
  readonly readFileFn?: (path: string) => string;
  readonly existsFn?: (path: string) => boolean;
  readonly runFn?: RunFn;
  readonly detectFn?: typeof detectPackageManager;
  readonly safeIO?: SafeIO;
  readonly dirtyFilesFn?: (cwd: string) => SafeResult<readonly string[]>;
}

interface PackageJsonRoot {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  [key: string]: unknown;
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultDirtyAdapter(cwd: string): SafeResult<readonly string[]> {
  const r = defaultDirtyFiles(cwd);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return true;
}

/**
 * Splits `"name@version"` into `{ name }`. The `@` may be absent (just a
 * name) or appear as the leading character (scoped pkg `@scope/name`),
 * possibly followed by a version (`@scope/name@1.0.0`). The package manager
 * gets the full spec; we only need the bare name to compare against
 * `package.json#dependencies`/`devDependencies`.
 */
export function specName(spec: string): string {
  if (spec.length === 0) return spec;
  // Scoped: "@scope/name" or "@scope/name@version"
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1) return spec; // malformed but pass through
    const versionAt = spec.indexOf("@", slashIdx + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

/**
 * Maps `(manager, specs)` to the argv passed to the package manager binary.
 * All four use the convention `<bin> add <flag> <spec>...`; npm uses
 * `install` instead of `add`. `--save-dev` (npm) / `-D` (pnpm) / `--dev`
 * (yarn, bun) all add to `devDependencies`.
 */
export function buildArgs(
  manager: PackageManager,
  specs: readonly string[],
): readonly string[] {
  switch (manager) {
    case "npm":
      return ["install", "--save-dev", ...specs];
    case "pnpm":
      return ["add", "--save-dev", ...specs];
    case "yarn":
      return ["add", "--dev", ...specs];
    case "bun":
      return ["add", "--dev", ...specs];
  }
}

export function installDeps(
  opts: InstallDepsOptions,
  deps: InstallDepsDeps = {},
): InstallDepsResult {
  const readFileFn = deps.readFileFn ?? defaultRead;
  const existsFn = deps.existsFn ?? defaultExists;
  const runFn = deps.runFn ?? defaultRun;
  const detectFn = deps.detectFn ?? detectPackageManager;
  const dirtyFilesFn = deps.dirtyFilesFn ?? defaultDirtyAdapter;

  const desiredSpecs = opts.deps ?? DEFAULT_DEPS;
  if (desiredSpecs.length === 0) {
    return { ok: false, error: "deps_empty", reason: "no packages to install" };
  }
  for (const spec of desiredSpecs) {
    if (typeof spec !== "string" || spec.length === 0) {
      return {
        ok: false,
        error: "deps_invalid",
        reason: "every dep must be a non-empty string (name or name@version)",
      };
    }
  }

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

  // Set of names already declared in any dep section. We treat
  // `dependencies` and `devDependencies` as equally satisfying — the user
  // may have moved oxlint to prod deps, and re-installing as devDep would
  // contradict that choice. Idempotency wins here.
  const existing = new Set<string>();
  if (isStringRecord(root.dependencies)) {
    for (const k of Object.keys(root.dependencies)) existing.add(k);
  }
  if (isStringRecord(root.devDependencies)) {
    for (const k of Object.keys(root.devDependencies)) existing.add(k);
  }

  const installed: string[] = [];
  const skipped: string[] = [];
  const installSpecs: string[] = [];
  for (const spec of desiredSpecs) {
    const name = specName(spec);
    if (existing.has(name)) {
      skipped.push(name);
      continue;
    }
    installed.push(name);
    installSpecs.push(spec);
  }

  const detection = detectFn(opts.cwd);

  if (installSpecs.length === 0) {
    return {
      ok: true,
      cwd: opts.cwd,
      pkg_manager: detection.manager,
      source: detection.source,
      installed: [],
      skipped,
      action: "noop",
      recorded: 0,
    };
  }

  if (opts.strict) {
    const dirty = dirtyFilesFn(opts.cwd);
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

  const args = buildArgs(detection.manager, installSpecs);
  const result = runFn(detection.manager, args, opts.cwd);
  if (!result.ok || result.exitCode !== 0) {
    return {
      ok: false,
      error: "pkg_install_failed",
      reason: `${detection.manager} ${args.join(" ")} (exit=${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
    };
  }

  let recorded = 0;
  for (const name of installed) {
    recordEntry(
      opts.cwd,
      {
        path: `package.json#devDependencies/${name}`,
        kind: DEP_KIND,
        created_at: (deps.safeIO?.now ? deps.safeIO.now() : new Date()).toISOString(),
        merged: true,
      },
      deps.safeIO,
    );
    recorded++;
  }

  return {
    ok: true,
    cwd: opts.cwd,
    pkg_manager: detection.manager,
    source: detection.source,
    installed,
    skipped,
    action: "installed",
    recorded,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly deps?: readonly string[];
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseInstallDepsArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let deps: readonly string[] | undefined;
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
    if (arg === "--deps") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --deps" };
      }
      const parsed = parseDefensive<unknown>(value);
      if (!parsed.ok) {
        return { ok: false, error: `invalid --deps JSON: ${parsed.error}` };
      }
      if (!Array.isArray(parsed.value)) {
        return { ok: false, error: "--deps must be a JSON array of strings" };
      }
      const list: string[] = [];
      for (const item of parsed.value) {
        if (typeof item !== "string" || item.length === 0) {
          return { ok: false, error: "--deps array must contain non-empty strings" };
        }
        list.push(item);
      }
      deps = list;
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
    value: { cwd, ...(deps !== undefined ? { deps } : {}), strict },
  };
}

export function runInstallDeps(argv: readonly string[]): ExitCode {
  const parsed = parseInstallDepsArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-deps [--cwd <path>] [--deps <json>] [--strict]\n" +
          "\n" +
          "Installs qualy's runtime devDependencies via the project's package\n" +
          "manager (detected from the lockfile: bun → pnpm → yarn → npm).\n" +
          "Default deps: oxlint, oxfmt, quality-metrics, ts-morph.\n" +
          "Pass --deps '[\"name\",\"name@1.2.3\",...]' to override.\n" +
          "Already-installed packages are skipped (idempotent).\n" +
          "Exit codes: 0 ok, 1 read/install failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-deps", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installDeps(parsed.value);
  if (!result.ok) {
    logger.error("install_deps_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "dirty_tree") return EXIT_CODES.DIRTY_TREE;
    if (result.error === "deps_empty" || result.error === "deps_invalid") {
      return EXIT_CODES.USAGE_ERROR;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_deps_ok", {
    pkg_manager: result.pkg_manager,
    installed: result.installed.length,
    skipped: result.skipped.length,
    action: result.action,
  });
  return EXIT_CODES.OK;
}
