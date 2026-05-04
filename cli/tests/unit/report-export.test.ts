/**
 * Contract tests for `cli/src/report/export.ts`
 * (IMPLEMENTATION_PLAN.md Phase 6 — line 115).
 *
 * What is locked:
 *   - The self-contained HTML inlines theme CSS (`<link>` → `<style>`),
 *     vendor + app JS (`<script src=...>` → inline `<script>`), and the
 *     `ReportData` JSON (via `inlineReportData` reuse from server.ts).
 *   - Sensitive-data filter (SPEC §6 line 422):
 *       * `cwd` is replaced with `<redacted>`.
 *       * Embedded absolute Unix/Windows paths become `<redacted-path>`.
 *       * `process.env.NAME` references become `<redacted-env>`.
 *       * GitHub/OpenAI/Slack-shaped tokens become `<redacted-token>`.
 *     Project-relative paths and URLs are NOT mangled.
 *   - `exportReport` writes to `quality-report/<timestamp>.html` under cwd
 *     and never records the file in `.lint-manifest.json`.
 *
 * No real esbuild is invoked — `bundleAppFn` is stubbed throughout.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir as fsMkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPORT_DIR,
  REDACTED_CWD,
  REDACTED_ENV,
  REDACTED_PATH,
  REDACTED_TOKEN,
  assembleHtml,
  exportReport,
  inlineAllScripts,
  inlineThemeCss,
  redactSensitiveData,
  redactString,
  type AssembleAssets,
} from "../../src/report/export.ts";
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

function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    version: "1",
    generated_at: "2026-05-04T12:00:00Z",
    cwd: "/Users/alice/code/proj",
    audit_path: ".lint-audit/2026-05-04T12-00-00-000Z.json",
    audit: canonicalAudit(),
    history: [],
    coverage: null,
    git: { first_commit_date: null, churn_90d: 0 },
    ...overrides,
  };
}

const SHELL = `<!DOCTYPE html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="./themes/linear-design-md/light.css" />
    <link rel="stylesheet" href="./themes/linear-design-md/dark.css" />
  </head>
  <body>
    <main id="main">x</main>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`;

const STUB_ASSETS: AssembleAssets = {
  indexShell: SHELL,
  cssLight: ":root { --c: light; }",
  cssDark: ':root[data-theme="dark"] { --c: dark; }',
  vendorChart: "/* chart.js stub */ globalThis.Chart = function(){};",
  vendorTreemap: "/* treemap stub */",
  appBundle: "console.log('boot');",
};

// ---------------------------------------------------------------------------
// redactString — sensitive-data primitives
// ---------------------------------------------------------------------------

describe("redactString", () => {
  it("returns plain text untouched when nothing matches", () => {
    expect(redactString("hello world")).toBe("hello world");
    expect(redactString("see ./src/foo.ts for context")).toBe(
      "see ./src/foo.ts for context",
    );
  });

  it("redacts an absolute Unix path at the start of the string", () => {
    expect(redactString("/Users/alice/proj/foo.ts")).toBe(REDACTED_PATH);
  });

  it("redacts an absolute Unix path embedded after whitespace", () => {
    expect(redactString("compiled at /Users/alice/code/x.ts:12")).toBe(
      `compiled at ${REDACTED_PATH}:12`,
    );
  });

  it("redacts /home/, /var/, /tmp/, /opt/ paths the same way", () => {
    expect(redactString("/home/bob/code/x.ts")).toBe(REDACTED_PATH);
    expect(redactString("/var/folders/abc/xyz")).toBe(REDACTED_PATH);
    expect(redactString("/tmp/build/out.js")).toBe(REDACTED_PATH);
    expect(redactString("/opt/homebrew/lib")).toBe(REDACTED_PATH);
  });

  it("redacts an absolute Windows path", () => {
    expect(redactString("C:\\Users\\alice\\proj")).toBe(REDACTED_PATH);
    expect(redactString("D:/dev/proj/src")).toBe(REDACTED_PATH);
    expect(redactString("at C:\\Users\\alice line 1")).toBe(`at ${REDACTED_PATH} line 1`);
  });

  it("does NOT redact project-relative paths", () => {
    expect(redactString("src/foo.ts")).toBe("src/foo.ts");
    expect(redactString(".lint-audit/2026.json")).toBe(".lint-audit/2026.json");
    expect(redactString("./src/foo")).toBe("./src/foo");
  });

  it("does NOT redact URL paths (https://example.com/foo)", () => {
    expect(redactString("see https://oxc.rs/docs/index.html")).toBe(
      "see https://oxc.rs/docs/index.html",
    );
    expect(redactString("http://example.com/path/to/thing")).toBe(
      "http://example.com/path/to/thing",
    );
  });

  it("redacts a single-segment root only when it has at least 2 segments", () => {
    // bare /tmp (no slash after) should NOT be redacted — too narrow a match
    expect(redactString("at /tmp end")).toBe("at /tmp end");
    expect(redactString("/usr")).toBe("/usr");
    // but two segments suffices to redact:
    expect(redactString("/tmp/build")).toBe(REDACTED_PATH);
  });

  it("redacts process.env references", () => {
    expect(redactString("read process.env.HOME at boot")).toBe(`read ${REDACTED_ENV} at boot`);
    expect(redactString("process.env.SECRET_TOKEN_42")).toBe(REDACTED_ENV);
  });

  it("redacts well-known token shapes (sk-, ghp_, xoxb-)", () => {
    expect(redactString("token: sk-abc1234567890XYZdef0123456")).toBe(
      `token: ${REDACTED_TOKEN}`,
    );
    expect(redactString("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(REDACTED_TOKEN);
    expect(redactString("Slack: xoxb-1234567890-abcdefghijkl")).toBe(`Slack: ${REDACTED_TOKEN}`);
  });

  it("does NOT redact short non-token-shaped strings starting with sk-", () => {
    // skin-tone, sk-foo (too short) — must survive
    expect(redactString("sk-foo")).toBe("sk-foo");
    expect(redactString("skin-tone")).toBe("skin-tone");
  });

  it("redacts multiple sensitive items in a single string", () => {
    const input =
      "User /Users/alice/code at process.env.HOME with token sk-abc1234567890XYZdef0123456";
    expect(redactString(input)).toBe(
      `User ${REDACTED_PATH} at ${REDACTED_ENV} with token ${REDACTED_TOKEN}`,
    );
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveData — full-tree walk
// ---------------------------------------------------------------------------

describe("redactSensitiveData", () => {
  it("replaces top-level cwd with <redacted> regardless of its value", () => {
    const data = makeReportData({ cwd: "/Users/alice/proj" });
    const out = redactSensitiveData(data);
    expect(out.cwd).toBe(REDACTED_CWD);
  });

  it("replaces relative cwd too (defense in depth)", () => {
    const data = makeReportData({ cwd: "./relative/path" });
    expect(redactSensitiveData(data).cwd).toBe(REDACTED_CWD);
  });

  it("preserves project-relative audit_path", () => {
    const data = makeReportData({
      audit_path: ".lint-audit/2026-05-04T12-00-00-000Z.json",
    });
    expect(redactSensitiveData(data).audit_path).toBe(
      ".lint-audit/2026-05-04T12-00-00-000Z.json",
    );
  });

  it("redacts absolute paths inside nested rationale strings", () => {
    const data = makeReportData({
      audit: {
        ...canonicalAudit(),
        recommendations: [
          {
            id: "raise-wmc",
            type: "raise-threshold" as const,
            title: "raise wmc",
            rationale: "Found at /Users/alice/code/proj/src/foo.ts line 42",
            blast_radius: { files_newly_violating: 0, files_currently_violating: 0 },
            patch: {},
            severity: "suggest" as const,
            applies_to: "src/foo.ts",
          },
        ],
      },
    });
    const out = redactSensitiveData(data);
    expect(out.audit.recommendations[0]?.rationale).toBe(
      `Found at ${REDACTED_PATH} line 42`,
    );
    // applies_to was already project-relative — left untouched
    expect(out.audit.recommendations[0]?.applies_to).toBe("src/foo.ts");
  });

  it("does not mutate the input", () => {
    const data = makeReportData({ cwd: "/Users/alice/proj" });
    const before = JSON.parse(JSON.stringify(data));
    redactSensitiveData(data);
    expect(data).toEqual(before);
  });

  it("preserves numeric and null fields", () => {
    const data = makeReportData({
      coverage: {
        source: "/Users/alice/proj/coverage/coverage-summary.json",
        lines: 85.5,
        functions: null,
        branches: 70,
        statements: 80,
      },
      git: { first_commit_date: "2026-04-01T00:00:00Z", churn_90d: 12 },
    });
    const out = redactSensitiveData(data);
    expect(out.coverage?.source).toBe(REDACTED_PATH);
    expect(out.coverage?.lines).toBe(85.5);
    expect(out.coverage?.functions).toBe(null);
    expect(out.git.churn_90d).toBe(12);
  });

  it("walks history entries (timestamps survive — no slashes)", () => {
    const data = makeReportData({
      history: [
        {
          timestamp: "2026-05-04T12-00-00-000Z",
          generated_at: "2026-05-04T12:00:00Z",
          stage: "greenfield",
          errors: 1,
          warnings: 2,
          files_affected: 3,
          by_metric: { wmc: 1, halstead: 0, lcom: 0, cbo: 0, dit: 0 },
        },
      ],
    });
    const out = redactSensitiveData(data);
    expect(out.history[0]?.timestamp).toBe("2026-05-04T12-00-00-000Z");
    expect(out.history[0]?.errors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// inlineThemeCss
// ---------------------------------------------------------------------------

describe("inlineThemeCss", () => {
  it("replaces both light and dark <link> tags with <style> blocks", () => {
    const out = inlineThemeCss(SHELL, ":root { --light: 1; }", ":root { --dark: 1; }");
    expect(out).not.toContain('<link rel="stylesheet" href="./themes/linear-design-md/light.css"');
    expect(out).not.toContain('<link rel="stylesheet" href="./themes/linear-design-md/dark.css"');
    expect(out).toContain("<style>");
    expect(out).toContain("--light: 1;");
    expect(out).toContain("--dark: 1;");
  });

  it("preserves order: light <style> precedes dark <style>", () => {
    const out = inlineThemeCss(SHELL, "/* LIGHT-MARKER */", "/* DARK-MARKER */");
    const light = out.indexOf("/* LIGHT-MARKER */");
    const dark = out.indexOf("/* DARK-MARKER */");
    expect(light).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(light);
  });

  it("escapes any literal </style> inside the inlined CSS", () => {
    const evilCss = "body{} </style>more-css{}";
    const out = inlineThemeCss(
      '<link rel="stylesheet" href="./themes/linear-design-md/light.css" /><link rel="stylesheet" href="./themes/linear-design-md/dark.css" />',
      evilCss,
      "",
    );
    // The only legitimate </style> closers are the two we emit (light + dark).
    expect((out.match(/<\/style>/g) ?? []).length).toBe(2);
    // The escaped form of the smuggled tag is present:
    expect(out).toContain("<\\/style");
    expect(out).toContain("more-css{}");
  });

  it("is a no-op when the link tag is absent", () => {
    const html = "<head>nothing here</head>";
    expect(inlineThemeCss(html, "x", "y")).toBe(html);
  });
});

// ---------------------------------------------------------------------------
// inlineAllScripts
// ---------------------------------------------------------------------------

describe("inlineAllScripts", () => {
  it("replaces the canonical app.js script with three inline scripts in order", () => {
    const out = inlineAllScripts(
      SHELL,
      "/* CHART-MARKER */",
      "/* TREEMAP-MARKER */",
      "/* APP-MARKER */",
    );
    expect(out).not.toContain('src="./app.js"');
    const chart = out.indexOf("/* CHART-MARKER */");
    const treemap = out.indexOf("/* TREEMAP-MARKER */");
    const app = out.indexOf("/* APP-MARKER */");
    expect(chart).toBeGreaterThan(0);
    expect(treemap).toBeGreaterThan(chart);
    expect(app).toBeGreaterThan(treemap);
  });

  it("emits the app block as type=module so import syntax in app.js works", () => {
    const out = inlineAllScripts(SHELL, "vendor1", "vendor2", "import x from 'y';");
    // Two non-module <script> blocks (vendors) + one type=module (app)
    expect((out.match(/<script>/g) ?? []).length).toBe(2);
    expect((out.match(/<script type="module">/g) ?? []).length).toBe(1);
  });

  it("defangs literal </script> inside JS bundles", () => {
    const evilJs = 'var x = "</script><script>alert(1)//";';
    const out = inlineAllScripts(SHELL, "v1", "v2", evilJs);
    // The literal closer would prematurely terminate the inline script.
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("<\\/script");
  });

  it("returns input unchanged when the canonical app.js script tag is absent", () => {
    const html = "<html><body>no scripts</body></html>";
    expect(inlineAllScripts(html, "v1", "v2", "app")).toBe(html);
  });
});

// ---------------------------------------------------------------------------
// assembleHtml
// ---------------------------------------------------------------------------

describe("assembleHtml", () => {
  it("composes inlined CSS, JS, and JSON into a single document", () => {
    const data = makeReportData();
    const out = assembleHtml({ data }, STUB_ASSETS);
    expect(out).toContain("<style>");
    expect(out).toContain("<script>");
    expect(out).toContain('id="report-data"');
    expect(out).toContain('type="application/json"');
    expect(out).not.toContain('href="./themes/linear-design-md/light.css"');
    expect(out).not.toContain('src="./app.js"');
  });

  it("redacts cwd by default", () => {
    const data = makeReportData({ cwd: "/Users/alice/secrets/proj" });
    const out = assembleHtml({ data }, STUB_ASSETS);
    expect(out).toContain(`"cwd":"${REDACTED_CWD}"`);
    expect(out).not.toContain("/Users/alice/secrets");
  });

  it("preserves cwd when redact=false (e.g. local trusted preview)", () => {
    const data = makeReportData({ cwd: "/Users/alice/proj" });
    const out = assembleHtml({ data, redact: false }, STUB_ASSETS);
    expect(out).toContain('"cwd":"/Users/alice/proj"');
  });

  it("inlines the audit JSON so the offline page hydrates without fetch", () => {
    const data = makeReportData();
    const out = assembleHtml({ data }, STUB_ASSETS);
    // greenfield is the canonical stage in the fixture
    expect(out).toContain("greenfield");
  });
});

// ---------------------------------------------------------------------------
// exportReport — end-to-end with a real tmpdir
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch {
      // ignore — tmp dirs may have already been removed
    }
  }
});

async function makeTmpProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "qualy-export-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await fsMkdir(dir, { recursive: true });
  return dir;
}

describe("exportReport", () => {
  it("writes <cwd>/quality-report/<ts>.html and reports its byte length", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
        now: new Date("2026-05-04T12:00:00.000Z"),
      },
      {
        bundleAppFn: async () => "console.log('app');",
        readFileFn: (p) => {
          if (p.endsWith("index.html")) return SHELL;
          if (p.endsWith("light.css")) return ":root{--l:1}";
          if (p.endsWith("dark.css")) return ":root[data-theme='dark']{--d:1}";
          if (p.endsWith("chart.umd.js")) return "/* chart */";
          if (p.endsWith("chartjs-chart-treemap.min.js")) return "/* treemap */";
          throw new Error(`unexpected read: ${p}`);
        },
      },
    );
    if (!result.ok) throw new Error(`export failed: ${result.error}/${result.reason}`);
    expect(result.path).toBe(`${EXPORT_DIR}/2026-05-04T12-00-00-000Z.html`);
    expect(result.redacted).toBe(true);
    expect(result.bytes).toBeGreaterThan(100);

    const written = readFileSync(join(cwd, result.path), "utf8");
    expect(written.length).toBe(result.bytes);
    expect(written).toContain("<style>");
    expect(written).toContain('id="report-data"');
    expect(written).toContain(`"cwd":"${REDACTED_CWD}"`);
    expect(written).toContain("/* chart */");
    expect(written).toContain("/* treemap */");
    expect(written).toContain("console.log('app');");
  });

  function readFileStub(path: string): string {
    if (path.endsWith("index.html")) return SHELL;
    return "stub";
  }

  it("respects filenameStem override (skipping the timestamp)", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
        filenameStem: "custom",
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: readFileStub,
      },
    );
    if (!result.ok) throw new Error(`export failed: ${result.error}`);
    expect(result.path).toBe(`${EXPORT_DIR}/custom.html`);
  });

  it("creates quality-report/ if it does not exist", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
        now: new Date("2026-05-04T12:00:00Z"),
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: readFileStub,
      },
    );
    expect(result.ok).toBe(true);
    // Listing the file directly shows the directory exists.
    const dirContents = readFileSync(
      join(cwd, EXPORT_DIR, "2026-05-04T12-00-00-000Z.html"),
      "utf8",
    );
    expect(dirContents.length).toBeGreaterThan(0);
  });

  it("does NOT record the snapshot in .lint-manifest.json (user-versioned)", async () => {
    const cwd = await makeTmpProject();
    // Pre-existing manifest (simulating an installed project)
    writeFileSync(
      join(cwd, ".lint-manifest.json"),
      JSON.stringify({
        version: "1",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
        entries: [],
      }),
    );

    await exportReport(
      {
        cwd,
        data: makeReportData(),
        filenameStem: "snap",
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: readFileStub,
      },
    );

    const manifest = JSON.parse(readFileSync(join(cwd, ".lint-manifest.json"), "utf8"));
    expect(manifest.entries).toEqual([]);
  });

  it("propagates loader failure when data is omitted", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      { cwd },
      {
        loadReportDataFn: () => ({
          ok: false,
          error: "audit_missing",
          reason: "no audits found",
        }),
        bundleAppFn: async () => "x",
        readFileFn: () => "stub",
      },
    );
    expect(result).toEqual({
      ok: false,
      error: "audit_missing",
      reason: "no audits found",
    });
  });

  it("surfaces malformed shell as assembly_failed", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
      },
      {
        bundleAppFn: async () => "x",
        // Returns a shell with NO </head>, exercising the inlineReportData
        // throw path. exportReport must convert this into a tagged result
        // rather than letting the exception escape.
        readFileFn: () => "<html><body>broken</body></html>",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("assembly_failed");
      expect(result.reason).toContain("</head>");
    }
  });

  it("surfaces asset-read errors as asset_read_failed", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: (p) => {
          if (p.endsWith("light.css")) throw new Error("ENOENT");
          return "stub";
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("asset_read_failed");
      expect(result.reason).toContain("ENOENT");
    }
  });

  it("surfaces write errors as write_failed", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData(),
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: readFileStub,
        writeFileFn: () => {
          throw new Error("EACCES");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("write_failed");
      expect(result.reason).toContain("EACCES");
    }
  });

  it("can be called with redact=false (skipping the filter)", async () => {
    const cwd = await makeTmpProject();
    const result = await exportReport(
      {
        cwd,
        data: makeReportData({ cwd: "/Users/alice/proj" }),
        redact: false,
        filenameStem: "raw",
      },
      {
        bundleAppFn: async () => "x",
        readFileFn: readFileStub,
      },
    );
    if (!result.ok) throw new Error(`export failed: ${result.error}`);
    expect(result.redacted).toBe(false);
    const written = readFileSync(join(cwd, result.path), "utf8");
    expect(written).toContain('"cwd":"/Users/alice/proj"');
  });
});
