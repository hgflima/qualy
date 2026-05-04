/**
 * `report/components/ChartTreemap` — atomic factory that renders a treemap of
 * quality violations grouped by file. Rectangles are sized by the number of
 * `top[]` entries that name the file across the five quality-metrics
 * (`wmc/halstead/lcom/cbo/dit`); larger rectangles = more violation incidents.
 *
 * SPEC §7.7 acceptance line ("treemap por arquivo") + SPEC §4 line 320
 * ("Charts: chart.js + chartjs-plugin-treemap"). The runtime dep is published
 * as `chartjs-chart-treemap` (v3); the SPEC's slug is the abandoned name.
 *
 * Pattern matches the sibling `ChartLine`: vanilla DOM, pure factory, minimal
 * structural types so unit tests run without jsdom, and the file itself never
 * imports `chart.js` / `chartjs-chart-treemap`. Mounting the actual `Chart`
 * instance against the canvas is the caller's job (browser runtime in
 * `app.ts`); the component only emits the DOM scaffold and the deterministic
 * chart.js-shaped config.
 *
 * Why split scaffold from mount: chartjs-chart-treemap is a browser-only
 * plugin. Importing it into the unit-test path forces jsdom or mocking.
 * Keeping the config pure and JSON-serializable lets tests lock the output
 * exactly the same way `MetricCard` and `ChartLine` lock attributes — drift
 * surfaces here before it reaches the browser.
 *
 * a11y: SPEC §4 line 324 — "navegação por teclado nos charts (descrição
 * textual via aria-label)". The `<canvas>` carries `role="img"` and an
 * `aria-label` summarizing the treemap in plain language ("3 files violating,
 * worst: src/foo.ts with 5 incidents"). Empty inputs render an explicit
 * "no violations" label so the chart never reads as silent.
 */

import type {
  MetricKey,
  ViolationsByMetric,
} from "../../lib/audit-schema.ts";

// ---------------------------------------------------------------------------
// Public data contract
// ---------------------------------------------------------------------------

/**
 * Maximum rectangles plotted by default. Treemap legibility falls off fast
 * past ~50 rectangles; SPEC §4 leaves the cap as an implementation detail.
 */
export const DEFAULT_MAX_FILES = 50;

/** Stable metric keys iterated when aggregating; exported for tests. */
export const METRIC_IDS = ["wmc", "halstead", "lcom", "cbo", "dit"] as const satisfies readonly MetricKey[];

/**
 * Aggregated per-file violation row. `value` is the count of `top[]` entries
 * that named this file across all five metrics — used as the treemap rectangle
 * size. `metrics` lists which metrics fired (sorted by canonical order) so
 * tooltips/labels can show "wmc, lcom" without recomputing.
 */
export interface FileViolation {
  readonly file: string;
  readonly value: number;
  readonly metrics: readonly MetricKey[];
}

export interface ChartTreemapOptions {
  /** Cap on rectangles plotted; defaults to {@link DEFAULT_MAX_FILES}. */
  readonly maxFiles?: number;
  /** Border / fill color overrides (themes resolve CSS tokens at mount time). */
  readonly colors?: {
    readonly border?: string;
    readonly background?: string;
  };
  /** Override the heading ("Violations by file" by default). */
  readonly title?: string;
}

// ---------------------------------------------------------------------------
// Minimal DOM surface (mirrors MetricCard / ChartLine for consistency)
// ---------------------------------------------------------------------------

export interface ChartTreemapEl {
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: ChartTreemapEl): ChartTreemapEl;
}

export interface ChartTreemapDoc {
  createElement(tag: string): ChartTreemapEl;
}

// ---------------------------------------------------------------------------
// Default colors
// ---------------------------------------------------------------------------

/**
 * Default colors. Themes can override via `ChartTreemapOptions.colors` (CSS
 * custom properties resolved at mount time and passed in as concrete strings).
 */
export const DEFAULT_COLORS = {
  border: "#e5484d",
  background: "rgba(229,72,77,0.55)",
} as const;

// ---------------------------------------------------------------------------
// Chart.js / chartjs-chart-treemap config — structural types only
// ---------------------------------------------------------------------------

export interface ChartTreemapDataset {
  readonly label: string;
  readonly tree: readonly FileViolation[];
  readonly key: "value";
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly backgroundColor: string;
  readonly spacing: number;
}

export interface ChartTreemapConfig {
  readonly type: "treemap";
  readonly data: {
    readonly datasets: readonly [ChartTreemapDataset];
  };
  readonly options: {
    readonly responsive: true;
    readonly maintainAspectRatio: false;
    readonly animation: false | { readonly duration: number };
    readonly plugins: {
      readonly legend: { readonly display: false };
      readonly tooltip: { readonly enabled: true };
    };
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Walk every `top[]` entry across the five metrics and build a per-file count.
 * Each `top[]` entry contributes `+1` to the file's value (we count incidents,
 * not WMC/CBO numerical values, because the values across metrics are not
 * comparable). `metrics` lists the canonical metrics that fired for this file.
 *
 * Sort: descending by `value`, ties broken by file path for determinism.
 * Truncation respects `maxFiles` (≤0 disables the cap).
 */
export function aggregateViolationsByFile(
  byMetric: ViolationsByMetric,
  options: { readonly maxFiles?: number } = {},
): readonly FileViolation[] {
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;

  interface Accum {
    value: number;
    metrics: Set<MetricKey>;
  }
  const accum = new Map<string, Accum>();

  for (const metric of METRIC_IDS) {
    const block = byMetric[metric];
    for (const entry of block.top) {
      const existing = accum.get(entry.file) ?? { value: 0, metrics: new Set() };
      existing.value += 1;
      existing.metrics.add(metric);
      accum.set(entry.file, existing);
    }
  }

  const list: FileViolation[] = [];
  for (const [file, slot] of accum) {
    list.push({
      file,
      value: slot.value,
      metrics: METRIC_IDS.filter((m) => slot.metrics.has(m)),
    });
  }
  list.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.file.localeCompare(b.file);
  });
  return max <= 0 ? list : list.slice(0, max);
}

/**
 * Build the textual a11y summary for the canvas. Plain-language description
 * of what the chart shows — read out by screen readers when keyboard
 * navigation lands on the canvas.
 */
export function chartAriaLabel(rows: readonly FileViolation[]): string {
  if (rows.length === 0) {
    return "Violations treemap: no violations recorded";
  }
  const top = rows[0];
  if (top === undefined) {
    return "Violations treemap: no violations recorded";
  }
  const fileWord = rows.length === 1 ? "file" : "files";
  const incidentWord = top.value === 1 ? "incident" : "incidents";
  return (
    `Violations treemap: ${rows.length} ${fileWord} violating, ` +
    `worst ${top.file} with ${top.value} ${incidentWord}`
  );
}

/**
 * Resolve dataset colors with caller overrides layered on top of defaults.
 * Pure — no DOM or `getComputedStyle` access.
 */
export function resolveColors(
  override?: ChartTreemapOptions["colors"],
): { readonly border: string; readonly background: string } {
  return {
    border: override?.border ?? DEFAULT_COLORS.border,
    background: override?.background ?? DEFAULT_COLORS.background,
  };
}

// ---------------------------------------------------------------------------
// Chart.js config builder
// ---------------------------------------------------------------------------

const DATASET_LABEL = "Violations by file";

/**
 * Convert aggregated rows into a chartjs-chart-treemap config. JSON-
 * serializable so `report-export` can inline it verbatim into the self-
 * contained HTML. Caller is responsible for aggregation (via
 * {@link aggregateViolationsByFile}) before invoking this builder.
 */
export function buildChartTreemapConfig(
  rows: readonly FileViolation[],
  options: ChartTreemapOptions = {},
): ChartTreemapConfig {
  const colors = resolveColors(options.colors);

  return {
    type: "treemap",
    data: {
      datasets: [
        {
          label: DATASET_LABEL,
          tree: rows,
          key: "value",
          borderColor: colors.border,
          borderWidth: 1,
          backgroundColor: colors.background,
          spacing: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // SPEC §4 line 322 — `prefers-reduced-motion`. Animations off by default
      // keeps the chart accessible without a runtime check; themes can opt in.
      animation: false,
      plugins: {
        // Treemaps have one synthetic dataset; legend would just show the
        // dataset label. We surface that via the `<h3>` heading instead.
        legend: { display: false },
        tooltip: { enabled: true },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const CLASS_ROOT = "qualy-chart-treemap";
const CLASS_TITLE = "qualy-chart-treemap__title";
const CLASS_CANVAS_WRAP = "qualy-chart-treemap__canvas-wrap";
const CLASS_CANVAS = "qualy-chart-treemap__canvas";
const CLASS_EMPTY = "qualy-chart-treemap__empty";

const DEFAULT_TITLE = "Violations by file";
const EMPTY_MESSAGE = "No violations recorded — quality bar holds across all files.";

export interface CreateChartTreemapResult {
  /** Detached `<article>` root — caller mounts it. */
  readonly root: ChartTreemapEl;
  /**
   * The `<canvas>` element inside `root`. Caller passes this to chart.js:
   * `new Chart(canvas, result.config)`. Returned even when no violations
   * exist (the empty-state placeholder replaces it visually but the canvas
   * stays for layout consistency); `null` would force every caller to branch.
   */
  readonly canvas: ChartTreemapEl;
  /** JSON-serializable chartjs-chart-treemap config. Inline-safe for `report-export`. */
  readonly config: ChartTreemapConfig;
  /** Aggregated rows actually plotted (after truncation). */
  readonly rows: readonly FileViolation[];
  /** Whether `rows` was empty after aggregation — themes/css drive empty-state styling. */
  readonly isEmpty: boolean;
}

/**
 * Build the treemap article: heading + `<canvas>` (or empty-state placeholder
 * sibling). Aggregates violations across metrics internally and returns the
 * root, the canvas element, the chart.js config, and the aggregated rows so
 * `app.ts` can decide whether to mount chart.js (browser) or skip (export
 * pre-render).
 */
export function createChartTreemap(
  doc: ChartTreemapDoc,
  byMetric: ViolationsByMetric,
  options: ChartTreemapOptions = {},
): CreateChartTreemapResult {
  const rows = aggregateViolationsByFile(byMetric, { maxFiles: options.maxFiles });
  const config = buildChartTreemapConfig(rows, options);
  const isEmpty = rows.length === 0;
  const title = options.title ?? DEFAULT_TITLE;

  const root = doc.createElement("article");
  root.setAttribute("class", CLASS_ROOT);
  root.setAttribute("data-empty", isEmpty ? "true" : "false");
  root.setAttribute("data-files-count", String(rows.length));

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
  canvas.setAttribute("aria-label", chartAriaLabel(rows));
  wrap.appendChild(canvas);

  if (isEmpty) {
    const empty = doc.createElement("p");
    empty.setAttribute("class", CLASS_EMPTY);
    empty.textContent = EMPTY_MESSAGE;
    wrap.appendChild(empty);
  }

  return { root, canvas, config, rows, isEmpty };
}

// ---------------------------------------------------------------------------
// Class name + message constants exported for tests + sibling components
// ---------------------------------------------------------------------------

export const CHART_TREEMAP_CLASS_NAMES = {
  root: CLASS_ROOT,
  title: CLASS_TITLE,
  canvasWrap: CLASS_CANVAS_WRAP,
  canvas: CLASS_CANVAS,
  empty: CLASS_EMPTY,
} as const;

export const CHART_TREEMAP_MESSAGES = {
  defaultTitle: DEFAULT_TITLE,
  empty: EMPTY_MESSAGE,
  datasetLabel: DATASET_LABEL,
} as const;
