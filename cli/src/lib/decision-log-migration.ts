/**
 * One-time migration helper that moves the decision log from the legacy
 * `docs/lint-decisions.md` location into the qualy-namespaced
 * `.harn/qualy/docs/lint-decisions.md` (lint-ignore SPEC §Migration).
 *
 * Invoked at the top of every mutation entry-point (`rules/add`,
 * `rules/remove`, `recs/apply`, and the upcoming `ignore-*` commands) before
 * the existing decision-log read. Idempotent — repeated invocations are a
 * no-op once the migration has happened.
 *
 * Five mutually exclusive states:
 *   - legacy + new exist     → `decision_log_conflict` (refuse, surface a
 *                               cure one-liner so the user can merge by hand
 *                               and rerun)
 *   - legacy only, tracked   → `git mv` to preserve history + append a
 *                               `meta:migrate-decision-log` entry
 *   - legacy only, untracked → `fs.rename` + append meta entry
 *   - new only               → no-op (`already-migrated`)
 *   - neither                → no-op (`no-legacy`)
 *
 * Every dependency is injected so unit tests can simulate every state without
 * touching disk or running git.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  appendDecisionEntry,
  formatDecisionEntry,
} from "./decision-log.ts";
import {
  DECISION_LOG_PATH,
  LEGACY_DECISION_LOG_PATH,
} from "./paths.ts";

export interface DecisionLogMigrationDeps {
  readonly existsFn?: (path: string) => boolean;
  readonly readFileFn?: (path: string) => string | null;
  readonly writeFileFn?: (path: string, content: string) => void;
  readonly mkdirFn?: (dir: string) => void;
  readonly mvFn?: (from: string, to: string) => void;
  /** Returns `true` on success. Implementations should not throw on a soft
   *  failure (e.g. file untracked); the caller falls back to `mvFn`. */
  readonly gitMvFn?: (cwd: string, fromRel: string, toRel: string) => boolean;
  readonly gitTracksFn?: (cwd: string, pathRel: string) => boolean;
  readonly now?: () => Date;
  readonly templatePath?: string;
}

export type DecisionLogMigrationResult =
  | {
      readonly ok: true;
      readonly migrated: false;
      readonly reason: "already-migrated" | "no-legacy";
    }
  | {
      readonly ok: true;
      readonly migrated: true;
      readonly from: string;
      readonly to: string;
      readonly method: "git-mv" | "mv";
    }
  | {
      readonly ok: false;
      readonly error: "decision_log_conflict" | "migration_io_failed";
      readonly reason: string;
    };

const defaultExists = (p: string) => existsSync(p);
const defaultRead = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const defaultWrite = (p: string, c: string) => writeFileSync(p, c, "utf8");
const defaultMkdir = (d: string) => mkdirSync(d, { recursive: true });
const defaultMv = (from: string, to: string) => renameSync(from, to);
const defaultGitTracks = (cwd: string, pathRel: string): boolean => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", pathRel], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
const defaultGitMv = (cwd: string, fromRel: string, toRel: string): boolean => {
  try {
    execFileSync("git", ["mv", fromRel, toRel], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function migrateDecisionLogIfNeeded(
  cwd: string,
  deps: DecisionLogMigrationDeps = {},
): DecisionLogMigrationResult {
  const existsFn = deps.existsFn ?? defaultExists;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const writeFileFn = deps.writeFileFn ?? defaultWrite;
  const mkdirFn = deps.mkdirFn ?? defaultMkdir;
  const mvFn = deps.mvFn ?? defaultMv;
  const gitTracksFn = deps.gitTracksFn ?? defaultGitTracks;
  const gitMvFn = deps.gitMvFn ?? defaultGitMv;
  const now = deps.now ?? (() => new Date());

  const legacyAbs = join(cwd, LEGACY_DECISION_LOG_PATH);
  const newAbs = join(cwd, DECISION_LOG_PATH);

  const legacyExists = existsFn(legacyAbs);
  const newExists = existsFn(newAbs);

  if (legacyExists && newExists) {
    return {
      ok: false,
      error: "decision_log_conflict",
      reason:
        `both ${LEGACY_DECISION_LOG_PATH} and ${DECISION_LOG_PATH} exist; ` +
        "merge them by hand and remove one before retrying " +
        `(e.g. \`cat ${LEGACY_DECISION_LOG_PATH} >> ${DECISION_LOG_PATH} && rm ${LEGACY_DECISION_LOG_PATH}\`)`,
    };
  }

  if (!legacyExists) {
    return {
      ok: true,
      migrated: false,
      reason: newExists ? "already-migrated" : "no-legacy",
    };
  }

  // legacyExists === true && newExists === false → migrate.
  try {
    mkdirFn(dirname(newAbs));

    let method: "git-mv" | "mv";
    if (gitTracksFn(cwd, LEGACY_DECISION_LOG_PATH)) {
      const ok = gitMvFn(cwd, LEGACY_DECISION_LOG_PATH, DECISION_LOG_PATH);
      if (!ok) {
        return {
          ok: false,
          error: "migration_io_failed",
          reason: `git mv ${LEGACY_DECISION_LOG_PATH} → ${DECISION_LOG_PATH} failed`,
        };
      }
      method = "git-mv";
    } else {
      mvFn(legacyAbs, newAbs);
      method = "mv";
    }

    const moved = readFileFn(newAbs);
    if (moved === null) {
      return {
        ok: false,
        error: "migration_io_failed",
        reason: `decision log not readable at ${DECISION_LOG_PATH} after move`,
      };
    }

    const metaEntry = {
      timestamp: isoUtc(now()),
      kind: "meta:migrate-decision-log" as const,
      subject:
        `moved ${LEGACY_DECISION_LOG_PATH} → ${DECISION_LOG_PATH}`,
      bullets: [
        ["kind", "meta:migrate-decision-log"],
        ["from", LEGACY_DECISION_LOG_PATH],
        ["to", DECISION_LOG_PATH],
        ["method", method],
      ] as ReadonlyArray<readonly [string, string]>,
    };

    const appended = appendDecisionEntry(moved, metaEntry);
    if (!appended.ok) {
      // Decision-log markers missing — fall back to writing as-is so we don't
      // lose the moved content; the next mutation will surface the error.
      return {
        ok: false,
        error: "migration_io_failed",
        reason: `decision log markers missing after move: ${appended.error}`,
      };
    }

    writeFileFn(newAbs, appended.text);

    return {
      ok: true,
      migrated: true,
      from: LEGACY_DECISION_LOG_PATH,
      to: DECISION_LOG_PATH,
      method,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      error: "migration_io_failed",
      reason: e.message ?? "unknown filesystem error",
    };
  }
}

// Re-export for consumers that build their own meta entries (rare).
export { formatDecisionEntry };
