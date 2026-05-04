/**
 * `report/export` — produce a single self-contained HTML snapshot of the
 * quality report (SPEC §4 line 325, §7.7 line 463–468). The output opens
 * directly from `file://`, renders identical to the live server, and can be
 * versioned in `quality-report/<timestamp>.html`.
 *
 * What "self-contained" means here:
 *   - The two theme stylesheets (`themes/linear-design-md/{light,dark}.css`)
 *     are embedded as `<style>` blocks (preserving the order: light first,
 *     dark second — same precedence the live page uses).
 *   - The two vendor UMD bundles (`chart.js`, `chartjs-chart-treemap`) and the
 *     esbuild-produced `app.js` are embedded as inline `<script>` blocks. The
 *     vendor scripts MUST evaluate before the app bundle so `globalThis.Chart`
 *     is available when the treemap controller registers and `mountChart`
 *     consumes it.
 *   - The `ReportData` JSON is injected via `inlineReportData` from
 *     `server.ts` — same `<script id="report-data" type="application/json">`
 *     contract `app.ts` reads on boot. No fetch round-trip; offline-safe.
 *
 * Sensitive-data filter (SPEC §6 Never line 422 — "filtrar `process.env`,
 * paths absolutos do filesystem do autor, tokens em config"):
 *   - `cwd` is replaced with the literal string `<redacted>` (the live server
 *     keeps it because it is local to the developer's machine; the export is
 *     versionable and can leak through a git push).
 *   - Every other string in the payload is run through `redactString`, which:
 *       * Replaces inline absolute Unix paths (`/Users/...`, `/home/...`,
 *         `/root/...`, `/var/folders/...`, etc.) with `<redacted-path>`.
 *       * Replaces inline absolute Windows paths (`C:\Users\...`,
 *         `D:/Users/...`) with `<redacted-path>`.
 *       * Replaces literal `process.env.NAME` references with `<redacted-env>`.
 *       * Replaces well-known token shapes (`sk-…`, `ghp_…`, `xoxb-…`, etc.)
 *         with `<redacted-token>`.
 *   - Project-relative paths (`.lint-audit/2026-…json`, `src/foo.ts`) are
 *     left intact — they are part of the audit's value to a reader and do
 *     not leak filesystem topology.
 *   - The redaction can be disabled (`redact: false`) for tests or trusted
 *     local previews, but the default is `true`.
 *
 * Pure helpers vs. orchestration: every transformation is a pure function over
 * strings/`ReportData`, exported and unit-tested. `exportReport` is the only
 * function with side effects (FS write); it composes the pure helpers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveSafePath } from "../lib/fs-safe.ts";
import { toSafeTimestamp } from "../commands/audit.ts";
import {
  type LoadDeps,
  type LoadResult,
  type ReportCoverage,
  type ReportData,
  type ReportGit,
  type ReportHistoryEntry,
  loadReportData as defaultLoadReportData,
} from "./data-loader.ts";
import {
  INDEX_HTML_PATH,
  THEME_DARK_PATH,
  THEME_LIGHT_PATH,
  VENDOR_CHART_PATH,
  VENDOR_TREEMAP_PATH,
  bundleApp as defaultBundleApp,
  inlineReportData,
  type BundleAppFn,
} from "./server.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Project-relative directory where snapshots land (SPEC §4 line 181, §7.7). */
export const EXPORT_DIR = "quality-report";

/** Replacement strings used by the redactor. Public so tests can assert exactness. */
export const REDACTED_CWD = "<redacted>" as const;
export const REDACTED_PATH = "<redacted-path>" as const;
export const REDACTED_ENV = "<redacted-env>" as const;
export const REDACTED_TOKEN = "<redacted-token>" as const;

// ---------------------------------------------------------------------------
// Sensitive-data redaction (pure)
// ---------------------------------------------------------------------------

/**
 * Match an absolute filesystem path embedded anywhere in a string. The match
 * is gated by a boundary that explicitly excludes another `/` or `\` so the
 * `//` of `https://example.com/foo` does NOT trigger a redaction (the second
 * `/` is preceded by a `/`, which is now in the exclusion set).
 *
 * Two shapes:
 *   - POSIX: `/segment/segment[/...]` — at least two segments to avoid
 *     greedily redacting bare slashes or single-segment roots like `/tmp`.
 *   - Windows: `<DriveLetter>:[\\/]` plus body.
 */
const ABSOLUTE_PATH_RE =
  /(?:^|(?<=[^A-Za-z0-9._/\\-]))(?:\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?|[A-Za-z]:[\\/][A-Za-z0-9._\\/-]+)/g;

/** `process.env.NAME` references inside log lines, rationales, etc. */
const ENV_REF_RE = /\bprocess\.env\.[A-Z_][A-Z0-9_]*\b/g;

/**
 * Common token prefixes (OpenAI, GitHub PAT/installation, Slack). Length floor
 * (≥ 16 chars after the prefix) avoids false-positives like the literal
 * `sk-foo` in a comment. Conservative on purpose — broader heuristics tend to
 * mangle normal identifiers.
 */
const TOKEN_RE = /\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[a-z])[-_][A-Za-z0-9_-]{16,}\b/g;

/**
 * Apply all three sensitive-data filters to a single string. Pure — returns a
 * new string. Order matters: tokens first (they may overlap with paths in
 * weird shapes), then env refs, then absolute paths.
 */
export function redactString(value: string): string {
  return value
    .replace(TOKEN_RE, REDACTED_TOKEN)
    .replace(ENV_REF_RE, REDACTED_ENV)
    .replace(ABSOLUTE_PATH_RE, REDACTED_PATH);
}

/**
 * Recursively scrub a `ReportData` blob:
 *   - `cwd` → `<redacted>` (always — even if it doesn't look absolute).
 *   - Every other string field → run through {@link redactString}.
 *   - Numbers, booleans, null, and arrays are walked through unchanged.
 *
 * Returns a fresh structure; the input is never mutated.
 */
export function redactSensitiveData(data: ReportData): ReportData {
  return {
    ...data,
    cwd: REDACTED_CWD,
    audit_path: redactString(data.audit_path),
    audit: redactValue(data.audit) as ReportData["audit"],
    history: data.history.map(redactHistoryEntry),
    coverage: data.coverage === null ? null : redactCoverage(data.coverage),
    git: redactGit(data.git),
  };
}

function redactValue(input: unknown): unknown {
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map(redactValue);
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = redactValue(v);
    return out;
  }
  return input;
}

function redactHistoryEntry(entry: ReportHistoryEntry): ReportHistoryEntry {
  return {
    timestamp: redactString(entry.timestamp),
    generated_at: redactString(entry.generated_at),
    stage: entry.stage,
    errors: entry.errors,
    warnings: entry.warnings,
    files_affected: entry.files_affected,
    by_metric: { ...entry.by_metric },
  };
}

function redactCoverage(c: ReportCoverage): ReportCoverage {
  return {
    source: redactString(c.source),
    lines: c.lines,
    functions: c.functions,
    branches: c.branches,
    statements: c.statements,
  };
}

function redactGit(g: ReportGit): ReportGit {
  return {
    first_commit_date: g.first_commit_date,
    churn_90d: g.churn_90d,
  };
}

// ---------------------------------------------------------------------------
// HTML transforms (pure)
// ---------------------------------------------------------------------------

/**
 * Replace the two theme `<link rel="stylesheet">` tags in the shell with
 * inline `<style>` blocks. Preserves order (light first, then dark) so the
 * dark cascade still wins under `[data-theme="dark"]`.
 *
 * If a `<link>` tag is missing (e.g. shell already pre-inlined), that side is
 * skipped — the function is idempotent for partial states.
 */
export function inlineThemeCss(
  html: string,
  lightCss: string,
  darkCss: string,
): string {
  return html
    .replace(
      /<link rel="stylesheet" href="\.\/themes\/linear-design-md\/light\.css"\s*\/?>/,
      buildStyleBlock(lightCss),
    )
    .replace(
      /<link rel="stylesheet" href="\.\/themes\/linear-design-md\/dark\.css"\s*\/?>/,
      buildStyleBlock(darkCss),
    );
}

function buildStyleBlock(css: string): string {
  // CSS may legally contain `</style>` only when escaped, but to be safe we
  // strip any literal closing tag (HTML5 disallows the sequence inside a
  // <style> block). `<` would also break — but that's only relevant in
  // JS strings; CSS source is plain text.
  return `<style>\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`;
}

/**
 * Replace the canonical `<script type="module" src="./app.js"></script>` tag
 * with three inline scripts: vendor chart, vendor treemap, and the bundled
 * app — in that order. The vendors are NOT type=module (they're UMD); the
 * app bundle is also emitted as a classic script (esbuild produces ESM with
 * `format: "esm"` in `bundleApp`, but inline `<script type="module">` works
 * fine in browsers and the export must too — so we keep `type="module"` on
 * the app block).
 *
 * Returns input unchanged if the canonical script tag is absent — defensive
 * mirroring of `injectVendorScripts`'s contract.
 */
export function inlineAllScripts(
  html: string,
  vendorChart: string,
  vendorTreemap: string,
  appBundle: string,
): string {
  const marker = '<script type="module" src="./app.js"></script>';
  const idx = html.indexOf(marker);
  if (idx < 0) return html;

  const block =
    `<script>\n${stripScriptCloser(vendorChart)}\n</script>\n    ` +
    `<script>\n${stripScriptCloser(vendorTreemap)}\n</script>\n    ` +
    `<script type="module">\n${stripScriptCloser(appBundle)}\n</script>`;

  return html.slice(0, idx) + block + html.slice(idx + marker.length);
}

/**
 * Defang any literal `</script` sequence that might appear inside JS source
 * (regex literals, string contents). HTML parsers terminate the script block
 * on the first such sequence regardless of JS syntax. Replacement is the
 * standard `<\/script` escape recognized by the JS string/regex parser when
 * the surrounding context is itself a string — but for the inline-script
 * embedding case we just need the bytes to differ from the parser's exit
 * trigger. We only modify the closing form, never `<script`.
 */
function stripScriptCloser(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  readonly data: ReportData;
  /** Apply sensitive-data filter (default true). */
  readonly redact?: boolean;
}

export interface AssembleAssets {
  readonly indexShell: string;
  readonly cssLight: string;
  readonly cssDark: string;
  readonly vendorChart: string;
  readonly vendorTreemap: string;
  readonly appBundle: string;
}

/**
 * Compose a self-contained HTML document from the shell + assets + data.
 * Pure function — does no FS or network. Used directly by `exportReport`
 * and (indirectly) by tests that want to assert byte-level shape without
 * touching disk.
 */
export function assembleHtml(opts: AssembleOptions, assets: AssembleAssets): string {
  const data = opts.redact === false ? opts.data : redactSensitiveData(opts.data);
  let html = inlineThemeCss(assets.indexShell, assets.cssLight, assets.cssDark);
  html = inlineAllScripts(
    html,
    assets.vendorChart,
    assets.vendorTreemap,
    assets.appBundle,
  );
  html = inlineReportData(html, data);
  return html;
}

// ---------------------------------------------------------------------------
// Exporter (side-effecting)
// ---------------------------------------------------------------------------

export interface ExportOptions {
  readonly cwd: string;
  /** Pre-resolved data; tests pass this to skip the loader. */
  readonly data?: ReportData;
  /** Override `new Date()` for the timestamped filename. */
  readonly now?: Date;
  /** Apply sensitive-data filter (default true; SPEC §6 line 422). */
  readonly redact?: boolean;
  /** Write under `quality-report/<override>.html` instead of timestamping. */
  readonly filenameStem?: string;
}

export interface ExportDeps {
  readonly loadReportDataFn?: (opts: { cwd: string }, deps?: LoadDeps) => LoadResult;
  readonly bundleAppFn?: BundleAppFn;
  readonly readFileFn?: (path: string) => string;
  readonly writeFileFn?: (path: string, content: string) => void;
  readonly mkdirFn?: (path: string) => void;
}

export interface ExportOk {
  readonly ok: true;
  /** Project-relative path of the written snapshot (e.g. `quality-report/<ts>.html`). */
  readonly path: string;
  /** Byte length of the written HTML (UTF-8). */
  readonly bytes: number;
  /** Whether redaction was applied. */
  readonly redacted: boolean;
}

export interface ExportErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type ExportResult = ExportOk | ExportErr;

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

function defaultWrite(p: string, c: string): void {
  writeFileSync(p, c, "utf8");
}

function defaultMkdir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/**
 * Build the snapshot HTML and write it under
 * `<cwd>/quality-report/<timestamp>.html`. The directory is created if missing.
 *
 * Snapshots are user-owned versionable artifacts (SPEC §2 — opt-in,
 * `quality-report/` is committed to git by the user). They are NOT recorded in
 * `.lint-manifest.json` because uninstall must preserve them.
 *
 * Errors:
 *   - Loader failure (when `data` is omitted) propagates the loader's
 *     `{error, reason}`.
 *   - FS errors (cwd unreadable, write fails) surface as
 *     `{error: "write_failed", reason}`.
 *   - `cwd` rejection (`..` escape) surfaces as `{error: "invalid_cwd"}`.
 */
export async function exportReport(
  opts: ExportOptions,
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const data = await resolveExportData(opts, deps);
  if (!data.ok) return data;

  const safeDir = resolveSafePath(opts.cwd, EXPORT_DIR);
  if (!safeDir.ok) {
    return { ok: false, error: "invalid_cwd", reason: safeDir.error };
  }

  const readFile = deps.readFileFn ?? defaultRead;
  const writeFile = deps.writeFileFn ?? defaultWrite;
  const mkdir = deps.mkdirFn ?? defaultMkdir;
  const bundleAppFn = deps.bundleAppFn ?? defaultBundleApp;

  let assets: AssembleAssets;
  try {
    const appBundle = await bundleAppFn();
    assets = {
      indexShell: readFile(INDEX_HTML_PATH),
      cssLight: readFile(THEME_LIGHT_PATH),
      cssDark: readFile(THEME_DARK_PATH),
      vendorChart: readFile(VENDOR_CHART_PATH),
      vendorTreemap: readFile(VENDOR_TREEMAP_PATH),
      appBundle,
    };
  } catch (err) {
    return {
      ok: false,
      error: "asset_read_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const redacted = opts.redact !== false;
  let html: string;
  try {
    html = assembleHtml({ data: data.data, redact: redacted }, assets);
  } catch (err) {
    return {
      ok: false,
      error: "assembly_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const stem = opts.filenameStem ?? toSafeTimestamp(opts.now ?? new Date());
  const filename = `${stem}.html`;
  const relPath = `${EXPORT_DIR}/${filename}`;
  const absPath = join(safeDir.value, filename);

  try {
    mkdir(dirname(absPath));
    writeFile(absPath, html);
  } catch (err) {
    return {
      ok: false,
      error: "write_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    path: relPath,
    bytes: Buffer.byteLength(html, "utf8"),
    redacted,
  };
}

interface ResolveOk {
  readonly ok: true;
  readonly data: ReportData;
}

async function resolveExportData(
  opts: ExportOptions,
  deps: ExportDeps,
): Promise<ResolveOk | ExportErr> {
  if (opts.data !== undefined) return { ok: true, data: opts.data };
  const loader = deps.loadReportDataFn ?? defaultLoadReportData;
  const res = loader({ cwd: opts.cwd });
  if (!res.ok) {
    return { ok: false, error: res.error, reason: res.reason };
  }
  return { ok: true, data: res.data };
}

