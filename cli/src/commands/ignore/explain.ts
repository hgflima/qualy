/**
 * `ignore-explain` — read-only inspection of a single ignore entry plus its
 * mutation history (lint-ignore SPEC §3.4, PLAN T2.5).
 *
 * Resolves an entry by `(glob, rule)` (rule defaults to `null` for path-only,
 * mirrors `ignore-remove`). Returns the entry along with every block in
 * `.harn/qualy/docs/lint-decisions.md` whose `- **id**: <id>` bullet matches
 * the resolved entry's id — so `ignore-add` / `ignore-update` / `ignore-remove`
 * / `ignore-import` mutations of that exact `(glob, rule)` are surfaced.
 *
 * Read-only:
 *   - Never mutates the manifest.
 *   - Never edits the decision log.
 *   - Manifest absent / no entries → exit `1` `entry_not_found`.
 *   - Manifest corrupt / unsupported version → exit `70` INTERNAL_ERROR.
 *   - Decision log absent or with marker drift → emits `history: []` (the
 *     entry is still meaningful even when no log file exists).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ENTRIES_END, ENTRIES_START } from "../../lib/decision-log.ts";
import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO } from "../../lib/fs-safe.ts";
import {
  type IgnoreEntry,
  loadIgnoreManifest,
} from "../../lib/ignore-manifest.ts";
import { logger, output } from "../../lib/logger.ts";
import { DECISION_LOG_PATH } from "../../lib/paths.ts";

import { type IgnoreListEntry } from "./list.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuleSelector = string | null | undefined;

export interface IgnoreExplainOptions {
  readonly cwd: string;
  readonly glob: string;
  readonly rule?: RuleSelector;
  readonly now?: Date;
}

export interface DecisionHistoryEntry {
  readonly timestamp: string;
  readonly kind: string;
  readonly subject: string;
  /** Raw markdown block (header + bullets) verbatim from the log. */
  readonly raw: string;
}

export interface IgnoreExplainOk {
  readonly ok: true;
  readonly cwd: string;
  readonly entry: IgnoreListEntry;
  readonly history: readonly DecisionHistoryEntry[];
  readonly exitCode: ExitCode;
}

export interface IgnoreExplainErr {
  readonly ok: false;
  readonly error: string;
  readonly reason: string;
  readonly exitCode: ExitCode;
  readonly candidates?: ReadonlyArray<{
    readonly id: string;
    readonly rule: string | null;
  }>;
}

export type IgnoreExplainResult = IgnoreExplainOk | IgnoreExplainErr;

export interface IgnoreExplainDeps {
  readonly safeIO?: SafeIO;
  readonly readFileFn?: (p: string) => string | null;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Match resolution (mirrors ignore-remove, kept local to avoid coupling)
// ---------------------------------------------------------------------------

function normalizeRuleSelector(rule: RuleSelector): RuleSelector {
  if (rule === undefined) return undefined;
  if (rule === null) return null;
  if (rule === "path" || rule === "(path-only)") return null;
  return rule;
}

interface MatchOk {
  readonly kind: "found";
  readonly entry: IgnoreEntry;
}
interface MatchAmbiguous {
  readonly kind: "ambiguous";
  readonly candidates: ReadonlyArray<{ id: string; rule: string | null }>;
}
type MatchResult = MatchOk | MatchAmbiguous | { readonly kind: "not_found" };

function resolveMatch(
  entries: readonly IgnoreEntry[],
  glob: string,
  selector: RuleSelector,
): MatchResult {
  const byGlob = entries.filter((e) => e.glob === glob);
  if (byGlob.length === 0) return { kind: "not_found" };
  if (selector === undefined) {
    if (byGlob.length === 1) return { kind: "found", entry: byGlob[0]! };
    return {
      kind: "ambiguous",
      candidates: byGlob.map((e) => ({ id: e.id, rule: e.rule })),
    };
  }
  const exact = byGlob.filter((e) => e.rule === selector);
  if (exact.length === 0) return { kind: "not_found" };
  return { kind: "found", entry: exact[0]! };
}

// ---------------------------------------------------------------------------
// Decoration (mirrors list.decorateEntry — kept local to avoid an export web)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function decorateEntry(entry: IgnoreEntry, now: Date): IgnoreListEntry {
  if (entry.expires === null || !ISO_DATE_RE.test(entry.expires)) {
    return { ...entry, status: "active" };
  }
  const expiresMs = Date.parse(`${entry.expires}T00:00:00.000Z`);
  if (!Number.isFinite(expiresMs)) {
    return { ...entry, status: "active" };
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (expiresMs >= today) return { ...entry, status: "active" };
  const days = Math.floor((today - expiresMs) / MS_PER_DAY);
  return { ...entry, status: "expired", days_overdue: days };
}

// ---------------------------------------------------------------------------
// History extraction
// ---------------------------------------------------------------------------

const ENTRY_HEADER_RE = /^### (\S+) — ([^:]+): (.+)$/;
const ID_BULLET_RE = /^- \*\*id\*\*:\s*(\S+)\s*$/m;

/** Parse blocks between `<!-- qualy:entries-start -->` and `<!-- qualy:entries-end -->`,
 *  filter to those whose `- **id**: <x>` bullet matches `entryId`. */
export function extractHistoryForEntry(
  decisionsRaw: string,
  entryId: string,
): readonly DecisionHistoryEntry[] {
  const start = decisionsRaw.indexOf(ENTRIES_START);
  const end = decisionsRaw.indexOf(ENTRIES_END);
  if (start === -1 || end === -1 || start >= end) return [];
  const slice = decisionsRaw.slice(start + ENTRIES_START.length, end);

  // Split into blocks by `\n### ` (each block keeps its own header).
  const blocks: string[] = [];
  const lines = slice.split("\n");
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (current.length > 0) {
        const text = current.join("\n").trim();
        if (text.length > 0) blocks.push(text);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const text = current.join("\n").trim();
    if (text.length > 0) blocks.push(text);
  }

  const out: DecisionHistoryEntry[] = [];
  for (const block of blocks) {
    const idMatch = ID_BULLET_RE.exec(block);
    if (idMatch === null || idMatch[1] !== entryId) continue;
    const headerLine = block.split("\n", 1)[0] ?? "";
    const headerMatch = ENTRY_HEADER_RE.exec(headerLine);
    if (headerMatch === null) continue;
    out.push({
      timestamp: headerMatch[1]!,
      kind: headerMatch[2]!.trim(),
      subject: headerMatch[3]!.trim(),
      raw: block,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function ignoreExplain(
  opts: IgnoreExplainOptions,
  deps: IgnoreExplainDeps = {},
): IgnoreExplainResult {
  const now = deps.now ? deps.now() : opts.now ?? new Date();

  if (typeof opts.glob !== "string" || opts.glob.trim().length === 0) {
    return {
      ok: false,
      error: "invalid_glob",
      reason: "glob is empty",
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const loaded = loadIgnoreManifest(opts.cwd, deps.safeIO);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reason: loaded.reason,
      exitCode: EXIT_CODES.INTERNAL_ERROR,
    };
  }
  if (loaded.manifest === null || loaded.manifest.entries.length === 0) {
    return {
      ok: false,
      error: "entry_not_found",
      reason: `no entries in .harn/qualy/ignore.json (manifest is empty)`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const selector = normalizeRuleSelector(opts.rule);
  const match = resolveMatch(loaded.manifest.entries, opts.glob, selector);
  if (match.kind === "not_found") {
    return {
      ok: false,
      error: "entry_not_found",
      reason:
        selector === undefined
          ? `no entry matches glob "${opts.glob}"`
          : `no entry matches (glob: "${opts.glob}", rule: ${selector === null ? "(path-only)" : selector})`,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: "entry_ambiguous",
      reason: `glob "${opts.glob}" matches ${match.candidates.length} entries; pass --rule to disambiguate (use "--rule path" for the path-only entry)`,
      candidates: match.candidates,
      exitCode: EXIT_CODES.RECOVERABLE_ERROR,
    };
  }

  const entry = decorateEntry(match.entry, now);

  // History: read decision log; missing/markerless → empty list (read-only,
  // no error surfacing — the entry is still useful on its own).
  const readFileFn = deps.readFileFn ?? defaultRead;
  const decisionsAbs = join(opts.cwd, DECISION_LOG_PATH);
  const decisionsRaw = readFileFn(decisionsAbs);
  const history =
    decisionsRaw === null
      ? []
      : extractHistoryForEntry(decisionsRaw, match.entry.id);

  return {
    ok: true,
    cwd: opts.cwd,
    entry,
    history,
    exitCode: EXIT_CODES.OK,
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  readonly cwd: string;
  readonly glob: string;
  readonly rule: RuleSelector;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

export function parseIgnoreExplainArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let glob: string | null = null;
  let positional: string | null = null;
  let rule: RuleSelector = undefined;

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
    if (arg === "--glob") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --glob" };
      }
      glob = value;
      i++;
      continue;
    }
    if (arg === "--rule") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --rule" };
      }
      rule = value;
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

  const resolvedGlob = glob ?? positional;
  if (resolvedGlob === null) {
    return {
      ok: false,
      error: "missing glob (use --glob <pattern> or pass as positional)",
    };
  }

  return {
    ok: true,
    value: { cwd, glob: resolvedGlob, rule },
  };
}

export function runIgnoreExplain(argv: readonly string[]): ExitCode {
  const parsed = parseIgnoreExplainArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy ignore-explain <glob> [--rule <name>|path] [--cwd <path>]\n" +
          "\n" +
          "Shows one entry from .harn/qualy/ignore.json (status, expires,\n" +
          "createdBy, …) plus every matching mutation block from\n" +
          ".harn/qualy/docs/lint-decisions.md filtered by entry id. Read-only.\n" +
          "\n" +
          "Without --rule, the glob must match exactly one entry; ambiguous\n" +
          "matches require --rule (use --rule path to select the path-only\n" +
          "entry).\n" +
          "\n" +
          "Exit codes: 0 ok, 1 entry not found / ambiguous, 4 usage,\n" +
          "  70 manifest corrupt/unsupported version.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "ignore-explain", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = ignoreExplain({
    cwd: parsed.value.cwd,
    glob: parsed.value.glob,
    rule: parsed.value.rule,
  });

  if (!result.ok) {
    logger.error("ignore_explain_failed", { reason: result.reason ?? result.error });
    output({
      ok: false,
      error: result.error,
      reason: result.reason,
      ...(result.candidates ? { candidates: result.candidates } : {}),
    });
    return result.exitCode;
  }

  output({
    ok: true,
    cwd: result.cwd,
    entry: result.entry,
    history: result.history,
  });
  logger.info("ignore_explain_ok", {
    id: result.entry.id,
    history: result.history.length,
  });
  return result.exitCode;
}
