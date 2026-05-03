/**
 * `install-husky` — wire husky's pre-commit hook to lint-staged in the target
 * project.
 *
 * SPEC §1.4 + §7.1: pre-commit must run lint-staged so the fast→deep oxlint
 * pipeline (defined in `lintstagedrc.example.js`) gates every commit. SPEC §6
 * "Ask first": if the user already maintains `.husky/pre-commit` or any
 * lint-staged config, the harness owns the question — this CLI never clobbers
 * a pre-existing user file.
 *
 * Behavior (two artifacts, decided independently):
 *
 *   A) `.husky/pre-commit` (mode 0o755)
 *      - Absent → write our minimal script (`npx lint-staged`); action="created".
 *      - Present and references "lint-staged" → action="unchanged".
 *      - Present without reference → action="kept" (no overwrite); the harness
 *        decides whether to merge or replace.
 *
 *   B) lint-staged config
 *      - Probes 10 known config filenames + `package.json#lint-staged`.
 *      - If ANY exists → action="kept" with `path` pointing at the survivor;
 *        no write (preserves the user's pipeline).
 *      - If NONE exists → copy `cli/src/templates/lintstagedrc.example.js`.
 *        Filename: `.lintstagedrc.js` when `package.json#type === "module"`,
 *        else `.lintstagedrc.mjs` (the .mjs extension is unconditionally ESM,
 *        so it works in CommonJS projects too — matches the template's
 *        documented fallback).
 *
 * Manifest kinds:
 *   - `.husky/pre-commit` → kind="husky"
 *   - `.lintstagedrc.{js,mjs}` → kind="lintstaged"
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, husky:    { path, action, recorded },
 *           lintstaged: { path, action, recorded } }
 *   action ∈ "created" | "unchanged" | "kept"
 *
 * Exit codes:
 *   - OK                — both decisions succeeded.
 *   - USAGE_ERROR       — unknown flag.
 *   - RECOVERABLE_ERROR — template missing, write failed.
 *   - DIRTY_TREE        — `--strict` and working tree dirty.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { parseDefensive } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

/**
 * Bundled `.lintstagedrc` template. Resolved via `import.meta.url` so it works
 * under copy/symlink/global install (ADR 0009).
 */
const LINTSTAGED_TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "lintstagedrc.example.js",
);

const HUSKY_REL_PATH = ".husky/pre-commit";
const PACKAGE_JSON_REL = "package.json";

/**
 * Modern husky v9: a plain shell script in `.husky/pre-commit` is run directly
 * without the legacy boilerplate (`. "$(dirname -- "$0")/_/husky.sh"`). We use
 * `npx lint-staged` rather than a bare `lint-staged` so it resolves regardless
 * of whether the binary is on PATH (works for npm/pnpm/yarn/bun installs).
 */
const HUSKY_SCRIPT_BODY = "#!/usr/bin/env sh\nnpx lint-staged\n";

/**
 * Probed in order. Same set as `status.ts` LINT_STAGED_CONFIG_FILES — keep
 * synchronized so detection stays consistent across detect/install/status.
 */
const LINT_STAGED_CONFIG_FILES = [
  ".lintstagedrc",
  ".lintstagedrc.json",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
  ".lintstagedrc.js",
  ".lintstagedrc.cjs",
  ".lintstagedrc.mjs",
  "lint-staged.config.js",
  "lint-staged.config.cjs",
  "lint-staged.config.mjs",
] as const;

export type HuskyAction = "created" | "unchanged" | "kept";
export type LintstagedAction = "created" | "kept";

export interface InstallHuskyOptions {
  readonly cwd: string;
  readonly strict?: boolean;
}

export interface InstallHuskyArtifact {
  readonly path: string;
  readonly action: HuskyAction;
  readonly recorded: boolean;
}

export interface InstallLintstagedArtifact {
  readonly path: string;
  readonly action: LintstagedAction;
  readonly recorded: boolean;
}

export interface InstallHuskyOk {
  readonly ok: true;
  readonly cwd: string;
  readonly husky: InstallHuskyArtifact;
  readonly lintstaged: InstallLintstagedArtifact;
}

export interface InstallHuskyErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallHuskyResult = InstallHuskyOk | InstallHuskyErr;

export interface InstallHuskyDeps {
  readonly templatePath?: string;
  readonly readFileFn?: (path: string) => string | null;
  readonly existsFn?: (path: string) => boolean;
  readonly safeIO?: SafeIO;
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultExists(p: string): boolean {
  return defaultRead(p) !== null;
}

/**
 * Picks `.lintstagedrc.js` for `"type":"module"` projects, else `.lintstagedrc.mjs`.
 * `.mjs` is unconditionally ESM regardless of `type`, so it's the safe default
 * when package.json is absent or unparseable.
 */
export function chooseLintstagedFilename(packageJsonRaw: string | null): string {
  if (packageJsonRaw === null) return ".lintstagedrc.mjs";
  const parsed = parseDefensive<{ type?: unknown } & Record<string, unknown>>(packageJsonRaw);
  if (!parsed.ok) return ".lintstagedrc.mjs";
  const v = parsed.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return ".lintstagedrc.mjs";
  return v.type === "module" ? ".lintstagedrc.js" : ".lintstagedrc.mjs";
}

/**
 * Returns the first existing lint-staged config (file path) or "package.json#lint-staged"
 * when the inline form is present. Returns `null` when no config exists.
 */
export function detectExistingLintstaged(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): string | null {
  for (const name of LINT_STAGED_CONFIG_FILES) {
    if (existsFn(join(cwd, name))) return name;
  }
  const pkgRaw = readFileFn(join(cwd, PACKAGE_JSON_REL));
  if (pkgRaw === null) return null;
  const parsed = parseDefensive<Record<string, unknown>>(pkgRaw);
  if (!parsed.ok) return null;
  const v = parsed.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.prototype.hasOwnProperty.call(v, "lint-staged")) {
    return "package.json#lint-staged";
  }
  return null;
}

export function installHusky(
  opts: InstallHuskyOptions,
  deps: InstallHuskyDeps = {},
): InstallHuskyResult {
  const templatePath = deps.templatePath ?? LINTSTAGED_TEMPLATE_PATH;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const existsFn = deps.existsFn ?? defaultExists;
  const strict = opts.strict ?? false;

  // ── A) .husky/pre-commit ───────────────────────────────────────────────
  const huskyAbs = join(opts.cwd, HUSKY_REL_PATH);
  const huskyExisting = readFileFn(huskyAbs);
  let huskyArtifact: InstallHuskyArtifact;

  if (huskyExisting === null) {
    const w = safeWriteFile(
      opts.cwd,
      HUSKY_REL_PATH,
      HUSKY_SCRIPT_BODY,
      { kind: "husky", strict, mode: 0o755 },
      deps.safeIO,
    );
    if (!w.ok) {
      return { ok: false, error: "write_failed", reason: `${HUSKY_REL_PATH}: ${w.error}` };
    }
    huskyArtifact = { path: w.value.path, action: "created", recorded: w.value.recorded };
  } else if (huskyExisting.includes("lint-staged")) {
    huskyArtifact = { path: HUSKY_REL_PATH, action: "unchanged", recorded: false };
  } else {
    huskyArtifact = { path: HUSKY_REL_PATH, action: "kept", recorded: false };
  }

  // ── B) lint-staged config ──────────────────────────────────────────────
  const existingLs = detectExistingLintstaged(opts.cwd, existsFn, readFileFn);
  let lintstagedArtifact: InstallLintstagedArtifact;

  if (existingLs !== null) {
    lintstagedArtifact = { path: existingLs, action: "kept", recorded: false };
  } else {
    let templateBody: string;
    try {
      const raw = readFileFn(templatePath);
      if (raw === null) throw new Error(`template not found: ${templatePath}`);
      templateBody = raw;
    } catch (err) {
      return {
        ok: false,
        error: "template_read_failed",
        reason: `${templatePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const pkgRaw = readFileFn(join(opts.cwd, PACKAGE_JSON_REL));
    const lsRel = chooseLintstagedFilename(pkgRaw);
    const w = safeWriteFile(
      opts.cwd,
      lsRel,
      templateBody,
      { kind: "lintstaged", strict },
      deps.safeIO,
    );
    if (!w.ok) {
      return { ok: false, error: "write_failed", reason: `${lsRel}: ${w.error}` };
    }
    lintstagedArtifact = { path: w.value.path, action: "created", recorded: w.value.recorded };
  }

  return {
    ok: true,
    cwd: opts.cwd,
    husky: huskyArtifact,
    lintstaged: lintstagedArtifact,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly strict: boolean;
}

export type ArgParseResult = { ok: true; value: ParsedArgs } | { ok: false; error: string };

export function parseInstallHuskyArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
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
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, strict } };
}

export function runInstallHusky(argv: readonly string[]): ExitCode {
  const parsed = parseInstallHuskyArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-husky [--cwd <path>] [--strict]\n" +
          "\n" +
          "Writes .husky/pre-commit and a lint-staged config (.lintstagedrc.js or .mjs).\n" +
          "Both artifacts respect pre-existing files: presence is reported as\n" +
          "action=\"kept\" so the harness can offer merge/replace explicitly.\n" +
          "Exit codes: 0 ok, 1 write/template failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-husky", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installHusky(parsed.value);
  if (!result.ok) {
    logger.error("install_husky_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_husky_ok", {
    husky_action: result.husky.action,
    lintstaged_action: result.lintstaged.action,
    lintstaged_path: result.lintstaged.path,
  });
  return EXIT_CODES.OK;
}
