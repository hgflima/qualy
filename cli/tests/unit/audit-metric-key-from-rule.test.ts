/**
 * Contract tests for `metricKeyFromRule` (PLAN.md T2.3).
 *
 * Locks in that the audit aggregator accepts BOTH `quality-metrics/<rule>`
 * (slash form, used internally and by some ESLint-style outputs) AND
 * `quality-metrics(<rule>)` (parens form, emitted by oxlint 1.62.0 in its
 * JSON `code` field). Without this tolerance, real oxlint diagnostics
 * silently fail to aggregate into `by_metric.*` (Bug B5 in PLAN.md).
 */
import { describe, expect, it } from "vitest";

import { metricKeyFromRule } from "../../src/commands/audit.ts";

describe("metricKeyFromRule — slash form (legacy / ESLint-style)", () => {
  it("maps quality-metrics/wmc → wmc", () => {
    expect(metricKeyFromRule("quality-metrics/wmc")).toBe("wmc");
  });

  it("maps quality-metrics/halstead → halstead", () => {
    expect(metricKeyFromRule("quality-metrics/halstead")).toBe("halstead");
  });

  it("maps quality-metrics/halstead-volume → halstead (legacy alias)", () => {
    expect(metricKeyFromRule("quality-metrics/halstead-volume")).toBe(
      "halstead",
    );
  });

  it("maps quality-metrics/halstead-effort → halstead (legacy alias)", () => {
    expect(metricKeyFromRule("quality-metrics/halstead-effort")).toBe(
      "halstead",
    );
  });

  it("maps quality-metrics/lcom → lcom", () => {
    expect(metricKeyFromRule("quality-metrics/lcom")).toBe("lcom");
  });

  it("maps quality-metrics/cbo → cbo", () => {
    expect(metricKeyFromRule("quality-metrics/cbo")).toBe("cbo");
  });

  it("maps quality-metrics/dit → dit", () => {
    expect(metricKeyFromRule("quality-metrics/dit")).toBe("dit");
  });
});

describe("metricKeyFromRule — parens form (oxlint 1.62.0 JSON output)", () => {
  it("maps quality-metrics(wmc) → wmc", () => {
    expect(metricKeyFromRule("quality-metrics(wmc)")).toBe("wmc");
  });

  it("maps quality-metrics(halstead) → halstead", () => {
    expect(metricKeyFromRule("quality-metrics(halstead)")).toBe("halstead");
  });

  it("maps quality-metrics(halstead-volume) → halstead (legacy alias)", () => {
    expect(metricKeyFromRule("quality-metrics(halstead-volume)")).toBe(
      "halstead",
    );
  });

  it("maps quality-metrics(halstead-effort) → halstead (legacy alias)", () => {
    expect(metricKeyFromRule("quality-metrics(halstead-effort)")).toBe(
      "halstead",
    );
  });

  it("maps quality-metrics(lcom) → lcom", () => {
    expect(metricKeyFromRule("quality-metrics(lcom)")).toBe("lcom");
  });

  it("maps quality-metrics(cbo) → cbo", () => {
    expect(metricKeyFromRule("quality-metrics(cbo)")).toBe("cbo");
  });

  it("maps quality-metrics(dit) → dit", () => {
    expect(metricKeyFromRule("quality-metrics(dit)")).toBe("dit");
  });
});

describe("metricKeyFromRule — non-quality-metrics rules", () => {
  it("returns null for eslint(no-shadow) (parens form, foreign namespace)", () => {
    expect(metricKeyFromRule("eslint(no-shadow)")).toBeNull();
  });

  it("returns null for correctness/no-debugger (slash form, foreign namespace)", () => {
    expect(metricKeyFromRule("correctness/no-debugger")).toBeNull();
  });

  it("returns null for suspicious/no-shadow", () => {
    expect(metricKeyFromRule("suspicious/no-shadow")).toBeNull();
  });

  it("returns null for unknown quality-metrics tail (slash form)", () => {
    expect(metricKeyFromRule("quality-metrics/unknown-rule")).toBeNull();
  });

  it("returns null for unknown quality-metrics tail (parens form)", () => {
    expect(metricKeyFromRule("quality-metrics(unknown-rule)")).toBeNull();
  });
});

describe("metricKeyFromRule — degenerate inputs", () => {
  it("returns null for null", () => {
    expect(metricKeyFromRule(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(metricKeyFromRule("")).toBeNull();
  });

  it("returns null for bare 'wmc' (no namespace)", () => {
    expect(metricKeyFromRule("wmc")).toBeNull();
  });

  it("returns null for parens with empty tail", () => {
    expect(metricKeyFromRule("quality-metrics()")).toBeNull();
  });

  it("returns null for malformed parens (unclosed)", () => {
    expect(metricKeyFromRule("quality-metrics(wmc")).toBeNull();
  });
});
