/**
 * Fixture materialization helper (IMPLEMENTATION_PLAN.md §Fase 1).
 *
 * The fixtures under `cli/tests/fixtures/<name>/` ship as plain trees: a parent
 * git repo cannot track nested `.git/` directories, so each fixture is a
 * blueprint that tests must copy into a temp dir and `git init` before any
 * detector that reads git state (every detector in `src/lib/git.ts`) becomes
 * exercisable.
 *
 * Contract documented in each fixture's `EXPECTED.md` ("`.git` materialization"
 * section) — this helper is the single executable source of truth.
 *
 * Determinism:
 *   - Author/committer are pinned (`fixture@qualy.local` / `fixture`) so the
 *     materialized commit hash depends only on tree contents + commitDate.
 *   - `commitDate` (default: `2025-01-01T00:00:00Z`) is forwarded as both
 *     `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`. Tests that need a "now"
 *     reference for `age_days` can pass their own `now` to the detector
 *     instead of mutating the commit date.
 *   - `--initial-branch=main` keeps repos consistent across host git defaults
 *     (older `master`, newer `main`).
 *
 * Safety:
 *   - The temp dir is always created with `mkdtempSync` under `os.tmpdir()`.
 *   - `cleanup()` re-checks the prefix before `rmSync` — if a caller somehow
 *     mutates `dir`, cleanup refuses rather than recursing into a wrong tree.
 *   - `EXPECTED.md` is filtered out of the copy: it is documentation about the
 *     fixture, not part of the simulated project state.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MaterializeOptions {
  /**
   * ISO-8601 commit date for the deterministic root commit. Default
   * `2025-01-01T00:00:00Z`. Used for both author and committer dates so the
   * commit is fully reproducible.
   */
  readonly commitDate?: string;
}

export interface MaterializedFixture {
  /** Absolute path to the materialized temp directory. */
  readonly dir: string;
  /**
   * Idempotent recursive remove of the temp directory. Safe to call multiple
   * times. Refuses to act on paths that are not under `os.tmpdir()`.
   */
  readonly cleanup: () => void;
}

const FIXTURES_ROOT = resolve(fileURLToPath(import.meta.url), "..");
const DEFAULT_COMMIT_DATE = "2025-01-01T00:00:00Z";
const FIXTURE_AUTHOR = "fixture";
const FIXTURE_EMAIL = "fixture@qualy.local";

/**
 * Copy `cli/tests/fixtures/<name>/` into a fresh temp dir, run
 * `git init` + `git add -A` + a single deterministic commit, and return the
 * absolute path plus a cleanup callback.
 *
 * Throws synchronously if:
 *   - `name` contains path separators or `..` (shape guard, not a security
 *     boundary — fixtures live in-repo and the helper is test-only).
 *   - The named fixture directory does not exist.
 *   - Any of the three git invocations fails.
 */
export function materializeFixture(
  name: string,
  options: MaterializeOptions = {},
): MaterializedFixture {
  if (name.length === 0 || /[\\/]|\.\./.test(name)) {
    throw new Error(`materializeFixture: invalid fixture name ${JSON.stringify(name)}`);
  }
  const sourceDir = join(FIXTURES_ROOT, name);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`materializeFixture: fixture not found: ${sourceDir}`);
  }

  const tmpRoot = tmpdir();
  const dir = mkdtempSync(join(tmpRoot, `qualy-fixture-${name}-`));

  try {
    cpSync(sourceDir, dir, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        return name !== "EXPECTED.md" && name !== "EXPECTED.json";
      },
    });
  } catch (err) {
    safeCleanup(dir, tmpRoot);
    throw err;
  }

  const commitDate = options.commitDate ?? DEFAULT_COMMIT_DATE;

  try {
    runGit(dir, ["init", "-q", "--initial-branch=main"]);
    runGit(dir, ["add", "-A"]);
    runGit(
      dir,
      [
        "-c",
        `user.email=${FIXTURE_EMAIL}`,
        "-c",
        `user.name=${FIXTURE_AUTHOR}`,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        `fixture: ${name}`,
      ],
      {
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate,
        GIT_AUTHOR_NAME: FIXTURE_AUTHOR,
        GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
        GIT_COMMITTER_NAME: FIXTURE_AUTHOR,
        GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
      },
    );
  } catch (err) {
    safeCleanup(dir, tmpRoot);
    throw err;
  }

  return {
    dir,
    cleanup: () => safeCleanup(dir, tmpRoot),
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
}

function safeCleanup(dir: string, tmpRoot: string): void {
  const resolved = resolve(dir);
  const resolvedTmp = resolve(tmpRoot);
  if (!resolved.startsWith(resolvedTmp + "/") && resolved !== resolvedTmp) {
    return;
  }
  if (resolved === resolvedTmp) return;
  rmSync(resolved, { recursive: true, force: true });
}
