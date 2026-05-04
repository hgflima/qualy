/**
 * Contract suite for `report/components/ViolationsTable`. Locks DOM scaffold,
 * column ordering, sort axes, a11y wiring, and empty-state rendering.
 * Mirrors the FakeDoc/FakeEl strategy `report-chart-treemap.test.ts` uses so
 * the report tests stay jsdom-free.
 */
import { describe, expect, it } from "vitest";

import type {
  MetricViolations,
  ViolationsByMetric,
  ViolationTopEntry,
} from "../../src/lib/audit-schema.ts";
import {
  COLUMNS,
  DEFAULT_MAX_ROWS,
  METRIC_IDS,
  SORT_KEYS,
  VIOLATIONS_TABLE_CLASS_NAMES,
  VIOLATIONS_TABLE_COLUMN_LABELS,
  VIOLATIONS_TABLE_MESSAGES,
  type SortKey,
  type ViolationsTableDoc,
  type ViolationsTableEl,
  createViolationsTable,
  flattenViolations,
  sortRows,
  tableCaption,
  truncateRows,
} from "../../src/report/components/ViolationsTable.ts";

// ---------------------------------------------------------------------------
// Fake DOM + helpers
// ---------------------------------------------------------------------------

interface FakeEl extends ViolationsTableEl {
  readonly attributes: Map<string, string>;
  readonly children: FakeEl[];
}

function createFakeDoc(): { doc: ViolationsTableDoc; readonly created: FakeEl[] } {
  const created: FakeEl[] = [];
  const doc: ViolationsTableDoc = {
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

function findAllByTag(root: FakeEl, tag: string): FakeEl[] {
  const acc: FakeEl[] = [];
  if (root.tagName === tag) acc.push(root);
  for (const child of root.children) {
    acc.push(...findAllByTag(child, tag));
  }
  return acc;
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

  it("exposes the four sort axes", () => {
    expect(SORT_KEYS).toEqual(["value-desc", "value-asc", "file-asc", "metric-asc"]);
  });

  it("caps default rows at 20 (top-N glanceable)", () => {
    expect(DEFAULT_MAX_ROWS).toBe(20);
  });

  it("exposes the canonical column ids in stable order", () => {
    expect(COLUMNS).toEqual(["metric", "file", "class", "value", "max"]);
  });

  it("exposes class-name constants for sibling components", () => {
    expect(VIOLATIONS_TABLE_CLASS_NAMES).toEqual({
      root: "qualy-violations-table",
      title: "qualy-violations-table__title",
      table: "qualy-violations-table__table",
      caption: "qualy-violations-table__caption",
      thead: "qualy-violations-table__thead",
      tbody: "qualy-violations-table__tbody",
      row: "qualy-violations-table__row",
      emptyRow: "qualy-violations-table__row--empty",
      cell: "qualy-violations-table__cell",
      header: "qualy-violations-table__header",
    });
  });

  it("exposes default title and empty-state message", () => {
    expect(VIOLATIONS_TABLE_MESSAGES.defaultTitle).toBe("Top violations");
    expect(VIOLATIONS_TABLE_MESSAGES.empty).toMatch(/no violations/i);
  });

  it("exposes human-readable column labels", () => {
    expect(VIOLATIONS_TABLE_COLUMN_LABELS).toEqual({
      metric: "Metric",
      file: "File",
      class: "Class",
      value: "Value",
      max: "Max",
    });
  });
});

// ---------------------------------------------------------------------------
// flattenViolations
// ---------------------------------------------------------------------------

describe("flattenViolations", () => {
  it("returns an empty list when no metric has top entries", () => {
    expect(flattenViolations(buildByMetric({}))).toEqual([]);
  });

  it("emits one row per top[] entry, tagged with its metric", () => {
    const rows = flattenViolations(
      buildByMetric({
        wmc: metric([{ file: "a.ts", value: 30, max: 20 }]),
        cbo: metric([{ file: "b.ts", value: 12, max: 10 }]),
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ metric: "wmc", file: "a.ts", value: 30, max: 20 });
    expect(rows[1]).toEqual({ metric: "cbo", file: "b.ts", value: 12, max: 10 });
  });

  it("preserves canonical metric order regardless of insertion shape", () => {
    // Insertion order in object literal is irrelevant — flatten walks
    // METRIC_IDS in canonical order.
    const rows = flattenViolations(
      buildByMetric({
        dit: metric([{ file: "d.ts" }]),
        wmc: metric([{ file: "a.ts" }]),
        cbo: metric([{ file: "c.ts" }]),
      }),
    );
    expect(rows.map((r) => r.metric)).toEqual(["wmc", "cbo", "dit"]);
  });

  it("preserves within-metric top[] order", () => {
    const rows = flattenViolations(
      buildByMetric({
        wmc: metric([
          { file: "third.ts" },
          { file: "first.ts" },
          { file: "second.ts" },
        ]),
      }),
    );
    expect(rows.map((r) => r.file)).toEqual(["third.ts", "first.ts", "second.ts"]);
  });

  it("propagates class/value/max only when present on the source entry", () => {
    const rows = flattenViolations(
      buildByMetric({
        wmc: metric([{ file: "a.ts", class: "Foo", value: 25, max: 20 }]),
        halstead: metric([{ file: "b.ts" }]), // halstead is per-file — no class
      }),
    );
    expect(rows[0]).toEqual({
      metric: "wmc",
      file: "a.ts",
      class: "Foo",
      value: 25,
      max: 20,
    });
    expect(rows[1]).toEqual({ metric: "halstead", file: "b.ts" });
    expect(rows[1]).not.toHaveProperty("class");
    expect(rows[1]).not.toHaveProperty("value");
    expect(rows[1]).not.toHaveProperty("max");
  });

  it("walks all five metrics", () => {
    const rows = flattenViolations(
      buildByMetric({
        wmc: metric([{ file: "x.ts" }]),
        halstead: metric([{ file: "x.ts" }]),
        lcom: metric([{ file: "x.ts" }]),
        cbo: metric([{ file: "x.ts" }]),
        dit: metric([{ file: "x.ts" }]),
      }),
    );
    expect(rows.map((r) => r.metric)).toEqual(["wmc", "halstead", "lcom", "cbo", "dit"]);
  });
});

// ---------------------------------------------------------------------------
// sortRows
// ---------------------------------------------------------------------------

describe("sortRows", () => {
  const rows = [
    { metric: "wmc" as const, file: "low.ts", value: 5, max: 20 },
    { metric: "cbo" as const, file: "high.ts", value: 15, max: 10 },
    { metric: "halstead" as const, file: "mid.ts", value: 10 },
    { metric: "wmc" as const, file: "no-value.ts" }, // no value
  ];

  it("defaults to value-desc when no axis is supplied", () => {
    const sorted = sortRows(rows);
    expect(sorted.map((r) => r.file)).toEqual(["high.ts", "mid.ts", "low.ts", "no-value.ts"]);
  });

  it("value-desc puts highest value first; missing value sinks to bottom", () => {
    const sorted = sortRows(rows, "value-desc");
    expect(sorted.map((r) => r.file)).toEqual(["high.ts", "mid.ts", "low.ts", "no-value.ts"]);
  });

  it("value-asc puts lowest value first; missing value still sinks to bottom", () => {
    const sorted = sortRows(rows, "value-asc");
    expect(sorted.map((r) => r.file)).toEqual(["low.ts", "mid.ts", "high.ts", "no-value.ts"]);
  });

  it("file-asc sorts lexicographically by file path", () => {
    const sorted = sortRows(rows, "file-asc");
    expect(sorted.map((r) => r.file)).toEqual(["high.ts", "low.ts", "mid.ts", "no-value.ts"]);
  });

  it("file-asc breaks ties by canonical metric order", () => {
    const sameFile = [
      { metric: "dit" as const, file: "a.ts", value: 1 },
      { metric: "wmc" as const, file: "a.ts", value: 2 },
      { metric: "lcom" as const, file: "a.ts", value: 3 },
    ];
    const sorted = sortRows(sameFile, "file-asc");
    expect(sorted.map((r) => r.metric)).toEqual(["wmc", "lcom", "dit"]);
  });

  it("metric-asc sorts by canonical metric order, ties by file path", () => {
    const sorted = sortRows(rows, "metric-asc");
    expect(sorted.map((r) => `${r.metric}:${r.file}`)).toEqual([
      "wmc:low.ts",
      "wmc:no-value.ts",
      "halstead:mid.ts",
      "cbo:high.ts",
    ]);
  });

  it("metric-asc breaks file ties by class", () => {
    const sameFile = [
      { metric: "wmc" as const, file: "a.ts", class: "Beta", value: 1 },
      { metric: "wmc" as const, file: "a.ts", class: "Alpha", value: 2 },
    ];
    const sorted = sortRows(sameFile, "metric-asc");
    expect(sorted.map((r) => r.class)).toEqual(["Alpha", "Beta"]);
  });

  it("does not mutate the input array", () => {
    const fresh = [...rows];
    sortRows(fresh, "value-asc");
    expect(fresh).toEqual(rows);
  });

  it("handles empty input", () => {
    expect(sortRows([])).toEqual([]);
    expect(sortRows([], "metric-asc")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// truncateRows
// ---------------------------------------------------------------------------

describe("truncateRows", () => {
  const rows = [
    { metric: "wmc" as const, file: "a.ts" },
    { metric: "wmc" as const, file: "b.ts" },
    { metric: "wmc" as const, file: "c.ts" },
  ];

  it("returns input untouched when length <= max", () => {
    expect(truncateRows(rows, 5)).toEqual(rows);
    expect(truncateRows(rows, 3)).toEqual(rows);
  });

  it("keeps the first N when length > max", () => {
    const trimmed = truncateRows(rows, 2);
    expect(trimmed).toHaveLength(2);
    expect(trimmed.map((r) => r.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("treats maxRows <= 0 as 'no cap'", () => {
    expect(truncateRows(rows, 0)).toEqual(rows);
    expect(truncateRows(rows, -1)).toEqual(rows);
  });

  it("defaults to DEFAULT_MAX_ROWS when no cap is supplied", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      metric: "wmc" as const,
      file: `f${i}.ts`,
    }));
    expect(truncateRows(many)).toHaveLength(DEFAULT_MAX_ROWS);
  });
});

// ---------------------------------------------------------------------------
// tableCaption
// ---------------------------------------------------------------------------

describe("tableCaption", () => {
  it("returns an empty-state caption when total is 0", () => {
    expect(tableCaption(0, 0, "value-desc")).toMatch(/no violations/i);
  });

  it("uses singular 'violation' for total == 1", () => {
    const cap = tableCaption(1, 1, "value-desc");
    expect(cap).toContain("1 violation,");
    expect(cap).not.toContain("1 violations");
  });

  it("uses plural 'violations' for total > 1", () => {
    expect(tableCaption(5, 5, "value-desc")).toContain("5 violations");
  });

  it("flags truncation when visible < total", () => {
    expect(tableCaption(50, 20, "value-desc")).toContain("20 of 50 violations");
  });

  it("does not flag truncation when visible >= total", () => {
    const cap = tableCaption(5, 5, "value-desc");
    expect(cap).not.toContain("of");
  });

  it("describes each sort axis with a human label", () => {
    expect(tableCaption(3, 3, "value-desc")).toMatch(/value.*highest/i);
    expect(tableCaption(3, 3, "value-asc")).toMatch(/value.*lowest/i);
    expect(tableCaption(3, 3, "file-asc")).toMatch(/by file/i);
    expect(tableCaption(3, 3, "metric-asc")).toMatch(/by metric/i);
  });
});

// ---------------------------------------------------------------------------
// createViolationsTable — DOM scaffold
// ---------------------------------------------------------------------------

describe("createViolationsTable", () => {
  function nonEmptyAudit(): ViolationsByMetric {
    return buildByMetric({
      wmc: metric([{ file: "src/a.ts", class: "Foo", value: 25, max: 20 }]),
      cbo: metric([{ file: "src/b.ts", class: "Bar", value: 12, max: 10 }]),
      halstead: metric([{ file: "src/c.ts", value: 1234.567 }]),
    });
  }

  it("builds the canonical structure for a non-empty audit", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());

    expect(result.root.tagName).toBe("article");
    expect(result.root.attributes.get("class")).toBe("qualy-violations-table");
    expect(result.root.attributes.get("data-empty")).toBe("false");
    expect(result.root.attributes.get("data-sort")).toBe("value-desc");
    expect(result.root.attributes.get("data-total")).toBe("3");
    expect(result.root.attributes.get("data-visible")).toBe("3");

    const heading = expectByClass(result.root as FakeEl, "qualy-violations-table__title");
    expect(heading.tagName).toBe("h3");
    expect(heading.textContent).toBe("Top violations");

    const table = expectByClass(result.root as FakeEl, "qualy-violations-table__table");
    expect(table.tagName).toBe("table");
    expect(table.attributes.get("role")).toBe("table");
    expect(result.table).toBe(table);

    const caption = expectByClass(table, "qualy-violations-table__caption");
    expect(caption.tagName).toBe("caption");
    expect(caption.textContent).toMatch(/3 violations/);
    expect(caption.textContent).toMatch(/value.*highest/);
  });

  it("renders the empty-state row when there are no violations", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, buildByMetric({}));

    expect(result.isEmpty).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.root.attributes.get("data-empty")).toBe("true");

    const tbody = expectByClass(result.root as FakeEl, "qualy-violations-table__tbody");
    const rows = findAllByTag(tbody, "tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attributes.get("class")).toContain("qualy-violations-table__row--empty");
    const cells = findAllByTag(rows[0] as FakeEl, "td");
    expect(cells).toHaveLength(1);
    expect(cells[0]?.attributes.get("colspan")).toBe(String(COLUMNS.length));
    expect(cells[0]?.textContent).toMatch(/no violations/i);
  });

  it("emits 5 column headers in canonical order with scope=col", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());

    const thead = expectByClass(result.root as FakeEl, "qualy-violations-table__thead");
    const headers = findAllByTag(thead, "th");
    expect(headers).toHaveLength(5);
    expect(headers.map((h) => h.attributes.get("data-column"))).toEqual([
      "metric",
      "file",
      "class",
      "value",
      "max",
    ]);
    for (const th of headers) {
      expect(th.attributes.get("scope")).toBe("col");
      expect(th.attributes.get("class")).toBe("qualy-violations-table__header");
    }
    expect(headers.map((h) => h.textContent)).toEqual([
      "Metric",
      "File",
      "Class",
      "Value",
      "Max",
    ]);
  });

  it("emits one tbody row per violation with data-metric/data-file attributes", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());

    const tbody = expectByClass(result.root as FakeEl, "qualy-violations-table__tbody");
    const rows = findAllByTag(tbody, "tr");
    expect(rows).toHaveLength(3);

    // Sorted by value desc: wmc(25) > cbo(12) > halstead(1234.567)
    // halstead value 1234.567 is the highest — value-desc puts it first.
    expect(rows[0]?.attributes.get("data-metric")).toBe("halstead");
    expect(rows[0]?.attributes.get("data-file")).toBe("src/c.ts");
    expect(rows[1]?.attributes.get("data-metric")).toBe("wmc");
    expect(rows[2]?.attributes.get("data-metric")).toBe("cbo");
  });

  it("renders cells in canonical column order with formatted values", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit(), { sort: "metric-asc" });

    const tbody = expectByClass(result.root as FakeEl, "qualy-violations-table__tbody");
    const rows = findAllByTag(tbody, "tr");

    // metric-asc: wmc, halstead, cbo
    const wmcCells = findAllByTag(rows[0] as FakeEl, "td");
    expect(wmcCells.map((c) => c.attributes.get("data-column"))).toEqual([
      "metric",
      "file",
      "class",
      "value",
      "max",
    ]);
    expect(wmcCells.map((c) => c.textContent)).toEqual([
      "wmc",
      "src/a.ts",
      "Foo",
      "25",
      "20",
    ]);

    // halstead row — no class, fractional value rounded to 2 decimals
    const halsteadCells = findAllByTag(rows[1] as FakeEl, "td");
    expect(halsteadCells.map((c) => c.textContent)).toEqual([
      "halstead",
      "src/c.ts",
      "—",
      "1234.57",
      "—",
    ]);
  });

  it("defaults to sort=value-desc and applies aria-sort to the value column", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());

    expect(result.sort).toBe("value-desc");
    const thead = expectByClass(result.root as FakeEl, "qualy-violations-table__thead");
    const headers = findAllByTag(thead, "th");
    const ariaSorts = Object.fromEntries(
      headers.map((h) => [h.attributes.get("data-column"), h.attributes.get("aria-sort")]),
    );
    expect(ariaSorts).toEqual({
      metric: "none",
      file: "none",
      class: "none",
      value: "descending",
      max: "none",
    });
  });

  const ariaSortMatrix: Array<{ sort: SortKey; column: string; expected: string }> = [
    { sort: "value-asc", column: "value", expected: "ascending" },
    { sort: "file-asc", column: "file", expected: "ascending" },
    { sort: "metric-asc", column: "metric", expected: "ascending" },
  ];
  for (const row of ariaSortMatrix) {
    it(`applies aria-sort=${row.expected} to the ${row.column} column when sort=${row.sort}`, () => {
      const { doc } = createFakeDoc();
      const result = createViolationsTable(doc, nonEmptyAudit(), { sort: row.sort });
      expect(result.sort).toBe(row.sort);
      expect(result.root.attributes.get("data-sort")).toBe(row.sort);
      const thead = expectByClass(result.root as FakeEl, "qualy-violations-table__thead");
      const headers = findAllByTag(thead, "th");
      const target = headers.find((h) => h.attributes.get("data-column") === row.column);
      expect(target?.attributes.get("aria-sort")).toBe(row.expected);
    });
  }

  it("respects maxRows by trimming the lowest-priority tail", () => {
    const audit = buildByMetric({
      wmc: metric([
        { file: "a.ts", value: 50 },
        { file: "b.ts", value: 40 },
        { file: "c.ts", value: 30 },
        { file: "d.ts", value: 20 },
      ]),
    });
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, audit, { maxRows: 2 });
    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.file)).toEqual(["a.ts", "b.ts"]);

    expect(result.root.attributes.get("data-total")).toBe("4");
    expect(result.root.attributes.get("data-visible")).toBe("2");

    const caption = expectByClass(result.root as FakeEl, "qualy-violations-table__caption");
    expect(caption.textContent).toMatch(/2 of 4 violations/);
  });

  it("treats maxRows <= 0 as 'no cap'", () => {
    const audit = buildByMetric({
      wmc: metric(Array.from({ length: 25 }, (_, i) => ({ file: `f${i}.ts`, value: i }))),
    });
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, audit, { maxRows: 0 });
    expect(result.rows).toHaveLength(25);
  });

  it("uses a custom title when provided", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit(), { title: "Quality drift" });
    const heading = expectByClass(result.root as FakeEl, "qualy-violations-table__title");
    expect(heading.textContent).toBe("Quality drift");
  });

  it("formats integer values without decimals and fractionals to 2 places", () => {
    const audit = buildByMetric({
      wmc: metric([{ file: "int.ts", value: 25, max: 20 }]),
      halstead: metric([{ file: "frac.ts", value: 1234.567, max: 1000 }]),
    });
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, audit, { sort: "file-asc" });
    const tbody = expectByClass(result.root as FakeEl, "qualy-violations-table__tbody");
    const trs = findAllByTag(tbody, "tr");
    const fracCells = findAllByTag(trs[0] as FakeEl, "td"); // frac.ts first (alphabetical)
    expect(fracCells[3]?.textContent).toBe("1234.57"); // value column
    const intCells = findAllByTag(trs[1] as FakeEl, "td");
    expect(intCells[3]?.textContent).toBe("25");
    expect(intCells[4]?.textContent).toBe("20");
  });

  it("falls back to em-dash for missing class/value/max", () => {
    const audit = buildByMetric({
      halstead: metric([{ file: "lonely.ts" }]), // no class/value/max
    });
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, audit);
    const tbody = expectByClass(result.root as FakeEl, "qualy-violations-table__tbody");
    const tr = findAllByTag(tbody, "tr")[0];
    const cells = findAllByTag(tr as FakeEl, "td");
    // Order: metric, file, class, value, max
    expect(cells.map((c) => c.textContent)).toEqual([
      "halstead",
      "lonely.ts",
      "—",
      "—",
      "—",
    ]);
  });

  it("uses lowercase tag names (HTML conformance)", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());
    function walk(el: FakeEl): void {
      expect(el.tagName).toBe(el.tagName.toLowerCase());
      el.children.forEach(walk);
    }
    walk(result.root as FakeEl);
  });

  it("returns the rendered rows so app.ts can wire interactivity without re-aggregating", () => {
    const { doc } = createFakeDoc();
    const result = createViolationsTable(doc, nonEmptyAudit());
    expect(result.rows).toHaveLength(3);
    // Every row carries metric + file at minimum (audit-schema invariant).
    for (const row of result.rows) {
      expect(typeof row.metric).toBe("string");
      expect(typeof row.file).toBe("string");
    }
  });

  it("never throws on a real-world brownfield audit shape (5 metrics, mixed data)", () => {
    const audit: ViolationsByMetric = {
      wmc: metric([
        { file: "src/router.ts", class: "Router", value: 32, max: 20 },
        { file: "src/handlers.ts", class: "Auth", value: 24, max: 20 },
      ]),
      halstead: metric([{ file: "src/parser.ts", value: 1500.42 }]),
      lcom: metric([{ file: "src/store.ts", class: "Cache", value: 5, max: 2 }]),
      cbo: metric([{ file: "src/router.ts", class: "Router", value: 18, max: 10 }]),
      dit: metric([]),
    };
    const { doc } = createFakeDoc();
    expect(() => createViolationsTable(doc, audit)).not.toThrow();
    const result = createViolationsTable(doc, audit);
    expect(result.total).toBe(5);
    expect(result.rows).toHaveLength(5);
  });
});
