/**
 * `report/server` — ephemeral local HTTP server for the qualy quality report.
 *
 * SPEC anchors:
 *   - §4 (Report visual, line 320): "TypeScript puro + Vite-like dev server
 *     embutido (`server.ts` usa Node `http` + esbuild via `import('esbuild')`)".
 *   - §6 Never (line 421): "Nunca expor o servidor do report fora de
 *     `localhost` (sem `0.0.0.0`, sem túnel)" — the bind host is a constant
 *     locked by tests; the API never accepts a host override.
 *   - §4 line 326 (state source): the page is hydrated from the same
 *     `ReportData` blob `report/export.ts` will inline offline.
 *
 * Architecture:
 *
 *   - One server instance per `startReportServer()` call. Lifecycle is a
 *     `ServerHandle` whose `close()` resolves once the http server stops.
 *   - Routes are a hard whitelist (never compute fs paths from user input):
 *       GET /                                     → modified `index.html`
 *       GET /app.js                               → esbuild bundle of `app.ts`
 *       GET /themes/linear-design-md/light.css    → static CSS
 *       GET /themes/linear-design-md/dark.css     → static CSS
 *     Anything else → 404. Method other than GET/HEAD → 405.
 *   - The bundle is built lazily on the first `/app.js` request and cached for
 *     the lifetime of the handle (the report is read-only — there's nothing
 *     to invalidate after the first response).
 *   - `chart.js` and `chartjs-chart-treemap` are bundled into `app.js` (not
 *     served as separate scripts) so the live page and the offline export
 *     share the same payload boundary. `export.ts` will reuse `bundleApp()`.
 *
 * Pure helpers (testable without sockets):
 *   - {@link escapeJsonForHtml}: JSON.stringify wrapper that hides `</script>`.
 *   - {@link inlineReportData}: injects the data `<script>` before `</head>`.
 *   - {@link routeFor}: maps a pathname to a {@link RouteKind} or `null`.
 *   - {@link mimeFor}: route → MIME type.
 *   - {@link bundleApp}: wraps `esbuild.build` with stubbing seam.
 *
 * The actual `http` server is exercised by 1–2 integration tests that listen
 * on port 0 and fetch each whitelisted route with a stub bundler.
 */
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, parse as parsePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
  loadReportData as defaultLoadReportData,
  type LoadDeps,
  type LoadResult,
  type ReportData,
} from "./data-loader.ts";

// ---------------------------------------------------------------------------
// Constants — locked by tests
// ---------------------------------------------------------------------------

/**
 * Bind host for the report server. SPEC §6 Never line 421 prohibits exposing
 * beyond localhost — this is a hardcoded literal, never user-configurable.
 */
export const SERVER_HOST = "127.0.0.1" as const;

/** Element id of the inlined data script (matches `app.ts#REPORT_DATA_SCRIPT_ID`). */
export const REPORT_DATA_SCRIPT_ID = "report-data" as const;

/** Whitelisted routes — request pathnames are matched verbatim. */
export const ROUTES = {
  index: "/",
  app: "/app.js",
  cssLight: "/themes/linear-design-md/light.css",
  cssDark: "/themes/linear-design-md/dark.css",
  vendorChart: "/vendor/chart.umd.js",
  vendorTreemap: "/vendor/chartjs-chart-treemap.umd.js",
} as const;

export type RouteKind = keyof typeof ROUTES;

/** MIME types for each whitelisted route. */
export const MIME_TYPES: Readonly<Record<RouteKind, string>> = {
  index: "text/html; charset=utf-8",
  app: "text/javascript; charset=utf-8",
  cssLight: "text/css; charset=utf-8",
  cssDark: "text/css; charset=utf-8",
  vendorChart: "text/javascript; charset=utf-8",
  vendorTreemap: "text/javascript; charset=utf-8",
};

export const REPORT_ROOT = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML_PATH = join(REPORT_ROOT, "index.html");
export const APP_ENTRY_PATH = join(REPORT_ROOT, "app.ts");
export const THEME_LIGHT_PATH = join(REPORT_ROOT, "themes/linear-design-md/light.css");
export const THEME_DARK_PATH = join(REPORT_ROOT, "themes/linear-design-md/dark.css");

// Vendor chart libs are resolved by walking up the directory tree looking for
// `node_modules/<pkg>/<subpath>`. This works with npm workspaces (hoisted to
// repo root), pnpm/yarn flat layouts, and the install.sh layout under
// `~/.claude/skills/lint/cli/`. We avoid `createRequire().resolve` because
// modern packages (e.g. chart.js) restrict their `exports` field and refuse
// to expose `./dist/chart.umd.js` even though the file exists on disk.
function findInNodeModules(start: string, subpath: string): string {
  let dir = start;
  const { root } = parsePath(dir);
  // Bound the walk: at most until the filesystem root (parsePath).
  while (true) {
    const candidate = join(dir, "node_modules", subpath);
    if (existsSync(candidate)) return candidate;
    if (dir === root) {
      // Defer the failure to startup so the error message includes the
      // intended path rather than a stack trace from module init.
      return join(start, "node_modules", subpath);
    }
    dir = dirname(dir);
  }
}

export const VENDOR_CHART_PATH = findInNodeModules(
  REPORT_ROOT,
  "chart.js/dist/chart.umd.js",
);
export const VENDOR_TREEMAP_PATH = findInNodeModules(
  REPORT_ROOT,
  "chartjs-chart-treemap/dist/chartjs-chart-treemap.min.js",
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` with `</` escaped so the result can be embedded inside an
 * HTML `<script>` block without a value smuggling a closing tag and breaking
 * out of the script context. Also escapes U+2028/U+2029 which are valid in
 * JSON strings but illegal in JS source.
 */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Inject a `<script id="report-data" type="application/json">…</script>` into
 * the report shell. The script is placed immediately before `</head>` so the
 * inline anti-flash bootstrap (which already lives in `<head>`) executes
 * first, but the JSON is in the document by the time `app.js` runs (deferred
 * by `type=module`).
 *
 * Throws when the shell does not contain a `</head>` tag — the index.html in
 * this repo always does, but a malformed override would silently produce a
 * broken page otherwise.
 */
export function inlineReportData(html: string, data: ReportData): string {
  const close = html.indexOf("</head>");
  if (close < 0) {
    throw new Error("inlineReportData: shell html has no </head> tag");
  }
  const tag =
    `    <script id="${REPORT_DATA_SCRIPT_ID}" type="application/json">` +
    escapeJsonForHtml(data) +
    `</script>\n  `;
  return html.slice(0, close) + tag + html.slice(close);
}

/**
 * Inject the vendor chart `<script>` tags before the existing
 * `<script src="./app.js">` so chart.js + chartjs-chart-treemap are loaded
 * (and `globalThis.Chart` is set) before `app.js` evaluates. Both vendor UMD
 * bundles attach to `window.Chart`; the treemap registers its controller via
 * `Chart.register(...)` at evaluation time.
 *
 * The function searches for the canonical `app.js` script tag from
 * `index.html`. If absent, returns the input unchanged — defense in depth
 * against a future shell that already wires charts differently.
 */
export function injectVendorScripts(html: string): string {
  const marker = '<script type="module" src="./app.js"></script>';
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  const tags =
    '<script src="./vendor/chart.umd.js"></script>\n' +
    '    <script src="./vendor/chartjs-chart-treemap.umd.js"></script>\n' +
    "    ";
  return html.slice(0, idx) + tags + html.slice(idx);
}

/**
 * Resolve a request pathname to a known route, or `null` for 404. Path
 * traversal (`..`), query strings, and trailing slashes other than `/` are
 * rejected silently — the caller maps `null` to a 404 response.
 */
export function routeFor(pathname: string): RouteKind | null {
  if (pathname.includes("..")) return null;
  for (const [name, route] of Object.entries(ROUTES) as Array<[RouteKind, string]>) {
    if (pathname === route) return name;
  }
  return null;
}

/** MIME type for a known route. */
export function mimeFor(route: RouteKind): string {
  return MIME_TYPES[route];
}

// ---------------------------------------------------------------------------
// Bundler seam
// ---------------------------------------------------------------------------

/**
 * Async function that returns the JS bundle text for `app.ts`. Tests stub
 * this so unit suites do not invoke esbuild. The real implementation
 * (`defaultBundleApp`) calls `esbuild.build` with the entry point pointing
 * at this module's sibling `app.ts`.
 */
export type BundleAppFn = () => Promise<string>;

async function defaultBundleApp(): Promise<string> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: [APP_ENTRY_PATH],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error("bundleApp: esbuild produced no output");
  }
  return file.text;
}

/**
 * Public bundling helper, exported so `report/export.ts` can reuse the exact
 * same compilation path. Wraps any provided seam through unchanged.
 */
export async function bundleApp(deps?: { readonly bundleAppFn?: BundleAppFn }): Promise<string> {
  const fn = deps?.bundleAppFn ?? defaultBundleApp;
  return fn();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface StartServerOptions {
  readonly cwd: string;
  /** Defaults to 0 (kernel-assigned free port). */
  readonly port?: number;
  /**
   * Pre-resolved report payload. When omitted, the server calls
   * `loadReportData({cwd})` internally. Tests pass this to skip FS access.
   */
  readonly data?: ReportData;
}

export interface StartServerDeps {
  readonly loadReportDataFn?: (
    opts: { readonly cwd: string },
    deps?: LoadDeps,
  ) => LoadResult;
  readonly bundleAppFn?: BundleAppFn;
  /** Override how static assets are read from disk (tests). */
  readonly readFileFn?: (path: string) => string;
}

export interface ServerHandle {
  readonly host: typeof SERVER_HOST;
  readonly port: number;
  readonly url: string;
  /**
   * The pre-rendered `ReportData` payload exposed for callers that want to
   * print summary info (e.g. `commands/report/serve.ts`).
   */
  readonly data: ReportData;
  close(): Promise<void>;
}

function defaultRead(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Start an ephemeral HTTP server bound to {@link SERVER_HOST}. The returned
 * handle carries the actual port (kernel-assigned when `port` is 0) and a
 * `close()` that resolves once the listener stops.
 *
 * @throws If `data` is omitted and `loadReportData` returns `{ok: false}`.
 */
export async function startReportServer(
  opts: StartServerOptions,
  deps: StartServerDeps = {},
): Promise<ServerHandle> {
  const data = await resolveData(opts, deps);
  const readFile = deps.readFileFn ?? defaultRead;
  const bundleFn = deps.bundleAppFn ?? defaultBundleApp;

  // Read static assets eagerly so a malformed install fails fast at startup
  // rather than 500-ing on the first request. The bundle is lazy + cached.
  const indexShell = readFile(INDEX_HTML_PATH);
  const indexHtml = injectVendorScripts(inlineReportData(indexShell, data));
  const cssLight = readFile(THEME_LIGHT_PATH);
  const cssDark = readFile(THEME_DARK_PATH);
  const vendorChart = readFile(VENDOR_CHART_PATH);
  const vendorTreemap = readFile(VENDOR_TREEMAP_PATH);

  let appBundle: string | null = null;
  let appBundlePromise: Promise<string> | null = null;
  const getAppBundle = async (): Promise<string> => {
    if (appBundle !== null) return appBundle;
    if (appBundlePromise === null) {
      appBundlePromise = bundleFn().then((js) => {
        appBundle = js;
        return js;
      });
    }
    return appBundlePromise;
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      indexHtml,
      cssLight,
      cssDark,
      vendorChart,
      vendorTreemap,
      getAppBundle,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      respond(res, 500, "text/plain; charset=utf-8", `server_error: ${message}`);
    });
  });

  const port = await listenAsync(server, opts.port ?? 0);
  return {
    host: SERVER_HOST,
    port,
    url: `http://${SERVER_HOST}:${port}/`,
    data,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

async function resolveData(
  opts: StartServerOptions,
  deps: StartServerDeps,
): Promise<ReportData> {
  if (opts.data !== undefined) return opts.data;
  const loader = deps.loadReportDataFn ?? defaultLoadReportData;
  const result = loader({ cwd: opts.cwd });
  if (!result.ok) {
    const reason = result.reason ? ` (${result.reason})` : "";
    throw new Error(`startReportServer: ${result.error}${reason}`);
  }
  return result.data;
}

function listenAsync(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const addr = server.address();
      if (addr && typeof addr === "object" && typeof addr.port === "number") {
        resolve(addr.port);
        return;
      }
      reject(new Error("listenAsync: no port assigned"));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, SERVER_HOST);
  });
}

interface RequestContext {
  readonly indexHtml: string;
  readonly cssLight: string;
  readonly cssDark: string;
  readonly vendorChart: string;
  readonly vendorTreemap: string;
  readonly getAppBundle: () => Promise<string>;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    respond(res, 405, "text/plain; charset=utf-8", "method_not_allowed");
    return;
  }

  const url = new URL(req.url ?? "/", `http://${SERVER_HOST}`);
  const route = routeFor(url.pathname);
  if (route === null) {
    respond(res, 404, "text/plain; charset=utf-8", "not_found");
    return;
  }

  const body = await bodyForRoute(route, ctx);
  respond(res, 200, mimeFor(route), method === "HEAD" ? "" : body);
}

async function bodyForRoute(route: RouteKind, ctx: RequestContext): Promise<string> {
  switch (route) {
    case "index":
      return ctx.indexHtml;
    case "app":
      return ctx.getAppBundle();
    case "cssLight":
      return ctx.cssLight;
    case "cssDark":
      return ctx.cssDark;
    case "vendorChart":
      return ctx.vendorChart;
    case "vendorTreemap":
      return ctx.vendorTreemap;
  }
}

function respond(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  // Defense in depth: refuse cross-origin embedding so the report cannot be
  // framed from a malicious page sharing the user's localhost.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.end(body);
}
