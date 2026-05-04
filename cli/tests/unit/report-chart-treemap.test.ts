/**
 * Contract suite for `report/components/ChartTreemap`. Locks the
 * chartjs-chart-treemap config shape, DOM scaffold, a11y wiring, and the
 * cross-metric aggregation. Mirrors the FakeDoc/FakeEl strategy
 * `report-chart-line.test.ts` uses so the report tests stay jsdom-free.
 */
import { describe, expect, it } from "vitest";

import type {
  MetricViolations,
  ViolationsByMetric,
  ViolationTopEntry,
} from "../../src/lib/audit-schema.ts";
import {
  CHART_TREEMAP_CLASS_NAMES,
  CHART_TREEMAP_MESSAGES,
  type ChartTreemapDoc,
  type ChartTreemapEl,
  DEFAULT_COLORS,
  DEFAULT_MAX_FILES,
  METRIC_IDS,
  aggregateViolationsByFile,
  buildChartTreemapConfig,
  chartAriaLabel,
  createChartTreemap,
  resolveColors,
} from "../../src/report/components/ChartTreemap.ts";

// ---------------------------------------------------------------------------
// Fake DOM + helpers
// ---------------------------------------------------------------------------

interface FakeEl extends ChartTreemapEl {
  readonly attributes: Map<string, string>;
  readonly children: FakeEl[];
}

function createFakeDoc(): { doc: ChartTreemapDoc; readonly created: FakeEl[] } {
  const created: FakeEl[] = [];
  const doc: ChartTreemapDoc = {
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

// ---------------------------------------------------------------------------
// ViolationsByMetric builders
// ---------------------------------------------------------------------------

function emptyMetric(): MetricViolations {
  return { violations: 0, top: [] };
}

function metric(top: readonly ViolationTopEntry[]): MetricViolations {
  return { violations: top.length, top: [...top] };
}

function buildByMetric(partial: Partial<ViolationsByMetric>): ViolationsByMetric {
  return {
    wmc: partial.wmc ?? emptyMetric(),
    halstead: partial.halstead ?? emptyMetric(),
    lcom: partial.lcom ?? emptyMetric(),
    cbo: partial.cbo ?? emptyMetric(),
    dit: partial.dit ?? emptyMetric(),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports the canonical metric ids in stable order", () => {
    expect(METRIC_IDS).toEqual(["wmc", "halstead", "lcom", "cbo", "dit"]);
  });

  it("exposes default colors with a contrasting border + translucent fill", () => {
    expect(DEFAULT_COLORS.border).toMatch(/^#[0-9a-f]{6}$/i);
    expect(DEFAULT_COLORS.background).toMatch(/^rgba?\(/);
  });

  it("caps default plotted files at 50", () => {
    expect(DEFAULT_MAX_FILES).toBe(50);
  });

  it("exposes class-name constants for sibling components", () => {
    expect(CHART_TREEMAP_CLASS_NAMES).toEqual({
      root: "qualy-chart-treemap",
      title: "qualy-chart-treemap__title",
      canvasWrap: "qualy-chart-treemap__canvas-wrap",
      canvas: "qualy-chart-treemap__canvas",
      empty: "qualy-chart-treemap__empty",
    });
  });

  it("exposes message constants for empty state, default title, and dataset label", () => {
    expect(CHART_TREEMAP_MESSAGES.defaultTitle).toBe("Violations by file");
    expect(CHART_TREEMAP_MESSAGES.empty).toMatch(/no violations/i);
    expect(CHART_TREEMAP_MESSAGES.datasetLabel).toBe("Violations by file");
  });
});

// ---------------------------------------------------------------------------
// aggregateViolationsByFile
// ---------------------------------------------------------------------------

describe("aggregateViolationsByFile", () => {
  it("returns an empty list when no metric has top entries", () => {
    expect(aggregateViolationsByFile(buildByMetric({}))).toEqual([]);
  });

  it("counts each top[] entry as +1 toward the file's value", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([{ file: "src/a.ts" }, { file: "src/b.ts" }]),
        cbo: metric([{ file: "src/a.ts" }]),
      }),
    );
    const a = rows.find((r) => r.file === "src/a.ts");
    const b = rows.find((r) => r.file === "src/b.ts");
    expect(a?.value).toBe(2);
    expect(b?.value).toBe(1);
  });

  it("collapses duplicate entries from the same metric (each entry still counts once)", () => {
    // Same file appearing twice in the same metric (e.g. two classes per file)
    // each contributes +1 — they are distinct incidents.
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([
          { file: "src/a.ts", class: "Foo" },
          { file: "src/a.ts", class: "Bar" },
        ]),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(2);
    expect(rows[0]?.metrics).toEqual(["wmc"]);
  });

  it("tracks contributing metrics in canonical order", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        // Insert across metrics in non-canonical order to prove sorting.
        dit: metric([{ file: "src/a.ts" }]),
        wmc: metric([{ file: "src/a.ts" }]),
        cbo: metric([{ file: "src/a.ts" }]),
      }),
    );
    expect(rows[0]?.metrics).toEqual(["wmc", "cbo", "dit"]);
  });

  it("sorts rows descending by value", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([{ file: "low.ts" }, { file: "high.ts" }, { file: "high.ts" }]),
        lcom: metric([{ file: "high.ts" }, { file: "mid.ts" }]),
      }),
    );
    expect(rows.map((r) => r.file)).toEqual(["high.ts", "low.ts", "mid.ts"]);
    expect(rows.map((r) => r.value)).toEqual([3, 1, 1]);
  });

  it("breaks value ties by file path lexicographic order", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([{ file: "z.ts" }, { file: "a.ts" }, { file: "m.ts" }]),
      }),
    );
    expect(rows.map((r) => r.file)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("respects maxFiles by trimming the lowest-value tail", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([
          { file: "a.ts" },
          { file: "a.ts" },
          { file: "a.ts" }, // 3 incidents
          { file: "b.ts" },
          { file: "b.ts" }, // 2 incidents
          { file: "c.ts" }, // 1 incident
          { file: "d.ts" }, // 1 incident
        ]),
      }),
      { maxFiles: 2 },
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("treats maxFiles <= 0 as 'no cap'", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric(Array.from({ length: 3 }, (_, i) => ({ file: `f${i}.ts` }))),
      }),
      { maxFiles: 0 },
    );
    expect(rows).toHaveLength(3);
  });

  it("walks all five metrics", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([{ file: "x.ts" }]),
        halstead: metric([{ file: "x.ts" }]),
        lcom: metric([{ file: "x.ts" }]),
        cbo: metric([{ file: "x.ts" }]),
        dit: metric([{ file: "x.ts" }]),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(5);
    expect(rows[0]?.metrics).toEqual(["wmc", "halstead", "lcom", "cbo", "dit"]);
  });

  it("ignores metrics with empty top arrays without crashing", () => {
    const rows = aggregateViolationsByFile(
      buildByMetric({
        wmc: metric([{ file: "only.ts" }]),
        // halstead/lcom/cbo/dit default to emptyMetric()
      }),
    );
    expect(rows).toEqual([{ file: "only.ts", value: 1, metrics: ["wmc"] }]);
  });
});

// ---------------------------------------------------------------------------
// chartAriaLabel
// ---------------------------------------------------------------------------

describe("chartAriaLabel", () => {
  it("returns an empty-state label when rows is empty", () => {
    expect(chartAriaLabel([])).toMatch(/no violations/i);
  });

  it("uses singular 'file' / 'incident' for one entry with one incident", () => {
    const label = chartAriaLabel([
      { file: "solo.ts", value: 1, metrics: ["wmc"] },
    ]);
    expect(label).toContain("1 file");
    expect(label).toContain("1 incident");
    expect(label).toContain("solo.ts");
  });

  it("uses plural 'files' / 'incidents' for multiple entries", () => {
    const label = chartAriaLabel([
      { file: "a.ts", value: 5, metrics: ["wmc", "cbo"] },
      { file: "b.ts", value: 2, metrics: ["wmc"] },
    ]);
    expect(label).toContain("2 files");
    expect(label).toContain("5 incidents");
    expect(label).toContain("a.ts");
  });

  it("singularizes 'incident' even when multiple files violate", () => {
    const label = chartAriaLabel([
      { file: "a.ts", value: 1, metrics: ["wmc"] },
      { file: "b.ts", value: 1, metrics: ["lcom"] },
    ]);
    expect(label).toContain("2 files");
    expect(label).toContain("1 incident");
    // Defensive: must not say "1 incidents".
    expect(label).not.toContain("1 incidents");
  });
});

// ---------------------------------------------------------------------------
// resolveColors
// ---------------------------------------------------------------------------

describe("resolveColors", () => {
  it("returns defaults when no override is supplied", () => {
    expect(resolveColors()).toEqual({
      border: DEFAULT_COLORS.border,
      background: DEFAULT_COLORS.background,
    });
    expect(resolveColors({})).toEqual({
      border: DEFAULT_COLORS.border,
      background: DEFAULT_COLORS.background,
    });
  });

  it("layers overrides over defaults independently", () => {
    expect(resolveColors({ border: "#000000" })).toEqual({
      border: "#000000",
      background: DEFAULT_COLORS.background,
    });
    expect(resolveColors({ background: "#abc" })).toEqual({
      border: DEFAULT_COLORS.border,
      background: "#abc",
    });
  });
});

// ---------------------------------------------------------------------------
// buildChartTreemapConfig
// ---------------------------------------------------------------------------

describe("buildChartTreemapConfig", () => {
  it("produces a chartjs-chart-treemap config with the canonical type", () => {
    const config = buildChartTreemapConfig([{ file: "a.ts", value: 1, metrics: ["wmc"] }]);
    expect(config.type).toBe("treemap");
  });

  it("emits a single dataset with key='value'", () => {
    const config = buildChartTreemapConfig([{ file: "a.ts", value: 1, metrics: ["wmc"] }]);
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0]?.key).toBe("value");
  });

  it("uses the canonical dataset label", () => {
    const config = buildChartTreemapConfig([]);
    expect(config.data.datasets[0]?.label).toBe("Violations by file");
  });

  it("forwards the rows verbatim into dataset.tree", () => {
    const rows = [
      { file: "a.ts", value: 3, metrics: ["wmc" as const, "cbo" as const] },
      { file: "b.ts", value: 1, metrics: ["lcom" as const] },
    ];
    const config = buildChartTreemapConfig(rows);
    expect(config.data.datasets[0]?.tree).toEqual(rows);
  });

  it("emits an empty tree array when rows is empty", () => {
    const config = buildChartTreemapConfig([]);
    expect(config.data.datasets[0]?.tree).toEqual([]);
  });

  it("disables animations by default (prefers-reduced-motion safe)", () => {
    const config = buildChartTreemapConfig([]);
    expect(config.options.animation).toBe(false);
  });

  it("hides the legend (single-dataset treemap) and enables tooltips", () => {
    const config = buildChartTreemapConfig([]);
    expect(config.options.plugins.legend).toEqual({ display: false });
    expect(config.options.plugins.tooltip).toEqual({ enabled: true });
  });

  it("propagates resolved colors into border + background", () => {
    const config = buildChartTreemapConfig([], {
      colors: { border: "#111111", background: "rgba(0,0,0,0.5)" },
    });
    const ds = config.data.datasets[0];
    expect(ds?.borderColor).toBe("#111111");
    expect(ds?.backgroundColor).toBe("rgba(0,0,0,0.5)");
  });

  it("uses default colors when none are provided", () => {
    const config = buildChartTreemapConfig([]);
    const ds = config.data.datasets[0];
    expect(ds?.borderColor).toBe(DEFAULT_COLORS.border);
    expect(ds?.backgroundColor).toBe(DEFAULT_COLORS.background);
  });

  it("emits responsive + maintainAspectRatio:false for fluid layouts", () => {
    const config = buildChartTreemapConfig([]);
    expect(config.options.responsive).toBe(true);
    expect(config.options.maintainAspectRatio).toBe(false);
  });

  it("emits JSON-serializable config (export.ts inlines this)", () => {
    const config = buildChartTreemapConfig([{ file: "a.ts", value: 1, metrics: ["wmc"] }]);
    const round = JSON.parse(JSON.stringify(config));
    expect(round.type).toBe("treemap");
    expect(round.data.datasets[0].tree[0].file).toBe("a.ts");
  });

  it("emits a positive borderWidth so adjacent rectangles are visually distinct", () => {
    const config = buildChartTreemapConfig([]);
    const ds = config.data.datasets[0];
    expect(ds?.borderWidth).toBeGreaterThan(0);
    expect(ds?.spacing).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// createChartTreemap — DOM scaffold
// ---------------------------------------------------------------------------

describe("createChartTreemap", () => {
  it("builds the canonical structure for a non-empty audit", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(
      doc,
      buildByMetric({ wmc: metric([{ file: "src/a.ts" }, { file: "src/b.ts" }]) }),
    );
    const root = result.root as FakeEl;

    expect(root.tagName).toBe("article");
    expect(root.attributes.get("class")).toBe("qualy-chart-treemap");
    expect(root.attributes.get("data-empty")).toBe("false");
    expect(root.attributes.get("data-files-count")).toBe("2");
    expect(result.isEmpty).toBe(false);
    expect(result.rows).toHaveLength(2);

    expect(root.children).toHaveLength(2);
    const heading = root.children[0];
    const wrap = root.children[1];
    if (heading === undefined || wrap === undefined) throw new Error("missing children");

    expect(heading.tagName).toBe("h3");
    expect(heading.attributes.get("class")).toBe("qualy-chart-treemap__title");
    expect(heading.textContent).toBe("Violations by file");

    expect(wrap.tagName).toBe("div");
    expect(wrap.attributes.get("class")).toBe("qualy-chart-treemap__canvas-wrap");
    expect(wrap.children).toHaveLength(1);

    const canvas = wrap.children[0];
    if (canvas === undefined) throw new Error("missing canvas");
    expect(canvas.tagName).toBe("canvas");
    expect(canvas.attributes.get("class")).toBe("qualy-chart-treemap__canvas");
    expect(canvas.attributes.get("role")).toBe("img");
    expect(canvas.attributes.get("aria-label")).toContain("2 files");
  });

  it("renders an empty-state placeholder when no metrics violate", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(doc, buildByMetric({}));
    const root = result.root as FakeEl;

    expect(result.isEmpty).toBe(true);
    expect(result.rows).toEqual([]);
    expect(root.attributes.get("data-empty")).toBe("true");
    expect(root.attributes.get("data-files-count")).toBe("0");

    const wrap = expectByClass(root, "qualy-chart-treemap__canvas-wrap");
    expect(wrap.children).toHaveLength(2);

    const empty = expectByClass(root, "qualy-chart-treemap__empty");
    expect(empty.tagName).toBe("p");
    expect(empty.textContent).toBe(CHART_TREEMAP_MESSAGES.empty);

    const canvas = expectByClass(root, "qualy-chart-treemap__canvas");
    expect(canvas.attributes.get("aria-label")).toMatch(/no violations/i);
  });

  it("returns canvas element regardless of empty state", () => {
    const { doc: docEmpty } = createFakeDoc();
    const empty = createChartTreemap(docEmpty, buildByMetric({}));
    expect((empty.canvas as FakeEl).tagName).toBe("canvas");

    const { doc: docFull } = createFakeDoc();
    const full = createChartTreemap(
      docFull,
      buildByMetric({ wmc: metric([{ file: "x.ts" }]) }),
    );
    expect((full.canvas as FakeEl).tagName).toBe("canvas");
  });

  it("returns the matching chartjs-chart-treemap config alongside the DOM", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(
      doc,
      buildByMetric({ wmc: metric([{ file: "x.ts" }]) }),
    );
    expect(result.config.type).toBe("treemap");
    expect(result.config.data.datasets[0]?.tree).toEqual(result.rows);
  });

  it("honors a custom title", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(doc, buildByMetric({}), { title: "Por arquivo" });
    const heading = expectByClass(result.root as FakeEl, "qualy-chart-treemap__title");
    expect(heading.textContent).toBe("Por arquivo");
  });

  it("forwards maxFiles into the aggregator (data-files-count reflects the truncated rows)", () => {
    const top: ViolationTopEntry[] = Array.from({ length: 10 }, (_, i) => ({
      file: `f${String(i).padStart(2, "0")}.ts`,
    }));
    const { doc } = createFakeDoc();
    const result = createChartTreemap(doc, buildByMetric({ wmc: metric(top) }), {
      maxFiles: 3,
    });
    expect(result.rows).toHaveLength(3);
    expect((result.root as FakeEl).attributes.get("data-files-count")).toBe("3");
  });

  it("forwards color overrides into the config builder", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(doc, buildByMetric({}), {
      colors: { border: "#000000" },
    });
    expect(result.config.data.datasets[0]?.borderColor).toBe("#000000");
  });

  it("uses lowercase tag names exclusively (createElement contract)", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(doc, buildByMetric({}));
    function walk(node: FakeEl): void {
      expect(node.tagName).toBe(node.tagName.toLowerCase());
      for (const child of node.children) walk(child);
    }
    walk(result.root as FakeEl);
  });

  it("creates only the elements it needs (no ghost children)", () => {
    const { doc, created } = createFakeDoc();
    createChartTreemap(doc, buildByMetric({}));
    // Empty: article + h3 + div + canvas + p = 5 elements.
    expect(created).toHaveLength(5);

    const { doc: docFull, created: createdFull } = createFakeDoc();
    createChartTreemap(docFull, buildByMetric({ wmc: metric([{ file: "x.ts" }]) }));
    // Non-empty: article + h3 + div + canvas = 4 elements.
    expect(createdFull).toHaveLength(4);
  });

  it("exposes the aggregated rows so callers can drive sibling components without re-aggregating", () => {
    const { doc } = createFakeDoc();
    const result = createChartTreemap(
      doc,
      buildByMetric({
        wmc: metric([{ file: "a.ts" }, { file: "a.ts" }]),
        cbo: metric([{ file: "a.ts" }, { file: "b.ts" }]),
      }),
    );
    expect(result.rows).toEqual([
      { file: "a.ts", value: 3, metrics: ["wmc", "cbo"] },
      { file: "b.ts", value: 1, metrics: ["cbo"] },
    ]);
  });
});
