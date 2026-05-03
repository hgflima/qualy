import { describe, expect, it } from "vitest";

import {
  applyVitestCoverage,
  findDefaultExportObject,
  parseConfigSource,
  readObjectPath,
  readVitestThresholds,
  serializeValue,
  setObjectPath,
  VITEST_THRESHOLD_KEYS,
} from "../../src/lib/ts-config-edit.ts";

const fence = (s: string): string => s.replace(/^\n/, "");

describe("parseConfigSource", () => {
  it("parses valid TS source into an in-memory project", () => {
    const r = parseConfigSource("export default { a: 1 };\n");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sourceFile.getFullText()).toContain("export default");
    }
  });

  it("does not throw on garbage text — ts-morph parses defensively", () => {
    const r = parseConfigSource("@@@ this is not ts at all");
    expect(r.ok).toBe(true);
  });
});

describe("findDefaultExportObject", () => {
  it("locates `export default { … }` directly", () => {
    const r = parseConfigSource("export default { test: { coverage: {} } };\n");
    if (!r.ok) throw new Error("parse failed");
    const obj = findDefaultExportObject(r.value.sourceFile);
    expect(obj).not.toBeNull();
    expect(obj?.getProperties().length).toBe(1);
  });

  it("unwraps `export default defineConfig({ … })`", () => {
    const r = parseConfigSource(
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n`,
    );
    if (!r.ok) throw new Error("parse failed");
    const obj = findDefaultExportObject(r.value.sourceFile);
    expect(obj).not.toBeNull();
    expect(obj?.getProperty("test")).toBeDefined();
  });

  it("unwraps `as const`", () => {
    const r = parseConfigSource("export default { x: 1 } as const;\n");
    if (!r.ok) throw new Error("parse failed");
    const obj = findDefaultExportObject(r.value.sourceFile);
    expect(obj).not.toBeNull();
  });

  it("unwraps `(…)` parens", () => {
    const r = parseConfigSource("export default ({ x: 1 });\n");
    if (!r.ok) throw new Error("parse failed");
    const obj = findDefaultExportObject(r.value.sourceFile);
    expect(obj).not.toBeNull();
  });

  it("returns null when there is no default export", () => {
    const r = parseConfigSource("export const config = { x: 1 };\n");
    if (!r.ok) throw new Error("parse failed");
    expect(findDefaultExportObject(r.value.sourceFile)).toBeNull();
  });

  it("returns null when default export is not an object literal (e.g. identifier)", () => {
    const r = parseConfigSource(
      "const cfg = { x: 1 };\nexport default cfg;\n",
    );
    if (!r.ok) throw new Error("parse failed");
    expect(findDefaultExportObject(r.value.sourceFile)).toBeNull();
  });

  it("returns null for a function call with no arguments", () => {
    const r = parseConfigSource("export default defineConfig();\n");
    if (!r.ok) throw new Error("parse failed");
    expect(findDefaultExportObject(r.value.sourceFile)).toBeNull();
  });

  it("returns null for a function call whose first arg is not an object literal", () => {
    const r = parseConfigSource("export default defineConfig(myCfg);\n");
    if (!r.ok) throw new Error("parse failed");
    expect(findDefaultExportObject(r.value.sourceFile)).toBeNull();
  });
});

describe("readObjectPath", () => {
  function obj(text: string) {
    const r = parseConfigSource(`export default ${text};\n`);
    if (!r.ok) throw new Error("parse failed");
    const o = findDefaultExportObject(r.value.sourceFile);
    if (!o) throw new Error("no default object");
    return o;
  }

  it("reads a leaf string", () => {
    expect(readObjectPath(obj(`{ a: "hi" }`), ["a"])).toBe("hi");
  });

  it("reads a leaf number, boolean, null", () => {
    const o = obj(`{ n: 42, b: true, z: null }`);
    expect(readObjectPath(o, ["n"])).toBe(42);
    expect(readObjectPath(o, ["b"])).toBe(true);
    expect(readObjectPath(o, ["z"])).toBeNull();
  });

  it("reads negative numeric literals", () => {
    expect(readObjectPath(obj(`{ n: -7 }`), ["n"])).toBe(-7);
  });

  it("reads no-substitution template literals as strings", () => {
    expect(readObjectPath(obj("{ a: `hi` }"), ["a"])).toBe("hi");
  });

  it("reads nested object paths", () => {
    const o = obj(`{ test: { coverage: { thresholds: { lines: 90 } } } }`);
    expect(
      readObjectPath(o, ["test", "coverage", "thresholds", "lines"]),
    ).toBe(90);
  });

  it("reads a leaf array of literals", () => {
    expect(readObjectPath(obj(`{ r: ["a", "b"] }`), ["r"])).toEqual(["a", "b"]);
  });

  it("reads a leaf object as a plain JS object", () => {
    expect(
      readObjectPath(obj(`{ t: { lines: 90, functions: 80 } }`), ["t"]),
    ).toEqual({ lines: 90, functions: 80 });
  });

  it("returns undefined when a path segment is missing", () => {
    expect(readObjectPath(obj(`{ a: 1 }`), ["b"])).toBeUndefined();
  });

  it("returns undefined when a non-leaf segment is not an object literal", () => {
    expect(readObjectPath(obj(`{ a: 1 }`), ["a", "b"])).toBeUndefined();
  });

  it("returns undefined when the leaf is a non-literal (identifier)", () => {
    expect(readObjectPath(obj(`{ a: someVar }`), ["a"])).toBeUndefined();
  });

  it("returns undefined when the property is a shorthand assignment", () => {
    expect(readObjectPath(obj(`{ x }`), ["x"])).toBeUndefined();
  });

  it("returns undefined when the property is a spread", () => {
    expect(readObjectPath(obj(`{ ...other, a: 1 }`), ["other"])).toBeUndefined();
  });
});

describe("setObjectPath", () => {
  function withObj(text: string, fn: (o: ReturnType<typeof findDefaultExportObject>) => void) {
    const r = parseConfigSource(`export default ${text};\n`);
    if (!r.ok) throw new Error("parse failed");
    const o = findDefaultExportObject(r.value.sourceFile);
    if (!o) throw new Error("no default object");
    fn(o);
    return r.value.sourceFile.getFullText();
  }

  it("adds a missing leaf", () => {
    const out = withObj(`{ a: 1 }`, (o) => {
      const r = setObjectPath(o!, ["b"], "2");
      expect(r.ok && r.value.replaced === false).toBe(true);
    });
    expect(out).toContain("b: 2");
  });

  it("replaces an existing leaf", () => {
    const out = withObj(`{ a: 1 }`, (o) => {
      const r = setObjectPath(o!, ["a"], "9");
      expect(r.ok && r.value.replaced === true).toBe(true);
    });
    expect(out).toContain("a: 9");
    expect(out).not.toContain("a: 1");
  });

  it("creates missing intermediate object literals", () => {
    const out = withObj(`{ }`, (o) => {
      const r = setObjectPath(o!, ["test", "coverage", "lines"], "90");
      expect(r.ok).toBe(true);
    });
    // Loose match: ensure the leaf and intermediates exist somewhere in output.
    expect(out).toMatch(/test\s*:/);
    expect(out).toMatch(/coverage\s*:/);
    expect(out).toMatch(/lines\s*:\s*90/);
  });

  it("merges into an existing intermediate object literal", () => {
    const out = withObj(`{ test: { setupFiles: ["x"] } }`, (o) => {
      const r = setObjectPath(o!, ["test", "globals"], "true");
      expect(r.ok).toBe(true);
    });
    expect(out).toContain('setupFiles: ["x"]');
    expect(out).toMatch(/globals\s*:\s*true/);
  });

  it("rejects an empty path", () => {
    withObj(`{ a: 1 }`, (o) => {
      const r = setObjectPath(o!, [], "1");
      expect(r.ok).toBe(false);
    });
  });

  it("errors when an intermediate exists but is not an object literal", () => {
    withObj(`{ a: 1 }`, (o) => {
      const r = setObjectPath(o!, ["a", "b"], "2");
      expect(r.ok).toBe(false);
    });
  });

  it("errors when an intermediate exists but is a function call", () => {
    withObj(`{ a: someFn() }`, (o) => {
      const r = setObjectPath(o!, ["a", "b"], "2");
      expect(r.ok).toBe(false);
    });
  });
});

describe("serializeValue", () => {
  it("serializes primitives", () => {
    expect(serializeValue("hi")).toBe('"hi"');
    expect(serializeValue(42)).toBe("42");
    expect(serializeValue(true)).toBe("true");
    expect(serializeValue(false)).toBe("false");
    expect(serializeValue(null)).toBe("null");
    expect(serializeValue(-3.14)).toBe("-3.14");
  });

  it("escapes strings via JSON.stringify rules", () => {
    expect(serializeValue('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(serializeValue("a\nb")).toBe('"a\\nb"');
  });

  it("serializes arrays of primitives", () => {
    expect(serializeValue([1, "x", true])).toBe('[1, "x", true]');
    expect(serializeValue([])).toBe("[]");
  });

  it("serializes plain objects with unquoted identifier keys", () => {
    expect(serializeValue({ lines: 90, functions: 80 })).toBe(
      "{ lines: 90, functions: 80 }",
    );
  });

  it("quotes non-identifier object keys", () => {
    expect(serializeValue({ "weird-key": 1, "@scope/x": 2 })).toBe(
      '{ "weird-key": 1, "@scope/x": 2 }',
    );
  });

  it("serializes nested structures", () => {
    expect(
      serializeValue({
        coverage: { provider: "v8", thresholds: { lines: 90 } },
      }),
    ).toBe(
      '{ coverage: { provider: "v8", thresholds: { lines: 90 } } }',
    );
  });

  it("emits {} for empty objects", () => {
    expect(serializeValue({})).toBe("{}");
  });

  it("throws on non-finite numbers", () => {
    expect(() => serializeValue(Infinity)).toThrow();
    expect(() => serializeValue(NaN)).toThrow();
  });

  it("throws on unsupported types (function)", () => {
    expect(() => serializeValue(() => 1)).toThrow();
  });
});

describe("readVitestThresholds", () => {
  it("returns null when there is no default export", () => {
    expect(readVitestThresholds("export const x = 1;\n")).toBeNull();
  });

  it("returns null when the config has no test.coverage.thresholds", () => {
    const src = `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n`;
    expect(readVitestThresholds(src)).toBeNull();
  });

  it("returns null when thresholds exists but has no numeric known keys", () => {
    const src = `export default { test: { coverage: { thresholds: { autoUpdate: true } } } };\n`;
    expect(readVitestThresholds(src)).toBeNull();
  });

  it("reads the four known threshold keys", () => {
    const src = `export default {
  test: {
    coverage: {
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 }
    }
  }
};
`;
    expect(readVitestThresholds(src)).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
  });

  it("returns the subset of numeric keys present", () => {
    const src = `export default {
  test: { coverage: { thresholds: { lines: 60, functions: 70 } } }
};
`;
    expect(readVitestThresholds(src)).toEqual({ lines: 60, functions: 70 });
  });

  it("ignores non-numeric values for known keys", () => {
    const src = `export default {
  test: { coverage: { thresholds: { lines: "high", functions: 80 } } }
};
`;
    expect(readVitestThresholds(src)).toEqual({ functions: 80 });
  });

  it("works through a defineConfig() wrapper", () => {
    const src = `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { coverage: { thresholds: { lines: 50 } } }
});
`;
    expect(readVitestThresholds(src)).toEqual({ lines: 50 });
  });
});

describe("applyVitestCoverage", () => {
  it("creates the full nested chain in an empty config", () => {
    const before = `export default {};\n`;
    const r = applyVitestCoverage(before, {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(true);
    expect(readVitestThresholds(r.value.content)).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
  });

  it("merges into an existing test.coverage block, preserving siblings", () => {
    const before = `export default {
  test: {
    setupFiles: ["./test-setup.ts"],
    coverage: {
      provider: "istanbul",
      exclude: ["dist/**"],
      thresholds: { lines: 60, functions: 60 }
    }
  }
};
`;
    const r = applyVitestCoverage(before, {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(true);
    expect(r.value.content).toContain('setupFiles: ["./test-setup.ts"]');
    expect(r.value.content).toContain('exclude: ["dist/**"]');
    expect(readVitestThresholds(r.value.content)).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
  });

  it("preserves leading and inline comments", () => {
    const before = `import { defineConfig } from "vitest/config";

// keep me as banner
export default defineConfig({
  test: {
    // existing inline note
    setupFiles: ["./test-setup.ts"]
  }
});
`;
    const r = applyVitestCoverage(before, {
      thresholds: { lines: 90 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.content).toContain("// keep me as banner");
    expect(r.value.content).toContain("// existing inline note");
    expect(readVitestThresholds(r.value.content)).toEqual({ lines: 90 });
  });

  it("is a no-op (changed=false) when all leaves already carry desired values", () => {
    const before = `export default {
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 }
    }
  }
};
`;
    const r = applyVitestCoverage(before, {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(false);
    // text should be byte-identical to the input
    expect(r.value.content).toBe(before);
  });

  it("changed=true when reporter array differs in any element or order", () => {
    const before = `export default {
  test: {
    coverage: { reporter: ["text", "json"] }
  }
};
`;
    const r = applyVitestCoverage(before, {
      reporter: ["text", "json-summary"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(true);
    const r2 = applyVitestCoverage(before, { reporter: ["text", "json"] });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.changed).toBe(false);
  });

  it("only touches the leaves declared in the patch", () => {
    const before = `export default {
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      thresholds: { lines: 60, functions: 60, branches: 50, statements: 60 }
    }
  }
};
`;
    const r = applyVitestCoverage(before, { thresholds: { lines: 90 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changed).toBe(true);
    expect(readVitestThresholds(r.value.content)).toEqual({
      lines: 90,
      functions: 60,
      branches: 50,
      statements: 60,
    });
    // provider and reporter untouched
    expect(r.value.content).toContain('provider: "v8"');
    expect(r.value.content).toContain('reporter: ["text"]');
  });

  it("works through a defineConfig() wrapper", () => {
    const before = `import { defineConfig } from "vitest/config";
export default defineConfig({ test: {} });
`;
    const r = applyVitestCoverage(before, {
      provider: "v8",
      thresholds: { lines: 70 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readVitestThresholds(r.value.content)).toEqual({ lines: 70 });
    // wrapper survives
    expect(r.value.content).toContain("defineConfig(");
  });

  it("errors when there is no default-exported object literal", () => {
    const before = `export const config = { test: { coverage: {} } };\n`;
    const r = applyVitestCoverage(before, { thresholds: { lines: 90 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("default-exported");
  });

  it("errors when an intermediate property is not an object literal", () => {
    const before = `export default { test: someVar };\n`;
    const r = applyVitestCoverage(before, { thresholds: { lines: 90 } });
    expect(r.ok).toBe(false);
  });

  it("VITEST_THRESHOLD_KEYS exposes exactly the four known keys", () => {
    expect([...VITEST_THRESHOLD_KEYS]).toEqual([
      "lines",
      "functions",
      "branches",
      "statements",
    ]);
  });
});

describe("integration — round-trip", () => {
  it("a fresh write followed by readVitestThresholds returns the written values", () => {
    const r = applyVitestCoverage(fence(`
import { defineConfig } from "vitest/config";

// banner
export default defineConfig({
  test: {
    // hi
    setupFiles: ["./s.ts"]
  }
});
`), {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readVitestThresholds(r.value.content)).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
    expect(r.value.content).toContain("// banner");
    expect(r.value.content).toContain("// hi");
    expect(r.value.content).toContain("defineConfig(");
  });

  it("two consecutive applyVitestCoverage calls with the same patch are idempotent on the second", () => {
    const before = `export default { test: {} };\n`;
    const r1 = applyVitestCoverage(before, {
      thresholds: { lines: 90 },
    });
    expect(r1.ok && r1.value.changed).toBe(true);
    if (!r1.ok) return;
    const r2 = applyVitestCoverage(r1.value.content, {
      thresholds: { lines: 90 },
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.changed).toBe(false);
    expect(r2.value.content).toBe(r1.value.content);
  });
});
