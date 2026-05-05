/**
 * Decision-log helpers — single source of truth for marker discipline and
 * entry formatting. Consumed by `rules/add`, `rules/remove`, `recs/apply`,
 * and the upcoming `ignore-*` commands (lint-ignore PLAN T1.2).
 *
 * The on-disk shape of an entry is:
 *
 *   ### {timestamp} — {kind}: {subject}
 *
 *   - **k1**: v1
 *   - **k2**: v2
 *   ...
 *
 * The bullet list is fully caller-controlled so each command can tailor the
 * field set (rules-add has no `recommendation_id`, recs-apply does, ignore-add
 * has `glob`/`expires`, etc) without forcing a union type into the formatter.
 */

export const ENTRIES_START = "<!-- qualy:entries-start -->";
export const ENTRIES_END = "<!-- qualy:entries-end -->";

/** Canonical decision kinds. Free-form strings are accepted to keep the
 * formatter forward-compatible — tests pin specific kinds where required. */
export type DecisionKind =
  | "rule-add"
  | "rule-remove"
  | "rec-apply"
  | "threshold-lower"
  | "coverage-lower"
  | "ignore-add"
  | "ignore-update"
  | "ignore-remove"
  | "ignore-import"
  | "meta:migrate-decision-log";

export interface DecisionEntry {
  readonly timestamp: string;
  readonly kind: DecisionKind | string;
  readonly subject: string;
  /** Ordered key→value bullets rendered as `- **{key}**: {value}`.
   *  Caller controls the full ordering — `kind`, `author`, `reason`, and any
   *  optional fields go here in their intended display order. */
  readonly bullets: ReadonlyArray<readonly [string, string]>;
}

export type DecisionLogResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Format a decision entry to its canonical on-disk shape. */
export function formatDecisionEntry(entry: DecisionEntry): string {
  const lines: string[] = [];
  lines.push(`### ${entry.timestamp} — ${entry.kind}: ${entry.subject}`);
  lines.push("");
  for (const [key, value] of entry.bullets) {
    lines.push(`- **${key}**: ${value}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Insert pre-formatted entry text between the qualy markers. Append-only —
 *  preserves any existing entries between the markers and never deduplicates. */
export function insertEntryBetweenMarkers(
  base: string,
  entryText: string,
): DecisionLogResult {
  const start = base.indexOf(ENTRIES_START);
  const end = base.indexOf(ENTRIES_END);
  if (start === -1 || end === -1 || start >= end) {
    return { ok: false, error: "decisions markers missing or malformed" };
  }
  const startEnd = start + ENTRIES_START.length;
  const head = base.slice(0, startEnd);
  const middle = base.slice(startEnd, end);
  const tail = base.slice(end);

  const trimmedMiddle = middle.replace(/^\s+/, "").replace(/\s+$/, "");
  const sep = "\n\n";
  const newMiddle =
    "\n" +
    (trimmedMiddle.length > 0 ? trimmedMiddle + "\n\n" : "") +
    entryText +
    sep;

  return { ok: true, text: head + newMiddle + tail };
}

/** Format and insert in a single call. Convenience for callers that don't
 *  need the intermediate formatted-text artifact. */
export function appendDecisionEntry(
  base: string,
  entry: DecisionEntry,
): DecisionLogResult {
  return insertEntryBetweenMarkers(base, formatDecisionEntry(entry));
}

/** Load existing decision-log content or fall back to the template at
 *  `templatePath`. Validates marker discipline on existing content. */
export function loadOrInitDecisions(
  current: string | null,
  templatePath: string,
  readFileFn: (p: string) => string | null,
): DecisionLogResult {
  if (current !== null) {
    if (
      current.indexOf(ENTRIES_START) === -1 ||
      current.indexOf(ENTRIES_END) === -1 ||
      current.indexOf(ENTRIES_START) > current.indexOf(ENTRIES_END)
    ) {
      return {
        ok: false,
        error:
          "decision log present but entry markers are missing or out of order",
      };
    }
    return { ok: true, text: current };
  }
  const tpl = readFileFn(templatePath);
  if (tpl === null) {
    return {
      ok: false,
      error: `decisions template not found at ${templatePath}`,
    };
  }
  return { ok: true, text: tpl };
}
