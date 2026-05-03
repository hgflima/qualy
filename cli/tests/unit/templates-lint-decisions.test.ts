/**
 * lint-decisions.md.tpl template contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §4 + §6).
 *
 * The template at `cli/src/templates/lint-decisions.md.tpl` is copied
 * byte-for-byte into `<target>/docs/lint-decisions.md` by the install
 * flow. After that, the CLI appends entries between two marker lines
 * (`<!-- qualy:entries-start -->` / `<!-- qualy:entries-end -->`) every
 * time a user adds/removes a rule, applies a recommendation, or lowers
 * a coverage threshold (SPEC §4 line 315 + §6 lines 389, 423, 462).
 *
 * These tests lock the immutable surface of the *initial* file:
 *   - the H1 title, the append-only intent, and the field list match
 *     SPEC §4 line 315 ("data, rule, motivo, autor")
 *   - the marker pair exists exactly once each, in start→end order, and
 *     the region between them is empty (CLI guarantees idempotent
 *     appends only when this is the case at install time)
 *   - the kinds enumerated in the entry-shape stub cover every event
 *     the SPEC requires logging
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "templates",
  "lint-decisions.md.tpl",
);

const ENTRIES_START = "<!-- qualy:entries-start -->";
const ENTRIES_END = "<!-- qualy:entries-end -->";

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

describe("templates/lint-decisions.md.tpl — header and intent", () => {
  it("opens with the canonical H1 title", () => {
    const text = readTemplate();
    expect(text).toMatch(/^# Lint decisions\b/m);
  });

  it("declares append-only semantics explicitly", () => {
    const text = readTemplate();
    expect(text.toLowerCase()).toContain("append-only");
    expect(text.toLowerCase()).toMatch(/never edit|do not (move|duplicate|remove|edit)/);
  });

  it("documents the four required entry fields from SPEC §4", () => {
    const text = readTemplate();
    // SPEC §4 line 315: "registra data, rule, motivo, autor"
    expect(text).toMatch(/\btimestamp\b/i);
    expect(text).toMatch(/\bauthor\b/i);
    expect(text).toMatch(/\breason\b/i);
    expect(text).toMatch(/\brule\b/i);
  });

  it("anchors the timestamp format to ISO-8601 UTC", () => {
    const text = readTemplate();
    expect(text).toMatch(/ISO-?8601/i);
    expect(text).toMatch(/YYYY-MM-DDTHH:MM:SSZ/);
  });

  it("anchors the author field to `git config user.email`", () => {
    const text = readTemplate();
    expect(text).toMatch(/git config user\.email/);
  });

  it("anchors the reason field to AskUserQuestion capture", () => {
    const text = readTemplate();
    expect(text).toMatch(/AskUserQuestion/);
  });
});

describe("templates/lint-decisions.md.tpl — entry-region markers", () => {
  it("contains exactly one start marker and one end marker", () => {
    const text = readTemplate();
    const startMatches = text.match(new RegExp(escapeRegex(ENTRIES_START), "g")) ?? [];
    const endMatches = text.match(new RegExp(escapeRegex(ENTRIES_END), "g")) ?? [];
    expect(startMatches).toHaveLength(1);
    expect(endMatches).toHaveLength(1);
  });

  it("orders the start marker strictly before the end marker", () => {
    const text = readTemplate();
    const startIdx = text.indexOf(ENTRIES_START);
    const endIdx = text.indexOf(ENTRIES_END);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("leaves the entries region empty (whitespace only) at install time", () => {
    const text = readTemplate();
    const startIdx = text.indexOf(ENTRIES_START) + ENTRIES_START.length;
    const endIdx = text.indexOf(ENTRIES_END);
    const between = text.slice(startIdx, endIdx);
    expect(between.trim()).toBe("");
  });

  it("places the markers after an `## Entries` heading", () => {
    const text = readTemplate();
    const headingIdx = text.indexOf("## Entries");
    const startIdx = text.indexOf(ENTRIES_START);
    expect(headingIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(headingIdx);
  });
});

describe("templates/lint-decisions.md.tpl — entry-shape stub", () => {
  it("enumerates every kind the SPEC requires logging", () => {
    const text = readTemplate();
    // SPEC §4/§6 require logging at least: rule add, rule remove,
    // recommendation apply, coverage threshold lower. Threshold raise
    // is included for symmetry with §6 acceptance flow.
    for (const kind of [
      "rule-add",
      "rule-remove",
      "threshold-raise",
      "threshold-lower",
      "coverage-lower",
      "rec-apply",
    ]) {
      expect(text).toContain(kind);
    }
  });

  it("uses an H3 heading template for entries", () => {
    const text = readTemplate();
    expect(text).toMatch(/### <timestamp> — <kind>: <subject>/);
  });
});

describe("templates/lint-decisions.md.tpl — file hygiene", () => {
  it("is plain UTF-8 without a BOM", () => {
    const buf = readFileSync(TEMPLATE_PATH);
    expect(buf[0]).not.toBe(0xef);
    expect(buf[1]).not.toBe(0xbb);
    expect(buf[2]).not.toBe(0xbf);
  });

  it("uses LF line endings (no CRLF)", () => {
    const text = readTemplate();
    expect(text).not.toMatch(/\r\n/);
  });

  it("ends with a trailing newline", () => {
    const text = readTemplate();
    expect(text.endsWith("\n")).toBe(true);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
