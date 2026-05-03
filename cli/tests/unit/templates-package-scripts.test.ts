/**
 * package-scripts.json template contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §7.1).
 *
 * The template at `cli/src/templates/package-scripts.json` is a static
 * snippet consumed by `install-scripts.ts` (Phase 2) when wiring the
 * four canonical scripts into the target project's `package.json#scripts`:
 *
 *   - lint       → fast oxlint pass (correctness + suspicious)
 *   - lint:deep  → deep oxlint pass (quality-metrics, slower)
 *   - format     → oxfmt in write mode
 *   - coverage   → runner-specific (vitest|jest) — picked at install
 *                  time from `coverage_by_runner`; omitted entirely when
 *                  no runner is detected.
 *
 * SPEC §7.1 acceptance lists `lint`, `lint:deep`, `format`, `coverage`
 * by name; the bodies must reference the presets and tools that the
 * other Phase 2 install-* commands emit (`oxlint.fast.json`,
 * `oxlint.deep.json`, `oxfmt`).
 *
 * These tests lock the contract so install-scripts can rely on a
 * stable shape, and so any future drift in tool names or preset paths
 * fails here before reaching a user's project.
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
  "package-scripts.json",
);

interface TemplateShape {
  _comment: string;
  scripts: Record<string, string>;
  coverage_by_runner: Record<string, string>;
}

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

function parseTemplate(): TemplateShape {
  return JSON.parse(readTemplate()) as TemplateShape;
}

describe("templates/package-scripts.json — file hygiene", () => {
  it("is valid JSON", () => {
    expect(() => parseTemplate()).not.toThrow();
  });

  it("uses LF line endings and ends with a trailing newline", () => {
    const text = readTemplate();
    expect(text).not.toMatch(/\r\n/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("has no UTF-8 BOM", () => {
    const text = readTemplate();
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("templates/package-scripts.json — top-level shape", () => {
  it("has exactly _comment, scripts, and coverage_by_runner keys", () => {
    const tpl = parseTemplate();
    expect(Object.keys(tpl).sort()).toEqual([
      "_comment",
      "coverage_by_runner",
      "scripts",
    ]);
  });

  it("declares qualy provenance and references SPEC §7.1 in _comment", () => {
    const tpl = parseTemplate();
    expect(tpl._comment).toMatch(/qualy/);
    expect(tpl._comment).toMatch(/SPEC §7\.1/);
    expect(tpl._comment).toMatch(/install-scripts/);
  });

  it("scripts is a non-empty object of string commands", () => {
    const tpl = parseTemplate();
    expect(typeof tpl.scripts).toBe("object");
    expect(tpl.scripts).not.toBeNull();
    for (const value of Object.values(tpl.scripts)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("coverage_by_runner is a non-empty object of string commands", () => {
    const tpl = parseTemplate();
    expect(typeof tpl.coverage_by_runner).toBe("object");
    expect(tpl.coverage_by_runner).not.toBeNull();
    for (const value of Object.values(tpl.coverage_by_runner)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("templates/package-scripts.json — scripts contract (SPEC §7.1)", () => {
  it("declares exactly the three runner-agnostic scripts", () => {
    const tpl = parseTemplate();
    expect(Object.keys(tpl.scripts).sort()).toEqual([
      "format",
      "lint",
      "lint:deep",
    ]);
  });

  it("'lint' invokes oxlint with the fast preset", () => {
    const tpl = parseTemplate();
    expect(tpl.scripts.lint).toMatch(/^oxlint /);
    expect(tpl.scripts.lint).toMatch(/--config oxlint\.fast\.json\b/);
    expect(tpl.scripts.lint).not.toMatch(/oxlint\.deep\.json/);
  });

  it("'lint:deep' invokes oxlint with the deep preset", () => {
    const tpl = parseTemplate();
    expect(tpl.scripts["lint:deep"]).toMatch(/^oxlint /);
    expect(tpl.scripts["lint:deep"]).toMatch(/--config oxlint\.deep\.json\b/);
    expect(tpl.scripts["lint:deep"]).not.toMatch(/oxlint\.fast\.json/);
  });

  it("'format' invokes oxfmt in write mode", () => {
    const tpl = parseTemplate();
    expect(tpl.scripts.format).toMatch(/^oxfmt\b/);
    expect(tpl.scripts.format).toMatch(/--write\b/);
  });

  it("does not declare a static 'coverage' script (runner-resolved at install time)", () => {
    const tpl = parseTemplate();
    expect(tpl.scripts).not.toHaveProperty("coverage");
  });
});

describe("templates/package-scripts.json — coverage_by_runner contract (SPEC §3 / §7.1)", () => {
  it("supports exactly the two SPEC §3 runners (vitest, jest)", () => {
    const tpl = parseTemplate();
    expect(Object.keys(tpl.coverage_by_runner).sort()).toEqual([
      "jest",
      "vitest",
    ]);
  });

  it("'vitest' uses 'vitest run --coverage'", () => {
    const tpl = parseTemplate();
    expect(tpl.coverage_by_runner.vitest).toBe("vitest run --coverage");
  });

  it("'jest' uses 'jest --coverage'", () => {
    const tpl = parseTemplate();
    expect(tpl.coverage_by_runner.jest).toBe("jest --coverage");
  });

  it("does not declare a fallback for runner='none' (install-scripts must omit coverage script)", () => {
    const tpl = parseTemplate();
    expect(tpl.coverage_by_runner).not.toHaveProperty("none");
    expect(tpl.coverage_by_runner).not.toHaveProperty("default");
  });
});
