/**
 * Single source of truth for repository-relative paths used by qualy.
 *
 * Paths are POSIX-form, relative to the project root. Callers are responsible
 * for resolving against `cwd` via `node:path/join` when they need an absolute
 * path. Constants live here (rather than inline `const` in command modules) so
 * the migration `docs/lint-decisions.md → .harn/qualy/docs/lint-decisions.md`
 * (lint-ignore SPEC §Migration) can be performed in one place and the legacy
 * location stays referenced exclusively by the migration helper.
 */

/** Active decision-log path. New mutations always target this. */
export const DECISION_LOG_PATH = ".harn/qualy/docs/lint-decisions.md";

/** Pre-namespace decision-log path. Only the migration helper reads it. */
export const LEGACY_DECISION_LOG_PATH = "docs/lint-decisions.md";

/** Ignore manifest authored by `qualy ignore-*` commands. */
export const IGNORE_MANIFEST_PATH = ".harn/qualy/ignore.json";

/** oxlint preset filenames (relative to project root). */
export const PRESET_PATHS = Object.freeze({
  fast: "oxlint.fast.json",
  deep: "oxlint.deep.json",
} as const);

/** Sentinel placed by `ignore-compile` at the start of qualy-managed regions. */
export const IGNORE_MARKER_START = "_qualy:start_";

/** Sentinel placed by `ignore-compile` at the end of qualy-managed regions. */
export const IGNORE_MARKER_END = "_qualy:end_";
