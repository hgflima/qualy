/**
 * Format contract tests for `docs/lint-decisions.md` entries produced by
 * `rules-add` and `rules-remove` (IMPLEMENTATION_PLAN.md Phase 5 — line 102).
 *
 * The integration tests in `rules-add.test.ts` and `rules-remove.test.ts`
 * exercise idempotency end-to-end (two runs → byte-equal preset and
 * decisions log) and verify the templated log is created when missing /
 * appended to when present. This file complements them by locking the
 * **shape of an entry** at the unit level, so a refactor of the formatter
 * cannot silently change the on-disk format that downstream tooling
 * (auditors, recs apply, the lint decisions docs) all depend on.
 *
 * Three properties pinned here:
 *   1. `formatDecisionEntry` emits an H3 timestamp/kind/subject heading,
 *      a blank line, four labeled bullets in a fixed order
 *      (kind, rule, author, reason), and a trailing blank line.
 *   2. The shape is identical between `rules-add` and `rules-remove`
 *      (same heading skeleton, same bullet labels, same order). Only the
 *      `kind` value differs (`rule-add` vs `rule-remove`).
 *   3. `insertEntryBetweenMarkers` is idempotent against re-application:
 *      inserting the same entry twice yields two distinct entries (it is
 *      append-only, not dedup), but inserting into a trimmed-empty marker
 *      window vs. a populated one preserves prior content and never
 *      drops the markers themselves.
 */
import { describe, expect, it } from "vitest";

import {
  formatDecisionEntry as formatAddEntry,
  insertEntryBetweenMarkers,
  ENTRIES_END,
  ENTRIES_START,
} from "../../src/commands/rules/add.ts";
import { formatDecisionEntry as formatRemoveEntry } from "../../src/commands/rules/remove.ts";

const ISO = "2026-05-03T12:00:00Z";

// ---------------------------------------------------------------------------
// formatDecisionEntry — exact-byte contract
// ---------------------------------------------------------------------------

describe("formatDecisionEntry — rule-add exact bytes", () => {
  it("emits H3 heading + four ordered bullets + trailing blank line", () => {
    const text = formatAddEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "quality-metrics/dit: severity=error, max=4",
      rule: "quality-metrics/dit",
      author: "alice@example.com",
      reason: "limit inheritance depth",
    });

    expect(text).toBe(
      [
        "### 2026-05-03T12:00:00Z — rule-add: quality-metrics/dit: severity=error, max=4",
        "",
        "- **kind**: rule-add",
        "- **rule**: quality-metrics/dit",
        "- **author**: alice@example.com",
        "- **reason**: limit inheritance depth",
        "",
      ].join("\n"),
    );
  });

  it("preserves user-provided reason verbatim (no escaping, no truncation)", () => {
    const reason = "tightening: see PR #1234 — discussed w/ @bob";
    const text = formatAddEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "category:correctness: severity=error",
      rule: "category:correctness",
      author: "alice@example.com",
      reason,
    });
    expect(text).toContain(`- **reason**: ${reason}`);
  });
});

describe("formatDecisionEntry — rule-remove exact bytes", () => {
  it("emits same skeleton with `rule-remove` kind and `(was ...)` subject", () => {
    const text = formatRemoveEntry({
      timestamp: ISO,
      kind: "rule-remove",
      subject: "quality-metrics/dit (was severity=error, max=4)",
      rule: "quality-metrics/dit",
      author: "alice@example.com",
      reason: "false positives on test fixtures",
    });

    expect(text).toBe(
      [
        "### 2026-05-03T12:00:00Z — rule-remove: quality-metrics/dit (was severity=error, max=4)",
        "",
        "- **kind**: rule-remove",
        "- **rule**: quality-metrics/dit",
        "- **author**: alice@example.com",
        "- **reason**: false positives on test fixtures",
        "",
      ].join("\n"),
    );
  });
});

describe("formatDecisionEntry — cross-command structural equivalence", () => {
  it("add and remove share the same line skeleton (header + 4 bullets + blank)", () => {
    // Same fields except `kind`; the skeleton (number of lines, ordering of
    // bullets, blank-line discipline) must match exactly.
    const baseFields = {
      timestamp: ISO,
      subject: "quality-metrics/wmc",
      rule: "quality-metrics/wmc",
      author: "alice@example.com",
      reason: "x",
    };
    const addLines = formatAddEntry({ ...baseFields, kind: "rule-add" }).split("\n");
    const removeLines = formatRemoveEntry({ ...baseFields, kind: "rule-remove" }).split("\n");

    expect(addLines.length).toBe(removeLines.length);
    expect(addLines.length).toBe(7); // H3, "", 4× bullet, ""

    // Heading prefix (timestamp + kind + subject) — only the kind differs.
    expect(addLines[0]).toBe(`### ${ISO} — rule-add: quality-metrics/wmc`);
    expect(removeLines[0]).toBe(`### ${ISO} — rule-remove: quality-metrics/wmc`);

    // Bullet labels must match position-by-position.
    const addLabels = addLines.slice(2, 6).map((l) => l.replace(/:.*/, ""));
    const removeLabels = removeLines.slice(2, 6).map((l) => l.replace(/:.*/, ""));
    expect(addLabels).toEqual([
      "- **kind**",
      "- **rule**",
      "- **author**",
      "- **reason**",
    ]);
    expect(removeLabels).toEqual(addLabels);

    // Trailing blank.
    expect(addLines[addLines.length - 1]).toBe("");
    expect(removeLines[removeLines.length - 1]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// insertEntryBetweenMarkers — append-only contract
// ---------------------------------------------------------------------------

const TEMPLATE_BODY = `# Lint decisions

## Entries

${ENTRIES_START}
${ENTRIES_END}
`;

describe("insertEntryBetweenMarkers — marker discipline", () => {
  it("inserts into an empty marker window without disturbing surrounding text", () => {
    const entry = formatAddEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "category:correctness: severity=error",
      rule: "category:correctness",
      author: "alice@example.com",
      reason: "default",
    });

    const r = insertEntryBetweenMarkers(TEMPLATE_BODY, entry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.text.startsWith("# Lint decisions\n")).toBe(true);
    expect(r.text.endsWith("\n")).toBe(true);
    expect(r.text).toContain(ENTRIES_START);
    expect(r.text).toContain(ENTRIES_END);
    expect(r.text.indexOf(ENTRIES_START)).toBeLessThan(r.text.indexOf(entry));
    expect(r.text.indexOf(entry)).toBeLessThan(r.text.indexOf(ENTRIES_END));
  });

  it("is append-only: re-inserting the same entry yields two copies", () => {
    // The command-level idempotency test (rules-add/remove integration) prevents
    // duplicate writes when the preset state matches; the marker helper itself
    // is intentionally append-only — it does not dedup. Pin that here so a
    // future "smart" dedup change cannot mask a missing command-level idempotency
    // check.
    const entry = formatAddEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "x: severity=warn",
      rule: "x",
      author: "alice@example.com",
      reason: "first",
    });

    const first = insertEntryBetweenMarkers(TEMPLATE_BODY, entry);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = insertEntryBetweenMarkers(first.text, entry);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const occurrences = second.text.split(entry).length - 1;
    expect(occurrences).toBe(2);
  });

  it("preserves prior entries when appending a new one", () => {
    const first = formatAddEntry({
      timestamp: "2026-04-01T00:00:00Z",
      kind: "rule-add",
      subject: "a: severity=warn",
      rule: "a",
      author: "alice@example.com",
      reason: "older",
    });
    const second = formatRemoveEntry({
      timestamp: "2026-05-03T12:00:00Z",
      kind: "rule-remove",
      subject: "a (was severity=warn)",
      rule: "a",
      author: "alice@example.com",
      reason: "newer",
    });

    const after1 = insertEntryBetweenMarkers(TEMPLATE_BODY, first);
    expect(after1.ok).toBe(true);
    if (!after1.ok) return;
    const after2 = insertEntryBetweenMarkers(after1.text, second);
    expect(after2.ok).toBe(true);
    if (!after2.ok) return;

    // Both entries present, in chronological insertion order.
    expect(after2.text).toContain("rule-add: a:");
    expect(after2.text).toContain("rule-remove: a ");
    expect(after2.text.indexOf("rule-add: a:")).toBeLessThan(
      after2.text.indexOf("rule-remove: a "),
    );
    // Markers still bracket the entries.
    const startIdx = after2.text.indexOf(ENTRIES_START);
    const endIdx = after2.text.indexOf(ENTRIES_END);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(after2.text.indexOf("rule-add: a:")).toBeGreaterThan(startIdx);
    expect(after2.text.indexOf("rule-remove: a ")).toBeLessThan(endIdx);
  });

  it("returns an error when markers are missing or inverted", () => {
    const entry = formatAddEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "x: severity=warn",
      rule: "x",
      author: "alice@example.com",
      reason: "r",
    });

    const noMarkers = insertEntryBetweenMarkers("# decisions\n\nbody\n", entry);
    expect(noMarkers.ok).toBe(false);

    const inverted = insertEntryBetweenMarkers(
      `${ENTRIES_END}\n${ENTRIES_START}\n`,
      entry,
    );
    expect(inverted.ok).toBe(false);
  });
});
