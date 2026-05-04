/**
 * Contract for `cli/src/report/index.html` (IMPLEMENTATION_PLAN.md §Fase 6 + SPEC §3, §4, §6).
 *
 * The shell HTML is the single mount point consumed by both the dev server
 * (`server.ts`, served verbatim) and the offline export (`export.ts`, with
 * stylesheets and scripts inlined). Locking the shell prevents drift between
 * the two consumers — every component, theme link, and accessibility hook
 * the rest of the report depends on must be present here.
 *
 * What is asserted (do not loosen without an ADR):
 *   - File hygiene: LF only, single trailing newline, no BOM.
 *   - Doctype + lang attribute + initial data-theme attribute.
 *   - color-scheme meta + viewport meta.
 *   - Both theme stylesheets linked (light.css and dark.css).
 *   - No-flash inline theme bootstrap script reads localStorage("qualy.theme")
 *     and falls back to prefers-color-scheme; sits before the <link>s so the
 *     attribute is set before stylesheets cascade.
 *   - Theme toggle button with stable id + aria-label + aria-pressed.
 *   - Skip-link to the <main> landmark + ARIA landmarks (banner/main/contentinfo).
 *   - Mount points for the four components: metric-cards, chart-line,
 *     chart-treemap, violations-table — each as a `data-mount` attribute the
 *     bootstrap in app.ts can target.
 *   - Charts carry role="img" + aria-label so the report is navigable by
 *     screen reader (SPEC §4 a11y).
 *   - aria-live status region for app-level updates (offline mode, errors).
 *   - Module script entry references ./app.js (compiled output of app.ts).
 *   - No external CDN script tags — export.ts must produce a self-contained
 *     HTML, so any external <script src> would leak network on offline open
 *     (SPEC §6 Never line 421-422).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "report",
  "index.html",
);

function readShell(): string {
  return readFileSync(SHELL_PATH, "utf8");
}

describe("report shell — file hygiene", () => {
  const text = readShell();

  it("uses LF line endings only", () => {
    expect(text.includes("\r")).toBe(false);
  });

  it("ends with exactly one trailing newline", () => {
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("has no UTF-8 BOM", () => {
    const bytes = readFileSync(SHELL_PATH);
    expect(bytes[0]).not.toBe(0xef);
  });
});

describe("report shell — doctype and root attributes", () => {
  const text = readShell();

  it("declares HTML5 doctype on the first line", () => {
    expect(text.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("sets lang on <html>", () => {
    expect(text).toMatch(/<html[^>]*\blang="[a-z]{2,}"/);
  });

  it("sets initial data-theme on <html> for the no-flash default", () => {
    expect(text).toMatch(/<html[^>]*\bdata-theme="(light|dark)"/);
  });

  it("declares color-scheme meta supporting both modes", () => {
    expect(text).toMatch(
      /<meta[^>]*name="color-scheme"[^>]*content="light dark"/,
    );
  });

  it("declares responsive viewport meta", () => {
    expect(text).toMatch(
      /<meta[^>]*name="viewport"[^>]*content="width=device-width[^"]*"/,
    );
  });

  it("declares UTF-8 charset", () => {
    expect(text).toMatch(/<meta[^>]*charset="UTF-8"/i);
  });
});

describe("report shell — theme integration", () => {
  const text = readShell();

  it("links the linear-design-md light stylesheet", () => {
    expect(text).toMatch(
      /<link[^>]*href="\.\/themes\/linear-design-md\/light\.css"/,
    );
  });

  it("links the linear-design-md dark stylesheet", () => {
    expect(text).toMatch(
      /<link[^>]*href="\.\/themes\/linear-design-md\/dark\.css"/,
    );
  });

  it("inlines a no-flash bootstrap script before the stylesheet links", () => {
    const bootstrapIdx = text.indexOf("qualy.theme");
    const lightLinkIdx = text.indexOf("light.css");
    expect(bootstrapIdx).toBeGreaterThan(0);
    expect(lightLinkIdx).toBeGreaterThan(0);
    expect(bootstrapIdx).toBeLessThan(lightLinkIdx);
  });

  it("bootstrap reads localStorage and prefers-color-scheme", () => {
    expect(text).toMatch(/localStorage\.getItem\("qualy\.theme"\)/);
    expect(text).toMatch(/prefers-color-scheme:\s*dark/);
  });

  it("bootstrap sets data-theme on documentElement", () => {
    expect(text).toMatch(
      /document\.documentElement\.setAttribute\("data-theme",/,
    );
  });
});

describe("report shell — accessibility landmarks", () => {
  const text = readShell();

  it("has a skip link pointing at the main landmark", () => {
    expect(text).toMatch(/<a[^>]*class="skip-link"[^>]*href="#main"/);
  });

  it("declares banner, main, and contentinfo landmarks", () => {
    expect(text).toMatch(/<header[^>]*role="banner"/);
    expect(text).toMatch(/<main[^>]*id="main"[^>]*role="main"/);
    expect(text).toMatch(/<footer[^>]*role="contentinfo"/);
  });

  it("has an aria-live status region for app-level updates", () => {
    expect(text).toMatch(/id="status"[^>]*role="status"[^>]*aria-live="polite"/);
  });
});

describe("report shell — theme toggle", () => {
  const text = readShell();

  it("exposes a theme-toggle button with stable id and aria-pressed", () => {
    expect(text).toMatch(
      /<button[^>]*id="theme-toggle"[\s\S]*?aria-pressed="(true|false)"/,
    );
  });

  it("button has an aria-label describing the action", () => {
    expect(text).toMatch(/<button[^>]*id="theme-toggle"[\s\S]*?aria-label="[^"]+"/);
  });
});

describe("report shell — component mount points", () => {
  const text = readShell();

  const mounts = [
    "metric-cards",
    "chart-line",
    "chart-treemap",
    "violations-table",
  ];

  for (const mount of mounts) {
    it(`declares a mount point for ${mount}`, () => {
      const re = new RegExp(`data-mount="${mount}"`);
      expect(text).toMatch(re);
    });
  }

  it("charts carry role=img and aria-label for screen readers", () => {
    const lineIdx = text.indexOf('data-mount="chart-line"');
    const treemapIdx = text.indexOf('data-mount="chart-treemap"');
    expect(lineIdx).toBeGreaterThan(0);
    expect(treemapIdx).toBeGreaterThan(0);

    const lineBlock = text.slice(Math.max(0, lineIdx - 200), lineIdx + 200);
    const treemapBlock = text.slice(
      Math.max(0, treemapIdx - 200),
      treemapIdx + 200,
    );
    expect(lineBlock).toMatch(/role="img"/);
    expect(lineBlock).toMatch(/aria-label="[^"]+"/);
    expect(treemapBlock).toMatch(/role="img"/);
    expect(treemapBlock).toMatch(/aria-label="[^"]+"/);
  });
});

describe("report shell — script entry and offline safety", () => {
  const text = readShell();

  it("loads ./app.js as a module", () => {
    expect(text).toMatch(/<script[^>]*type="module"[^>]*src="\.\/app\.js"/);
  });

  it("contains no external <script src> (offline-safe export contract)", () => {
    const scriptTags = Array.from(
      text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
    );
    for (const match of scriptTags) {
      const src = match[1];
      expect(src.startsWith("./") || src.startsWith("/")).toBe(true);
      expect(src.startsWith("http://")).toBe(false);
      expect(src.startsWith("https://")).toBe(false);
      expect(src.startsWith("//")).toBe(false);
    }
  });

  it("contains no external <link rel=stylesheet> (offline-safe)", () => {
    const linkTags = Array.from(
      text.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g),
    );
    for (const match of linkTags) {
      const href = match[1];
      expect(href.startsWith("./") || href.startsWith("/")).toBe(true);
      expect(href.startsWith("http://")).toBe(false);
      expect(href.startsWith("https://")).toBe(false);
      expect(href.startsWith("//")).toBe(false);
    }
  });
});
