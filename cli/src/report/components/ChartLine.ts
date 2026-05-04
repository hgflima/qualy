/**
 * `report/components/ChartLine` — atomic factory that renders the trend line
 * chart of audit history (errors + warnings over time).
 *
 * SPEC §7.7 acceptance line ("line de tendência por timestamp") + SPEC §4 line
 * 320 ("Charts: chart.js"). Following the MetricCard pattern (sibling): vanilla
 * DOM, pure factory, minimal structural types so unit tests run without jsdom
 * and the file itself never imports `chart.js`. Mounting the actual `Chart`
 * instance against the canvas is the caller's job (browser runtime in
 * `app.ts`); the component only emits the DOM scaffold and the deterministic
 * chart.js-shaped config.
 *
 * Why split scaffold from mount: chart.js is a browser-only dep (CommonJS
 * surface uses `window`). Importing it into the unit-test path forces jsdom or
 * mocking. Keeping the config pure and JSON-serializable lets tests lock the
 * output exactly the same way `MetricCard` locks attributes — drift surfaces
 * here before it reaches the browser.
 *
 * a11y: SPEC §4 line 324 — "navegação por teclado nos charts (descrição
 * textual via aria-label)". The `<canvas>` carries `role="img"` and an
 * `aria-label` that summarizes the trend in plain language ("3 audits, latest:
 * 12 errors, 47 warnings"). Empty histories render an explicit "no data yet"
 * label so the chart never reads as silent.
 */

import type { ReportHistoryEntry } from "../data-loader.ts";

// ---------------------------------------------------------------------------
// Public data contract
// ---------------------------------------------------------------------------

/**
 * Maximum entries plotted by default. SPEC §4 leaves the cap as an
 * implementation detail; 30 audits keeps the X axis legible while covering
 * a typical month of churn at the rate `/lint:audit` is invoked.
 */
export const DEFAULT_MAX_POINTS = 30;

/** Stable dataset identifiers — locked so themes/CSS can target them. */
export const DATASET_IDS = ["errors", "warnings"] as const;
export type DatasetId = (typeof DATASET_IDS)[number];

export interface DatasetTheme {
  readonly errors: string;
  readonly warnings: string;
}

/**
 * Default border colors. Themes can override via `ChartLineOptions.colors`
 * (the report's theme tokens emit CSS custom properties, but chart.js needs
 * concrete strings — themes resolve those at mount time and pass them in).
 */
export const DEFAULT_COLORS: DatasetTheme = {
  errors: "#e5484d",
  warnings: "#f0a900",
};

export interface ChartLineOptions {
  /** Cap on entries plotted; defaults to {@link DEFAULT_MAX_POINTS}. */
  readonly maxPoints?: number;
  /** Border colors per dataset. */
  readonly colors?: Partial<DatasetTheme>;
  /** Override the heading ("Audit history" by default). */
  readonly title?: string;
}

// ---------------------------------------------------------------------------
// Minimal DOM surface (mirrors MetricCard for consistency)
// ---------------------------------------------------------------------------

export interface ChartLineEl {
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: ChartLineEl): ChartLineEl;
}

export interface ChartLineDoc {
  createElement(tag: string): ChartLineEl;
}

// ---------------------------------------------------------------------------
// Chart.js config — structural types only (no chart.js import)
// ---------------------------------------------------------------------------

export interface ChartLineDataset {
  readonly id: DatasetId;
  readonly label: string;
  readonly data: readonly number[];
  readonly borderColor: string;
  readonly backgroundColor: string;
  readonly fill: false;
  readonly tension: number;
  readonly pointRadius: number;
  readonly borderWidth: number;
}

export interface ChartLineConfig {
  readonly type: "line";
  readonly data: {
    readonly labels: readonly string[];
    readonly datasets: readonly ChartLineDataset[];
  };
  readonly options: {
    readonly responsive: true;
    readonly maintainAspectRatio: false;
    readonly animation: false | { readonly duration: number };
    readonly plugins: {
      readonly legend: { readonly display: true; readonly position: "bottom" };
      readonly tooltip: { readonly enabled: true; readonly mode: "index"; readonly intersect: false };
    };
    readonly interaction: { readonly mode: "index"; readonly intersect: false };
    readonly scales: {
      readonly x: { readonly grid: { readonly display: false } };
      readonly y: { readonly beginAtZero: true; readonly grid: { readonly color: string } };
    };
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Trim history to the last `max` entries. The loader produces ascending order
 * (oldest first); we keep the tail so the chart shows the most recent run on
 * the right edge — convention chart.js readers expect.
 */
export function truncateHistory(
  entries: readonly ReportHistoryEntry[],
  max: number,
): readonly ReportHistoryEntry[] {
  if (max <= 0 || entries.length <= max) return entries;
  return entries.slice(entries.length - max);
}

/**
 * Convert a history entry into the X-axis label. Audit timestamps are minute-
 * precise ISO strings (e.g. `2026-05-03T14-22-11Z`); we surface only the date
 * portion so multiple audits per day collapse visually but the tooltip
 * (driven by chart.js `index` mode) still distinguishes them via dataset
 * value.
 */
export function formatLabel(entry: ReportHistoryEntry): string {
  // `timestamp` is the audit filename without `.json`, e.g. `2026-05-03T14-22-11Z`.
  // `generated_at` is the canonical ISO8601 string. Prefer the latter when present.
  const source = entry.generated_at.length > 0 ? entry.generated_at : entry.timestamp;
  // Take everything before the first `T`; fallback to the whole string when
  // the timestamp is malformed (history loader already filters, but we stay
  // defensive in case a future caller bypasses validation).
  const tIndex = source.indexOf("T");
  return tIndex > 0 ? source.slice(0, tIndex) : source;
}

/**
 * Build the textual a11y summary for the canvas. Plain-language description
 * of what the chart shows — read out by screen readers when keyboard
 * navigation lands on the canvas.
 */
export function chartAriaLabel(entries: readonly ReportHistoryEntry[]): string {
  if (entries.length === 0) {
    return "Audit history line chart: no audits recorded yet";
  }
  const latest = entries[entries.length - 1];
  if (latest === undefined) {
    return "Audit history line chart: no audits recorded yet";
  }
  const word = entries.length === 1 ? "audit" : "audits";
  return (
    `Audit history line chart: ${entries.length} ${word}, ` +
    `latest ${latest.errors} errors and ${latest.warnings} warnings`
  );
}

/**
 * Resolve dataset colors with caller overrides layered on top of defaults.
 * Pure — no DOM or `getComputedStyle` access.
 */
export function resolveColors(override?: Partial<DatasetTheme>): DatasetTheme {
  return {
    errors: override?.errors ?? DEFAULT_COLORS.errors,
    warnings: override?.warnings ?? DEFAULT_COLORS.warnings,
  };
}

// ---------------------------------------------------------------------------
// Chart.js config builder
// ---------------------------------------------------------------------------

const DATASET_LABELS: Readonly<Record<DatasetId, string>> = {
  errors: "Errors",
  warnings: "Warnings",
};

/**
 * Convert a history slice into a chart.js Line config. JSON-serializable so
 * `report-export` can inline it verbatim into the self-contained HTML.
 */
export function buildChartLineConfig(
  entries: readonly ReportHistoryEntry[],
  options: ChartLineOptions = {},
): ChartLineConfig {
  const max = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const slice = truncateHistory(entries, max);
  const colors = resolveColors(options.colors);

  const labels = slice.map(formatLabel);
  const datasets: ChartLineDataset[] = DATASET_IDS.map((id) => ({
    id,
    label: DATASET_LABELS[id],
    data: slice.map((entry) => entry[id]),
    borderColor: colors[id],
    backgroundColor: colors[id],
    fill: false,
    tension: 0.25,
    pointRadius: 3,
    borderWidth: 2,
  }));

  return {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // SPEC §4 line 322 — `prefers-reduced-motion`. Animations off by default
      // keeps the chart accessible without a runtime check; themes can opt in.
      animation: false,
      plugins: {
        legend: { display: true, position: "bottom" },
        tooltip: { enabled: true, mode: "index", intersect: false },
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "rgba(127,127,127,0.15)" } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const CLASS_ROOT = "qualy-chart-line";
const CLASS_TITLE = "qualy-chart-line__title";
const CLASS_CANVAS_WRAP = "qualy-chart-line__canvas-wrap";
const CLASS_CANVAS = "qualy-chart-line__canvas";
const CLASS_EMPTY = "qualy-chart-line__empty";

const DEFAULT_TITLE = "Audit history";
const EMPTY_MESSAGE = "No audits recorded yet — run /lint:audit to populate the trend.";

export interface CreateChartLineResult {
  /** Detached `<article>` root — caller mounts it. */
  readonly root: ChartLineEl;
  /**
   * The `<canvas>` element inside `root`. Caller passes this to chart.js:
   * `new Chart(canvas, result.config)`. Returned even when history is empty
   * (the empty-state placeholder replaces it visually but the canvas stays
   * for layout consistency); `null` would force every caller to branch.
   */
  readonly canvas: ChartLineEl;
  /** JSON-serializable chart.js config. Inline-safe for `report-export`. */
  readonly config: ChartLineConfig;
  /** Whether `entries` was empty — themes/css drive empty-state styling. */
  readonly isEmpty: boolean;
}

/**
 * Build the chart article: heading + `<canvas>` (or empty-state placeholder
 * sibling). Returns the root, the canvas element, and the chart.js config so
 * `app.ts` can decide whether to mount chart.js (browser) or skip (export
 * pre-render).
 */
export function createChartLine(
  doc: ChartLineDoc,
  entries: readonly ReportHistoryEntry[],
  options: ChartLineOptions = {},
): CreateChartLineResult {
  const config = buildChartLineConfig(entries, options);
  const isEmpty = entries.length === 0;
  const title = options.title ?? DEFAULT_TITLE;

  const root = doc.createElement("article");
  root.setAttribute("class", CLASS_ROOT);
  root.setAttribute("data-empty", isEmpty ? "true" : "false");
  root.setAttribute("data-history-length", String(entries.length));

  const heading = doc.createElement("h3");
  heading.setAttribute("class", CLASS_TITLE);
  heading.textContent = title;
  root.appendChild(heading);

  const wrap = doc.createElement("div");
  wrap.setAttribute("class", CLASS_CANVAS_WRAP);
  root.appendChild(wrap);

  const canvas = doc.createElement("canvas");
  canvas.setAttribute("class", CLASS_CANVAS);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", chartAriaLabel(entries));
  wrap.appendChild(canvas);

  if (isEmpty) {
    const empty = doc.createElement("p");
    empty.setAttribute("class", CLASS_EMPTY);
    empty.textContent = EMPTY_MESSAGE;
    wrap.appendChild(empty);
  }

  return { root, canvas, config, isEmpty };
}

// ---------------------------------------------------------------------------
// Class name + message constants exported for tests + sibling components
// ---------------------------------------------------------------------------

export const CHART_LINE_CLASS_NAMES = {
  root: CLASS_ROOT,
  title: CLASS_TITLE,
  canvasWrap: CLASS_CANVAS_WRAP,
  canvas: CLASS_CANVAS,
  empty: CLASS_EMPTY,
} as const;

export const CHART_LINE_MESSAGES = {
  defaultTitle: DEFAULT_TITLE,
  empty: EMPTY_MESSAGE,
} as const;
