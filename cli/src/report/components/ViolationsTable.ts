/**
 * `report/components/ViolationsTable` — atomic factory that renders the
 * top-N quality violations as a sortable HTML table. SPEC §7.7 acceptance
 * line ("top-N violações com sort").
 *
 * Vanilla DOM, pure factory, minimal structural types so unit tests run
 * without jsdom — same pattern as the sibling `ChartLine` / `ChartTreemap`.
 * The component flattens `violations.by_metric.<metric>.top[]` from the audit
 * payload into one row per incident and emits a static `<table>`. Interactive
 * sorting (clicking column headers) is `app.ts`'s job in the browser; this
 * factory only emits the deterministic baseline so `report-export` can inline
 * the same markup that ships at runtime.
 *
 * Why a flat per-incident row (not per file): the chart treemap groups by
 * file. The table is the audit-grade view — every entry from `top[]` shows up
 * with its metric, optional class, value, and threshold so reviewers can
 * triage without cross-referencing the JSON. Aggregation lives in
 * `ChartTreemap`.
 *
 * a11y: the `<table>` carries a `<caption>` summarizing what's plotted (row
 * count + active sort) so screen readers pick up the context before reading
 * the rows. Empty input renders a single placeholder row with `colspan` so
 * the table reads as "no violations" instead of "empty grid".
 */

import type {
  MetricKey,
  ViolationTopEntry,
  ViolationsByMetric,
} from "../../lib/audit-schema.ts";

// ---------------------------------------------------------------------------
// Public data contract
// ---------------------------------------------------------------------------

/**
 * Default cap on rows rendered. SPEC §7.7 calls this "top-N" without fixing
 * N — 20 keeps the table glanceable while leaving headroom for legit
 * brownfield audits with many violations.
 */
export const DEFAULT_MAX_ROWS = 20;

/** Stable metric keys iterated when flattening; exported for tests. */
export const METRIC_IDS = ["wmc", "halstead", "lcom", "cbo", "dit"] as const satisfies readonly MetricKey[];

/** Sort axes the table understands. Default `value-desc`. */
export const SORT_KEYS = ["value-desc", "value-asc", "file-asc", "metric-asc"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/**
 * Flattened violation row — one per `top[]` entry across the five metrics.
 * `value` / `max` are optional because metric-specific shapes vary (Halstead
 * is per-file with no class; LCOM is per-class; etc — see audit-schema's
 * `violationTopEntrySchema`).
 */
export interface ViolationRow {
  readonly metric: MetricKey;
  readonly file: string;
  readonly class?: string;
  readonly value?: number;
  readonly max?: number;
}

export interface ViolationsTableOptions {
  /** Cap on rows rendered; defaults to {@link DEFAULT_MAX_ROWS}. */
  readonly maxRows?: number;
  /** Initial sort axis; defaults to `value-desc`. */
  readonly sort?: SortKey;
  /** Override the heading ("Top violations" by default). */
  readonly title?: string;
}

// ---------------------------------------------------------------------------
// Minimal DOM surface (mirrors ChartTreemap / ChartLine for consistency)
// ---------------------------------------------------------------------------

export interface ViolationsTableEl {
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: ViolationsTableEl): ViolationsTableEl;
}

export interface ViolationsTableDoc {
  createElement(tag: string): ViolationsTableEl;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Walk every `top[]` entry across the five metrics and produce one row per
 * incident, tagged with its metric. Order before sort: insertion order across
 * metrics (canonical `METRIC_IDS` order, then within-metric `top[]` order) —
 * stable so equal-keyed rows preserve a deterministic relative order.
 */
export function flattenViolations(
  byMetric: ViolationsByMetric,
): readonly ViolationRow[] {
  const rows: ViolationRow[] = [];
  for (const metric of METRIC_IDS) {
    const block = byMetric[metric];
    for (const entry of block.top) {
      rows.push(toRow(metric, entry));
    }
  }
  return rows;
}

function toRow(metric: MetricKey, entry: ViolationTopEntry): ViolationRow {
  // Build only the keys present so that downstream tests can assert
  // `class`/`value`/`max` are absent (not just undefined) when the audit
  // doesn't carry them.
  const row: { -readonly [K in keyof ViolationRow]: ViolationRow[K] } = {
    metric,
    file: entry.file,
  };
  if (entry.class !== undefined) row.class = entry.class;
  if (entry.value !== undefined) row.value = entry.value;
  if (entry.max !== undefined) row.max = entry.max;
  return row;
}

/**
 * Sort rows by the requested axis. Returns a new array; never mutates input.
 *
 * - `value-desc` (default): highest `value` first; rows without `value` sink
 *   to the bottom (treated as `-Infinity`).
 * - `value-asc`: lowest `value` first; missing `value` rises to the top
 *   (`+Infinity` semantics flipped intentionally — the absence of a value
 *   means "we don't know how bad it is", which is least informative for a
 *   "least bad" sort, so push to the bottom there too).
 * - `file-asc`: lexicographic by file path, then metric canonical order.
 * - `metric-asc`: by canonical metric order (`wmc` first), then file.
 *
 * Tie-breakers are deterministic across all axes so the rendered HTML is
 * stable across runs (`report-export` snapshots depend on this).
 */
export function sortRows(
  rows: readonly ViolationRow[],
  sort: SortKey = "value-desc",
): readonly ViolationRow[] {
  const metricRank = new Map<MetricKey, number>(METRIC_IDS.map((m, i) => [m, i]));
  const list = [...rows];
  list.sort((a, b) => {
    switch (sort) {
      case "value-desc": {
        const av = a.value ?? -Infinity;
        const bv = b.value ?? -Infinity;
        if (av !== bv) return bv - av;
        return tiebreak(a, b, metricRank);
      }
      case "value-asc": {
        // Rows without value are considered "least informative" — push to
        // the bottom rather than the top so users always see ranked rows
        // first regardless of axis.
        const av = a.value ?? Infinity;
        const bv = b.value ?? Infinity;
        if (av !== bv) return av - bv;
        return tiebreak(a, b, metricRank);
      }
      case "file-asc": {
        const c = a.file.localeCompare(b.file);
        if (c !== 0) return c;
        const ar = metricRank.get(a.metric) ?? 0;
        const br = metricRank.get(b.metric) ?? 0;
        return ar - br;
      }
      case "metric-asc": {
        const ar = metricRank.get(a.metric) ?? 0;
        const br = metricRank.get(b.metric) ?? 0;
        if (ar !== br) return ar - br;
        const c = a.file.localeCompare(b.file);
        if (c !== 0) return c;
        return (a.class ?? "").localeCompare(b.class ?? "");
      }
    }
  });
  return list;
}

function tiebreak(
  a: ViolationRow,
  b: ViolationRow,
  metricRank: Map<MetricKey, number>,
): number {
  const c = a.file.localeCompare(b.file);
  if (c !== 0) return c;
  const ar = metricRank.get(a.metric) ?? 0;
  const br = metricRank.get(b.metric) ?? 0;
  if (ar !== br) return ar - br;
  return (a.class ?? "").localeCompare(b.class ?? "");
}

/**
 * Truncate to the requested cap. `maxRows <= 0` disables the cap. Pure.
 */
export function truncateRows(
  rows: readonly ViolationRow[],
  maxRows: number = DEFAULT_MAX_ROWS,
): readonly ViolationRow[] {
  if (maxRows <= 0) return rows;
  return rows.length <= maxRows ? rows : rows.slice(0, maxRows);
}

/**
 * Plain-language caption for the `<table>` — read by screen readers before
 * the rows. Surfaces total + visible counts and the active sort axis.
 */
export function tableCaption(
  total: number,
  visible: number,
  sort: SortKey,
): string {
  if (total === 0) return "Top violations: no violations recorded";
  const noun = total === 1 ? "violation" : "violations";
  if (visible >= total) {
    return `Top violations: ${total} ${noun}, sorted by ${labelForSort(sort)}`;
  }
  return `Top violations: ${visible} of ${total} ${noun}, sorted by ${labelForSort(sort)}`;
}

function labelForSort(sort: SortKey): string {
  switch (sort) {
    case "value-desc":
      return "value (highest first)";
    case "value-asc":
      return "value (lowest first)";
    case "file-asc":
      return "file";
    case "metric-asc":
      return "metric";
  }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const CLASS_ROOT = "qualy-violations-table";
const CLASS_TITLE = "qualy-violations-table__title";
const CLASS_TABLE = "qualy-violations-table__table";
const CLASS_CAPTION = "qualy-violations-table__caption";
const CLASS_THEAD = "qualy-violations-table__thead";
const CLASS_TBODY = "qualy-violations-table__tbody";
const CLASS_ROW = "qualy-violations-table__row";
const CLASS_EMPTY_ROW = "qualy-violations-table__row--empty";
const CLASS_CELL = "qualy-violations-table__cell";
const CLASS_HEADER = "qualy-violations-table__header";

const DEFAULT_TITLE = "Top violations";
const EMPTY_MESSAGE = "No violations recorded — nothing to triage.";

/** Column ids — also used as `data-column` attributes for app.ts sort wiring. */
export const COLUMNS = ["metric", "file", "class", "value", "max"] as const;
export type ColumnId = (typeof COLUMNS)[number];

const COLUMN_LABELS: Record<ColumnId, string> = {
  metric: "Metric",
  file: "File",
  class: "Class",
  value: "Value",
  max: "Max",
};

export interface CreateViolationsTableResult {
  /** Detached `<article>` root — caller mounts it. */
  readonly root: ViolationsTableEl;
  /** The `<table>` element inside `root`. */
  readonly table: ViolationsTableEl;
  /** Rows actually rendered (after sort + truncate). */
  readonly rows: readonly ViolationRow[];
  /** Active sort axis. */
  readonly sort: SortKey;
  /** Total violation count before truncation (for caption / app.ts). */
  readonly total: number;
  /** Whether `rows` was empty — themes/css drive empty-state styling. */
  readonly isEmpty: boolean;
}

/**
 * Build the violations table article: heading + `<table>` with caption,
 * thead, and tbody. Returns the root, the table element, and the sorted/
 * truncated rows so `app.ts` can read the baseline before wiring sort
 * interactivity.
 */
export function createViolationsTable(
  doc: ViolationsTableDoc,
  byMetric: ViolationsByMetric,
  options: ViolationsTableOptions = {},
): CreateViolationsTableResult {
  const sort: SortKey = options.sort ?? "value-desc";
  const flat = flattenViolations(byMetric);
  const sorted = sortRows(flat, sort);
  const rows = truncateRows(sorted, options.maxRows);
  const total = flat.length;
  const isEmpty = rows.length === 0;
  const title = options.title ?? DEFAULT_TITLE;

  const root = doc.createElement("article");
  root.setAttribute("class", CLASS_ROOT);
  root.setAttribute("data-empty", isEmpty ? "true" : "false");
  root.setAttribute("data-sort", sort);
  root.setAttribute("data-total", String(total));
  root.setAttribute("data-visible", String(rows.length));

  const heading = doc.createElement("h3");
  heading.setAttribute("class", CLASS_TITLE);
  heading.textContent = title;
  root.appendChild(heading);

  const table = doc.createElement("table");
  table.setAttribute("class", CLASS_TABLE);
  // a11y: explicit role helps when CSS overrides display (e.g. responsive
  // card view collapses `<tbody>` to grid).
  table.setAttribute("role", "table");
  root.appendChild(table);

  const caption = doc.createElement("caption");
  caption.setAttribute("class", CLASS_CAPTION);
  caption.textContent = tableCaption(total, rows.length, sort);
  table.appendChild(caption);

  const thead = doc.createElement("thead");
  thead.setAttribute("class", CLASS_THEAD);
  const headRow = doc.createElement("tr");
  for (const column of COLUMNS) {
    const th = doc.createElement("th");
    th.setAttribute("class", CLASS_HEADER);
    th.setAttribute("scope", "col");
    th.setAttribute("data-column", column);
    th.setAttribute("aria-sort", ariaSortFor(column, sort));
    th.textContent = COLUMN_LABELS[column];
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement("tbody");
  tbody.setAttribute("class", CLASS_TBODY);
  table.appendChild(tbody);

  if (isEmpty) {
    const tr = doc.createElement("tr");
    tr.setAttribute("class", `${CLASS_ROW} ${CLASS_EMPTY_ROW}`);
    const td = doc.createElement("td");
    td.setAttribute("class", CLASS_CELL);
    td.setAttribute("colspan", String(COLUMNS.length));
    td.textContent = EMPTY_MESSAGE;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of rows) {
      const tr = doc.createElement("tr");
      tr.setAttribute("class", CLASS_ROW);
      tr.setAttribute("data-metric", row.metric);
      tr.setAttribute("data-file", row.file);
      for (const column of COLUMNS) {
        const td = doc.createElement("td");
        td.setAttribute("class", CLASS_CELL);
        td.setAttribute("data-column", column);
        td.textContent = cellText(row, column);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  return { root, table, rows, sort, total, isEmpty };
}

function ariaSortFor(column: ColumnId, sort: SortKey): "ascending" | "descending" | "none" {
  if (column === "value") {
    if (sort === "value-desc") return "descending";
    if (sort === "value-asc") return "ascending";
    return "none";
  }
  if (column === "file" && sort === "file-asc") return "ascending";
  if (column === "metric" && sort === "metric-asc") return "ascending";
  return "none";
}

function cellText(row: ViolationRow, column: ColumnId): string {
  switch (column) {
    case "metric":
      return row.metric;
    case "file":
      return row.file;
    case "class":
      return row.class ?? "—";
    case "value":
      return row.value === undefined ? "—" : formatNumber(row.value);
    case "max":
      return row.max === undefined ? "—" : formatNumber(row.max);
  }
}

function formatNumber(value: number): string {
  // Integers print bare; fractionals get up to 2 decimals (Halstead volumes
  // are often big floats like 1234.567 — rounding keeps the column readable
  // without lying about precision).
  if (Number.isInteger(value)) return String(value);
  return (Math.round(value * 100) / 100).toString();
}

// ---------------------------------------------------------------------------
// Class name + message constants exported for tests + sibling components
// ---------------------------------------------------------------------------

export const VIOLATIONS_TABLE_CLASS_NAMES = {
  root: CLASS_ROOT,
  title: CLASS_TITLE,
  table: CLASS_TABLE,
  caption: CLASS_CAPTION,
  thead: CLASS_THEAD,
  tbody: CLASS_TBODY,
  row: CLASS_ROW,
  emptyRow: CLASS_EMPTY_ROW,
  cell: CLASS_CELL,
  header: CLASS_HEADER,
} as const;

export const VIOLATIONS_TABLE_MESSAGES = {
  defaultTitle: DEFAULT_TITLE,
  empty: EMPTY_MESSAGE,
} as const;

export const VIOLATIONS_TABLE_COLUMN_LABELS = COLUMN_LABELS;
