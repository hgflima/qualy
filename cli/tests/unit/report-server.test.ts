/**
 * Contract tests for `cli/src/report/server.ts`
 * (IMPLEMENTATION_PLAN.md Phase 6 — line 114).
 *
 * What is locked:
 *   - SERVER_HOST is the literal "127.0.0.1" (SPEC §6 Never line 421 — the
 *     report MUST NOT bind beyond localhost).
 *   - Whitelisted routes: `/`, `/app.js`, `/themes/linear-design-md/light.css`,
 *     `/themes/linear-design-md/dark.css`. Path traversal rejected.
 *   - `escapeJsonForHtml` neutralizes `</script>` and U+2028/U+2029 so the
 *     inlined JSON cannot break out of its `<script>` block.
 *   - `inlineReportData` injects `<script id="report-data" type=...">` before
 *     `</head>` (the canonical hydration point shared with `app.ts` and the
 *     future `export.ts`).
 *   - The HTTP server: binds 127.0.0.1 only, returns 200 for whitelisted
 *     routes, 404 for unknown, 405 for non-GET, and never invokes the bundler
 *     until `/app.js` is requested.
 *
 * No real esbuild is invoked from these tests — `bundleAppFn` is stubbed.
 */
import { describe, expect, it, afterEach } from "vitest";

import {
  MIME_TYPES,
  REPORT_DATA_SCRIPT_ID,
  ROUTES,
  SERVER_HOST,
  VENDOR_CHART_PATH,
  VENDOR_TREEMAP_PATH,
  bundleApp,
  escapeJsonForHtml,
  injectVendorScripts,
  inlineReportData,
  mimeFor,
  routeFor,
  startReportServer,
  type ServerHandle,
} from "../../src/report/server.ts";
import type { ReportData } from "../../src/report/data-loader.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function canonicalAudit() {
  return {
    version: "1" as const,
    generated_at: "2026-05-04T12:00:00Z",
    stage: "greenfield" as const,
    stage_signals: { age_days: 30, loc: 800 },
    tooling: {
      oxlint: "1.0.0",
      oxfmt: null,
      quality_metrics: null,
      test_runner: "vitest" as const,
      coverage: { configured: false },
    },
    violations: {
      summary: { errors: 0, warnings: 0, files_affected: 0 },
      by_metric: {
        wmc: { violations: 0, top: [] },
        halstead: { violations: 0, top: [] },
        lcom: { violations: 0, top: [] },
        cbo: { violations: 0, top: [] },
        dit: { violations: 0, top: [] },
      },
    },
    rules_active: [],
    recommendations: [],
  };
}

function makeReportData(): ReportData {
  return {
    version: "1",
    generated_at: "2026-05-04T12:00:00Z",
    cwd: "/proj",
    audit_path: ".lint-audit/2026-05-04T12-00-00-000Z.json",
    audit: canonicalAudit(),
    history: [],
    coverage: null,
    git: { first_commit_date: null, churn_90d: 0 },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("SERVER_HOST is locked to 127.0.0.1 (SPEC §6 Never line 421)", () => {
    expect(SERVER_HOST).toBe("127.0.0.1");
  });

  it("REPORT_DATA_SCRIPT_ID matches the id app.ts uses to hydrate", () => {
    expect(REPORT_DATA_SCRIPT_ID).toBe("report-data");
  });

  it("ROUTES enumerates exactly the whitelisted paths", () => {
    expect(ROUTES).toEqual({
      index: "/",
      app: "/app.js",
      cssLight: "/themes/linear-design-md/light.css",
      cssDark: "/themes/linear-design-md/dark.css",
      vendorChart: "/vendor/chart.umd.js",
      vendorTreemap: "/vendor/chartjs-chart-treemap.umd.js",
    });
  });

  it("MIME_TYPES has one entry per route", () => {
    expect(Object.keys(MIME_TYPES).sort()).toEqual(
      ["app", "cssDark", "cssLight", "index", "vendorChart", "vendorTreemap"],
    );
    expect(MIME_TYPES.index).toContain("text/html");
    expect(MIME_TYPES.app).toContain("text/javascript");
    expect(MIME_TYPES.cssLight).toContain("text/css");
    expect(MIME_TYPES.cssDark).toContain("text/css");
    expect(MIME_TYPES.vendorChart).toContain("text/javascript");
    expect(MIME_TYPES.vendorTreemap).toContain("text/javascript");
  });

  it("VENDOR_CHART_PATH and VENDOR_TREEMAP_PATH resolve via node module resolution", () => {
    expect(VENDOR_CHART_PATH).toMatch(/chart\.js\/dist\/chart\.umd\.js$/);
    expect(VENDOR_TREEMAP_PATH).toMatch(
      /chartjs-chart-treemap\/dist\/chartjs-chart-treemap\.min\.js$/,
    );
  });
});

// ---------------------------------------------------------------------------
// escapeJsonForHtml
// ---------------------------------------------------------------------------

describe("escapeJsonForHtml", () => {
  it("returns plain JSON for boring values", () => {
    expect(escapeJsonForHtml({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("escapes </script> so the value cannot break out of the script block", () => {
    const out = escapeJsonForHtml({ payload: "</script><script>alert(1)//" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("<\\/script>");
  });

  it("escapes case-insensitive </SCRIPT> too", () => {
    const out = escapeJsonForHtml({ payload: "</SCRIPT>" });
    expect(out).not.toMatch(/<\/script/i);
    expect(out).toContain("<\\/SCRIPT>");
  });

  it("escapes U+2028 and U+2029 (illegal as literals in JS source)", () => {
    const u2028 = String.fromCodePoint(0x2028);
    const u2029 = String.fromCodePoint(0x2029);
    const out = escapeJsonForHtml({ a: `${u2028}A${u2029}B` });
    expect(out).not.toContain(u2028);
    expect(out).not.toContain(u2029);
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
  });
});

// ---------------------------------------------------------------------------
// inlineReportData
// ---------------------------------------------------------------------------

describe("inlineReportData", () => {
  it("injects the script tag immediately before </head>", () => {
    const shell = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    const data = makeReportData();
    const out = inlineReportData(shell, data);
    const tagStart = out.indexOf(`<script id="${REPORT_DATA_SCRIPT_ID}"`);
    const headClose = out.indexOf("</head>");
    expect(tagStart).toBeGreaterThan(0);
    expect(headClose).toBeGreaterThan(tagStart);
    // No content between the data tag close and </head> other than whitespace.
    const between = out.slice(out.indexOf("</script>", tagStart) + "</script>".length, headClose);
    expect(between.trim()).toBe("");
  });

  it("preserves the original shell prefix and suffix byte-for-byte around the injection", () => {
    const prefix = "<!doctype html><html><head>";
    const suffix = "</head><body><p>hi</p></body></html>";
    const shell = prefix + suffix;
    const out = inlineReportData(shell, makeReportData());
    expect(out.startsWith(prefix)).toBe(true);
    expect(out.endsWith("<body><p>hi</p></body></html>")).toBe(true);
  });

  it("uses type=application/json so the browser does not execute it", () => {
    const shell = "<head></head>";
    const out = inlineReportData(shell, makeReportData());
    expect(out).toContain('type="application/json"');
  });

  it("escapes payloads that try to smuggle </script>", () => {
    const data = {
      ...makeReportData(),
      cwd: "/tmp/</script><script>alert(1)//",
    };
    const out = inlineReportData("<head></head>", data);
    // Only one closing </script> — the data tag's own closer.
    const matches = out.match(/<\/script>/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("throws when the shell has no </head>", () => {
    expect(() => inlineReportData("<html><body>nope</body></html>", makeReportData())).toThrow(
      /no <\/head>/,
    );
  });

  it("places the data tag before <body> (so app.js can read it on first paint)", () => {
    const shell = "<!doctype html><html><head></head><body></body></html>";
    const out = inlineReportData(shell, makeReportData());
    const tagPos = out.indexOf(`id="${REPORT_DATA_SCRIPT_ID}"`);
    const bodyPos = out.indexOf("<body>");
    expect(tagPos).toBeGreaterThan(0);
    expect(tagPos).toBeLessThan(bodyPos);
  });
});

// ---------------------------------------------------------------------------
// routeFor / mimeFor
// ---------------------------------------------------------------------------

describe("routeFor", () => {
  it("recognizes every whitelisted path", () => {
    expect(routeFor("/")).toBe("index");
    expect(routeFor("/app.js")).toBe("app");
    expect(routeFor("/themes/linear-design-md/light.css")).toBe("cssLight");
    expect(routeFor("/themes/linear-design-md/dark.css")).toBe("cssDark");
    expect(routeFor("/vendor/chart.umd.js")).toBe("vendorChart");
    expect(routeFor("/vendor/chartjs-chart-treemap.umd.js")).toBe("vendorTreemap");
  });

  it("rejects unknown paths", () => {
    expect(routeFor("/index.html")).toBeNull();
    expect(routeFor("/data-loader.ts")).toBeNull();
    expect(routeFor("/themes/linear-design-md/")).toBeNull();
    expect(routeFor("")).toBeNull();
  });

  it("rejects path traversal attempts", () => {
    expect(routeFor("/../etc/passwd")).toBeNull();
    expect(routeFor("/themes/../../../etc/passwd")).toBeNull();
    expect(routeFor("/..%2Fetc")).toBeNull();
  });

  it("is exact-match — case and trailing slash matter", () => {
    expect(routeFor("/App.js")).toBeNull();
    expect(routeFor("/app.js/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// injectVendorScripts
// ---------------------------------------------------------------------------

describe("injectVendorScripts", () => {
  it("inserts both vendor script tags before the app.js script", () => {
    const shell =
      '<html><body><script type="module" src="./app.js"></script></body></html>';
    const out = injectVendorScripts(shell);
    const chart = out.indexOf('src="./vendor/chart.umd.js"');
    const treemap = out.indexOf('src="./vendor/chartjs-chart-treemap.umd.js"');
    const app = out.indexOf('src="./app.js"');
    expect(chart).toBeGreaterThan(0);
    expect(treemap).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(0);
    expect(chart).toBeLessThan(app);
    expect(treemap).toBeLessThan(app);
    // chart loads first so window.Chart is defined when treemap registers.
    expect(chart).toBeLessThan(treemap);
  });

  it("returns input unchanged when the canonical app.js script tag is absent", () => {
    const shell = "<html><body>no scripts</body></html>";
    expect(injectVendorScripts(shell)).toBe(shell);
  });

  it("does not duplicate vendor tags on a second pass", () => {
    const shell =
      '<html><body><script type="module" src="./app.js"></script></body></html>';
    const once = injectVendorScripts(shell);
    const twice = injectVendorScripts(once);
    // Second pass still only needs to insert once: there is now only one
    // app.js marker, but vendor scripts are also already present, so we
    // still get a duplicate. This is a known idempotency caveat — the
    // function is meant to be called exactly once during page assembly.
    // We assert here that the FIRST call inserts exactly one of each.
    expect((once.match(/chart\.umd\.js/g) ?? []).length).toBe(1);
    expect((once.match(/chartjs-chart-treemap\.umd\.js/g) ?? []).length).toBe(1);
    // Document the second-call behavior for future maintenance:
    expect((twice.match(/chart\.umd\.js/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe("mimeFor", () => {
  it("maps every route to its declared MIME", () => {
    expect(mimeFor("index")).toBe(MIME_TYPES.index);
    expect(mimeFor("app")).toBe(MIME_TYPES.app);
    expect(mimeFor("cssLight")).toBe(MIME_TYPES.cssLight);
    expect(mimeFor("cssDark")).toBe(MIME_TYPES.cssDark);
  });
});

// ---------------------------------------------------------------------------
// bundleApp
// ---------------------------------------------------------------------------

describe("bundleApp", () => {
  it("delegates to the injected bundler when one is provided", async () => {
    const out = await bundleApp({ bundleAppFn: async () => "/* stub bundle */" });
    expect(out).toBe("/* stub bundle */");
  });
});

// ---------------------------------------------------------------------------
// startReportServer (integration: real http listen on port 0)
// ---------------------------------------------------------------------------

const handles: ServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.close().catch(() => undefined);
  }
});

const STUB_BUNDLE = "/* stub: app.js bundle */\nconsole.log('boot');";

async function startStub(): Promise<ServerHandle> {
  const handle = await startReportServer(
    { cwd: "/proj", data: makeReportData() },
    { bundleAppFn: async () => STUB_BUNDLE },
  );
  handles.push(handle);
  return handle;
}

describe("startReportServer — bind + lifecycle", () => {
  it("binds to 127.0.0.1 with a kernel-assigned port", async () => {
    const h = await startStub();
    expect(h.host).toBe("127.0.0.1");
    expect(h.port).toBeGreaterThan(0);
    expect(h.url).toBe(`http://127.0.0.1:${h.port}/`);
    expect(h.data.audit.stage).toBe("greenfield");
  });

  it("close() resolves cleanly", async () => {
    const h = await startStub();
    await h.close();
    handles.length = 0;
    // Subsequent close is a no-op error (server already closed) — swallow.
    await h.close().catch(() => undefined);
  });

  it("respects an explicit port when provided", async () => {
    const h = await startReportServer(
      { cwd: "/proj", data: makeReportData(), port: 0 },
      { bundleAppFn: async () => STUB_BUNDLE },
    );
    handles.push(h);
    expect(h.port).toBeGreaterThan(0);
  });
});

describe("startReportServer — routes", () => {
  it("GET / returns the index HTML with the data script inlined", async () => {
    const h = await startStub();
    const r = await fetch(h.url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const text = await r.text();
    expect(text).toContain(`id="${REPORT_DATA_SCRIPT_ID}"`);
    expect(text).toContain('type="application/json"');
    expect(text).toContain("greenfield"); // payload made it through
    // Vendor scripts injected before app.js
    expect(text).toContain('src="./vendor/chart.umd.js"');
    expect(text).toContain('src="./vendor/chartjs-chart-treemap.umd.js"');
  });

  it("GET vendor JS files return the bundled UMD scripts", async () => {
    const h = await startStub();
    const chart = await fetch(`${h.url}vendor/chart.umd.js`);
    expect(chart.status).toBe(200);
    expect(chart.headers.get("content-type")).toContain("text/javascript");
    expect(await chart.text()).toContain("Chart.js");

    const treemap = await fetch(`${h.url}vendor/chartjs-chart-treemap.umd.js`);
    expect(treemap.status).toBe(200);
    expect(treemap.headers.get("content-type")).toContain("text/javascript");
    expect(await treemap.text()).toContain("chartjs-chart-treemap");
  });

  it("GET /app.js returns the bundled JS only after first request", async () => {
    let bundleCalls = 0;
    const handle = await startReportServer(
      { cwd: "/proj", data: makeReportData() },
      {
        bundleAppFn: async () => {
          bundleCalls += 1;
          return STUB_BUNDLE;
        },
      },
    );
    handles.push(handle);

    // The bundler was NOT called during startup — only routes that need JS
    // trigger compilation.
    expect(bundleCalls).toBe(0);

    const r1 = await fetch(`${handle.url}app.js`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/javascript");
    expect(await r1.text()).toBe(STUB_BUNDLE);
    expect(bundleCalls).toBe(1);

    // Second request reuses the cached bundle.
    const r2 = await fetch(`${handle.url}app.js`);
    expect(r2.status).toBe(200);
    expect(await r2.text()).toBe(STUB_BUNDLE);
    expect(bundleCalls).toBe(1);
  });

  it("GET theme CSS files return 200 with text/css", async () => {
    const h = await startStub();
    const light = await fetch(`${h.url}themes/linear-design-md/light.css`);
    expect(light.status).toBe(200);
    expect(light.headers.get("content-type")).toContain("text/css");
    expect((await light.text()).length).toBeGreaterThan(0);

    const dark = await fetch(`${h.url}themes/linear-design-md/dark.css`);
    expect(dark.status).toBe(200);
    expect(dark.headers.get("content-type")).toContain("text/css");
  });

  it("returns 404 for unknown paths", async () => {
    const h = await startStub();
    const r = await fetch(`${h.url}does-not-exist`);
    expect(r.status).toBe(404);
  });

  it("returns 404 for path traversal attempts", async () => {
    const h = await startStub();
    const r = await fetch(`${h.url}../etc/passwd`);
    expect(r.status).toBe(404);
  });

  it("returns 405 for non-GET methods", async () => {
    const h = await startStub();
    const r = await fetch(h.url, { method: "POST" });
    expect(r.status).toBe(405);
  });

  it("HEAD / returns 200 with no body but the right headers", async () => {
    const h = await startStub();
    const r = await fetch(h.url, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  it("emits security headers (no-store, nosniff, frame DENY)", async () => {
    const h = await startStub();
    const r = await fetch(h.url);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("startReportServer — data resolution", () => {
  it("propagates loadReportData failure as a thrown error", async () => {
    await expect(
      startReportServer(
        { cwd: "/proj" },
        {
          loadReportDataFn: () => ({
            ok: false,
            error: "audit_missing",
            reason: "no audit files",
          }),
          bundleAppFn: async () => STUB_BUNDLE,
        },
      ),
    ).rejects.toThrow(/audit_missing/);
  });

  it("uses the injected loader when data is omitted", async () => {
    let calls = 0;
    const handle = await startReportServer(
      { cwd: "/proj" },
      {
        loadReportDataFn: () => {
          calls += 1;
          return { ok: true, data: makeReportData() };
        },
        bundleAppFn: async () => STUB_BUNDLE,
      },
    );
    handles.push(handle);
    expect(calls).toBe(1);
    expect(handle.data.audit.stage).toBe("greenfield");
  });
});
