/**
 * `appendIgnoreLine` keeps a single literal line present in the repo's root
 * `.gitignore`. The harness installer calls it for `--scope local` (SPEC §3
 * table — "local" is gitignored, "project" meant for commit) so the user does
 * not accidentally commit `.claude/` after experimenting locally.
 *
 * Behavior:
 *   - File absent → create it containing `${line}\n`. Returns "created".
 *   - File present and a trim-equal line already exists → no write. Returns
 *     "already-present".
 *   - File present without the line → append `${line}\n`, prefixing with `\n`
 *     when the existing content does not end in one (avoids `lastline.claude/`
 *     glued onto the previous entry). Returns "added".
 *
 * Comparison is `trim()` equality per source line — `.claude/` matches an
 * existing `.claude/` regardless of trailing spaces or `\r`. Subdirectory
 * patterns (`.claude/foo`) are NOT considered equivalent; an explicit
 * `.claude/` is what the harness writes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type IgnoreAction = "added" | "already-present" | "created";

export function appendIgnoreLine(repoRoot: string, line: string): IgnoreAction {
  const path = join(repoRoot, ".gitignore");
  const wanted = line.trim();
  if (wanted.length === 0) {
    throw new Error("appendIgnoreLine: line must not be empty after trim");
  }

  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, "utf8");
    return "created";
  }

  const existing = readFileSync(path, "utf8");
  const lines = existing.split("\n");
  for (const raw of lines) {
    if (raw.trim() === wanted) return "already-present";
  }

  const prefix = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${prefix}${line}\n`, "utf8");
  return "added";
}
