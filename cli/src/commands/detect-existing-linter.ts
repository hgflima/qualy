/**
 * `detect-existing-linter` — read-only probe for ESLint / Prettier / Biome /
 * dprint configs and package deps. SPEC §1.2 (substituição com consentimento)
 * needs an authoritative list of "what's already there" before `/lint:setup`
 * can offer to back it up and replace it.
 *
 * Two evidence types per tool:
 *   1. **Config files** at the project root. We probe specific filenames
 *      (`.eslintrc.json`, `eslint.config.js`, etc.) via `existsSync` — globs
 *      are intentionally avoided so the list is auditable in source.
 *   2. **Package deps**: a tool counts as installed when its npm package
 *      appears in `dependencies`, `devDependencies`, `peerDependencies` or
 *      `optionalDependencies` of the root `package.json`. We also surface
 *      inline configs declared via package.json keys (ESLint
 *      `eslintConfig`, Prettier `prettier`) as virtual config paths
 *      `package.json#<key>`.
 *
 * Classification (PLAN §Contratos CLI output `{ linters, formatters }`):
 *   - eslint   → linter
 *   - prettier → formatter
 *   - biome    → both (lints AND formats; appears in both arrays)
 *   - dprint   → formatter
 *
 * A tool is reported only when it has at least one config or `pkg_dep=true`
 * — empty entries would be noise. Order in the output matches the order in
 * `TOOLS` so callers can rely on a stable layout.
 *
 * Exit code: always `OK` on success. Detection itself never fails — missing
 * `package.json`, malformed JSON, or unreadable files are treated as
 * "no evidence" rather than errors. The harness uses the *content* of the
 * arrays, not exit codes, to drive the migrate-vs-greenfield decision.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { parseDefensive } from "../lib/json.ts";
import { logger, output } from "../lib/logger.ts";

type ToolKind = "linter" | "formatter" | "both";

interface ToolDef {
  readonly name: string;
  readonly kind: ToolKind;
  /** Filenames probed via `existsSync(join(cwd, file))`. */
  readonly configFiles: readonly string[];
  /** package.json keys whose mere presence (defined, non-undefined) counts as a config. */
  readonly packageJsonKeys?: readonly string[];
  /** npm packages whose presence in deps/devDeps/peerDeps/optionalDeps sets pkg_dep=true. */
  readonly pkgNames: readonly string[];
}

/**
 * Catalogue of tools to probe. Keep narrow on purpose: SPEC §1 lists the four
 * we care about (ESLint, Prettier, Biome, dprint) — adding more here without
 * a SPEC change risks false positives that block legitimate setups.
 */
const TOOLS: readonly ToolDef[] = [
  {
    name: "eslint",
    kind: "linter",
    configFiles: [
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.mjs",
      ".eslintrc.json",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      "eslint.config.js",
      "eslint.config.cjs",
      "eslint.config.mjs",
      "eslint.config.ts",
    ],
    packageJsonKeys: ["eslintConfig"],
    pkgNames: ["eslint"],
  },
  {
    name: "prettier",
    kind: "formatter",
    configFiles: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.toml",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ],
    packageJsonKeys: ["prettier"],
    pkgNames: ["prettier"],
  },
  {
    name: "biome",
    kind: "both",
    configFiles: ["biome.json", "biome.jsonc"],
    pkgNames: ["@biomejs/biome"],
  },
  {
    name: "dprint",
    kind: "formatter",
    configFiles: ["dprint.json", "dprint.jsonc", ".dprint.json"],
    pkgNames: ["dprint"],
  },
];

export interface ToolEntry {
  readonly name: string;
  readonly configs: readonly string[];
  readonly pkg_dep: boolean;
}

export interface DetectExistingLinterOk {
  readonly ok: true;
  readonly cwd: string;
  readonly linters: readonly ToolEntry[];
  readonly formatters: readonly ToolEntry[];
}

export type DetectExistingLinterResult = DetectExistingLinterOk;

export interface DetectExistingLinterOptions {
  readonly cwd: string;
}

export interface DetectExistingLinterDeps {
  /** Test seam. Defaults to `node:fs.existsSync`. */
  readonly existsFn?: (path: string) => boolean;
  /** Test seam. Returns file contents or `null` on any read failure. */
  readonly readFileFn?: (path: string) => string | null;
}

interface PackageJsonShape {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
  readonly optionalDependencies?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function loadPackageJson(
  cwd: string,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string) => string | null,
): PackageJsonShape | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsFn(pkgPath)) return null;
  const raw = readFileFn(pkgPath);
  if (raw === null) return null;
  const parsed = parseDefensive<unknown>(raw);
  if (!parsed.ok) return null;
  if (typeof parsed.value !== "object" || parsed.value === null) return null;
  return parsed.value as PackageJsonShape;
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function hasDep(pkg: PackageJsonShape, name: string): boolean {
  for (const field of DEP_FIELDS) {
    const map = pkg[field];
    if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, name)) {
      return true;
    }
  }
  return false;
}

/**
 * Pure detection — never throws; missing/invalid files are silently treated
 * as "no evidence". Inject `existsFn`/`readFileFn` in tests.
 */
export function detectExistingLinter(
  opts: DetectExistingLinterOptions,
  deps: DetectExistingLinterDeps = {},
): DetectExistingLinterResult {
  const { cwd } = opts;
  const existsFn = deps.existsFn ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFileFn ?? defaultReadFile;

  const pkg = loadPackageJson(cwd, existsFn, readFileFn);

  const linters: ToolEntry[] = [];
  const formatters: ToolEntry[] = [];

  for (const tool of TOOLS) {
    const configs: string[] = [];
    for (const file of tool.configFiles) {
      if (existsFn(join(cwd, file))) configs.push(file);
    }
    if (pkg && tool.packageJsonKeys) {
      for (const key of tool.packageJsonKeys) {
        if (Object.prototype.hasOwnProperty.call(pkg, key) && pkg[key] !== undefined) {
          configs.push(`package.json#${key}`);
        }
      }
    }
    let pkgDep = false;
    if (pkg) {
      for (const name of tool.pkgNames) {
        if (hasDep(pkg, name)) {
          pkgDep = true;
          break;
        }
      }
    }
    if (configs.length === 0 && !pkgDep) continue;
    const entry: ToolEntry = { name: tool.name, configs, pkg_dep: pkgDep };
    if (tool.kind === "linter" || tool.kind === "both") linters.push(entry);
    if (tool.kind === "formatter" || tool.kind === "both") formatters.push(entry);
  }

  return { ok: true, cwd, linters, formatters };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseDetectExistingLinterArgs(
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

export function runDetectExistingLinter(argv: readonly string[]): ExitCode {
  const parsed = parseDetectExistingLinterArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy detect-existing-linter [--cwd <path>]\n" +
          "\n" +
          "Probes for ESLint/Prettier/Biome/dprint configs and package deps.\n" +
          "Always exits 0 on success; output drives migrate-vs-greenfield flow.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "detect-existing-linter",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = detectExistingLinter(parsed.value);
  output({ linters: result.linters, formatters: result.formatters });
  logger.info("detect_existing_linter_done", {
    linters: result.linters.length,
    formatters: result.formatters.length,
  });
  return EXIT_CODES.OK;
}
