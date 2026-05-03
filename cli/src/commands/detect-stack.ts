/**
 * `detect-stack` — read-only classifier for whether the target project is
 * supported by the qualy/lint skill (SPEC §1: oxc cobre TS, TSX, JS, JSX).
 *
 * Two pieces of evidence are combined:
 *
 *   1. **Tracked source files**, queried via `git ls-files` (the same anchor
 *      SPEC §3 uses for every detector). We count `.ts`, `.tsx`, `.js`, `.jsx`
 *      as supported and `.vue`, `.svelte` as blockers (oxc has no SFC support
 *      in v1, see SPEC §1 non-objectives).
 *   2. **Unsupported language markers** at the project root, probed via
 *      `existsSync` against well-known files: `pyproject.toml`, `go.mod`,
 *      `Cargo.toml`, etc. Existence-based on purpose: a freshly-initialized
 *      Python repo may have no committed files yet but its `pyproject.toml`
 *      already disqualifies it from oxc tooling.
 *
 * Decision (single rule, simple to audit):
 *   - `supported = blockers.length === 0 && (tsFiles + tsxFiles + jsFiles + jsxFiles) > 0`
 *
 * Exit code (SPEC §1 + EXIT_CODES.UNSUPPORTED_STACK = 2):
 *   - `OK` when supported.
 *   - `UNSUPPORTED_STACK` when blockers found *or* zero TS/JS files found —
 *     the harness in `commands/lint/setup.md` reads this code to abort with
 *     the standard "stack não suportada" message.
 *   - `RECOVERABLE_ERROR` when detection itself failed (no git repo, etc.).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { lsFilesByExt } from "../lib/git.ts";
import { logger, output } from "../lib/logger.ts";

/**
 * Marker files that, if present at the project root, indicate a primary
 * language oxc does not cover. Order is informational only — every probe runs
 * regardless. Keep this list intentionally narrow: false positives here block
 * legitimate users, so prefer language-canonical files (e.g. `pyproject.toml`)
 * over ambiguous ones (e.g. `requirements.txt`, which is sometimes generated).
 */
const UNSUPPORTED_MARKERS: ReadonlyArray<{
  readonly file: string;
  readonly kind: string;
}> = [
  { file: "pyproject.toml", kind: "python" },
  { file: "setup.py", kind: "python" },
  { file: "Pipfile", kind: "python" },
  { file: "go.mod", kind: "go" },
  { file: "Cargo.toml", kind: "rust" },
  { file: "Gemfile", kind: "ruby" },
  { file: "composer.json", kind: "php" },
  { file: "pom.xml", kind: "java" },
  { file: "build.gradle", kind: "java" },
  { file: "build.gradle.kts", kind: "java" },
  { file: "mix.exs", kind: "elixir" },
];

/** Single-file extensions whose mere presence (anywhere in the tree) blocks. */
const UNSUPPORTED_FILE_EXTS: readonly string[] = ["vue", "svelte"];

/** Extensions counted as supported source. Anchor: SPEC §1. */
const SUPPORTED_FILE_EXTS = ["ts", "tsx", "js", "jsx"] as const;

export type SupportedExt = (typeof SUPPORTED_FILE_EXTS)[number];

export interface StackBlocker {
  readonly kind: string;
  readonly file: string;
}

export interface DetectStackSignals {
  readonly tsFiles: number;
  readonly tsxFiles: number;
  readonly jsFiles: number;
  readonly jsxFiles: number;
  readonly hasPackageJson: boolean;
  readonly vueFiles: number;
  readonly svelteFiles: number;
}

export interface DetectStackOk {
  readonly ok: true;
  readonly cwd: string;
  readonly supported: boolean;
  readonly signals: DetectStackSignals;
  readonly blockers: ReadonlyArray<StackBlocker>;
  readonly supportedLanguages: ReadonlyArray<SupportedExt>;
}

export interface DetectStackErr {
  readonly ok: false;
  readonly error: string;
}

export type DetectStackResult = DetectStackOk | DetectStackErr;

export interface DetectStackOptions {
  readonly cwd: string;
}

export interface DetectStackDeps {
  /** Test seam. Defaults to `node:fs.existsSync`. */
  readonly existsFn?: (path: string) => boolean;
}

/**
 * Counts how many entries of `files` end with `.${ext}`, ignoring `.tsx` when
 * counting `.ts` (since `endsWith(".ts")` would otherwise double-count `.tsx`).
 *
 * `endsWith` semantics:
 *   - `"foo.ts".endsWith(".ts")` → true
 *   - `"foo.tsx".endsWith(".ts")` → false  (last char differs)
 * So we don't actually need the tsx exclusion at runtime — but the explicit
 * suffix avoids subtle bugs if extensions ever overlap (e.g. ".cjs" vs ".js").
 */
function countByExt(files: readonly string[], ext: string): number {
  const suffix = `.${ext}`;
  let n = 0;
  for (const f of files) if (f.endsWith(suffix)) n++;
  return n;
}

/**
 * Pure detection — no I/O on its own; receives `existsFn` and uses the
 * `git.ts` module-level runner (mockable via `setGitRunner` in tests).
 */
export function detectStack(
  opts: DetectStackOptions,
  deps: DetectStackDeps = {},
): DetectStackResult {
  const cwd = opts.cwd;
  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));

  const filesRes = lsFilesByExt(cwd, [...SUPPORTED_FILE_EXTS, ...UNSUPPORTED_FILE_EXTS]);
  if (!filesRes.ok) {
    return { ok: false, error: filesRes.error };
  }
  const files = filesRes.value;

  const tsFiles = countByExt(files, "ts");
  const tsxFiles = countByExt(files, "tsx");
  const jsFiles = countByExt(files, "js");
  const jsxFiles = countByExt(files, "jsx");
  const vueFiles = countByExt(files, "vue");
  const svelteFiles = countByExt(files, "svelte");

  const blockers: StackBlocker[] = [];
  for (const marker of UNSUPPORTED_MARKERS) {
    if (existsFn(join(cwd, marker.file))) {
      blockers.push({ kind: marker.kind, file: marker.file });
    }
  }
  if (vueFiles > 0) {
    blockers.push({ kind: "vue-sfc", file: `*.vue (${vueFiles})` });
  }
  if (svelteFiles > 0) {
    blockers.push({ kind: "svelte-sfc", file: `*.svelte (${svelteFiles})` });
  }

  const supportedLanguages: SupportedExt[] = [];
  if (tsFiles > 0) supportedLanguages.push("ts");
  if (tsxFiles > 0) supportedLanguages.push("tsx");
  if (jsFiles > 0) supportedLanguages.push("js");
  if (jsxFiles > 0) supportedLanguages.push("jsx");

  const totalSupported = tsFiles + tsxFiles + jsFiles + jsxFiles;
  const supported = blockers.length === 0 && totalSupported > 0;

  return {
    ok: true,
    cwd,
    supported,
    signals: {
      tsFiles,
      tsxFiles,
      jsFiles,
      jsxFiles,
      hasPackageJson: existsFn(join(cwd, "package.json")),
      vueFiles,
      svelteFiles,
    },
    blockers,
    supportedLanguages,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

/**
 * Minimal flag parser for this command. Only `--cwd <path>` is recognized;
 * anything else is rejected with USAGE_ERROR upstream.
 *
 * Resolution: the path is resolved against `defaultCwd` (typically
 * `process.cwd()`) so the caller can pass either absolute or relative.
 */
export function parseDetectStackArgs(
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

/**
 * Handler invoked by the dispatcher. Emits exactly one stdout JSON document
 * via `output()` and uses `logger.*` for stderr diagnostics.
 */
export function runDetectStack(argv: readonly string[]): ExitCode {
  const parsed = parseDetectStackArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy detect-stack [--cwd <path>]\n" +
          "\n" +
          "Classifies the project as supported (TS/TSX/JS/JSX) or blocked.\n" +
          "Exit codes: 0 supported, 2 unsupported, 1 detection error.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "detect-stack", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = detectStack(parsed.value);
  if (!result.ok) {
    logger.error("detect_stack_failed", { reason: result.error });
    output({ ok: false, error: "detect_stack_failed", reason: result.error });
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  if (result.supported) {
    logger.info("detect_stack_supported", {
      languages: result.supportedLanguages,
    });
    return EXIT_CODES.OK;
  }
  logger.warn("detect_stack_unsupported", {
    blockers: result.blockers,
    totalSupportedFiles:
      result.signals.tsFiles +
      result.signals.tsxFiles +
      result.signals.jsFiles +
      result.signals.jsxFiles,
  });
  return EXIT_CODES.UNSUPPORTED_STACK;
}
