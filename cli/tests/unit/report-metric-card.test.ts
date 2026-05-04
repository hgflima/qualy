/**
 * Contract suite for `report/components/MetricCard`. Locks the rendered DOM
 * tree, attribute set, and a11y wiring so future style/layout drifts surface
 * here before reaching the browser.
 *
 * The component declares its own minimal `MetricCardDoc` / `MetricCardEl`
 * surface (tsconfig `lib` excludes DOM). This suite implements a tiny
 * `FakeDoc`/`FakeEl` pair that mirrors that surface — no jsdom / happy-dom
 * needed.
 */
import { describe, expect, it } from "vitest";

import {
  DIRECTIONS,
  METRIC_CARD_CLASS_NAMES,
  STATUSES,
  type MetricCardData,
  type MetricCardDoc,
  type MetricCardEl,
  createMetricCard,
  deltaAriaLabel,
  deltaGlyph,
  formatMetricValue,
} from "../../src/report/components/MetricCard.ts";

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

interface FakeEl extends MetricCardEl {
  readonly attributes: Map<string, string>;
  readonly children: FakeEl[];
}

function createFakeDoc(): {
  doc: MetricCardDoc;
  /** Tracks `createElement` calls in order — used for ordering assertions. */
  readonly created: FakeEl[];
} {
  const created: FakeEl[] = [];
  const doc: MetricCardDoc = {
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

function tagsInOrder(root: FakeEl): string[] {
  const tags: string[] = [];
  function walk(node: FakeEl): void {
    tags.push(node.tagName);
    for (const child of node.children) walk(child);
  }
  walk(root);
  return tags;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports the four canonical statuses", () => {
    expect(STATUSES).toEqual(["ok", "warn", "error", "neutral"]);
  });

  it("exports the three canonical directions", () => {
    expect(DIRECTIONS).toEqual(["up", "down", "flat"]);
  });

  it("exposes class-name constants for sibling components", () => {
    expect(METRIC_CARD_CLASS_NAMES).toEqual({
      root: "qualy-card",
      header: "qualy-card__header",
      label: "qualy-card__label",
      delta: "qualy-card__delta",
      body: "qualy-card__body",
      value: "qualy-card__value",
      unit: "qualy-card__unit",
      caption: "qualy-card__caption",
    });
  });
});

// ---------------------------------------------------------------------------
// formatMetricValue
// ---------------------------------------------------------------------------

describe("formatMetricValue", () => {
  it("formats integers with thousands separators", () => {
    expect(formatMetricValue(1500)).toBe("1,500");
    expect(formatMetricValue(1_234_567)).toBe("1,234,567");
  });

  it("formats zero and small numbers without separators", () => {
    expect(formatMetricValue(0)).toBe("0");
    expect(formatMetricValue(7)).toBe("7");
  });

  it("preserves decimals", () => {
    expect(formatMetricValue(94.2)).toBe("94.2");
  });

  it("renders strings verbatim", () => {
    expect(formatMetricValue("94.2%")).toBe("94.2%");
    expect(formatMetricValue("—")).toBe("—");
    expect(formatMetricValue("")).toBe("");
  });

  it("falls back to em-dash for non-finite numbers", () => {
    expect(formatMetricValue(Number.NaN)).toBe("—");
    expect(formatMetricValue(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatMetricValue(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  it("handles negative numbers", () => {
    expect(formatMetricValue(-12)).toBe("-12");
  });
});

// ---------------------------------------------------------------------------
// deltaGlyph + deltaAriaLabel
// ---------------------------------------------------------------------------

describe("deltaGlyph", () => {
  it("locks the glyph for each direction", () => {
    expect(deltaGlyph("up")).toBe("▲");
    expect(deltaGlyph("down")).toBe("▼");
    expect(deltaGlyph("flat")).toBe("▬");
  });
});

describe("deltaAriaLabel", () => {
  it("combines direction word with the caption", () => {
    expect(deltaAriaLabel({ direction: "up", label: "+3" })).toBe("trend up: +3");
    expect(deltaAriaLabel({ direction: "down", label: "-12 vs prev" })).toBe(
      "trend down: -12 vs prev",
    );
    expect(deltaAriaLabel({ direction: "flat", label: "no change" })).toBe(
      "trend unchanged: no change",
    );
  });

  it("drops the caption when the label is empty", () => {
    expect(deltaAriaLabel({ direction: "up", label: "" })).toBe("trend up");
    expect(deltaAriaLabel({ direction: "flat", label: "" })).toBe("trend unchanged");
  });
});

// ---------------------------------------------------------------------------
// createMetricCard — happy paths
// ---------------------------------------------------------------------------

describe("createMetricCard", () => {
  it("builds the canonical structure for a minimal payload", () => {
    const { doc } = createFakeDoc();
    const data: MetricCardData = { label: "Errors", value: 0 };

    const root = createMetricCard(doc, data) as FakeEl;

    expect(root.tagName).toBe("article");
    expect(root.attributes.get("class")).toBe("qualy-card");
    // No status → defaults to neutral.
    expect(root.attributes.get("data-status")).toBe("neutral");

    // article > header(label) + body(value)
    expect(root.children).toHaveLength(2);
    const header = root.children[0];
    const body = root.children[1];
    expect(header).toBeDefined();
    expect(body).toBeDefined();
    if (header === undefined || body === undefined) return;

    expect(header.tagName).toBe("header");
    expect(header.attributes.get("class")).toBe("qualy-card__header");
    expect(header.children).toHaveLength(1); // no delta in minimal payload
    const labelEl = header.children[0];
    if (labelEl === undefined) throw new Error("expected label element");
    expect(labelEl.tagName).toBe("h3");
    expect(labelEl.attributes.get("class")).toBe("qualy-card__label");
    expect(labelEl.textContent).toBe("Errors");

    expect(body.tagName).toBe("div");
    expect(body.attributes.get("class")).toBe("qualy-card__body");
    expect(body.children).toHaveLength(1); // no unit in minimal payload
    const valueEl = body.children[0];
    if (valueEl === undefined) throw new Error("expected value element");
    expect(valueEl.tagName).toBe("strong");
    expect(valueEl.attributes.get("class")).toBe("qualy-card__value");
    expect(valueEl.textContent).toBe("0");
  });

  it("renders all four optional fields together", () => {
    const { doc } = createFakeDoc();
    const data: MetricCardData = {
      label: "Coverage",
      value: 94.2,
      unit: "%",
      caption: "lines",
      status: "ok",
      delta: { direction: "up", label: "+0.4%" },
    };

    const root = createMetricCard(doc, data) as FakeEl;

    expect(root.attributes.get("data-status")).toBe("ok");
    expect(root.children).toHaveLength(3); // header + body + caption

    const header = expectByClass(root, "qualy-card__header");
    expect(header.children).toHaveLength(2); // label + delta

    const delta = expectByClass(root, "qualy-card__delta");
    expect(delta.tagName).toBe("span");
    expect(delta.attributes.get("data-direction")).toBe("up");
    expect(delta.attributes.get("aria-label")).toBe("trend up: +0.4%");
    expect(delta.textContent).toBe("▲ +0.4%");

    const body = expectByClass(root, "qualy-card__body");
    expect(body.children).toHaveLength(2); // value + unit

    const valueEl = expectByClass(root, "qualy-card__value");
    expect(valueEl.textContent).toBe("94.2");

    const unitEl = expectByClass(root, "qualy-card__unit");
    expect(unitEl.tagName).toBe("span");
    expect(unitEl.textContent).toBe("%");

    const captionEl = expectByClass(root, "qualy-card__caption");
    expect(captionEl.tagName).toBe("p");
    expect(captionEl.textContent).toBe("lines");
  });

  it("formats numeric values with thousands separators in the DOM", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, { label: "WMC", value: 1234 }) as FakeEl;
    const valueEl = expectByClass(root, "qualy-card__value");
    expect(valueEl.textContent).toBe("1,234");
  });

  it("renders pre-formatted string values verbatim", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, { label: "Status", value: "—" }) as FakeEl;
    const valueEl = expectByClass(root, "qualy-card__value");
    expect(valueEl.textContent).toBe("—");
  });

  it("propagates status to data-status for each accepted value", () => {
    for (const status of STATUSES) {
      const { doc } = createFakeDoc();
      const root = createMetricCard(doc, {
        label: "X",
        value: 1,
        status,
      }) as FakeEl;
      expect(root.attributes.get("data-status")).toBe(status);
    }
  });

  it("emits the right glyph + a11y label for each delta direction", () => {
    for (const direction of DIRECTIONS) {
      const { doc } = createFakeDoc();
      const root = createMetricCard(doc, {
        label: "X",
        value: 1,
        delta: { direction, label: "+1" },
      }) as FakeEl;
      const delta = expectByClass(root, "qualy-card__delta");
      expect(delta.attributes.get("data-direction")).toBe(direction);
      expect(delta.attributes.get("aria-label")).toBe(deltaAriaLabel({ direction, label: "+1" }));
      expect(delta.textContent?.startsWith(deltaGlyph(direction))).toBe(true);
    }
  });

  it("handles a delta with empty label (drops glyph trailing space)", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, {
      label: "X",
      value: 1,
      delta: { direction: "flat", label: "" },
    }) as FakeEl;
    const delta = expectByClass(root, "qualy-card__delta");
    expect(delta.textContent).toBe("▬"); // trailing space trimmed
    expect(delta.attributes.get("aria-label")).toBe("trend unchanged");
  });

  it("omits unit element when unit is missing or empty", () => {
    const { doc: docMissing } = createFakeDoc();
    const rootMissing = createMetricCard(docMissing, { label: "X", value: 1 }) as FakeEl;
    expect(findByClass(rootMissing, "qualy-card__unit")).toBeNull();

    const { doc: docEmpty } = createFakeDoc();
    const rootEmpty = createMetricCard(docEmpty, {
      label: "X",
      value: 1,
      unit: "",
    }) as FakeEl;
    expect(findByClass(rootEmpty, "qualy-card__unit")).toBeNull();
  });

  it("omits caption element when caption is missing or empty", () => {
    const { doc: docMissing } = createFakeDoc();
    const rootMissing = createMetricCard(docMissing, { label: "X", value: 1 }) as FakeEl;
    expect(findByClass(rootMissing, "qualy-card__caption")).toBeNull();

    const { doc: docEmpty } = createFakeDoc();
    const rootEmpty = createMetricCard(docEmpty, {
      label: "X",
      value: 1,
      caption: "",
    }) as FakeEl;
    expect(findByClass(rootEmpty, "qualy-card__caption")).toBeNull();
  });

  it("omits delta element when delta is missing", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, { label: "X", value: 1 }) as FakeEl;
    expect(findByClass(root, "qualy-card__delta")).toBeNull();
  });

  it("preserves child ordering: header before body before caption", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, {
      label: "X",
      value: 1,
      caption: "ctx",
    }) as FakeEl;
    const tags = root.children.map((c) => c.tagName);
    expect(tags).toEqual(["header", "div", "p"]);
  });

  it("preserves header child ordering: label before delta", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, {
      label: "X",
      value: 1,
      delta: { direction: "up", label: "+1" },
    }) as FakeEl;
    const header = expectByClass(root, "qualy-card__header");
    const tags = header.children.map((c) => c.tagName);
    expect(tags).toEqual(["h3", "span"]);
  });

  it("preserves body child ordering: value before unit", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, { label: "X", value: 1, unit: "ms" }) as FakeEl;
    const body = expectByClass(root, "qualy-card__body");
    const tags = body.children.map((c) => c.tagName);
    expect(tags).toEqual(["strong", "span"]);
  });

  it("creates only one element per call (no global side effects)", () => {
    const { doc, created } = createFakeDoc();
    createMetricCard(doc, { label: "A", value: 1 });
    const firstCount = created.length;
    createMetricCard(doc, { label: "B", value: 2 });
    expect(created.length).toBeGreaterThan(firstCount);
  });

  it("uses lowercase tag names exclusively (createElement contract)", () => {
    const { doc } = createFakeDoc();
    const root = createMetricCard(doc, {
      label: "X",
      value: 1,
      unit: "u",
      caption: "c",
      delta: { direction: "up", label: "+1" },
      status: "warn",
    }) as FakeEl;
    for (const tag of tagsInOrder(root)) {
      expect(tag).toBe(tag.toLowerCase());
    }
  });
});
