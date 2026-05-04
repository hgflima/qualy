/**
 * Theme contract for `linear-design-md` (IMPLEMENTATION_PLAN.md §Fase 6 + SPEC §4).
 *
 * Locks the three source files that ship with the report — `tokens.json`,
 * `light.css`, `dark.css` — so future changes to the palette can't drift
 * (token in CSS but not in JSON, light-only color missing from dark, etc.).
 *
 * What is asserted:
 *   - All three files exist at the canonical path.
 *   - tokens.json parses, declares both modes, and lists matching color keys
 *     in the light and dark palettes (no missing token).
 *   - light.css declares the foundation custom properties (font/space/radius/motion)
 *     that dark.css inherits, plus the full color palette under :root[data-theme="light"].
 *   - dark.css declares the same color custom properties under
 *     :root[data-theme="dark"] AND under prefers-color-scheme: dark — so palettes
 *     stay in lockstep.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const THEME_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "report",
  "themes",
  "linear-design-md",
);

interface Tokens {
  name: string;
  modes: string[];
  color: { light: Record<string, string>; dark: Record<string, string> };
  chart: { light: string[]; dark: string[] };
  font: {
    family: Record<string, string>;
    size: Record<string, string>;
    weight: Record<string, number>;
    "line-height": Record<string, number>;
  };
  space: Record<string, string>;
  radius: Record<string, string>;
  shadow: { light: Record<string, string>; dark: Record<string, string> };
  motion: { duration: Record<string, string>; easing: Record<string, string> };
}

function readTheme(file: string): string {
  return readFileSync(join(THEME_DIR, file), "utf8");
}

function loadTokens(): Tokens {
  return JSON.parse(readTheme("tokens.json")) as Tokens;
}

describe("theme linear-design-md — file presence", () => {
  it("ships tokens.json, light.css, and dark.css", () => {
    expect(() => readTheme("tokens.json")).not.toThrow();
    expect(() => readTheme("light.css")).not.toThrow();
    expect(() => readTheme("dark.css")).not.toThrow();
  });
});

describe("theme linear-design-md — tokens.json", () => {
  const tokens = loadTokens();

  it('declares name "linear-design-md" and both modes', () => {
    expect(tokens.name).toBe("linear-design-md");
    expect(tokens.modes).toEqual(["light", "dark"]);
  });

  it("light and dark color palettes share the same keys (no drift)", () => {
    const lightKeys = Object.keys(tokens.color.light).sort();
    const darkKeys = Object.keys(tokens.color.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it("light and dark chart palettes have the same length", () => {
    expect(tokens.chart.dark.length).toBe(tokens.chart.light.length);
    expect(tokens.chart.light.length).toBeGreaterThanOrEqual(8);
  });

  it("light and dark shadow tokens share the same keys", () => {
    const lightKeys = Object.keys(tokens.shadow.light).sort();
    const darkKeys = Object.keys(tokens.shadow.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it("declares the canonical semantic color tokens used by report components", () => {
    const required = [
      "bg-canvas",
      "bg-surface",
      "bg-surface-elevated",
      "fg-primary",
      "fg-secondary",
      "fg-muted",
      "border-default",
      "accent",
      "accent-fg",
      "status-error",
      "status-warn",
      "status-ok",
      "status-info",
      "focus-ring",
    ];
    for (const key of required) {
      expect(tokens.color.light, `light.${key}`).toHaveProperty(key);
      expect(tokens.color.dark, `dark.${key}`).toHaveProperty(key);
    }
  });
});

function expectedColorVariables(tokens: Tokens): string[] {
  return Object.keys(tokens.color.light)
    .map((k) => `--color-${k}`)
    .concat(tokens.chart.light.map((_, i) => `--color-chart-${i + 1}`));
}

describe("theme linear-design-md — light.css", () => {
  const css = readTheme("light.css");
  const tokens = loadTokens();

  it("declares the foundation tokens on :root", () => {
    expect(css).toMatch(/:root\s*\{/);
    for (const family of ["sans", "mono"]) {
      expect(css).toContain(`--font-family-${family}:`);
    }
    for (const size of Object.keys(tokens.font.size)) {
      expect(css).toContain(`--font-size-${size}:`);
    }
    for (const step of Object.keys(tokens.space)) {
      expect(css).toContain(`--space-${step}:`);
    }
    for (const r of Object.keys(tokens.radius)) {
      expect(css).toContain(`--radius-${r}:`);
    }
    for (const d of Object.keys(tokens.motion.duration)) {
      expect(css).toContain(`--motion-duration-${d}:`);
    }
  });

  it('declares the full light color palette under :root[data-theme="light"]', () => {
    expect(css).toMatch(/:root\[data-theme="light"\]/);
    for (const variable of expectedColorVariables(tokens)) {
      expect(css, variable).toContain(`${variable}:`);
    }
  });

  it("respects prefers-reduced-motion (collapses motion durations)", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("theme linear-design-md — dark.css", () => {
  const css = readTheme("dark.css");
  const tokens = loadTokens();

  it('declares the dark palette under :root[data-theme="dark"]', () => {
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    for (const variable of expectedColorVariables(tokens)) {
      expect(css, variable).toContain(`${variable}:`);
    }
  });

  it("auto-applies the dark palette when the user prefers dark and no explicit theme is set", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme\]\)/);
  });

  it("never re-declares foundation tokens (those belong to light.css)", () => {
    expect(css).not.toContain("--font-family-sans:");
    expect(css).not.toContain("--space-1:");
    expect(css).not.toContain("--radius-sm:");
    expect(css).not.toContain("--motion-duration-base:");
  });
});
