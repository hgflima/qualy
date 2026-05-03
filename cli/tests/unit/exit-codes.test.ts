import { describe, expect, it } from "vitest";
import { EXIT_CODES, exitCodeName } from "../../src/lib/exit-codes.ts";

describe("exit-codes", () => {
  it("documents the canonical codes from PLAN.md §Princípios", () => {
    expect(EXIT_CODES.OK).toBe(0);
    expect(EXIT_CODES.RECOVERABLE_ERROR).toBe(1);
    expect(EXIT_CODES.UNSUPPORTED_STACK).toBe(2);
    expect(EXIT_CODES.DIRTY_TREE).toBe(3);
  });

  it("assigns unique values to every named code", () => {
    const values = Object.values(EXIT_CODES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("OK is always zero", () => {
    expect(EXIT_CODES.OK).toBe(0);
  });

  it("non-OK codes are non-zero", () => {
    for (const [name, value] of Object.entries(EXIT_CODES)) {
      if (name === "OK") continue;
      expect(value).not.toBe(0);
    }
  });

  it("exitCodeName returns the symbolic name for known codes", () => {
    expect(exitCodeName(0)).toBe("OK");
    expect(exitCodeName(2)).toBe("UNSUPPORTED_STACK");
    expect(exitCodeName(3)).toBe("DIRTY_TREE");
  });

  it("exitCodeName returns UNKNOWN for unmapped codes", () => {
    expect(exitCodeName(999)).toBe("UNKNOWN");
  });
});
