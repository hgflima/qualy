/**
 * lintstagedrc.example.js template contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §4).
 *
 * The template at `cli/src/templates/lintstagedrc.example.js` is copied
 * byte-for-byte into `<target>/.lintstagedrc.js` by `install-husky`. It
 * must:
 *   - be an ES module (`export default ...`) — SPEC §4 line 314
 *   - drive the pre-commit pipeline in fast-then-deep order so cheap
 *     rule violations fail before the slower `quality-metrics` pass
 *   - target only the four oxc-supported extensions (.ts/.tsx/.js/.jsx)
 *   - reference both `oxlint.fast.json` and `oxlint.deep.json` (matching
 *     the presets emitted by `install-oxlint`)
 *
 * Static assertions lock the contract; a runtime dynamic-import asserts
 * the file is a valid ES module exporting an object literal whose
 * commands are an array in the documented order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "templates",
  "lintstagedrc.example.js",
);

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

describe("templates/lintstagedrc.example.js — static contract", () => {
  it("uses ES module syntax (export default)", () => {
    const text = readTemplate();
    expect(text).toMatch(/^export default \{/m);
    expect(text).not.toMatch(/module\.exports\s*=/);
    expect(text).not.toMatch(/^require\(/m);
  });

  it("targets exactly the four oxc-supported extensions", () => {
    const text = readTemplate();
    // Anchor to the only glob key — header comments may legitimately
    // mention other extensions (e.g. `.mjs` as a fallback file rename),
    // so we assert the glob key itself rather than the whole file body.
    const globMatches = text.match(/"\*\.\{[^"]+\}"/g) ?? [];
    expect(globMatches).toEqual(["\"*.{ts,tsx,js,jsx}\""]);
  });

  it("references both fast and deep oxlint presets", () => {
    const text = readTemplate();
    expect(text).toMatch(/oxlint --config oxlint\.fast\.json/);
    expect(text).toMatch(/oxlint --config oxlint\.deep\.json/);
  });

  it("orders fast tier strictly before deep tier", () => {
    const text = readTemplate();
    const fastIdx = text.indexOf("oxlint.fast.json");
    const deepIdx = text.indexOf("oxlint.deep.json");
    expect(fastIdx).toBeGreaterThan(-1);
    expect(deepIdx).toBeGreaterThan(fastIdx);
  });

  it("formats with oxfmt before linting", () => {
    const text = readTemplate();
    const fmtIdx = text.indexOf("oxfmt --write");
    const fastIdx = text.indexOf("oxlint.fast.json");
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(fastIdx).toBeGreaterThan(fmtIdx);
  });
});

describe("templates/lintstagedrc.example.js — runtime ESM shape", () => {
  it("loads as an ES module and exports a glob → commands map", async () => {
    const mod = await import(pathToFileURL(TEMPLATE_PATH).href);
    expect(mod.default).toBeTypeOf("object");
    expect(mod.default).not.toBeNull();

    const config = mod.default as Record<string, unknown>;
    const keys = Object.keys(config);
    expect(keys).toEqual(["*.{ts,tsx,js,jsx}"]);

    const commands = config["*.{ts,tsx,js,jsx}"];
    expect(Array.isArray(commands)).toBe(true);
    expect(commands).toEqual([
      "oxfmt --write",
      "oxlint --config oxlint.fast.json",
      "oxlint --config oxlint.deep.json",
    ]);
  });
});
