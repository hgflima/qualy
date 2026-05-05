/**
 * Contract tests for `lib/decision-log.ts` — the single source of truth for
 * marker discipline and entry formatting consumed by `rules/add`, `rules/remove`,
 * `recs/apply`, and the upcoming `ignore-*` commands (lint-ignore PLAN T1.2).
 *
 * Byte-exact format is pinned because downstream tooling (auditors, slash
 * commands, future report panels) parses the on-disk shape. The legacy callers
 * keep adapter shims so their existing format tests continue to pass against
 * the generalized formatter.
 */
import { describe, expect, it } from "vitest";

import {
  appendDecisionEntry,
  ENTRIES_END,
  ENTRIES_START,
  formatDecisionEntry,
  insertEntryBetweenMarkers,
  loadOrInitDecisions,
} from "../../src/lib/decision-log.ts";

const ISO = "2026-05-05T12:00:00Z";

const TEMPLATE_BODY = `# Lint decisions

## Entries

${ENTRIES_START}
${ENTRIES_END}
`;

describe("formatDecisionEntry — generic shape", () => {
  it("emits H3 heading + ordered bullets + trailing blank line", () => {
    const text = formatDecisionEntry({
      timestamp: ISO,
      kind: "rule-add",
      subject: "quality-metrics/dit: severity=error, max=4",
      bullets: [
        ["kind", "rule-add"],
        ["rule", "quality-metrics/dit"],
        ["author", "alice@example.com"],
        ["reason", "limit inheritance depth"],
      ],
    });

    expect(text).toBe(
      [
        "### 2026-05-05T12:00:00Z — rule-add: quality-metrics/dit: severity=error, max=4",
        "",
        "- **kind**: rule-add",
        "- **rule**: quality-metrics/dit",
        "- **author**: alice@example.com",
        "- **reason**: limit inheritance depth",
        "",
      ].join("\n"),
    );
  });

  it("preserves bullet ordering provided by the caller", () => {
    const text = formatDecisionEntry({
      timestamp: ISO,
      kind: "rec-apply",
      subject: "wmc",
      bullets: [
        ["kind", "rec-apply"],
        ["rule", "quality-metrics/wmc"],
        ["author", "alice"],
        ["reason", "tighten"],
        ["recommendation_id", "rec-001"],
      ],
    });

    const lines = text.split("\n");
    expect(lines.slice(2, 7).map((l) => l.split(":")[0])).toEqual([
      "- **kind**",
      "- **rule**",
      "- **author**",
      "- **reason**",
      "- **recommendation_id**",
    ]);
  });

  it("supports the meta:migrate-decision-log kind for migration entries", () => {
    const text = formatDecisionEntry({
      timestamp: ISO,
      kind: "meta:migrate-decision-log",
      subject: "moved docs/lint-decisions.md → .harn/qualy/docs/lint-decisions.md",
      bullets: [
        ["kind", "meta:migrate-decision-log"],
        ["from", "docs/lint-decisions.md"],
        ["to", ".harn/qualy/docs/lint-decisions.md"],
      ],
    });

    expect(text).toContain("meta:migrate-decision-log");
    expect(text).toContain("- **from**: docs/lint-decisions.md");
    expect(text).toContain("- **to**: .harn/qualy/docs/lint-decisions.md");
  });
});

describe("insertEntryBetweenMarkers — marker discipline", () => {
  it("inserts into an empty marker window without disturbing surrounding text", () => {
    const entry = formatDecisionEntry({
      timestamp: ISO,
      kind: "ignore-add",
      subject: "src/legacy/**",
      bullets: [
        ["kind", "ignore-add"],
        ["glob", "src/legacy/**"],
        ["author", "alice"],
        ["reason", "imported"],
      ],
    });

    const r = insertEntryBetweenMarkers(TEMPLATE_BODY, entry);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.text.startsWith("# Lint decisions\n")).toBe(true);
    expect(r.text).toContain(ENTRIES_START);
    expect(r.text).toContain(ENTRIES_END);
    expect(r.text.indexOf(ENTRIES_START)).toBeLessThan(r.text.indexOf(entry));
    expect(r.text.indexOf(entry)).toBeLessThan(r.text.indexOf(ENTRIES_END));
  });

  it("returns error when markers are missing or inverted", () => {
    const entry = "### x\n\n- **kind**: y\n";
    expect(insertEntryBetweenMarkers("no markers", entry).ok).toBe(false);
    expect(
      insertEntryBetweenMarkers(`${ENTRIES_END}\n${ENTRIES_START}\n`, entry).ok,
    ).toBe(false);
  });
});

describe("appendDecisionEntry — format + insert in one call", () => {
  it("formats and inserts the entry idempotently across multiple appends", () => {
    const r1 = appendDecisionEntry(TEMPLATE_BODY, {
      timestamp: ISO,
      kind: "ignore-add",
      subject: "a/**",
      bullets: [["kind", "ignore-add"], ["glob", "a/**"]],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = appendDecisionEntry(r1.text, {
      timestamp: "2026-05-06T00:00:00Z",
      kind: "ignore-remove",
      subject: "a/**",
      bullets: [["kind", "ignore-remove"], ["glob", "a/**"]],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    expect(r2.text.indexOf("ignore-add")).toBeLessThan(
      r2.text.indexOf("ignore-remove"),
    );
    expect(r2.text.match(new RegExp(ENTRIES_START, "g"))?.length).toBe(1);
    expect(r2.text.match(new RegExp(ENTRIES_END, "g"))?.length).toBe(1);
  });
});

describe("loadOrInitDecisions — template fallback", () => {
  it("returns existing content when both markers are present and well-ordered", () => {
    const r = loadOrInitDecisions(TEMPLATE_BODY, "/tpl", () => null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(TEMPLATE_BODY);
  });

  it("falls back to template when current is null", () => {
    const r = loadOrInitDecisions(null, "/tpl", (p) => {
      expect(p).toBe("/tpl");
      return TEMPLATE_BODY;
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(TEMPLATE_BODY);
  });

  it("rejects existing content with missing markers", () => {
    const r = loadOrInitDecisions("# decisions\n\nbody\n", "/tpl", () => null);
    expect(r.ok).toBe(false);
  });

  it("rejects existing content with inverted markers", () => {
    const r = loadOrInitDecisions(
      `${ENTRIES_END}\n${ENTRIES_START}\n`,
      "/tpl",
      () => null,
    );
    expect(r.ok).toBe(false);
  });

  it("returns error when template is missing", () => {
    const r = loadOrInitDecisions(null, "/tpl", () => null);
    expect(r.ok).toBe(false);
  });
});
