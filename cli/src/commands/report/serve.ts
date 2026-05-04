/**
 * `report-serve` — thin command wrapper around {@link startReportServer}.
 *
 * SPEC anchors:
 *   - §2 line 51 — `/lint:report` boots a local ephemeral server.
 *   - §6 Never line 421 — bind host is locked to 127.0.0.1 inside `report/server.ts`.
 *   - §7.7 — acceptance: server renders on `127.0.0.1:<porta-livre>`.
 *
 * PLAN §Contratos CLI (line 85): `report-serve --port <n>` → `{ url, port }`,
 * long-running until the parent harness sends SIGINT/SIGTERM (the harness kills
 * the child by PID). The harness reads the JSON line from stdout, captures
 * `pid`, opens the URL in the browser, and later signals the PID to stop.
 *
 * Output (stdout, exactly one canonical JSON document):
 *   { ok: true, host, port, url, pid, audit_path }
 *
 * Exit codes:
 *   - OK                — server started, served traffic, and shut down cleanly.
 *   - USAGE_ERROR       — unknown flag, malformed `--port`, port out of range.
 *   - RECOVERABLE_ERROR — `startReportServer` failed (audit_missing, EADDRINUSE).
 */
import { resolve as resolvePath } from "node:path";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { logger, output } from "../../lib/logger.ts";
import {
  type ServerHandle,
  type StartServerDeps,
  type StartServerOptions,
  startReportServer as defaultStartReportServer,
} from "../../report/server.ts";

export const MIN_PORT = 0;
export const MAX_PORT = 65535;

export interface ParsedArgs {
  readonly cwd: string;
  readonly port?: number;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

/**
 * Parse `report-serve` argv. Accepts:
 *   --cwd <path>   resolved against `defaultCwd` (kept relative-aware to match
 *                  every other subcommand in the dispatcher).
 *   --port <n>     integer in [0, 65535]. 0 (default) lets the kernel pick.
 *   --help | -h    sentinel value `"help"` so the caller can route to usage.
 */
export function parseReportServeArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let port: number | undefined;
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
    if (arg === "--port") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --port" };
      }
      if (!/^\d+$/.test(value)) {
        return { ok: false, error: `invalid port: ${value} (expected integer)` };
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
        return {
          ok: false,
          error: `port out of range: ${value} (expected ${MIN_PORT}..${MAX_PORT})`,
        };
      }
      port = n;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, ...(port !== undefined ? { port } : {}) } };
}

const HELP_TEXT =
  "qualy report-serve [--cwd <path>] [--port <n>]\n" +
  "\n" +
  "Starts the local report server bound to 127.0.0.1 and runs until\n" +
  "SIGINT/SIGTERM. Reads .lint-audit/<latest>.json from <cwd>.\n" +
  "Stdout: one JSON document {ok, host, port, url, pid, audit_path}.\n" +
  "Exit codes: 0 ok, 1 audit/start failure, 4 usage.\n";

export interface RunReportServeDeps {
  /** Override `startReportServer`. Tests use this to skip the real bind. */
  readonly startReportServerFn?: (
    opts: StartServerOptions,
    deps?: StartServerDeps,
  ) => Promise<ServerHandle>;
  /**
   * Resolves once the server should shut down. Default subscribes to the
   * process SIGINT/SIGTERM signals; tests pass an immediately-resolving promise.
   */
  readonly waitForExitFn?: (handle: ServerHandle) => Promise<void>;
  /** Test seam — defaults to `process.pid`. */
  readonly pidFn?: () => number;
}

function defaultWaitForExit(_handle: ServerHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runReportServe(
  argv: readonly string[],
  deps: RunReportServeDeps = {},
): Promise<ExitCode> {
  const parsed = parseReportServeArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(HELP_TEXT);
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "report-serve", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const startFn = deps.startReportServerFn ?? defaultStartReportServer;
  const waitForExit = deps.waitForExitFn ?? defaultWaitForExit;
  const pidFn = deps.pidFn ?? (() => process.pid);

  const startOpts: StartServerOptions = {
    cwd: parsed.value.cwd,
    ...(parsed.value.port !== undefined ? { port: parsed.value.port } : {}),
  };

  let handle: ServerHandle;
  try {
    handle = await startFn(startOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("report_serve_start_failed", { reason: message });
    output({ ok: false, error: "start_failed", reason: message });
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output({
    ok: true,
    host: handle.host,
    port: handle.port,
    url: handle.url,
    pid: pidFn(),
    audit_path: handle.data.audit_path,
  });
  logger.info("report_serve_listening", {
    host: handle.host,
    port: handle.port,
    url: handle.url,
  });

  try {
    await waitForExit(handle);
  } finally {
    await handle.close().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("report_serve_close_error", { reason: message });
    });
  }

  logger.info("report_serve_stopped", { port: handle.port });
  return EXIT_CODES.OK;
}
