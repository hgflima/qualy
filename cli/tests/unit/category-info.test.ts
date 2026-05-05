/**
 * Contract tests for `commands/category-info.ts` (lint-ignore PLAN T3.5).
 *
 * The subcommand is a thin reader over `lib/category-catalog.ts`: it must
 * resolve a known category to `{ category, rules, count }`, reject unknown
 * names with `unknown_category` exit `1`, and accept both bare (`correctness`)
 * and qualified (`category:correctness`) ids so the slash command can pass
 * whatever the user typed.
 */
import { describe, expect, it } from "vitest";

import {
  categoryInfo,
  parseCategoryInfoArgs,
} from "../../src/commands/category-info.ts";
import {
  getCategorySize,
  KNOWN_CATEGORIES,
} from "../../src/lib/category-catalog.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";

describe("categoryInfo — resolution", () => {
  it("returns rules + count for every known category (bare name)", () => {
    for (const cat of KNOWN_CATEGORIES) {
      const result = categoryInfo({ name: cat });
      if (!result.ok) throw new Error(`expected ok for ${cat}`);
      expect(result.category).toBe(cat);
      expect(result.count).toBe(getCategorySize(cat));
      expect(result.rules.length).toBe(result.count);
      expect(result.exitCode).toBe(EXIT_CODES.OK);
    }
  });

  it("accepts the qualified `category:<name>` form (slash command passthrough)", () => {
    const result = categoryInfo({ name: "category:perf" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.category).toBe("perf");
    expect(result.count).toBe(getCategorySize("perf"));
  });

  it("trims whitespace before resolution", () => {
    const result = categoryInfo({ name: "  correctness  " });
    expect(result.ok).toBe(true);
  });

  it("returns the same array instance the catalog holds (read-only)", () => {
    const result = categoryInfo({ name: "perf" });
    if (!result.ok) throw new Error("expected ok");
    // Stable iteration across calls — caller must not mutate.
    const second = categoryInfo({ name: "perf" });
    if (!second.ok) throw new Error("expected ok");
    expect(result.rules).toBe(second.rules);
  });
});

describe("categoryInfo — rejection", () => {
  it("rejects unknown categories with exit 1 and the canonical list", () => {
    const result = categoryInfo({ name: "bogus" });
    if (result.ok) throw new Error("expected error");
    expect(result.error).toBe("unknown_category");
    expect(result.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    for (const cat of KNOWN_CATEGORIES) {
      expect(result.reason).toContain(cat);
    }
  });

  it("rejects empty names", () => {
    const result = categoryInfo({ name: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects qualified-but-unknown categories", () => {
    const result = categoryInfo({ name: "category:bogus" });
    if (result.ok) throw new Error("expected error");
    expect(result.error).toBe("unknown_category");
  });
});

describe("parseCategoryInfoArgs", () => {
  it("accepts a positional name", () => {
    const r = parseCategoryInfoArgs(["correctness"]);
    if (!r.ok) throw new Error(`expected ok: ${r.error}`);
    expect(r.value.name).toBe("correctness");
  });

  it("accepts --name <category>", () => {
    const r = parseCategoryInfoArgs(["--name", "perf"]);
    if (!r.ok) throw new Error(`expected ok: ${r.error}`);
    expect(r.value.name).toBe("perf");
  });

  it("--name takes precedence over positional", () => {
    const r = parseCategoryInfoArgs(["bogus", "--name", "perf"]);
    if (!r.ok) throw new Error(`expected ok: ${r.error}`);
    expect(r.value.name).toBe("perf");
  });

  it("accepts and discards --cwd (parity with other subcommands)", () => {
    const r = parseCategoryInfoArgs(["correctness", "--cwd", "/tmp"]);
    expect(r.ok).toBe(true);
  });

  it("rejects --name without a value", () => {
    const r = parseCategoryInfoArgs(["--name"]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const r = parseCategoryInfoArgs(["correctness", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects calls without a category", () => {
    const r = parseCategoryInfoArgs([]);
    expect(r.ok).toBe(false);
  });

  it("treats --help specially", () => {
    const r = parseCategoryInfoArgs(["--help"]);
    if (r.ok) throw new Error("expected help error");
    expect(r.error).toBe("help");
  });
});
