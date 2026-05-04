/**
 * `report/components/MetricCard` — atomic DOM primitive that renders a single
 * quality metric (errors, warnings, coverage %, top WMC violations, etc.).
 *
 * SPEC §4 line 305 ("vanilla DOM") — no framework, no JSX. The component is a
 * pure factory: given a `Document`-like object and a typed payload, it returns
 * the root `<article>` element. The caller (`app.ts`) decides where to mount
 * it. Re-rendering means discarding the returned element and creating a fresh
 * one — keeps the contract simple and lets the harness skip an extra
 * diff/patch layer that nobody asked for.
 *
 * DOM types: tsconfig `lib` excludes `DOM` (CLI is a Node program first), so
 * the file declares minimal structural interfaces (`MetricCardDoc`,
 * `MetricCardEl`). Browser `Document`/`HTMLElement` satisfy them automatically;
 * tests pass a tiny in-memory stub.
 *
 * a11y: `<article>` exposes a banner-less landmark; the label is wrapped in
 * `<h3>` so screen readers can navigate by heading; the optional delta carries
 * `aria-label` so the trend direction is read out alongside the value.
 */

// ---------------------------------------------------------------------------
// Public data contract
// ---------------------------------------------------------------------------

export const STATUSES = ["ok", "warn", "error", "neutral"] as const;
export type MetricCardStatus = (typeof STATUSES)[number];

export const DIRECTIONS = ["up", "down", "flat"] as const;
export type MetricCardDirection = (typeof DIRECTIONS)[number];

export interface MetricCardDelta {
  /** Visual + a11y direction. `flat` is "no change". */
  readonly direction: MetricCardDirection;
  /**
   * Short caption shown next to the arrow (e.g. `"-12 vs last audit"`,
   * `"+0.4% lines"`). Caller is responsible for formatting — the component is
   * deliberately ignorant of comparison semantics.
   */
  readonly label: string;
}

export interface MetricCardData {
  /** Short label shown above the value (e.g. `"Errors"`). */
  readonly label: string;
  /**
   * Primary value. Numbers are formatted with `Intl.NumberFormat("en-US")` so
   * `1500` becomes `"1,500"`; strings are rendered verbatim (caller can
   * pre-format `"94.2%"` or `"—"`).
   */
  readonly value: string | number;
  /** Optional unit shown next to the value (e.g. `"%"`, `"violations"`). */
  readonly unit?: string;
  /** Optional caption shown below the value. */
  readonly caption?: string;
  /** Trend indicator. */
  readonly delta?: MetricCardDelta;
  /**
   * Status accent. Drives `data-status` so CSS can style the border/badge.
   * Defaults to `"neutral"` (no accent) when omitted.
   */
  readonly status?: MetricCardStatus;
}

// ---------------------------------------------------------------------------
// Minimal DOM surface
// ---------------------------------------------------------------------------

/**
 * Subset of `HTMLElement` the component touches. Lets unit tests inject a
 * lightweight stub without pulling in jsdom / happy-dom.
 */
export interface MetricCardEl {
  /** Lowercase per `Document.createElement` contract. */
  readonly tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: MetricCardEl): MetricCardEl;
}

export interface MetricCardDoc {
  createElement(tag: string): MetricCardEl;
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without DOM)
// ---------------------------------------------------------------------------

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Format a metric value for display. Numbers go through `Intl.NumberFormat`
 * for thousands separators; strings pass through unchanged. Non-finite numbers
 * (`NaN`, `Infinity`) render as `"—"` (em-dash) so the card never displays
 * `"NaN"` to the user.
 */
export function formatMetricValue(value: string | number): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "—";
  return NUMBER_FORMAT.format(value);
}

/**
 * Resolve the visible glyph for a delta direction. Kept as a small lookup so
 * tests can lock the symbol set in one place — drift here breaks both the
 * visual layer and the a11y label.
 */
export function deltaGlyph(direction: MetricCardDirection): string {
  switch (direction) {
    case "up":
      return "▲";
    case "down":
      return "▼";
    case "flat":
      return "▬";
  }
}

/**
 * Build the `aria-label` for a delta. Combines the direction (read out as a
 * word, not the glyph) with the caller-supplied label so screen readers
 * announce both.
 */
export function deltaAriaLabel(delta: MetricCardDelta): string {
  const word =
    delta.direction === "up"
      ? "trend up"
      : delta.direction === "down"
        ? "trend down"
        : "trend unchanged";
  return delta.label.length > 0 ? `${word}: ${delta.label}` : word;
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

const CLASS_ROOT = "qualy-card";
const CLASS_HEADER = "qualy-card__header";
const CLASS_LABEL = "qualy-card__label";
const CLASS_DELTA = "qualy-card__delta";
const CLASS_BODY = "qualy-card__body";
const CLASS_VALUE = "qualy-card__value";
const CLASS_UNIT = "qualy-card__unit";
const CLASS_CAPTION = "qualy-card__caption";

/**
 * Construct the metric card element tree. The returned `<article>` is detached
 * — caller appends to its host (typically `document.querySelector('[data-mount=
 * "metric-cards"]')`).
 */
export function createMetricCard(doc: MetricCardDoc, data: MetricCardData): MetricCardEl {
  const status = data.status ?? "neutral";

  const root = doc.createElement("article");
  root.setAttribute("class", CLASS_ROOT);
  root.setAttribute("data-status", status);

  const header = doc.createElement("header");
  header.setAttribute("class", CLASS_HEADER);
  root.appendChild(header);

  const label = doc.createElement("h3");
  label.setAttribute("class", CLASS_LABEL);
  label.textContent = data.label;
  header.appendChild(label);

  if (data.delta !== undefined) {
    const delta = doc.createElement("span");
    delta.setAttribute("class", CLASS_DELTA);
    delta.setAttribute("data-direction", data.delta.direction);
    delta.setAttribute("aria-label", deltaAriaLabel(data.delta));
    delta.textContent = `${deltaGlyph(data.delta.direction)} ${data.delta.label}`.trim();
    header.appendChild(delta);
  }

  const body = doc.createElement("div");
  body.setAttribute("class", CLASS_BODY);
  root.appendChild(body);

  const value = doc.createElement("strong");
  value.setAttribute("class", CLASS_VALUE);
  value.textContent = formatMetricValue(data.value);
  body.appendChild(value);

  if (data.unit !== undefined && data.unit.length > 0) {
    const unit = doc.createElement("span");
    unit.setAttribute("class", CLASS_UNIT);
    unit.textContent = data.unit;
    body.appendChild(unit);
  }

  if (data.caption !== undefined && data.caption.length > 0) {
    const caption = doc.createElement("p");
    caption.setAttribute("class", CLASS_CAPTION);
    caption.textContent = data.caption;
    root.appendChild(caption);
  }

  return root;
}

// ---------------------------------------------------------------------------
// Class name constants exported for tests + sibling components
// ---------------------------------------------------------------------------

export const METRIC_CARD_CLASS_NAMES = {
  root: CLASS_ROOT,
  header: CLASS_HEADER,
  label: CLASS_LABEL,
  delta: CLASS_DELTA,
  body: CLASS_BODY,
  value: CLASS_VALUE,
  unit: CLASS_UNIT,
  caption: CLASS_CAPTION,
} as const;
