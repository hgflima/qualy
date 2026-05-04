/**
 * Scope resolution for the harness installer.
 *
 * `resolveScope(scope, cwd)` maps a `--scope` flag to the absolute `.claude`
 * directory the installer will mutate. SPEC §3 (table "Path resolvido"):
 *
 *   user    → ${HOME}/.claude
 *   project → ${cwd}/.claude  (requires `.git/` — meant to be committed)
 *   local   → ${cwd}/.claude  (gitignored by the install handler)
 *
 * Anti-traversal: reject any `cwd` that contains `..` segments after
 * normalization, or that resolves to the filesystem root `/`. The installer
 * never tries to be clever about "the user probably meant the workspace
 * root" (SPEC §10 D4 — "previsibilidade > esperteza"); a literal `cwd` is
 * the only input it trusts.
 */
import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

import { RecoverableError } from "./errors.ts";

export type Scope = "user" | "project" | "local";

export type ResolvedScope = {
  root: string;
  scope: Scope;
};

const CLAUDE_DIR = ".claude";

export function resolveScope(scope: Scope, cwd: string): ResolvedScope {
  if (scope === "user") {
    const home = process.env.HOME;
    if (home === undefined || home.length === 0) {
      throw new RecoverableError(
        "HOME undefined; cannot resolve --scope user",
      );
    }
    return { root: join(home, CLAUDE_DIR), scope };
  }

  const normalized = normalize(cwd);
  if (normalized.split(sep).includes("..")) {
    throw new RecoverableError(
      `--scope ${scope}: cwd must not contain ".." segments (got: ${cwd})`,
    );
  }
  const resolved = resolve(normalized);
  if (resolved === sep) {
    throw new RecoverableError(
      `--scope ${scope}: refusing to install at filesystem root "/"`,
    );
  }

  if (scope === "project" && !existsSync(join(resolved, ".git"))) {
    throw new RecoverableError(
      "project scope requires a git repo; use --scope local instead",
    );
  }

  return { root: join(resolved, CLAUDE_DIR), scope };
}
