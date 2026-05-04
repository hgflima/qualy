/**
 * `report/app` — browser bootstrap for the qualy quality report. Reads the
 * inlined `ReportData` JSON, applies the persisted theme, mounts each component
 * built in `report/components/*` into its `data-mount` slot, and wires the
 * `<button id="theme-toggle">` so users can flip light/dark.
 *
 * SPEC §4 (Report visual):
 *  - vanilla DOM, no UI framework (line 305).
 *  - charts: chart.js + chartjs-chart-treemap (line 320).
 *  - theming: CSS custom properties + `[data-theme]` attribute on `<html>`,
 *    persisted via `localStorage` (key `qualy.theme`) (line 322).
 *  - a11y: `prefers-reduced-motion` respected — chart configs already disable
 *    animation by default (`ChartLine`/`ChartTreemap`), and the toggle button
 *    has no transition. So this file does NOT add a runtime motion check;
 *    motion-safe is the default and themes opt in.
 *  - export: `report/export.ts` produces a self-contained HTML; both the live
 *    server and the offline export inline the `ReportData` JSON via
 *    `<script id="report-data" type="application/json">…</script>` so the
 *    bootstrap path is identical (no fetch round-trip, offline-safe).
 *
 * Pure factory pattern (matches sibling components): every helper is testable
 * without jsdom — minimal structural DOM types declared inline (the CLI's
 * tsconfig excludes the `DOM` lib because the package is Node-first; the
 * browser bundler picks it up via global `document`/`localStorage`).
 *
 * Auto-boot: a single side-effecting IIFE at the bottom of the file checks for
 * `globalThis.document` and, if present, hydrates from the inline JSON and
 * calls `bootstrap()`. Tests import the module under Node where `document` is
 * undefined — the IIFE returns immediately and the side effect is silent.
 */

import {
  createChartLine,
  type ChartLineConfig,
} from "./components/ChartLine.ts";
import {
  createChartTreemap,
  type ChartTreemapConfig,
} from "./components/ChartTreemap.ts";
import {
  createMetricCard,
  type MetricCardData,
  type MetricCardDelta,
  type MetricCardDirection,
  type MetricCardStatus,
} from "./components/MetricCard.ts";
import { createViolationsTable } from "./components/ViolationsTable.ts";
import type { ReportData } from "./data-loader.ts";
import type { Stage } from "../lib/audit-schema.ts";

// Re-exported so callers (server.ts/export.ts) compose mount results without
// reaching into component modules.
export type { ChartLineConfig, ChartTreemapConfig };

// ---------------------------------------------------------------------------
// Constants (locked by tests)
// ---------------------------------------------------------------------------

/** localStorage key shared with the inline anti-flash bootstrap in `index.html`. */
export const THEME_STORAGE_KEY = "qualy.theme";

/** `<script type="application/json">` element id carrying the inlined `ReportData`. */
export const REPORT_DATA_SCRIPT_ID = "report-data";

/** `<button>` id of the theme toggle in `index.html`. */
export const THEME_TOGGLE_ID = "theme-toggle";

/** `aria-live` region id for app-level status messages. */
export const STATUS_ID = "status";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "light";

/** `data-mount="<key>"` slots iterated by {@link mountAll}. */
export const MOUNT_KEYS = [
  "metric-cards",
  "chart-line",
  "chart-treemap",
  "violations-table",
] as const;
export type MountKey = (typeof MOUNT_KEYS)[number];

// ---------------------------------------------------------------------------
// Minimal DOM / runtime surface — structural types so unit tests stub without
// jsdom. Browser `Document`/`HTMLElement`/`localStorage` satisfy these by
// shape.
// ---------------------------------------------------------------------------

/**
 * Element surface the bootstrap touches. Browser `HTMLElement` satisfies this
 * structurally; tests pass a `FakeEl` with the same shape. Compatible with the
 * narrower component-side types (`MetricCardEl`/`ChartLineEl`/etc.) because
 * TypeScript treats method parameters bivariantly — the `AppEl` is freely
 * passed into `createMetricCard` / `createChartLine` / ... without casts.
 */
export interface AppEl {
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: AppEl): AppEl;
  /** Used to clear a mount slot before (re)rendering. */
  replaceChildren(): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface AppRoot {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

export interface AppDoc {
  createElement(tag: string): AppEl;
  getElementById(id: string): AppEl | null;
  querySelector(selector: string): AppEl | null;
  readonly documentElement: AppRoot;
}

export interface AppStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppMatchMedia {
  (query: string): { readonly matches: boolean };
}

/**
 * Browser-side hook that mounts a chart.js `Chart` instance against a canvas.
 * Optional: tests pass `undefined` (no chart.js available); the mount step is
 * silently skipped and the static DOM scaffold from `createChartLine` /
 * `createChartTreemap` is enough to verify wiring.
 */
export type ChartMounter = (
  canvas: AppEl,
  config: ChartLineConfig | ChartTreemapConfig,
) => void;

export interface AppDeps {
  readonly doc: AppDoc;
  readonly data: ReportData;
  readonly storage: AppStorage | null;
  readonly matchMedia?: AppMatchMedia;
  readonly mountChart?: ChartMounter;
}

// ---------------------------------------------------------------------------
// Theme helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Resolve the initial theme. Precedence:
 *   1. `localStorage.qualy.theme` if "light" or "dark" (anything else ignored).
 *   2. OS-level `prefers-color-scheme: dark`.
 *   3. {@link DEFAULT_THEME} ("light").
 *
 * Mirrors the inline anti-flash bootstrap in `index.html` exactly — drift here
 * causes a flash between paint and hydration.
 */
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : DEFAULT_THEME;
}

export function nextTheme(current: Theme): Theme {
  return current === "light" ? "dark" : "light";
}

/** Best-effort persistence; null storage and quota errors are silently ignored. */
export function persistTheme(storage: AppStorage | null, theme: Theme): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage may throw under quota or sandboxed iframes — fail-soft.
  }
}

function safeGet(storage: AppStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Read the current theme from `<html data-theme>`; defaults to `"light"`. */
export function readCurrentTheme(doc: AppDoc): Theme {
  const v = doc.documentElement.getAttribute("data-theme");
  return v === "dark" ? "dark" : "light";
}

/**
 * Apply a theme to the document. Sets `<html data-theme>` and synchronizes the
 * toggle button's `aria-pressed` (true when dark, false when light) so screen
 * readers announce the active state.
 */
export function applyTheme(doc: AppDoc, theme: Theme): void {
  doc.documentElement.setAttribute("data-theme", theme);
  const toggle = doc.getElementById(THEME_TOGGLE_ID);
  if (toggle !== null) {
    toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }
}

// ---------------------------------------------------------------------------
// Inlined data hydration
// ---------------------------------------------------------------------------

/**
 * Read the inlined `ReportData` JSON from the `<script id="report-data">`
 * element. Returns null when the element is missing, empty, or holds invalid
 * JSON — caller decides how to surface the failure (the live server can refresh
 * with a useful error; the offline export should never reach this branch
 * because export.ts inlines a validated payload).
 */
export function parseInlineReportData(doc: AppDoc): ReportData | null {
  const el = doc.getElementById(REPORT_DATA_SCRIPT_ID);
  if (el === null) return null;
  const raw = el.textContent ?? "";
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ReportData;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metric card composition (pure)
// ---------------------------------------------------------------------------

/**
 * Format a percentage for display. Coverage values from istanbul are already
 * 0–100 floats; `1` decimal keeps the card glanceable while exposing trend.
 */
export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  greenfield: "Greenfield",
  "brownfield-moderate": "Brownfield",
  legacy: "Legacy",
};

/** Human-readable stage name. Locked so card layout is stable. */
export function formatStage(stage: Stage): string {
  return STAGE_LABELS[stage];
}

/**
 * Pick a status accent for a coverage value against an optional threshold.
 *  - threshold absent → `"neutral"` (we don't know the bar).
 *  - value ≥ threshold → `"ok"`.
 *  - value within 10% of threshold → `"warn"`.
 *  - otherwise → `"error"`.
 */
export function coverageStatus(
  value: number,
  threshold: number | null | undefined,
): MetricCardStatus {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return "neutral";
  if (value >= threshold) return "ok";
  if (value >= threshold * 0.9) return "warn";
  return "error";
}

/**
 * Build a delta showing the diff vs the previous audit. `current === previous`
 * surfaces as `flat` so the card visibly reads "no change" instead of dropping
 * the badge altogether.
 */
export function deltaCount(current: number, previous: number): MetricCardDelta {
  const diff = current - previous;
  const direction: MetricCardDirection = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  const magnitude = Math.abs(diff);
  return {
    direction,
    label: `${sign}${magnitude} vs previous audit`,
  };
}

/**
 * Compose the metric cards from `ReportData`. Order is locked so themes can
 * style by position and the offline export snapshot is stable run-to-run.
 *
 * Cards: errors, warnings, files affected, stage, coverage (when present).
 * Coverage card is omitted when the runner emitted no `lines` percentage —
 * showing a phantom "—%" makes the report look broken.
 */
export function buildMetricCards(data: ReportData): MetricCardData[] {
  const cards: MetricCardData[] = [];
  const summary = data.audit.violations.summary;
  // History from the loader is ascending by timestamp; the LAST entry equals
  // the current audit. The "previous" delta therefore comes from history[-2].
  const previous =
    data.history.length >= 2 ? data.history[data.history.length - 2] : null;

  cards.push({
    label: "Errors",
    value: summary.errors,
    status: summary.errors > 0 ? "error" : "ok",
    ...(previous !== undefined && previous !== null
      ? { delta: deltaCount(summary.errors, previous.errors) }
      : {}),
  });

  cards.push({
    label: "Warnings",
    value: summary.warnings,
    status: summary.warnings > 0 ? "warn" : "ok",
    ...(previous !== undefined && previous !== null
      ? { delta: deltaCount(summary.warnings, previous.warnings) }
      : {}),
  });

  cards.push({
    label: "Files affected",
    value: summary.files_affected,
    status: "neutral",
    ...(previous !== undefined && previous !== null
      ? { delta: deltaCount(summary.files_affected, previous.files_affected) }
      : {}),
  });

  cards.push({
    label: "Stage",
    value: formatStage(data.audit.stage),
    status: "neutral",
  });

  if (data.coverage !== null && data.coverage.lines !== null) {
    const threshold = data.audit.tooling.coverage.thresholds?.lines ?? null;
    cards.push({
      label: "Coverage (lines)",
      value: formatPct(data.coverage.lines),
      status: coverageStatus(data.coverage.lines, threshold),
      caption: data.coverage.source,
    });
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Mount loop
// ---------------------------------------------------------------------------

export interface MountResult {
  readonly metricCards: number;
  readonly chartLine: boolean;
  readonly chartTreemap: boolean;
  readonly violationsTable: boolean;
  readonly chartsMounted: number;
}

function mountSelector(key: MountKey): string {
  return `[data-mount="${key}"]`;
}

/**
 * Mount every component into its `data-mount` slot. Hosts that are missing
 * (e.g. a custom `index.html` dropped a section) are silently skipped — the
 * report degrades to "section absent" rather than crashing on first miss.
 *
 * Charts: when `deps.mountChart` is provided (browser path), the canvas is
 * passed to chart.js. Tests omit `mountChart` and assert on the static DOM
 * scaffold + config. Empty charts (no history / no violations) skip the mount
 * call — chart.js would render an empty axis pair which is noisier than the
 * empty-state placeholder the component already provides.
 */
export function mountAll(deps: AppDeps): MountResult {
  let metricCards = 0;
  let chartLine = false;
  let chartTreemap = false;
  let violationsTable = false;
  let chartsMounted = 0;

  const metricsHost = deps.doc.querySelector(mountSelector("metric-cards"));
  if (metricsHost !== null) {
    metricsHost.replaceChildren();
    const cards = buildMetricCards(deps.data);
    for (const card of cards) {
      metricsHost.appendChild(createMetricCard(deps.doc, card) as AppEl);
    }
    metricCards = cards.length;
  }

  const lineHost = deps.doc.querySelector(mountSelector("chart-line"));
  if (lineHost !== null) {
    lineHost.replaceChildren();
    const r = createChartLine(deps.doc, deps.data.history);
    lineHost.appendChild(r.root as AppEl);
    if (deps.mountChart !== undefined && !r.isEmpty) {
      deps.mountChart(r.canvas as AppEl, r.config);
      chartsMounted += 1;
    }
    chartLine = true;
  }

  const treemapHost = deps.doc.querySelector(mountSelector("chart-treemap"));
  if (treemapHost !== null) {
    treemapHost.replaceChildren();
    const r = createChartTreemap(deps.doc, deps.data.audit.violations.by_metric);
    treemapHost.appendChild(r.root as AppEl);
    if (deps.mountChart !== undefined && !r.isEmpty) {
      deps.mountChart(r.canvas as AppEl, r.config);
      chartsMounted += 1;
    }
    chartTreemap = true;
  }

  const tableHost = deps.doc.querySelector(mountSelector("violations-table"));
  if (tableHost !== null) {
    tableHost.replaceChildren();
    const r = createViolationsTable(deps.doc, deps.data.audit.violations.by_metric);
    tableHost.appendChild(r.root as AppEl);
    violationsTable = true;
  }

  return { metricCards, chartLine, chartTreemap, violationsTable, chartsMounted };
}

// ---------------------------------------------------------------------------
// Theme toggle wiring
// ---------------------------------------------------------------------------

/**
 * Wire a click handler to `<button id="theme-toggle">` that flips `data-theme`
 * and persists the choice. Returns true when the button was found (caller can
 * surface a warning for misconfigured shells).
 */
export function wireThemeToggle(deps: AppDeps): boolean {
  const toggle = deps.doc.getElementById(THEME_TOGGLE_ID);
  if (toggle === null) return false;
  toggle.addEventListener("click", () => {
    const next = nextTheme(readCurrentTheme(deps.doc));
    applyTheme(deps.doc, next);
    persistTheme(deps.storage, next);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  readonly theme: Theme;
  readonly mounts: MountResult;
  readonly toggleWired: boolean;
}

/**
 * One-shot bootstrap. Invoked once per page load (refresh re-runs the entire
 * pipeline — there is no partial hydration). Order matters: theme is applied
 * BEFORE mount so the components paint with the correct CSS custom properties
 * resolved on first frame.
 */
export function bootstrap(deps: AppDeps): BootstrapResult {
  const stored = deps.storage !== null ? safeGet(deps.storage, THEME_STORAGE_KEY) : null;
  const prefersDark =
    deps.matchMedia !== undefined
      ? deps.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
  const theme = resolveInitialTheme(stored, prefersDark);
  applyTheme(deps.doc, theme);

  const mounts = mountAll(deps);
  const toggleWired = wireThemeToggle(deps);

  return { theme, mounts, toggleWired };
}

// ---------------------------------------------------------------------------
// Browser auto-boot
// ---------------------------------------------------------------------------

/**
 * Side-effecting entry point: when the module loads inside a browser (i.e.
 * `globalThis.document` is defined), reads the inline `ReportData` and calls
 * `bootstrap()`. In Node (tests, server imports for non-bundling reasons) the
 * IIFE returns immediately. esbuild keeps the IIFE in the bundle because of
 * the `globalThis.document` check; tree-shaking does not remove top-level side
 * effects.
 */
(function maybeAutoBoot(): void {
  if (typeof globalThis === "undefined") return;
  const g = globalThis as Record<string, unknown>;
  if (g.document === undefined) return;

  const doc = g.document as AppDoc;
  const data = parseInlineReportData(doc);
  if (data === null) return;

  const storage =
    g.localStorage !== undefined ? (g.localStorage as AppStorage) : null;
  const matchMedia =
    typeof g.matchMedia === "function"
      ? (g.matchMedia as AppMatchMedia)
      : undefined;

  // chart.js global — server.ts/export.ts pre-load chart.js + chartjs-chart-
  // treemap and assign `Chart` on `window` before this module evaluates. When
  // missing (degraded environment), the static DOM scaffold renders without
  // the interactive chart and the empty-state placeholder is unaffected.
  const ChartCtor = g.Chart as
    | (new (canvas: unknown, config: unknown) => unknown)
    | undefined;
  const mountChart: ChartMounter | undefined =
    typeof ChartCtor === "function"
      ? (canvas, config) => {
          new ChartCtor(canvas, config);
        }
      : undefined;

  bootstrap({ doc, data, storage, matchMedia, mountChart });
})();
