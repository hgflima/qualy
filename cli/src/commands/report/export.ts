/**
 * `report-export` — thin command wrapper around {@link exportReport}.
 *
 * SPEC anchors:
 *   - §2 line 51 — `/lint:report` ends by offering to export a snapshot.
 *   - §4 line 325 — `export.ts` produces a self-contained HTML.
 *   - §6 Never line 422 — sensitive data must be filtered from the export.
 *   - §7.7 lines 467–468 — acceptance: snapshot to `quality-report/<ts>.html`,
 *     opens offline, renders identical to the live server.
 *
 * PLAN §Contratos CLI: `report-export --cwd <path>` writes the snapshot and
 * emits `{ ok, path, bytes, redacted }` on stdout. The harness opens the file
 * in the browser after this command returns.
 *
 * Output (stdout, exactly one canonical JSON document):
 *   { ok: true, cwd, path, bytes, redacted }
 *
 * Exit codes:
 *   - OK                — snapshot written.
 *   - USAGE_ERROR       — unknown flag, missing value, or `--no-redact` typo.
 *   - RECOVERABLE_ERROR — `exportReport` failed (audit_missing, write_failed,
 *                         asset_read_failed, assembly_failed, invalid_cwd).
 */
import { resolve as resolvePath } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { logger, output } from "../../lib/logger.ts";
import {
  type ExportDeps,
  type ExportOptions,
  type ExportResult,
  exportReport as defaultExportReport,
} from "../../report/export.ts";

export interface ParsedArgs {
  readonly cwd: string;
  /** When true (default), apply the SPEC §6 redaction filter to the payload. */
  readonly redact: boolean;
  /** Override the timestamped filename stem (e.g. `--name 2026-05-04`). */
  readonly filenameStem?: string;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

/**
 * Parse `report-export` argv. Accepts:
 *   --cwd <path>     resolved against `defaultCwd` (matches every other
 *                    subcommand in the dispatcher).
 *   --no-redact      disables the sensitive-data filter; default is on.
 *   --name <stem>    overrides the filename stem (no `.html` suffix).
 *   --help | -h      sentinel `"help"` so the caller can route to usage.
 */
export function parseReportExportArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let redact = true;
  let filenameStem: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
      cwd = resolvePath(defaultCwd, value);
      i++;
      continue;
    }
    if (arg === "--no-redact") {
      redact = false;
      continue;
    }
    if (arg === "--name") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --name" };
      }
      if (/[/\\]/.test(value) || value === "." || value === "..") {
        return { ok: false, error: `invalid --name: ${value}` };
      }
      filenameStem = value;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return {
    ok: true,
    value: {
      cwd,
      redact,
      ...(filenameStem !== undefined ? { filenameStem } : {}),
    },
  };
}

const HELP_TEXT =
  "qualy report-export [--cwd <path>] [--no-redact] [--name <stem>]\n" +
  "\n" +
  "Writes a self-contained HTML snapshot of the latest audit to\n" +
  "<cwd>/quality-report/<timestamp>.html. Opens offline; bit-identical\n" +
  "to the live server.\n" +
  "\n" +
  "Sensitive-data filter (SPEC §6): replaces cwd, absolute paths,\n" +
  "process.env.* references, and known token shapes with placeholders.\n" +
  "Use --no-redact only for trusted local previews.\n" +
  "\n" +
  "Stdout: one JSON document {ok, cwd, path, bytes, redacted}.\n" +
  "Exit codes: 0 ok, 1 export failure, 4 usage.\n";

export interface RunReportExportDeps {
  readonly exportReportFn?: (
    opts: ExportOptions,
    deps?: ExportDeps,
  ) => Promise<ExportResult>;
}

export async function runReportExport(
  argv: readonly string[],
  deps: RunReportExportDeps = {},
): Promise<ExitCode> {
  const parsed = parseReportExportArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "report-export", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const exportFn = deps.exportReportFn ?? defaultExportReport;
  const opts: ExportOptions = {
    cwd: parsed.value.cwd,
    redact: parsed.value.redact,
    ...(parsed.value.filenameStem !== undefined
      ? { filenameStem: parsed.value.filenameStem }
      : {}),
  };

  let result: ExportResult;
  try {
    result = await exportFn(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("report_export_unexpected", { reason: message });
    output({ ok: false, error: "internal_error", reason: message });
    return EXIT_CODES.INTERNAL_ERROR;
  }

  if (!result.ok) {
    logger.error("report_export_failed", {
      error: result.error,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
    output({
      ok: false,
      error: result.error,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output({
    ok: true,
    cwd: parsed.value.cwd,
    path: result.path,
    bytes: result.bytes,
    redacted: result.redacted,
  });
  logger.info("report_export_written", {
    path: result.path,
    bytes: result.bytes,
    redacted: result.redacted,
  });
  return EXIT_CODES.OK;
}
