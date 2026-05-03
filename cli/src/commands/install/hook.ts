/**
 * `install-hook` — install the Claude Code PostToolUse hook in the target
 * project: copies `post-edit.sh` to `.claude/hooks/` and merges a hook entry
 * into `.claude/settings.json`.
 *
 * SPEC §1.4 + §4: hook fires on Write|Edit|MultiEdit and runs oxlint fast tier
 * on changed paths. SPEC §6 "Ask first": when `.claude/settings.json` already
 * exists, the harness must offer merge before overwrite — this command always
 * merges (never replaces), so it can be invoked unconditionally; the harness
 * handles the user-facing question.
 *
 * Behavior:
 *   1. Copy `cli/src/templates/post-edit.sh` byte-for-byte to
 *      `<cwd>/.claude/hooks/post-edit.sh` (mode 0o755). Manifest kind="hook".
 *   2. Load existing `.claude/settings.json` (or start fresh if absent).
 *      Refuse to proceed when present-but-malformed — destructive parse
 *      recovery would risk losing the user's other hooks.
 *   3. Ensure `hooks.PostToolUse` contains an entry with matcher
 *      `Write|Edit|MultiEdit` whose `hooks[]` references `.claude/hooks/post-edit.sh`.
 *      Existing entries are preserved; the hook is appended only if missing.
 *      Manifest kind="settings", merged=true (uninstall must not delete the file).
 *
 * Idempotency:
 *   - Re-running with no changes leaves both files byte-identical and the
 *     manifest with two entries (one per path).
 *   - If the script bytes change in a future qualy version, the file is
 *     overwritten — but the settings entry is unchanged.
 *
 * Output (PLAN §Contratos CLI):
 *   { ok, cwd, script: { path, bytes, recorded }, settings: { path, action, recorded } }
 *   action ∈ "created" | "updated" | "unchanged"
 *
 * Exit codes:
 *   - OK                — both writes succeeded.
 *   - USAGE_ERROR       — unknown flag.
 *   - RECOVERABLE_ERROR — settings.json malformed, template missing, write failed.
 *   - DIRTY_TREE        — `--strict` and working tree dirty.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { parseDefensive, stringifyPretty } from "../../lib/json.ts";
import { logger, output } from "../../lib/logger.ts";

/**
 * Bundled `post-edit.sh` template path. Resolved via `import.meta.url` so it
 * works whether qualy is installed locally, globally, or via symlink (ADR 0009).
 */
const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "post-edit.sh",
);

const SCRIPT_REL_PATH = ".claude/hooks/post-edit.sh";
const SETTINGS_REL_PATH = ".claude/settings.json";
const HOOK_MATCHER = "Write|Edit|MultiEdit";
/** Stored in settings.json as a project-relative path; matched as substring by `status`. */
const HOOK_COMMAND = ".claude/hooks/post-edit.sh";

export interface InstallHookOptions {
  readonly cwd: string;
  readonly strict?: boolean;
}

export interface InstallHookScriptOk {
  readonly path: string;
  readonly bytes: number;
  readonly recorded: boolean;
}

export type SettingsAction = "created" | "updated" | "unchanged";

export interface InstallHookSettingsOk {
  readonly path: string;
  readonly action: SettingsAction;
  readonly recorded: boolean;
}

export interface InstallHookOk {
  readonly ok: true;
  readonly cwd: string;
  readonly script: InstallHookScriptOk;
  readonly settings: InstallHookSettingsOk;
}

export interface InstallHookErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallHookResult = InstallHookOk | InstallHookErr;

export interface InstallHookDeps {
  readonly templatePath?: string;
  readonly readFileFn?: (path: string) => string;
  readonly safeIO?: SafeIO;
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

interface SettingsHookCommand {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly [key: string]: unknown;
}

interface SettingsHookEntry {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

interface SettingsRoot {
  hooks?: { PostToolUse?: SettingsHookEntry[]; [k: string]: unknown };
  [key: string]: unknown;
}

/**
 * Returns true when the entry already declares a command pointing at
 * `post-edit.sh` (substring match — defensive against path style drift).
 */
function entryReferencesPostEdit(entry: SettingsHookEntry): boolean {
  if (!Array.isArray(entry.hooks)) return false;
  for (const h of entry.hooks as SettingsHookCommand[]) {
    if (h && typeof h === "object" && typeof h.command === "string") {
      if (h.command.includes("post-edit.sh")) return true;
    }
  }
  return false;
}

function buildHookEntry(): SettingsHookEntry {
  return {
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  };
}

/**
 * Computes the next settings.json content. Returns:
 *   - { ok: false, error } when the existing file is malformed.
 *   - { ok: true, content, action: "unchanged" } when the hook is already wired.
 *   - { ok: true, content, action: "created"|"updated" } when a write is needed.
 */
export function mergeSettings(
  existing: string | null,
): { ok: true; content: string; action: SettingsAction } | { ok: false; error: string } {
  if (existing === null) {
    const fresh: SettingsRoot = {
      hooks: { PostToolUse: [buildHookEntry()] },
    };
    return { ok: true, content: stringifyPretty(fresh), action: "created" };
  }

  const parsed = parseDefensive<SettingsRoot>(existing);
  if (!parsed.ok) {
    return { ok: false, error: `settings.json is malformed: ${parsed.error}` };
  }
  const root = parsed.value;
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return { ok: false, error: "settings.json is not a JSON object" };
  }

  const hooks =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};

  const postToolUse = Array.isArray(hooks["PostToolUse"])
    ? (hooks["PostToolUse"] as SettingsHookEntry[])
    : [];

  if (postToolUse.some(entryReferencesPostEdit)) {
    return { ok: true, content: existing, action: "unchanged" };
  }

  const nextPostToolUse = [...postToolUse, buildHookEntry()];
  const nextHooks = { ...hooks, PostToolUse: nextPostToolUse };
  const nextRoot: SettingsRoot = { ...root, hooks: nextHooks };
  return { ok: true, content: stringifyPretty(nextRoot), action: "updated" };
}

export function installHook(
  opts: InstallHookOptions,
  deps: InstallHookDeps = {},
): InstallHookResult {
  const templatePath = deps.templatePath ?? TEMPLATE_PATH;
  const readFileFn = deps.readFileFn ?? defaultRead;
  const strict = opts.strict ?? false;

  let scriptContent: string;
  try {
    scriptContent = readFileFn(templatePath);
  } catch (err) {
    return {
      ok: false,
      error: "template_read_failed",
      reason: `${templatePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const scriptWrite = safeWriteFile(
    opts.cwd,
    SCRIPT_REL_PATH,
    scriptContent,
    { kind: "hook", strict, mode: 0o755 },
    deps.safeIO,
  );
  if (!scriptWrite.ok) {
    return { ok: false, error: "write_failed", reason: `${SCRIPT_REL_PATH}: ${scriptWrite.error}` };
  }

  const settingsAbs = join(opts.cwd, SETTINGS_REL_PATH);
  const existsFn = deps.safeIO?.existsFn ?? null;
  const settingsReadFn = deps.safeIO?.readFileFn ?? null;
  let existing: string | null = null;
  if (existsFn !== null && settingsReadFn !== null) {
    existing = existsFn(settingsAbs) ? settingsReadFn(settingsAbs) : null;
  } else {
    try {
      existing = readFileSync(settingsAbs, "utf8");
    } catch {
      existing = null;
    }
  }

  const merged = mergeSettings(existing);
  if (!merged.ok) {
    return { ok: false, error: "settings_malformed", reason: merged.error };
  }

  let settingsRecorded = false;
  let settingsPath = SETTINGS_REL_PATH;
  if (merged.action === "unchanged") {
    settingsPath = SETTINGS_REL_PATH;
  } else {
    const settingsWrite = safeWriteFile(
      opts.cwd,
      SETTINGS_REL_PATH,
      merged.content,
      { kind: "settings", merged: true, strict },
      deps.safeIO,
    );
    if (!settingsWrite.ok) {
      return {
        ok: false,
        error: "write_failed",
        reason: `${SETTINGS_REL_PATH}: ${settingsWrite.error}`,
      };
    }
    settingsRecorded = settingsWrite.value.recorded;
    settingsPath = settingsWrite.value.path;
  }

  return {
    ok: true,
    cwd: opts.cwd,
    script: {
      path: scriptWrite.value.path,
      bytes: scriptWrite.value.bytes,
      recorded: scriptWrite.value.recorded,
    },
    settings: {
      path: settingsPath,
      action: merged.action,
      recorded: settingsRecorded,
    },
  };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseInstallHookArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let strict = false;
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
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, strict } };
}

export function runInstallHook(argv: readonly string[]): ExitCode {
  const parsed = parseInstallHookArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-hook [--cwd <path>] [--strict]\n" +
          "\n" +
          "Copies post-edit.sh to .claude/hooks/ and merges a PostToolUse entry\n" +
          "into .claude/settings.json. Idempotent: re-running on a project that\n" +
          "already has the hook is a no-op for the settings file.\n" +
          "Exit codes: 0 ok, 1 write/parse failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-hook", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installHook(parsed.value);
  if (!result.ok) {
    logger.error("install_hook_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_hook_ok", {
    settings_action: result.settings.action,
    script_bytes: result.script.bytes,
  });
  return EXIT_CODES.OK;
}
