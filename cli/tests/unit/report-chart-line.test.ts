/**
 * Contract suite for `report/components/ChartLine`. Locks the chart.js config
 * shape, DOM scaffold, and a11y wiring. Mirrors the FakeDoc/FakeEl strategy
 * `report-metric-card.test.ts` uses so the report tests stay jsdom-free.
 */
import { describe, expect, it } from "vitest";

import type { ReportHistoryEntry } from "../../src/report/data-loader.ts";
import {
  CHART_LINE_CLASS_NAMES,
  CHART_LINE_MESSAGES,
  type ChartLineDoc,
  type ChartLineEl,
  DATASET_IDS,
  DEFAULT_COLORS,
  DEFAULT_MAX_POINTS,
  buildChartLineConfig,
  chartAriaLabel,
  createChartLine,
  formatLabel,
  resolveColors,
  truncateHistory,
} from "../../src/report/components/ChartLine.ts";

// ---------------------------------------------------------------------------
// Fake DOM + helpers
// ---------------------------------------------------------------------------

interface FakeEl extends ChartLineEl {
  readonly attributes: Map<string, string>;
  readonly children: FakeEl[];
}

function createFakeDoc(): { doc: ChartLineDoc; readonly created: FakeEl[] } {
  const created: FakeEl[] = [];
  const doc: ChartLineDoc = {
    createElement(tag: string): FakeEl {
      const attributes = new Map<string, string>();
      const children: FakeEl[] = [];
      const el: FakeEl = {
        tagName: tag,
        textContent: "",
        attributes,
        children,
        setAttribute(name, value) {
          attributes.set(name, value);
        },
        appendChild(child) {
          children.push(child as FakeEl);
          return child;
        },
      };
      created.push(el);
      return el;
    },
  };
  return { doc, created };
}

function findByClass(root: FakeEl, className: string): FakeEl | null {
  if (root.attributes.get("class") === className) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== null) return hit;
  }
  return null;
}

function expectByClass(root: FakeEl, className: string): FakeEl {
  const hit = findByClass(root, className);
  if (hit === null) throw new Error(`expected element with class "${className}"`);
  return hit;
}

function makeEntry(partial: Partial<ReportHistoryEntry>): ReportHistoryEntry {
  return {
    timestamp: partial.timestamp ?? "2026-05-03T10-00-00Z",
    generated_at: partial.generated_at ?? "2026-05-03T10:00:00.000Z",
    stage: partial.stage ?? "greenfield",
    errors: partial.errors ?? 0,
    warnings: partial.warnings ?? 0,
    files_affected: partial.files_affected ?? 0,
    by_metric: partial.by_metric ?? { wmc: 0, halstead: 0, lcom: 0, cbo: 0, dit: 0 },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports the canonical dataset ids in stable order", () => {
    expect(DATASET_IDS).toEqual(["errors", "warnings"]);
  });

  it("exposes default colors for both datasets", () => {
    expect(DEFAULT_COLORS).toEqual({ errors: "#e5484d", warnings: "#f0a900" });
  });

  it("caps default plotted points at 30", () => {
    expect(DEFAULT_MAX_POINTS).toBe(30);
  });

  it("exposes class-name constants for sibling components", () => {
    expect(CHART_LINE_CLASS_NAMES).toEqual({
      root: "qualy-chart-line",
      title: "qualy-chart-line__title",
      canvasWrap: "qualy-chart-line__canvas-wrap",
      canvas: "qualy-chart-line__canvas",
      empty: "qualy-chart-line__empty",
    });
  });

  it("exposes message constants for empty state and default title", () => {
    expect(CHART_LINE_MESSAGES.defaultTitle).toBe("Audit history");
    expect(CHART_LINE_MESSAGES.empty).toMatch(/no audits/i);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("truncateHistory", () => {
  it("returns the input unchanged when length <= max", () => {
    const entries = [makeEntry({}), makeEntry({})];
    expect(truncateHistory(entries, 5)).toBe(entries);
    expect(truncateHistory(entries, 2)).toBe(entries);
  });

  it("keeps the most recent N entries when length > max", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ errors: i, generated_at: `2026-05-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }),
    );
    const trimmed = truncateHistory(entries, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map((e) => e.errors)).toEqual([7, 8, 9]);
  });

  it("returns the input unchanged when max <= 0", () => {
    const entries = [makeEntry({}), makeEntry({})];
    expect(truncateHistory(entries, 0)).toBe(entries);
    expect(truncateHistory(entries, -5)).toBe(entries);
  });
});

describe("formatLabel", () => {
  it("returns the date portion of generated_at when present", () => {
    expect(formatLabel(makeEntry({ generated_at: "2026-05-03T14:22:11.000Z" }))).toBe("2026-05-03");
  });

  it("falls back to timestamp when generated_at is empty", () => {
    expect(
      formatLabel(makeEntry({ generated_at: "", timestamp: "2026-05-03T14-22-11Z" })),
    ).toBe("2026-05-03");
  });

  it("returns the whole string when no T separator exists", () => {
    expect(formatLabel(makeEntry({ generated_at: "2026-05-03" }))).toBe("2026-05-03");
  });
});

describe("chartAriaLabel", () => {
  it("returns an empty-state label when entries is empty", () => {
    expect(chartAriaLabel([])).toMatch(/no audits/i);
  });

  it("uses singular 'audit' for one entry", () => {
    const label = chartAriaLabel([makeEntry({ errors: 3, warnings: 4 })]);
    expect(label).toContain("1 audit,");
    expect(label).toContain("3 errors");
    expect(label).toContain("4 warnings");
  });

  it("uses plural 'audits' for multiple entries and reports the latest", () => {
    const entries = [
      makeEntry({ errors: 1, warnings: 2 }),
      makeEntry({ errors: 5, warnings: 9 }),
    ];
    const label = chartAriaLabel(entries);
    expect(label).toContain("2 audits,");
    expect(label).toContain("latest 5 errors");
    expect(label).toContain("9 warnings");
  });
});

describe("resolveColors", () => {
  it("returns defaults when no override is supplied", () => {
    expect(resolveColors()).toEqual(DEFAULT_COLORS);
    expect(resolveColors({})).toEqual(DEFAULT_COLORS);
  });

  it("layers overrides over defaults per dataset", () => {
    expect(resolveColors({ errors: "#ff0000" })).toEqual({
      errors: "#ff0000",
      warnings: DEFAULT_COLORS.warnings,
    });
    expect(resolveColors({ warnings: "#abc" })).toEqual({
      errors: DEFAULT_COLORS.errors,
      warnings: "#abc",
    });
  });
});

// ---------------------------------------------------------------------------
// buildChartLineConfig
// ---------------------------------------------------------------------------

describe("buildChartLineConfig", () => {
  it("produces a chart.js Line type with both datasets in the canonical order", () => {
    const config = buildChartLineConfig([makeEntry({ errors: 1, warnings: 2 })]);
    expect(config.type).toBe("line");
    expect(config.data.datasets.map((d) => d.id)).toEqual(["errors", "warnings"]);
    expect(config.data.datasets.map((d) => d.label)).toEqual(["Errors", "Warnings"]);
  });

  it("emits one label per entry in chronological order", () => {
    const config = buildChartLineConfig([
      makeEntry({ generated_at: "2026-05-01T10:00:00.000Z" }),
      makeEntry({ generated_at: "2026-05-02T10:00:00.000Z" }),
      makeEntry({ generated_at: "2026-05-03T10:00:00.000Z" }),
    ]);
    expect(config.data.labels).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
  });

  it("populates dataset.data from the matching entry field", () => {
    const config = buildChartLineConfig([
      makeEntry({ errors: 3, warnings: 7 }),
      makeEntry({ errors: 5, warnings: 11 }),
    ]);
    const errorsDs = config.data.datasets.find((d) => d.id === "errors");
    const warningsDs = config.data.datasets.find((d) => d.id === "warnings");
    expect(errorsDs?.data).toEqual([3, 5]);
    expect(warningsDs?.data).toEqual([7, 11]);
  });

  it("returns empty labels and empty data arrays for empty history", () => {
    const config = buildChartLineConfig([]);
    expect(config.data.labels).toEqual([]);
    for (const ds of config.data.datasets) {
      expect(ds.data).toEqual([]);
    }
  });

  it("respects maxPoints and keeps the most recent entries", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({ errors: i, generated_at: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z` }),
    );
    const config = buildChartLineConfig(entries, { maxPoints: 5 });
    const errorsDs = config.data.datasets.find((d) => d.id === "errors");
    expect(errorsDs?.data).toEqual([45, 46, 47, 48, 49]);
  });

  it("disables animations by default (prefers-reduced-motion safe)", () => {
    const config = buildChartLineConfig([makeEntry({})]);
    expect(config.options.animation).toBe(false);
  });

  it("places the legend at the bottom and enables index-mode tooltips", () => {
    const config = buildChartLineConfig([makeEntry({})]);
    expect(config.options.plugins.legend).toEqual({ display: true, position: "bottom" });
    expect(config.options.plugins.tooltip).toEqual({
      enabled: true,
      mode: "index",
      intersect: false,
    });
    expect(config.options.interaction).toEqual({ mode: "index", intersect: false });
  });

  it("forces y axis to begin at zero", () => {
    const config = buildChartLineConfig([makeEntry({ errors: 100 })]);
    expect(config.options.scales.y.beginAtZero).toBe(true);
  });

  it("propagates resolved colors into both border and background", () => {
    const config = buildChartLineConfig([makeEntry({})], {
      colors: { errors: "#111111", warnings: "#222222" },
    });
    const errorsDs = config.data.datasets.find((d) => d.id === "errors");
    const warningsDs = config.data.datasets.find((d) => d.id === "warnings");
    expect(errorsDs?.borderColor).toBe("#111111");
    expect(errorsDs?.backgroundColor).toBe("#111111");
    expect(warningsDs?.borderColor).toBe("#222222");
    expect(warningsDs?.backgroundColor).toBe("#222222");
  });

  it("uses default colors when none are provided", () => {
    const config = buildChartLineConfig([makeEntry({})]);
    const errorsDs = config.data.datasets.find((d) => d.id === "errors");
    expect(errorsDs?.borderColor).toBe(DEFAULT_COLORS.errors);
  });

  it("emits JSON-serializable config (export.ts inlines this)", () => {
    const config = buildChartLineConfig([makeEntry({ errors: 1 })]);
    const round = JSON.parse(JSON.stringify(config));
    expect(round.type).toBe("line");
    expect(round.data.datasets[0].id).toBe("errors");
  });

  it("never marks fill as true (line chart, not area)", () => {
    const config = buildChartLineConfig([makeEntry({})]);
    for (const ds of config.data.datasets) {
      expect(ds.fill).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// createChartLine — DOM scaffold
// ---------------------------------------------------------------------------

describe("createChartLine", () => {
  it("builds the canonical structure for a non-empty history", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, [makeEntry({ errors: 2, warnings: 3 })]);
    const root = result.root as FakeEl;

    expect(root.tagName).toBe("article");
    expect(root.attributes.get("class")).toBe("qualy-chart-line");
    expect(root.attributes.get("data-empty")).toBe("false");
    expect(root.attributes.get("data-history-length")).toBe("1");
    expect(result.isEmpty).toBe(false);

    expect(root.children).toHaveLength(2);
    const heading = root.children[0];
    const wrap = root.children[1];
    if (heading === undefined || wrap === undefined) throw new Error("missing children");

    expect(heading.tagName).toBe("h3");
    expect(heading.attributes.get("class")).toBe("qualy-chart-line__title");
    expect(heading.textContent).toBe("Audit history");

    expect(wrap.tagName).toBe("div");
    expect(wrap.attributes.get("class")).toBe("qualy-chart-line__canvas-wrap");
    expect(wrap.children).toHaveLength(1); // canvas only, no empty placeholder

    const canvas = wrap.children[0];
    if (canvas === undefined) throw new Error("missing canvas");
    expect(canvas.tagName).toBe("canvas");
    expect(canvas.attributes.get("class")).toBe("qualy-chart-line__canvas");
    expect(canvas.attributes.get("role")).toBe("img");
    expect(canvas.attributes.get("aria-label")).toContain("1 audit,");
  });

  it("renders an empty-state placeholder when history is empty", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, []);
    const root = result.root as FakeEl;

    expect(result.isEmpty).toBe(true);
    expect(root.attributes.get("data-empty")).toBe("true");
    expect(root.attributes.get("data-history-length")).toBe("0");

    const wrap = expectByClass(root, "qualy-chart-line__canvas-wrap");
    expect(wrap.children).toHaveLength(2); // canvas + empty paragraph

    const empty = expectByClass(root, "qualy-chart-line__empty");
    expect(empty.tagName).toBe("p");
    expect(empty.textContent).toBe(CHART_LINE_MESSAGES.empty);

    const canvas = expectByClass(root, "qualy-chart-line__canvas");
    expect(canvas.attributes.get("aria-label")).toMatch(/no audits/i);
  });

  it("returns canvas element regardless of empty state (caller never branches)", () => {
    const { doc: docEmpty } = createFakeDoc();
    const empty = createChartLine(docEmpty, []);
    expect((empty.canvas as FakeEl).tagName).toBe("canvas");

    const { doc: docFull } = createFakeDoc();
    const full = createChartLine(docFull, [makeEntry({})]);
    expect((full.canvas as FakeEl).tagName).toBe("canvas");
  });

  it("returns the matching chart.js config alongside the DOM", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, [makeEntry({ errors: 4 })]);
    expect(result.config.type).toBe("line");
    const errorsDs = result.config.data.datasets.find((d) => d.id === "errors");
    expect(errorsDs?.data).toEqual([4]);
  });

  it("honors a custom title", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, [makeEntry({})], { title: "Tendência" });
    const heading = expectByClass(result.root as FakeEl, "qualy-chart-line__title");
    expect(heading.textContent).toBe("Tendência");
  });

  it("forwards maxPoints into the config builder", () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ errors: i }));
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, entries, { maxPoints: 2 });
    const errorsDs = result.config.data.datasets.find((d) => d.id === "errors");
    expect(errorsDs?.data).toEqual([3, 4]);
    // data-history-length reflects the *input* length, not the truncated slice
    // — observers want to know the dataset cardinality, not what we plotted.
    expect((result.root as FakeEl).attributes.get("data-history-length")).toBe("5");
  });

  it("forwards color overrides into the config builder", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, [makeEntry({})], {
      colors: { errors: "#000000" },
    });
    const errorsDs = result.config.data.datasets.find((d) => d.id === "errors");
    expect(errorsDs?.borderColor).toBe("#000000");
  });

  it("uses lowercase tag names exclusively (createElement contract)", () => {
    const { doc } = createFakeDoc();
    const result = createChartLine(doc, []);
    function walk(node: FakeEl): void {
      expect(node.tagName).toBe(node.tagName.toLowerCase());
      for (const child of node.children) walk(child);
    }
    walk(result.root as FakeEl);
  });

  it("creates only the elements it needs (no ghost children)", () => {
    const { doc, created } = createFakeDoc();
    createChartLine(doc, []);
    // Empty: article + h3 + div + canvas + p = 5 elements.
    expect(created).toHaveLength(5);

    const { doc: docFull, created: createdFull } = createFakeDoc();
    createChartLine(docFull, [makeEntry({})]);
    // Non-empty: article + h3 + div + canvas = 4 elements.
    expect(createdFull).toHaveLength(4);
  });
});
