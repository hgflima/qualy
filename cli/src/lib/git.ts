/**
 * Thin wrappers over `git` for read-only signals consumed by the detection
 * commands (SPEC §3 heurística de detecção de estágio).
 *
 * Design choices:
 *   - Synchronous `execFileSync` (not a shell) so callers can compose detectors
 *     without async plumbing and so we never expand globs through `/bin/sh`.
 *   - Every wrapper returns a `GitResult<T>` discriminated union — git can
 *     legitimately fail (no `.git/`, no commits, missing binary) and detectors
 *     must handle those without throwing.
 *   - `setGitRunner()` is a test seam. Real git runs in fixtures via
 *     `tests/unit/git.test.ts`; pure unit tests inject a fake runner.
 */
import { execFileSync } from "node:child_process";

export type GitResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GitRunner = (cwd: string, args: readonly string[]) => GitRunResult;

const defaultRunner: GitRunner = (cwd, args) => {
  try {
    const stdout = execFileSync("git", args, {
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
    const message = e.message ?? stderr ?? "git failed";
    return { ok: false, stdout, stderr: stderr || message, exitCode };
  }
};

let runner: GitRunner = defaultRunner;

/** Test-only seam. Pass `null` to restore the real `git` runner. */
export function setGitRunner(next: GitRunner | null): void {
  runner = next ?? defaultRunner;
}

function fail<T>(error: string): GitResult<T> {
  return { ok: false, error };
}

/**
 * `true` iff the working tree has zero modifications, including untracked
 * files. Implemented as `git status --porcelain` returning empty output —
 * matches SPEC §6 ("working tree git limpo antes de modificações").
 */
export function isClean(cwd: string): GitResult<boolean> {
  const res = runner(cwd, ["status", "--porcelain"]);
  if (!res.ok) return fail(res.stderr.trim() || "git status failed");
  return { ok: true, value: res.stdout.length === 0 };
}

/**
 * List of files reported by `git status --porcelain=v1 -z` — covers tracked
 * modifications and untracked files. Used by `git-clean-check` (SPEC §6) so
 * the user knows *which* files block a destructive command.
 *
 * Why `-z`:
 *   - Without it, paths with spaces, quotes, or newlines arrive escaped
 *     (e.g. "foo\\nbar") and would need un-escaping.
 *   - With `-z`, fields are NUL-terminated and paths are emitted verbatim.
 *
 * Parsing (porcelain v1):
 *   - Each record: 2 status chars + space + path, terminated by NUL.
 *   - Renames/copies (X='R'|'C'): the *next* NUL-terminated token holds the
 *     original path; we surface only the new path here.
 *
 * Returns the list of changed paths (clean tree → empty list).
 */
export function dirtyFiles(cwd: string): GitResult<readonly string[]> {
  const res = runner(cwd, ["status", "--porcelain=v1", "-z"]);
  if (!res.ok) return fail(res.stderr.trim() || "git status failed");
  if (res.stdout.length === 0) return { ok: true, value: [] };

  const tokens = res.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.length < 4) continue;
    const x = tok[0];
    const path = tok.slice(3);
    paths.push(path);
    if (x === "R" || x === "C") i++;
  }
  return { ok: true, value: paths };
}

/**
 * Date of the repo's first commit (oldest root commit). Returns `null` when
 * the repo has no commits yet — that is a valid greenfield signal, not an
 * error.
 *
 * Uses `--max-parents=0 --pretty=%cI` so we get root commits in committer-ISO
 * format. Multiple roots are possible in merged histories; we pick the
 * earliest by string compare (ISO-8601 sorts lexicographically).
 */
export function firstCommitDate(cwd: string): GitResult<Date | null> {
  const res = runner(cwd, ["log", "--max-parents=0", "--pretty=%cI"]);
  if (!res.ok) {
    const stderr = res.stderr.toLowerCase();
    if (stderr.includes("does not have any commits") || stderr.includes("bad default revision")) {
      return { ok: true, value: null };
    }
    return fail(res.stderr.trim() || "git log failed");
  }
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: true, value: null };
  const earliest = lines.reduce((min, cur) => (cur < min ? cur : min));
  const date = new Date(earliest);
  if (Number.isNaN(date.getTime())) {
    return fail(`unparsable commit date: ${earliest}`);
  }
  return { ok: true, value: date };
}

/**
 * Count of commits reachable from HEAD in the last 90 days (SPEC §3:
 * `git log --since='90 days ago' --pretty=oneline | wc -l`). Uses
 * `rev-list --count` for a single-integer answer that does not allocate
 * one stdout line per commit.
 *
 * Returns 0 when the repo has no commits — same rationale as
 * `firstCommitDate`: empty repo is a signal, not an error.
 */
export function churn90d(cwd: string): GitResult<number> {
  const res = runner(cwd, ["rev-list", "--count", "--since=90 days ago", "HEAD"]);
  if (!res.ok) {
    const stderr = res.stderr.toLowerCase();
    if (
      stderr.includes("unknown revision") ||
      stderr.includes("does not have any commits") ||
      stderr.includes("bad revision")
    ) {
      return { ok: true, value: 0 };
    }
    return fail(res.stderr.trim() || "git rev-list failed");
  }
  const trimmed = res.stdout.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return fail(`unparsable churn count: ${trimmed}`);
  return { ok: true, value: n };
}

/**
 * Tracked files matching one or more extensions. Extensions are normalized
 * to a trailing-glob form (`ts` → `*.ts`) and forwarded as positional
 * pathspecs to `git ls-files` — never expanded by a shell.
 *
 * Empty `exts` yields an empty list (no-op) rather than every tracked file:
 * detectors should be explicit about which file types they care about.
 *
 * SPEC §3 anchor: `git ls-files '*.ts' '*.tsx' '*.js' '*.jsx' | wc -l`.
 */
export function lsFilesByExt(cwd: string, exts: readonly string[]): GitResult<string[]> {
  if (exts.length === 0) return { ok: true, value: [] };
  const seen = new Set<string>();
  const pathspecs: string[] = [];
  for (const ext of exts) {
    const cleaned = ext.replace(/^\*?\./, "").replace(/^\*/, "");
    if (cleaned.length === 0 || /[/\\\s]/.test(cleaned)) {
      return fail(`invalid extension: ${JSON.stringify(ext)}`);
    }
    const spec = `*.${cleaned}`;
    if (!seen.has(spec)) {
      seen.add(spec);
      pathspecs.push(spec);
    }
  }
  const res = runner(cwd, ["ls-files", "-z", "--", ...pathspecs]);
  if (!res.ok) return fail(res.stderr.trim() || "git ls-files failed");
  if (res.stdout.length === 0) return { ok: true, value: [] };
  const files = res.stdout
    .split("\0")
    .filter((f) => f.length > 0);
  return { ok: true, value: files };
}
