/**
 * `category-info` — read-only resolver for an oxlint category from the static
 * catalog (lint-ignore SPEC §3.1.1, PLAN T3.5).
 *
 * Why a dedicated subcommand:
 *   The slash command `/lint:ignore:add` needs the rule list (and count) for a
 *   `category:<name>` selector before showing `AskUserQuestion` ("este flag
 *   silencia N rules — confirma?"). Without this preview, the slash would have
 *   to either (a) bundle a copy of the catalog in markdown — drifts — or
 *   (b) inspect `cli/src/lib/category-catalog.ts` via Bash — fragile. This
 *   subcommand is the same kind of thin CLI surface as `ignore-import-preview`
 *   (T3.4b): one read, one JSON answer, no side effects.
 *
 * Behaviour:
 *   - Resolves `<name>` against `KNOWN_CATEGORIES` (from `category-catalog.ts`).
 *   - Unknown category → exit `1` `unknown_category`, with the canonical list
 *     in `reason` so the caller can surface the choices to the user.
 *   - `--name <category>` and positional both accepted; `--name` wins when both
 *     are present, mirrors the parser shape used by `ignore-add`.
 *
 * Side effects: none.
 *
 * Exit codes:
 *   - OK                — preview computed.
 *   - RECOVERABLE_ERROR — unknown category.
 *   - USAGE_ERROR       — missing/malformed flag.
 */
import {
  getCategoryRules,
  isKnownCategory,
  KNOWN_CATEGORIES,
} from "../lib/category-catalog.ts";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { logger, output } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CategoryInfoOptions {
  readonly name: string;
}

export interface CategoryInfoOk {
  readonly ok: true;
  readonly category: string;
  readonly rules: readonly string[];
  readonly count: number;
  readonly exitCode: ExitCode;
}

export interface CategoryInfoErr {
  readonly ok: false;
  readonly error: "unknown_category";
  readonly reason: string;
  readonly exitCode: ExitCode;
}

export type CategoryInfoResult = CategoryInfoOk | CategoryInfoErr;

// ---------------------------------------------------------------------------
// Pure handler
// ---------------------------------------------------------------------------

const CATEGORY_PREFIX = "category:";

export function categoryInfo(opts: CategoryInfoOptions): CategoryInfoResult {
  const raw = opts.name.trim();
  // Accept either bare `correctness` or qualified `category:correctness` so
  // the slash command can pass through whatever the user typed (mirrors
  // the manifest's `rule` field shape).
  const name = raw.startsWith(CATEGORY_PREFIX)
    ? raw.slice(CATEGORY_PREFIX.length)
    : raw;

  if (!isKnownCategory(name)) {
    return {
      ok: false,
      error: "unknown_category",
      reason: `category '${name}' is not in the qualy catalog (known: ${KNOWN_CATEGORIES.join(", ")})`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const rules = getCategoryRules(name);
  return {
    ok: true,
    category: name,
    rules,
    count: rules.length,
    exitCode: EXIT_CODES.OK,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly name: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseCategoryInfoArgs(
  argv: readonly string[],
): ArgParseResult {
  let name: string | null = null;
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --name" };
      }
      name = value;
      i++;
      continue;
    }
    if (arg === "--cwd") {
      // Accept and discard --cwd for parity with every other subcommand
      // (slash commands forward $PWD reflexively). Read-only; nothing to do.
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
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

  const resolved = name ?? positional;
  if (resolved === null) {
    return {
      ok: false,
      error: "missing category (use --name <category> or pass as positional)",
    };
  }
  return { ok: true, value: { name: resolved } };
}

export function runCategoryInfo(argv: readonly string[]): ExitCode {
  const parsed = parseCategoryInfoArgs(argv);
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy category-info <category> [--cwd <path>]\n" +
          "\n" +
          "Read-only resolver for an oxlint category. Returns\n" +
          "{ category, rules, count } from the static catalog\n" +
          "(cli/src/lib/category-catalog.ts). Used by /lint:ignore:add to\n" +
          "surface the blast radius of a `--rule category:*` selector via\n" +
          "AskUserQuestion before injecting --i-know-this-disables-many.\n" +
          "\n" +
          "Both bare names (`correctness`) and qualified ids\n" +
          "(`category:correctness`) are accepted.\n" +
          "\n" +
          "Exit codes: 0 ok, 1 unknown_category, 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", {
      command: "category-info",
      reason: parsed.error,
    });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = categoryInfo({ name: parsed.value.name });
  if (!result.ok) {
    logger.error("category_info_failed", { reason: result.reason });
    output({ ok: false, error: result.error, reason: result.reason });
    return result.exitCode;
  }

  output({
    ok: true,
    category: result.category,
    rules: result.rules,
    count: result.count,
  });
  logger.info("category_info_ok", {
    category: result.category,
    count: result.count,
  });
  return result.exitCode;
}
