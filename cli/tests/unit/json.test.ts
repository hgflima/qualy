import { describe, expect, it } from "vitest";
import { parseDefensive, stringifyPretty } from "../../src/lib/json.ts";

describe("parseDefensive", () => {
  it("returns ok with parsed value for valid JSON", () => {
    const result = parseDefensive<{ a: number }>('{"a":1}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("returns ok for primitive top-level values", () => {
    expect(parseDefensive("true")).toEqual({ ok: true, value: true });
    expect(parseDefensive("42")).toEqual({ ok: true, value: 42 });
    expect(parseDefensive('"hi"')).toEqual({ ok: true, value: "hi" });
    expect(parseDefensive("null")).toEqual({ ok: true, value: null });
  });

  it("returns ok with null for the JSON literal null", () => {
    const result = parseDefensive("null");
    expect(result).toEqual({ ok: true, value: null });
  });

  it("returns error (does not throw) for malformed JSON", () => {
    const result = parseDefensive("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns error for empty string", () => {
    const result = parseDefensive("");
    expect(result.ok).toBe(false);
  });

  it("returns error for non-string input without throwing", () => {
    const result = parseDefensive(undefined as unknown as string);
    expect(result.ok).toBe(false);
  });
});

describe("stringifyPretty", () => {
  it("formats with 2-space indentation and trailing newline", () => {
    const out = stringifyPretty({ a: 1, b: [2, 3] });
    expect(out).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });

  it("formats primitives", () => {
    expect(stringifyPretty(true)).toBe("true\n");
    expect(stringifyPretty(null)).toBe("null\n");
    expect(stringifyPretty("x")).toBe('"x"\n');
  });

  it("survives circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    const out = stringifyPretty(a);
    expect(typeof out).toBe("string");
    expect(out).toContain('"name": "a"');
    expect(out).toContain("[Circular]");
  });

  it("survives BigInt values without throwing", () => {
    const out = stringifyPretty({ n: 10n });
    expect(out).toContain('"10"');
  });

  it("survives undefined value at top level", () => {
    const out = stringifyPretty(undefined);
    expect(typeof out).toBe("string");
  });

  it("round-trips through parseDefensive for plain objects", () => {
    const value = { a: 1, b: { c: [true, "x", null] } };
    const text = stringifyPretty(value);
    const parsed = parseDefensive<typeof value>(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(value);
  });
});
