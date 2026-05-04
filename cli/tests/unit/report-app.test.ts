/**
 * Contract suite for `report/app`. Locks the bootstrap pipeline (theme +
 * mount + toggle wiring) and the pure helpers it composes. The component is
 * pure-DOM via the same minimal structural typing pattern as the sibling
 * components — no jsdom / happy-dom dependency, just an in-memory FakeDoc.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME,
  MOUNT_KEYS,
  REPORT_DATA_SCRIPT_ID,
  STATUS_ID,
  THEMES,
  THEME_STORAGE_KEY,
  THEME_TOGGLE_ID,
  applyTheme,
  bootstrap,
  buildMetricCards,
  coverageStatus,
  deltaCount,
  formatPct,
  formatStage,
  mountAll,
  nextTheme,
  parseInlineReportData,
  persistTheme,
  readCurrentTheme,
  resolveInitialTheme,
  wireThemeToggle,
  type AppDeps,
  type AppDoc,
  type AppEl,
  type AppRoot,
  type AppStorage,
} from "../../src/report/app.ts";
import type { AuditPayload } from "../../src/lib/audit-schema.ts";
import type { ReportData, ReportHistoryEntry } from "../../src/report/data-loader.ts";

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

interface FakeEl extends AppEl {
  readonly attributes: Map<string, string>;
  readonly children: FakeEl[];
  readonly listeners: Map<string, Array<() => void>>;
}

interface FakeDoc extends AppDoc {
  readonly created: FakeEl[];
  /** Pre-registered `id → element` lookup table. */
  readonly byId: Map<string, FakeEl>;
  /** Pre-registered `selector → element` map driving `querySelector`. */
  readonly bySelector: Map<string, FakeEl>;
  /** Mutable root that backs `documentElement`. */
  readonly root: FakeEl & AppRoot;
}

function makeFakeEl(tag: string): FakeEl {
  const attributes = new Map<string, string>();
  const children: FakeEl[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const el: FakeEl = {
    tagName: tag,
    textContent: "",
    attributes,
    children,
    listeners,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    appendChild(child) {
      children.push(child as FakeEl);
      return child;
    },
    replaceChildren() {
      children.length = 0;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  };
  return el;
}

function createFakeDoc(): FakeDoc {
  const created: FakeEl[] = [];
  const byId = new Map<string, FakeEl>();
  const bySelector = new Map<string, FakeEl>();
  const root = makeFakeEl("html");
  const doc: FakeDoc = {
    created,
    byId,
    bySelector,
    root,
    documentElement: root,
    createElement(tag) {
      const el = makeFakeEl(tag);
      created.push(el);
      return el;
    },
    getElementById(id) {
      return byId.get(id) ?? null;
    },
    querySelector(selector) {
      return bySelector.get(selector) ?? null;
    },
  };
  return doc;
}

function withMountSlots(doc: FakeDoc, keys: readonly string[] = MOUNT_KEYS): {
  readonly slots: Record<string, FakeEl>;
} {
  const slots: Record<string, FakeEl> = {};
  for (const key of keys) {
    const el = makeFakeEl("div");
    el.setAttribute("data-mount", key);
    doc.bySelector.set(`[data-mount="${key}"]`, el);
    slots[key] = el;
  }
  return { slots };
}

function withToggleButton(doc: FakeDoc): FakeEl {
  const button = makeFakeEl("button");
  doc.byId.set(THEME_TOGGLE_ID, button);
  return button;
}

function withReportDataScript(doc: FakeDoc, payload: unknown): FakeEl {
  const el = makeFakeEl("script");
  el.textContent = JSON.stringify(payload);
  doc.byId.set(REPORT_DATA_SCRIPT_ID, el);
  return el;
}

// ---------------------------------------------------------------------------
// Fake storage
// ---------------------------------------------------------------------------

function createFakeStorage(initial: Record<string, string> = {}): AppStorage & {
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

function throwingStorage(): AppStorage {
  return {
    getItem() {
      throw new Error("getItem unavailable");
    },
    setItem() {
      throw new Error("setItem unavailable");
    },
  };
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

function makeAudit(overrides: Partial<AuditPayload> = {}): AuditPayload {
  const base: AuditPayload = {
    version: "1",
    generated_at: "2026-05-03T14:22:11Z",
    stage: "brownfield-moderate",
    stage_signals: {},
    tooling: {
      oxlint: "1.0.0",
      oxfmt: null,
      quality_metrics: "1.2.3",
      test_runner: "vitest",
      coverage: {
        configured: true,
        lines: 75,
        functions: 80,
        branches: 65,
        statements: 75,
        thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
    violations: {
      summary: { errors: 12, warnings: 47, files_affected: 18 },
      by_metric: {
        wmc: {
          violations: 4,
          max_seen: 38,
          top: [{ file: "src/a.ts", class: "Big", value: 38, max: 20 }],
        },
        halstead: { violations: 6, max_seen_volume: 1840, top: [{ file: "src/h.ts" }] },
        lcom: { violations: 5, top: [{ file: "src/l.ts", class: "L" }] },
        cbo: { violations: 9, top: [{ file: "src/a.ts", class: "Coupled", value: 12 }] },
        dit: { violations: 1, top: [{ file: "src/d.ts" }] },
      },
    },
    rules_active: [],
    recommendations: [],
  };
  return { ...base, ...overrides };
}

function makeHistory(entries: number, latest: AuditPayload): ReportHistoryEntry[] {
  const out: ReportHistoryEntry[] = [];
  for (let i = 0; i < entries - 1; i += 1) {
    out.push({
      timestamp: `2026-05-0${i + 1}T00-00-00Z`,
      generated_at: `2026-05-0${i + 1}T00:00:00Z`,
      stage: latest.stage,
      errors: 20,
      warnings: 60,
      files_affected: 25,
      by_metric: { wmc: 5, halstead: 8, lcom: 7, cbo: 12, dit: 2 },
    });
  }
  // The last history entry mirrors the current audit.
  const summary = latest.violations.summary;
  out.push({
    timestamp: latest.generated_at.replace(/[:.]/g, "-"),
    generated_at: latest.generated_at,
    stage: latest.stage,
    errors: summary.errors,
    warnings: summary.warnings,
    files_affected: summary.files_affected,
    by_metric: {
      wmc: latest.violations.by_metric.wmc.violations,
      halstead: latest.violations.by_metric.halstead.violations,
      lcom: latest.violations.by_metric.lcom.violations,
      cbo: latest.violations.by_metric.cbo.violations,
      dit: latest.violations.by_metric.dit.violations,
    },
  });
  return out;
}

function makeReportData(
  overrides: Partial<ReportData> = {},
  auditOverrides: Partial<AuditPayload> = {},
): ReportData {
  const audit = makeAudit(auditOverrides);
  const data: ReportData = {
    version: "1",
    generated_at: "2026-05-03T14:22:11Z",
    cwd: "/tmp/sample",
    audit_path: ".lint-audit/2026-05-03T14-22-11Z.json",
    audit,
    history: makeHistory(2, audit),
    coverage: {
      source: "coverage/coverage-summary.json",
      lines: 75,
      functions: 80,
      branches: 65,
      statements: 75,
    },
    git: { first_commit_date: "2024-01-01T00:00:00.000Z", churn_90d: 42 },
  };
  return { ...data, ...overrides };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("locks the localStorage key shared with index.html", () => {
    expect(THEME_STORAGE_KEY).toBe("qualy.theme");
  });

  it("locks the inlined data script id", () => {
    expect(REPORT_DATA_SCRIPT_ID).toBe("report-data");
  });

  it("locks the toggle button + status region ids", () => {
    expect(THEME_TOGGLE_ID).toBe("theme-toggle");
    expect(STATUS_ID).toBe("status");
  });

  it("locks the canonical theme set", () => {
    expect(THEMES).toEqual(["light", "dark"]);
    expect(DEFAULT_THEME).toBe("light");
  });

  it("locks the four mount keys in canonical order", () => {
    expect(MOUNT_KEYS).toEqual([
      "metric-cards",
      "chart-line",
      "chart-treemap",
      "violations-table",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

describe("resolveInitialTheme", () => {
  it("uses stored value when 'light'", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("light", true)).toBe("light");
  });

  it("uses stored value when 'dark'", () => {
    expect(resolveInitialTheme("dark", false)).toBe("dark");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
  });

  it("falls back to OS preference when stored is null", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(null, false)).toBe("light");
  });

  it("ignores unknown stored values and falls back", () => {
    expect(resolveInitialTheme("midnight", true)).toBe("dark");
    expect(resolveInitialTheme("midnight", false)).toBe("light");
    expect(resolveInitialTheme("", false)).toBe("light");
  });

  it("defaults to light when nothing is set", () => {
    expect(resolveInitialTheme(null, false)).toBe(DEFAULT_THEME);
  });
});

describe("nextTheme", () => {
  it("flips light → dark and dark → light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  it("is involutive (applying twice returns the same theme)", () => {
    expect(nextTheme(nextTheme("light"))).toBe("light");
    expect(nextTheme(nextTheme("dark"))).toBe("dark");
  });
});

describe("persistTheme", () => {
  it("writes the chosen theme under the canonical key", () => {
    const storage = createFakeStorage();
    persistTheme(storage, "dark");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
    persistTheme(storage, "light");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("no-ops when storage is null", () => {
    expect(() => {
      persistTheme(null, "dark");
    }).not.toThrow();
  });

  it("swallows errors thrown by setItem (quota / sandbox)", () => {
    expect(() => {
      persistTheme(throwingStorage(), "dark");
    }).not.toThrow();
  });
});

describe("readCurrentTheme", () => {
  it("returns 'dark' when data-theme=dark", () => {
    const doc = createFakeDoc();
    doc.root.setAttribute("data-theme", "dark");
    expect(readCurrentTheme(doc)).toBe("dark");
  });

  it("returns 'light' when data-theme=light", () => {
    const doc = createFakeDoc();
    doc.root.setAttribute("data-theme", "light");
    expect(readCurrentTheme(doc)).toBe("light");
  });

  it("defaults to 'light' when attribute is missing", () => {
    const doc = createFakeDoc();
    expect(readCurrentTheme(doc)).toBe("light");
  });

  it("defaults to 'light' on unrecognized values", () => {
    const doc = createFakeDoc();
    doc.root.setAttribute("data-theme", "midnight");
    expect(readCurrentTheme(doc)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("writes data-theme on documentElement", () => {
    const doc = createFakeDoc();
    applyTheme(doc, "dark");
    expect(doc.root.getAttribute("data-theme")).toBe("dark");
    applyTheme(doc, "light");
    expect(doc.root.getAttribute("data-theme")).toBe("light");
  });

  it("syncs aria-pressed on the toggle button when present", () => {
    const doc = createFakeDoc();
    const toggle = withToggleButton(doc);
    applyTheme(doc, "dark");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    applyTheme(doc, "light");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("no-ops on aria-pressed when toggle is missing", () => {
    const doc = createFakeDoc();
    expect(() => {
      applyTheme(doc, "dark");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseInlineReportData
// ---------------------------------------------------------------------------

describe("parseInlineReportData", () => {
  it("returns null when the script element is absent", () => {
    const doc = createFakeDoc();
    expect(parseInlineReportData(doc)).toBeNull();
  });

  it("returns null when textContent is empty", () => {
    const doc = createFakeDoc();
    const el = makeFakeEl("script");
    el.textContent = "";
    doc.byId.set(REPORT_DATA_SCRIPT_ID, el);
    expect(parseInlineReportData(doc)).toBeNull();
  });

  it("returns null when textContent is null", () => {
    const doc = createFakeDoc();
    const el = makeFakeEl("script");
    el.textContent = null;
    doc.byId.set(REPORT_DATA_SCRIPT_ID, el);
    expect(parseInlineReportData(doc)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    const doc = createFakeDoc();
    const el = makeFakeEl("script");
    el.textContent = "{ this is not json";
    doc.byId.set(REPORT_DATA_SCRIPT_ID, el);
    expect(parseInlineReportData(doc)).toBeNull();
  });

  it("returns null on JSON null / non-object payload", () => {
    const doc = createFakeDoc();
    withReportDataScript(doc, null);
    expect(parseInlineReportData(doc)).toBeNull();

    const doc2 = createFakeDoc();
    withReportDataScript(doc2, "string-payload");
    expect(parseInlineReportData(doc2)).toBeNull();

    const doc3 = createFakeDoc();
    withReportDataScript(doc3, 42);
    expect(parseInlineReportData(doc3)).toBeNull();
  });

  it("parses a valid ReportData payload", () => {
    const data = makeReportData();
    const doc = createFakeDoc();
    withReportDataScript(doc, data);
    const out = parseInlineReportData(doc);
    expect(out).not.toBeNull();
    expect(out?.audit.stage).toBe("brownfield-moderate");
    expect(out?.coverage?.lines).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// Pure formatting helpers
// ---------------------------------------------------------------------------

describe("formatPct", () => {
  it("formats with one decimal + percent sign", () => {
    expect(formatPct(75)).toBe("75.0%");
    expect(formatPct(94.27)).toBe("94.3%");
    expect(formatPct(0)).toBe("0.0%");
  });

  it("falls back to em-dash for non-finite values", () => {
    expect(formatPct(Number.NaN)).toBe("—");
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatStage", () => {
  it("locks the human label per stage", () => {
    expect(formatStage("greenfield")).toBe("Greenfield");
    expect(formatStage("brownfield-moderate")).toBe("Brownfield");
    expect(formatStage("legacy")).toBe("Legacy");
  });
});

describe("coverageStatus", () => {
  it("returns 'neutral' when threshold is missing", () => {
    expect(coverageStatus(75, undefined)).toBe("neutral");
    expect(coverageStatus(75, null)).toBe("neutral");
    expect(coverageStatus(75, Number.NaN)).toBe("neutral");
  });

  it("returns 'ok' when value meets or exceeds threshold", () => {
    expect(coverageStatus(70, 70)).toBe("ok");
    expect(coverageStatus(85, 70)).toBe("ok");
  });

  it("returns 'warn' within 10% of threshold", () => {
    expect(coverageStatus(63, 70)).toBe("warn"); // 63 ≥ 70 * 0.9 = 63
    expect(coverageStatus(68, 70)).toBe("warn");
  });

  it("returns 'error' below 90% of threshold", () => {
    expect(coverageStatus(60, 70)).toBe("error");
    expect(coverageStatus(0, 70)).toBe("error");
  });
});

describe("deltaCount", () => {
  it("emits 'up' when current > previous with positive sign", () => {
    expect(deltaCount(15, 10)).toEqual({
      direction: "up",
      label: "+5 vs previous audit",
    });
  });

  it("emits 'down' when current < previous with minus sign", () => {
    expect(deltaCount(10, 15)).toEqual({
      direction: "down",
      label: "−5 vs previous audit",
    });
  });

  it("emits 'flat' when equal", () => {
    expect(deltaCount(10, 10)).toEqual({
      direction: "flat",
      label: "±0 vs previous audit",
    });
  });
});

// ---------------------------------------------------------------------------
// buildMetricCards
// ---------------------------------------------------------------------------

describe("buildMetricCards", () => {
  it("emits the four core cards (errors, warnings, files, stage) plus coverage when available", () => {
    const data = makeReportData();
    const cards = buildMetricCards(data);
    expect(cards.map((c) => c.label)).toEqual([
      "Errors",
      "Warnings",
      "Files affected",
      "Stage",
      "Coverage (lines)",
    ]);
  });

  it("omits the coverage card when coverage is null", () => {
    const data = makeReportData({ coverage: null });
    const cards = buildMetricCards(data);
    expect(cards.map((c) => c.label)).toEqual([
      "Errors",
      "Warnings",
      "Files affected",
      "Stage",
    ]);
  });

  it("omits the coverage card when lines is null", () => {
    const data = makeReportData({
      coverage: {
        source: "coverage/coverage-summary.json",
        lines: null,
        functions: 80,
        branches: 65,
        statements: 70,
      },
    });
    const cards = buildMetricCards(data);
    expect(cards.find((c) => c.label === "Coverage (lines)")).toBeUndefined();
  });

  it("statuses errors=error when count>0 and ok when zero", () => {
    const audit = makeAudit();
    audit.violations.summary.errors = 0;
    const ok = buildMetricCards(makeReportData({}, { violations: audit.violations }));
    expect(ok.find((c) => c.label === "Errors")?.status).toBe("ok");

    const bad = buildMetricCards(makeReportData());
    expect(bad.find((c) => c.label === "Errors")?.status).toBe("error");
  });

  it("statuses warnings=warn when count>0 and ok when zero", () => {
    const audit = makeAudit();
    audit.violations.summary.warnings = 0;
    const clean = buildMetricCards(
      makeReportData({}, { violations: audit.violations }),
    );
    expect(clean.find((c) => c.label === "Warnings")?.status).toBe("ok");

    const dirty = buildMetricCards(makeReportData());
    expect(dirty.find((c) => c.label === "Warnings")?.status).toBe("warn");
  });

  it("includes the stage card with formatted human label", () => {
    const data = makeReportData({}, { stage: "legacy" });
    const cards = buildMetricCards(data);
    const stageCard = cards.find((c) => c.label === "Stage");
    expect(stageCard?.value).toBe("Legacy");
    expect(stageCard?.status).toBe("neutral");
  });

  it("attaches deltas to errors/warnings/files when history has ≥2 entries", () => {
    const data = makeReportData();
    const cards = buildMetricCards(data);
    expect(cards.find((c) => c.label === "Errors")?.delta).toBeDefined();
    expect(cards.find((c) => c.label === "Warnings")?.delta).toBeDefined();
    expect(cards.find((c) => c.label === "Files affected")?.delta).toBeDefined();
  });

  it("omits deltas when history has fewer than 2 entries", () => {
    const data = makeReportData({ history: makeHistory(1, makeAudit()) });
    const cards = buildMetricCards(data);
    expect(cards.find((c) => c.label === "Errors")?.delta).toBeUndefined();
    expect(cards.find((c) => c.label === "Warnings")?.delta).toBeUndefined();
    expect(cards.find((c) => c.label === "Files affected")?.delta).toBeUndefined();
  });

  it("omits deltas on the stage card always", () => {
    const data = makeReportData();
    const stageCard = buildMetricCards(data).find((c) => c.label === "Stage");
    expect(stageCard?.delta).toBeUndefined();
  });

  it("includes coverage source as caption", () => {
    const data = makeReportData();
    const cov = buildMetricCards(data).find((c) => c.label === "Coverage (lines)");
    expect(cov?.caption).toBe("coverage/coverage-summary.json");
    expect(cov?.value).toBe("75.0%");
  });

  it("threads coverage threshold into status accent", () => {
    const data = makeReportData(
      {
        coverage: {
          source: "coverage/coverage-summary.json",
          lines: 50,
          functions: 80,
          branches: 65,
          statements: 70,
        },
      },
      {
        tooling: {
          oxlint: "1.0.0",
          oxfmt: null,
          quality_metrics: "1.2.3",
          test_runner: "vitest",
          coverage: {
            configured: true,
            lines: 50,
            functions: 80,
            branches: 65,
            statements: 70,
            thresholds: { lines: 70 },
          },
        },
      },
    );
    const cov = buildMetricCards(data).find((c) => c.label === "Coverage (lines)");
    expect(cov?.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// mountAll
// ---------------------------------------------------------------------------

function makeMountDeps(opts?: {
  data?: ReportData;
  storage?: AppStorage | null;
  mountChart?: AppDeps["mountChart"];
  withSlots?: readonly string[];
  withToggle?: boolean;
}): {
  doc: FakeDoc;
  deps: AppDeps;
  slots: Record<string, FakeEl>;
  toggle: FakeEl | null;
} {
  const doc = createFakeDoc();
  const data = opts?.data ?? makeReportData();
  const slotRes = withMountSlots(doc, opts?.withSlots ?? MOUNT_KEYS);
  const toggle = opts?.withToggle === false ? null : withToggleButton(doc);
  const deps: AppDeps = {
    doc,
    data,
    storage: opts?.storage === undefined ? createFakeStorage() : opts.storage,
    mountChart: opts?.mountChart,
  };
  return { doc, deps, slots: slotRes.slots, toggle };
}

describe("mountAll", () => {
  it("mounts metric cards: count matches buildMetricCards output", () => {
    const { deps, slots } = makeMountDeps();
    const result = mountAll(deps);
    expect(result.metricCards).toBe(buildMetricCards(deps.data).length);
    expect(slots["metric-cards"].children.length).toBe(result.metricCards);
  });

  it("mounts the chart-line article into its slot", () => {
    const { deps, slots } = makeMountDeps();
    const result = mountAll(deps);
    expect(result.chartLine).toBe(true);
    expect(slots["chart-line"].children.length).toBe(1);
    expect(slots["chart-line"].children[0]?.tagName).toBe("article");
  });

  it("mounts the chart-treemap article into its slot", () => {
    const { deps, slots } = makeMountDeps();
    const result = mountAll(deps);
    expect(result.chartTreemap).toBe(true);
    expect(slots["chart-treemap"].children.length).toBe(1);
    expect(slots["chart-treemap"].children[0]?.tagName).toBe("article");
  });

  it("mounts the violations-table article into its slot", () => {
    const { deps, slots } = makeMountDeps();
    const result = mountAll(deps);
    expect(result.violationsTable).toBe(true);
    expect(slots["violations-table"].children.length).toBe(1);
    expect(slots["violations-table"].children[0]?.tagName).toBe("article");
  });

  it("clears existing children on each slot before mounting (re-render safe)", () => {
    const { deps, slots } = makeMountDeps();
    // Pre-pollute every slot with stale content.
    for (const slot of Object.values(slots)) {
      slot.children.push(makeFakeEl("span"));
    }
    mountAll(deps);
    // After mount: metric-cards holds N cards (N = buildMetricCards result),
    // each chart slot holds exactly 1 article, table slot holds exactly 1.
    expect(slots["chart-line"].children.length).toBe(1);
    expect(slots["chart-treemap"].children.length).toBe(1);
    expect(slots["violations-table"].children.length).toBe(1);
    // Stale span removed from metric-cards too.
    const metricsContainsSpan = slots["metric-cards"].children.some(
      (c) => c.tagName === "span",
    );
    expect(metricsContainsSpan).toBe(false);
  });

  it("invokes mountChart for non-empty line + treemap when provided", () => {
    const mountChart = vi.fn();
    const { deps } = makeMountDeps({ mountChart });
    const result = mountAll(deps);
    // Default fixture has history >= 1 and violations across 5 metrics → both
    // charts mount.
    expect(mountChart).toHaveBeenCalledTimes(2);
    expect(result.chartsMounted).toBe(2);
  });

  it("skips mountChart on empty history (line)", () => {
    const mountChart = vi.fn();
    const data = makeReportData({ history: [] });
    const { deps } = makeMountDeps({ data, mountChart });
    mountAll(deps);
    // Treemap still mounts (violations are non-empty); line does not.
    expect(mountChart).toHaveBeenCalledTimes(1);
  });

  it("skips mountChart entirely when no chart.js is available (deps.mountChart=undefined)", () => {
    const { deps } = makeMountDeps({ mountChart: undefined });
    const result = mountAll(deps);
    expect(result.chartsMounted).toBe(0);
    expect(result.chartLine).toBe(true); // DOM still rendered
    expect(result.chartTreemap).toBe(true);
  });

  it("silently skips slots that are absent in the DOM", () => {
    const { deps } = makeMountDeps({ withSlots: ["metric-cards"] });
    const result = mountAll(deps);
    expect(result.metricCards).toBeGreaterThan(0);
    expect(result.chartLine).toBe(false);
    expect(result.chartTreemap).toBe(false);
    expect(result.violationsTable).toBe(false);
  });

  it("returns zero metricCards count when the slot is absent", () => {
    const { deps } = makeMountDeps({ withSlots: [] });
    const result = mountAll(deps);
    expect(result.metricCards).toBe(0);
    expect(result.chartLine).toBe(false);
    expect(result.chartTreemap).toBe(false);
    expect(result.violationsTable).toBe(false);
    expect(result.chartsMounted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wireThemeToggle
// ---------------------------------------------------------------------------

describe("wireThemeToggle", () => {
  it("returns false when toggle button is missing", () => {
    const { deps } = makeMountDeps({ withToggle: false });
    expect(wireThemeToggle(deps)).toBe(false);
  });

  it("returns true and registers a click listener", () => {
    const { deps, toggle } = makeMountDeps();
    expect(wireThemeToggle(deps)).toBe(true);
    expect(toggle?.listeners.get("click")?.length).toBe(1);
  });

  it("flips theme on click and persists to storage", () => {
    const storage = createFakeStorage();
    const { deps, toggle, doc } = makeMountDeps({ storage });
    doc.root.setAttribute("data-theme", "light");
    wireThemeToggle(deps);
    const click = toggle?.listeners.get("click")?.[0];
    expect(click).toBeDefined();
    click?.();
    expect(doc.root.getAttribute("data-theme")).toBe("dark");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
    click?.();
    expect(doc.root.getAttribute("data-theme")).toBe("light");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("syncs aria-pressed with the new theme on each click", () => {
    const { deps, toggle, doc } = makeMountDeps();
    doc.root.setAttribute("data-theme", "light");
    wireThemeToggle(deps);
    toggle?.listeners.get("click")?.[0]?.();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    toggle?.listeners.get("click")?.[0]?.();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  });

  it("works when storage is null (private mode)", () => {
    const { deps, toggle, doc } = makeMountDeps({ storage: null });
    doc.root.setAttribute("data-theme", "light");
    wireThemeToggle(deps);
    expect(() => toggle?.listeners.get("click")?.[0]?.()).not.toThrow();
    expect(doc.root.getAttribute("data-theme")).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// bootstrap (end-to-end pipeline)
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
  it("applies the resolved theme before mounting", () => {
    const storage = createFakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    const { deps, doc } = makeMountDeps({ storage });
    const result = bootstrap(deps);
    expect(result.theme).toBe("dark");
    expect(doc.root.getAttribute("data-theme")).toBe("dark");
  });

  it("falls back to OS preference (matchMedia) when storage is empty", () => {
    const { deps, doc } = makeMountDeps({ storage: createFakeStorage() });
    const withMedia: AppDeps = {
      ...deps,
      matchMedia: () => ({ matches: true }),
    };
    const result = bootstrap(withMedia);
    expect(result.theme).toBe("dark");
    expect(doc.root.getAttribute("data-theme")).toBe("dark");
  });

  it("defaults to light when neither storage nor matchMedia indicate dark", () => {
    const { deps, doc } = makeMountDeps();
    const result = bootstrap(deps);
    expect(result.theme).toBe("light");
    expect(doc.root.getAttribute("data-theme")).toBe("light");
  });

  it("returns counts for every mounted region", () => {
    const { deps } = makeMountDeps();
    const result = bootstrap(deps);
    expect(result.mounts.metricCards).toBeGreaterThan(0);
    expect(result.mounts.chartLine).toBe(true);
    expect(result.mounts.chartTreemap).toBe(true);
    expect(result.mounts.violationsTable).toBe(true);
  });

  it("wires the toggle when present", () => {
    const { deps } = makeMountDeps();
    const result = bootstrap(deps);
    expect(result.toggleWired).toBe(true);
  });

  it("reports toggleWired=false when toggle is absent (degraded shell)", () => {
    const { deps } = makeMountDeps({ withToggle: false });
    const result = bootstrap(deps);
    expect(result.toggleWired).toBe(false);
  });

  it("survives null storage end-to-end", () => {
    const { deps } = makeMountDeps({ storage: null });
    const result = bootstrap(deps);
    expect(result.theme).toBe("light");
    expect(result.mounts.metricCards).toBeGreaterThan(0);
  });

  it("survives a throwing storage during initial read", () => {
    const { deps } = makeMountDeps({ storage: throwingStorage() });
    const result = bootstrap(deps);
    // Stored read failed → fall through to matchMedia (undefined here) →
    // default light.
    expect(result.theme).toBe("light");
  });
});
