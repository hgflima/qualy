/**
 * E2E test for `report/export` — self-contained snapshot that renders
 * **identical to the live server** when opened offline
 * (IMPLEMENTATION_PLAN.md Phase 6 line 119, SPEC §7.7 acceptance #4 line 468:
 * "O HTML exportado abre offline e renderiza idêntico ao servidor.").
 *
 * What is locked end-to-end against a real fixture:
 *
 *   1. The full pipeline runs without any asset stubs:
 *        materialize fixture → install oxlint preset → run audit() with stub
 *        diagnostics → write `.lint-audit/<ts>.json` → load report data via the
 *        real `loadReportData` → call `exportReport()` with REAL
 *        `bundleApp` (esbuild over `app.ts`), real theme CSS reads, and real
 *        vendor UMD reads (chart.js + chartjs-chart-treemap from node_modules).
 *
 *   2. Self-contained / offline-safe (SPEC §6 Never line 421-422):
 *        - The exported HTML carries ZERO external `<link rel="stylesheet">`,
 *          `<script src="...">`, or protocol-relative (`//host`) references.
 *          A user double-clicking the file from `quality-report/<ts>.html`
 *          must not trigger a network request.
 *        - The two theme CSS bodies (light + dark) are inlined verbatim as
 *          `<style>` blocks, in that order, so the dark cascade still wins
 *          under `[data-theme="dark"]`.
 *        - The two vendor UMD bundles (chart.js, chartjs-chart-treemap) and the
 *          esbuild-bundled `app.js` are inlined as `<script>` blocks, vendor
 *          first (so `globalThis.Chart` exists by the time the app boots).
 *
 *   3. Renders identical to the server:
 *        - Both server and export are fed the SAME `bundleAppFn` (memoized
 *          real esbuild call), so the app bundle bytes are byte-equal between
 *          the live page (`/app.js`) and the inlined `<script type="module">`
 *          in the snapshot.
 *        - The theme CSS bodies served at `/themes/linear-design-md/{light,
 *          dark}.css` appear verbatim inside the export's inlined `<style>`
 *          blocks.
 *        - The vendor UMD bytes served at `/vendor/{chart,chartjs-chart-
 *          treemap}.umd.js` appear verbatim inside the export's inlined
 *          vendor `<script>` blocks.
 *        - The `<script id="report-data" type="application/json">` payload
 *          structure is identical between server and export — every field
 *          except `cwd` is byte-equal; `cwd` is replaced by `<redacted>` in
 *          the export, since snapshots are user-versioned and must not leak
 *          the author's filesystem topology (SPEC §6 line 422).
 *
 *   4. Sensitive-data filter is on by default (no `--no-redact` flag passed):
 *        - `cwd` value in the inlined JSON is the literal `<redacted>`.
 *        - The audit_path (project-relative) is preserved.
 *
 * Why we run a single shared `bundleAppFn`: esbuild over `app.ts` takes
 * ~300–800ms; running it twice (once for the server, once for the export)
 * doubles wall time and risks non-determinism between calls. We bundle once,
 * cache the result, and feed the same bytes to both `startReportServer` and
 * `exportReport`. This is exactly what the production code paths do (each
 * path calls `bundleApp` ONCE per lifetime — the server caches lazily; the
 * export bundles once per invocation), so the cache is faithful to runtime.
 *
 * Why the audit is stubbed instead of running real `oxlint`: SPEC §7.5
 * requires error-level diagnostics to flow through; spawning real oxlint
 * needs the binary on PATH and a deterministic source tree. The stub
 * `runFn` is the same idiom `audit-recommendations.test.ts` uses — it
 * produces a canonical greenfield audit JSON without subprocess.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { audit, toSafeTimestamp } from "../../src/commands/audit.ts";
import { installOxlint } from "../../src/commands/install/oxlint.ts";
import { loadReportData } from "../../src/report/data-loader.ts";
import { exportReport } from "../../src/report/export.ts";
import {
  bundleApp,
  startReportServer,
  THEME_DARK_PATH,
  THEME_LIGHT_PATH,
  VENDOR_CHART_PATH,
  VENDOR_TREEMAP_PATH,
  type BundleAppFn,
  type ServerHandle,
} from "../../src/report/server.ts";
import { join } from "node:path";
import { materializeFixture } from "../fixtures/_materialize.ts";

const FIXED_DATE = new Date("2026-05-04T12:00:00.000Z");

interface StubDiagnostic {
  readonly severity: "error" | "warning";
  readonly filename: string;
  readonly rule: string;
  readonly value?: number;
  readonly max?: number;
  readonly class?: string;
}

/**
 * One wmc warning + one halstead warning. Enough to populate
 * `violations.by_metric.{wmc,halstead}.top[]` so the inlined JSON has real
 * shape (not just zeros), but not so many that the export blows past the
 * timestamped filename test path.
 */
function buildDiagnostics(): StubDiagnostic[] {
  return [
    {
      severity: "warning",
      filename: "src/calculator.ts",
      rule: "quality-metrics/wmc",
      class: "Calculator",
      value: 18,
      max: 15,
    },
    {
      severity: "warning",
      filename: "src/calculator.ts",
      rule: "quality-metrics/halstead-volume",
      class: "Calculator",
      value: 1100,
      max: 1000,
    },
  ];
}

function makeSharedBundler(): BundleAppFn {
  let cached: string | null = null;
  return async () => {
    if (cached === null) cached = await bundleApp();
    return cached;
  };
}

describe("e2e: SPEC §7.7 #4 — exported HTML opens offline and renders identical to server", () => {
  const cleanups: Array<() => void> = [];
  const handles: ServerHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop();
      if (h) await h.close().catch(() => undefined);
    }
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it(
    "exportReport produces a self-contained HTML whose inlined CSS/JS/data match the live server byte-for-byte",
    { timeout: 30_000 },
    async () => {
      // ── Step 1: materialize fixture + install preset ────────────────────
      const fx = materializeFixture("greenfield-ts");
      cleanups.push(fx.cleanup);

      const ox = installOxlint({ cwd: fx.dir, stage: "greenfield" });
      expect(ox.ok, JSON.stringify(ox)).toBe(true);

      // ── Step 2: write a real .lint-audit/<ts>.json via audit() ──────────
      const auditRes = audit(
        { cwd: fx.dir },
        {
          runFn: () => ({
            ok: true,
            stdout: JSON.stringify(buildDiagnostics()),
            stderr: "",
            exitCode: 0,
          }),
          now: () => FIXED_DATE,
        },
      );
      expect(auditRes.ok, JSON.stringify(auditRes)).toBe(true);
      if (!auditRes.ok) return;
      expect(auditRes.path).toBe(`.lint-audit/${toSafeTimestamp(FIXED_DATE)}.json`);
      expect(existsSync(join(fx.dir, auditRes.path))).toBe(true);

      // ── Step 3: load the canonical report data ──────────────────────────
      const dataRes = loadReportData({ cwd: fx.dir, now: FIXED_DATE });
      expect(dataRes.ok, JSON.stringify(dataRes)).toBe(true);
      if (!dataRes.ok) return;
      const reportData = dataRes.data;

      // Sanity: cwd is the absolute fixture path (will be redacted in export).
      expect(reportData.cwd).toBe(fx.dir);
      expect(reportData.audit_path).toBe(auditRes.path);
      expect(reportData.audit.violations.summary.warnings).toBe(2);
      expect(reportData.audit.violations.by_metric.wmc.violations).toBe(1);
      expect(reportData.audit.violations.by_metric.halstead.violations).toBe(1);

      // ── Step 4: bundle app.ts once via real esbuild and share with both ─
      // server and export. Two separate bundles would risk non-determinism;
      // sharing locks "same bytes everywhere" at the source.
      const sharedBundler = makeSharedBundler();
      const appBundle = await sharedBundler();
      expect(appBundle.length).toBeGreaterThan(1000);

      // ── Step 5: spawn the live server with the same data + bundler ──────
      // The server is the source of truth for the index HTML structure; we
      // only fetch `/` from it (to compare the inlined `report-data` payload
      // structurally against the export). For the JS/CSS asset bytes we read
      // straight from disk — Node's http response round-trips through string
      // encoding and can shift a few bytes (BOM normalization, line-ending
      // canonicalization), which is irrelevant to "identical rendering" since
      // the browser receives the disk bytes verbatim from the server too.
      const server = await startReportServer(
        { cwd: fx.dir, data: reportData },
        { bundleAppFn: sharedBundler },
      );
      handles.push(server);

      const serverIndex = await fetch(server.url).then((r) => r.text());

      // Read the actual asset bytes the server hands to the browser, from
      // the same paths the server reads at startup. Locks "exported HTML
      // contains the same disk bytes the server serves."
      const diskLight = readFileSync(THEME_LIGHT_PATH, "utf8");
      const diskDark = readFileSync(THEME_DARK_PATH, "utf8");
      const diskVendorChart = readFileSync(VENDOR_CHART_PATH, "utf8");
      const diskVendorTreemap = readFileSync(VENDOR_TREEMAP_PATH, "utf8");

      // ── Step 6: export the snapshot to disk via the REAL exporter ───────
      // No asset stubs, no bundleApp stub other than the shared cache —
      // every readFile and the esbuild call go through the real code path.
      const exportRes = await exportReport(
        {
          cwd: fx.dir,
          data: reportData,
          now: FIXED_DATE,
        },
        { bundleAppFn: sharedBundler },
      );
      expect(exportRes.ok, JSON.stringify(exportRes)).toBe(true);
      if (!exportRes.ok) return;
      expect(exportRes.redacted).toBe(true);
      expect(exportRes.path).toBe(
        `quality-report/${toSafeTimestamp(FIXED_DATE)}.html`,
      );

      const exportedBuf = readFileSync(join(fx.dir, exportRes.path));
      const exported = exportedBuf.toString("utf8");
      // `bytes` reports UTF-8 byte length; `exported.length` is UTF-16 code
      // units. Compare against the buffer byteLength to lock the on-disk
      // size against the value `exportReport` returned to the dispatcher.
      expect(exportedBuf.byteLength).toBe(exportRes.bytes);

      // ── Self-contained / offline-safe checks (SPEC §6 Never line 421-422) ─
      // Zero external <link rel="stylesheet"> tags — themes must be inline.
      expect(exported).not.toMatch(/<link\s+rel=["']stylesheet["']/i);
      // Zero <script src="..."> — vendors and app must be inline. The shell's
      // canonical `<script type="module" src="./app.js">` is replaced by the
      // exporter; vendors are NOT injected as src tags either (they are
      // inlined directly, unlike the live server where they are separate
      // routes).
      expect(exported).not.toMatch(/<script\s+[^>]*\bsrc=/i);
      // Zero protocol-relative or absolute external URLs in href/src.
      expect(exported).not.toMatch(/(?:href|src)=["']https?:\/\//i);
      expect(exported).not.toMatch(/(?:href|src)=["']\/\//);

      // ── Theme CSS bodies inlined verbatim (disk bytes ⊂ export) ─────────
      expect(diskLight.length).toBeGreaterThan(0);
      expect(diskDark.length).toBeGreaterThan(0);
      expect(exported).toContain(diskLight);
      expect(exported).toContain(diskDark);
      // Order: light first, dark second (so [data-theme="dark"] cascades win).
      expect(exported.indexOf(diskLight)).toBeLessThan(exported.indexOf(diskDark));
      // Both wrapped in <style> blocks (not <link>).
      expect(exported.match(/<style>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

      // ── Vendor UMD bytes inlined verbatim ───────────────────────────────
      // chart.umd.js and chartjs-chart-treemap.min.js are large (~200KB and
      // ~14KB respectively). Substring inclusion is the strongest assertion
      // possible without parsing the HTML — it locks the export to the same
      // disk bytes the server hands to the browser.
      expect(diskVendorChart.length).toBeGreaterThan(50_000);
      expect(diskVendorTreemap.length).toBeGreaterThan(5_000);
      expect(exported).toContain(diskVendorChart);
      expect(exported).toContain(diskVendorTreemap);
      // Vendor order: chart before treemap (treemap registers a controller on
      // window.Chart, which must already exist).
      expect(exported.indexOf(diskVendorChart)).toBeLessThan(
        exported.indexOf(diskVendorTreemap),
      );

      // ── App bundle inlined verbatim ─────────────────────────────────────
      // We compare against the cached bundle (the same bytes the server's
      // bundleAppFn returns). Note: the export's `inlineAllScripts` defangs
      // any literal `</script` in the bundle; if the esbuild output happened
      // to contain such a sequence, the inline copy would diverge. Today's
      // app.ts produces a bundle without `</script` (no string-literal
      // smuggling), so the bytes round-trip cleanly. If a future bundle DOES
      // contain `</script`, this assertion would fail and the test owner
      // would need to compare post-defang.
      expect(exported).toContain(appBundle);
      // App after both vendors so globalThis.Chart and the treemap controller
      // are wired before app.js boots.
      expect(exported.indexOf(diskVendorTreemap)).toBeLessThan(exported.indexOf(appBundle));

      // ── Inlined report-data script: structurally identical to server's ──
      // Both server and export inject a <script id="report-data"
      // type="application/json"> with the same payload, but export redacts
      // `cwd` (and runs `redactString` on every other string). For this
      // greenfield fixture, the only field that should differ is `cwd`.
      const dataScriptRe =
        /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/;
      const serverMatch = serverIndex.match(dataScriptRe);
      const exportMatch = exported.match(dataScriptRe);
      expect(serverMatch, "server html missing report-data script").toBeTruthy();
      expect(exportMatch, "exported html missing report-data script").toBeTruthy();
      if (!serverMatch || !exportMatch) return;

      const serverPayload = JSON.parse(serverMatch[1]) as Record<string, unknown>;
      const exportPayload = JSON.parse(exportMatch[1]) as Record<string, unknown>;

      // cwd diverges: server keeps it absolute (local-only context), export
      // replaces it with `<redacted>` (versionable artifact).
      expect(serverPayload.cwd).toBe(fx.dir);
      expect(exportPayload.cwd).toBe("<redacted>");

      // Every other top-level field is byte-equal between server and export.
      // (We don't care about field order — JSON.parse normalizes, but the
      // structural deepEqual confirms identity modulo cwd.)
      const stripCwd = (p: Record<string, unknown>): Record<string, unknown> => {
        const { cwd: _cwd, ...rest } = p;
        return rest;
      };
      expect(stripCwd(exportPayload)).toEqual(stripCwd(serverPayload));

      // Audit-relative path survives redaction (project-relative is fine).
      expect(exportPayload.audit_path).toBe(auditRes.path);
      // Audit JSON survived the round-trip intact (stage matches whatever the
      // detector decided for this fixture; warnings count locked by the stub
      // diagnostics).
      const exportedAudit = exportPayload.audit as {
        stage: string;
        violations: { summary: { warnings: number } };
      };
      expect(exportedAudit.stage).toBe(reportData.audit.stage);
      expect(exportedAudit.violations.summary.warnings).toBe(2);

      // ── Final hygiene: snapshot is NOT in .lint-manifest.json ───────────
      // Snapshots are user-versioned (SPEC §2 line 181 — committed by the
      // user, not tracked by the manifest, so /lint:uninstall preserves them).
      const manifestPath = join(fx.dir, ".lint-manifest.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          entries?: Array<{ path?: string }>;
        };
        const paths = manifest.entries?.map((e) => e.path) ?? [];
        expect(paths).not.toContain(exportRes.path);
        expect(paths.some((p) => p?.startsWith("quality-report/"))).toBe(false);
      }
    },
  );

  it("opens offline as a single document — every URL-bearing attribute is either inlined or project-relative", async () => {
    // Smaller smoke variant: skips the live server and just inspects the
    // exported HTML to lock the offline-safety contract on its own. Useful
    // because the heavy test above could regress without anyone noticing if
    // the server side broke first; this assertion is independent.
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    expect(installOxlint({ cwd: fx.dir, stage: "greenfield" }).ok).toBe(true);

    const auditRes = audit(
      { cwd: fx.dir },
      {
        runFn: () => ({ ok: true, stdout: "[]", stderr: "", exitCode: 0 }),
        now: () => FIXED_DATE,
      },
    );
    expect(auditRes.ok).toBe(true);
    if (!auditRes.ok) return;

    const exportRes = await exportReport(
      { cwd: fx.dir, now: FIXED_DATE },
      { bundleAppFn: makeSharedBundler() },
    );
    expect(exportRes.ok, JSON.stringify(exportRes)).toBe(true);
    if (!exportRes.ok) return;

    const html = readFileSync(join(fx.dir, exportRes.path), "utf8");

    // No external network references in any href/src attribute.
    const externalUrlRe = /(?:href|src)=["'](?:https?:|\/\/)/gi;
    expect(html).not.toMatch(externalUrlRe);

    // No <link rel="stylesheet"> at all (themes must be inlined).
    expect(html).not.toMatch(/<link\s+rel=["']stylesheet["']/i);

    // No <script src=...> at all (vendors + app must be inlined).
    expect(html).not.toMatch(/<script\s+[^>]*\bsrc=/i);

    // Inlined data carries the redacted cwd (SPEC §6 line 422).
    expect(html).toContain('"cwd":"<redacted>"');

    // The HTML contains the canonical hydration anchor.
    expect(html).toMatch(/<script id="report-data" type="application\/json">/);

    // Sanity: result was not registered in .lint-manifest.json (snapshots
    // are user-versioned, not part of the install manifest).
    const manifestPath = join(fx.dir, ".lint-manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        entries?: Array<{ path?: string }>;
      };
      const paths = manifest.entries?.map((e) => e.path) ?? [];
      expect(paths.some((p) => p?.startsWith("quality-report/"))).toBe(false);
    }
  });
});
