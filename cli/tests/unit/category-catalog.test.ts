/**
 * Contract tests for `lib/category-catalog.ts` (lint-ignore PLAN T3.1).
 *
 * Two layers:
 *   1. Pure shape — KNOWN_CATEGORIES, sorted+deduped rule lists, helper
 *      functions. These pin the on-disk format consumers depend on.
 *   2. Smoke check — installed oxlint major version equals
 *      `OXLINT_PINNED_MAJOR`. Drift here is the trigger for the quarterly
 *      review documented in the catalog header. The test reads
 *      `node_modules/oxlint/package.json` directly so it never spawns the
 *      binary.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type Category,
  getCategoryRules,
  getCategorySize,
  isKnownCategory,
  KNOWN_CATEGORIES,
  OXLINT_PINNED_MAJOR,
} from "../../src/lib/category-catalog.ts";

const EXPECTED_SIZES: Record<Category, number> = {
  correctness: 231,
  suspicious: 55,
  pedantic: 119,
  perf: 13,
  restriction: 93,
  style: 231,
  nursery: 10,
};

describe("category-catalog — shape", () => {
  it("exposes the 7 oxlint categories in canonical order", () => {
    expect(KNOWN_CATEGORIES).toEqual([
      "correctness",
      "suspicious",
      "pedantic",
      "perf",
      "restriction",
      "style",
      "nursery",
    ]);
  });

  it.each(KNOWN_CATEGORIES)(
    "%s has the expected rule count (drift here = quarterly review)",
    (category) => {
      expect(getCategorySize(category)).toBe(EXPECTED_SIZES[category]);
    },
  );

  it.each(KNOWN_CATEGORIES)("%s rules are sorted and unique", (category) => {
    const rules = getCategoryRules(category);
    const sorted = [...rules].sort();
    expect(rules).toEqual(sorted);
    expect(new Set(rules).size).toBe(rules.length);
  });

  it.each(KNOWN_CATEGORIES)(
    "%s rules use the 'plugin/rule-name' shape",
    (category) => {
      const rules = getCategoryRules(category);
      for (const rule of rules) {
        expect(rule).toMatch(/^[a-z][a-z0-9_]*\/[a-z][a-z0-9-]*$/);
      }
    },
  );

  it("getCategorySize matches array length for every category", () => {
    for (const category of KNOWN_CATEGORIES) {
      expect(getCategorySize(category)).toBe(getCategoryRules(category).length);
    }
  });

  it("a rule may appear in multiple plugins/categories — but never twice in the same one", () => {
    for (const category of KNOWN_CATEGORIES) {
      const rules = getCategoryRules(category);
      expect(new Set(rules).size).toBe(rules.length);
    }
  });
});

describe("category-catalog — isKnownCategory", () => {
  it("accepts every entry in KNOWN_CATEGORIES", () => {
    for (const category of KNOWN_CATEGORIES) {
      expect(isKnownCategory(category)).toBe(true);
    }
  });

  it("rejects unknown names", () => {
    expect(isKnownCategory("security")).toBe(false);
    expect(isKnownCategory("CORRECTNESS")).toBe(false);
    expect(isKnownCategory("")).toBe(false);
    expect(isKnownCategory("category:correctness")).toBe(false);
  });
});

describe("category-catalog — smoke pin", () => {
  it("OXLINT_PINNED_MAJOR matches the installed oxlint major version", () => {
    const pkgPath = join(
      process.cwd(),
      "node_modules",
      "oxlint",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    const installedMajor = Number.parseInt(pkg.version.split(".")[0] ?? "", 10);
    expect(installedMajor).toBe(OXLINT_PINNED_MAJOR);
  });
});
