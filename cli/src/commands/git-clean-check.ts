/**
 * `git-clean-check` — assert the working tree is clean before any mutating
 * command (SPEC §6 Always: "exigir working tree git limpo antes de
 * modificações; oferecer `git stash` se sujo").
 *
 * Output (PLAN §Contratos CLI):
 *   { clean: bool, dirty_files: string[] }
 *
 * Exit code:
 *   - OK            → tree is clean.
 *   - DIRTY_TREE    → tree has tracked modifications and/or untracked files.
 *   - RECOVERABLE_ERROR → not a git repo / git command failed.
 *
 * The harness reads exit codes — not the JSON — to decide whether to abort
 * and surface the standard "stash first" message. The list is informational
 * (rendered to the user when blocking).
 */
import { resolve } from "node:path";
import { EXIT_CODES, type ExitCode } from "../lib/exit-codes.ts";
import { dirtyFiles } from "../lib/git.ts";
import { logger, output } from "../lib/logger.ts";

export interface GitCleanCheckOptions {
  readonly cwd: string;
}

export interface GitCleanCheckOk {
  readonly ok: true;
  readonly cwd: string;
  readonly clean: boolean;
  readonly dirtyFiles: readonly string[];
}

export interface GitCleanCheckErr {
  readonly ok: false;
  readonly error: string;
}

export type GitCleanCheckResult = GitCleanCheckOk | GitCleanCheckErr;

/**
 * Pure check — delegates I/O to the `git.ts` runner (mockable in tests).
 */
export function gitCleanCheck(opts: GitCleanCheckOptions): GitCleanCheckResult {
  const res = dirtyFiles(opts.cwd);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    cwd: opts.cwd,
    clean: res.value.length === 0,
    dirtyFiles: res.value,
  };
}

export interface ParsedArgs {
  readonly cwd: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseGitCleanCheckArgs(
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

export function runGitCleanCheck(argv: readonly string[]): ExitCode {
  const parsed = parseGitCleanCheckArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy git-clean-check [--cwd <path>]\n" +
          "\n" +
          "Asserts the git working tree is clean before mutating commands.\n" +
          "Exit codes: 0 clean, 3 dirty, 1 git error.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "git-clean-check", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = gitCleanCheck(parsed.value);
  if (!result.ok) {
    logger.error("git_clean_check_failed", { reason: result.error });
    output({ ok: false, error: "git_clean_check_failed", reason: result.error });
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output({ clean: result.clean, dirty_files: result.dirtyFiles });
  if (result.clean) {
    logger.info("git_clean_check_clean", {});
    return EXIT_CODES.OK;
  }
  logger.warn("git_clean_check_dirty", { count: result.dirtyFiles.length });
  return EXIT_CODES.DIRTY_TREE;
}
