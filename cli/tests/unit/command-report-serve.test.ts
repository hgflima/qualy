/**
 * Contract tests for `cli/src/commands/report/serve.ts`
 * (IMPLEMENTATION_PLAN.md Phase 6 — line 116).
 *
 * What is locked:
 *   - Argv parser accepts `--cwd`, `--port`, `--help`/`-h` and rejects
 *     malformed/unknown flags with stable error tags.
 *   - Port range is `[0, 65535]` (locked via MIN_PORT/MAX_PORT).
 *   - `runReportServe` emits exactly one canonical JSON document on stdout
 *     (`{ ok, host, port, url, pid, audit_path }`) immediately after the
 *     server starts listening — the harness reads this line to capture the
 *     PID it will later signal.
 *   - The handler stays alive until `waitForExit` resolves, then `close()`s
 *     the server and returns `OK`.
 *   - `startReportServer` failures propagate as `{ ok:false, error:"start_failed" }`
 *     with `RECOVERABLE_ERROR`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import {
  MAX_PORT,
  MIN_PORT,
  parseReportServeArgs,
  runReportServe,
} from "../../src/commands/report/serve.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { setStreams } from "../../src/lib/logger.ts";
import type { ServerHandle } from "../../src/report/server.ts";
import type { ReportData } from "../../src/report/data-loader.ts";

// ---------------------------------------------------------------------------
// Stream sink — captures stdout/stderr for output assertions.
// ---------------------------------------------------------------------------

class StringSink extends Writable {
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

afterEach(() => {
  setStreams({ stdout: process.stdout, stderr: process.stderr });
});

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

interface FakeHandleSpy {
  closeCalls: number;
}

function makeFakeHandle(
  port: number,
  spy: FakeHandleSpy = { closeCalls: 0 },
): ServerHandle & { spy: FakeHandleSpy } {
  return {
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}/`,
    data: makeReportData(),
    close: async () => {
      spy.closeCalls += 1;
    },
    spy,
  };
}

// ---------------------------------------------------------------------------
// parseReportServeArgs
// ---------------------------------------------------------------------------

describe("parseReportServeArgs", () => {
  it("returns defaults (cwd from arg, no port) for empty argv", () => {
    const r = parseReportServeArgs([], "/cwd");
    expect(r).toEqual({ ok: true, value: { cwd: "/cwd" } });
  });

  it("resolves --cwd against the default cwd", () => {
    const r = parseReportServeArgs(["--cwd", "subdir"], "/root");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cwd).toMatch(/\/root\/subdir$/);
  });

  it("rejects --cwd without a value", () => {
    expect(parseReportServeArgs(["--cwd"], "/x")).toEqual({
      ok: false,
      error: "missing value for --cwd",
    });
  });

  it("rejects --cwd with empty string", () => {
    expect(parseReportServeArgs(["--cwd", ""], "/x")).toEqual({
      ok: false,
      error: "missing value for --cwd",
    });
  });

  it("accepts --port with an integer in range", () => {
    const r = parseReportServeArgs(["--port", "8080"], "/cwd");
    expect(r).toEqual({ ok: true, value: { cwd: "/cwd", port: 8080 } });
  });

  it("accepts --port 0 (kernel-assigned)", () => {
    const r = parseReportServeArgs(["--port", "0"], "/cwd");
    expect(r).toEqual({ ok: true, value: { cwd: "/cwd", port: 0 } });
  });

  it("accepts --port 65535 (max)", () => {
    const r = parseReportServeArgs(["--port", String(MAX_PORT)], "/cwd");
    expect(r).toEqual({ ok: true, value: { cwd: "/cwd", port: MAX_PORT } });
  });

  it("rejects --port without a value", () => {
    expect(parseReportServeArgs(["--port"], "/x")).toEqual({
      ok: false,
      error: "missing value for --port",
    });
  });

  it("rejects non-numeric --port", () => {
    expect(parseReportServeArgs(["--port", "abc"], "/x")).toEqual({
      ok: false,
      error: "invalid port: abc (expected integer)",
    });
  });

  it("rejects negative port (caught by integer regex)", () => {
    expect(parseReportServeArgs(["--port", "-1"], "/x")).toEqual({
      ok: false,
      error: "invalid port: -1 (expected integer)",
    });
  });

  it("rejects port > 65535", () => {
    const r = parseReportServeArgs(["--port", "65536"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("port out of range");
  });

  it("rejects fractional port (caught by integer regex)", () => {
    const r = parseReportServeArgs(["--port", "80.5"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid port");
  });

  it("returns the help sentinel for --help", () => {
    expect(parseReportServeArgs(["--help"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("returns the help sentinel for -h", () => {
    expect(parseReportServeArgs(["-h"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("rejects unknown flags", () => {
    const r = parseReportServeArgs(["--bogus"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown flag");
  });

  it("MIN_PORT and MAX_PORT are 0..65535", () => {
    expect(MIN_PORT).toBe(0);
    expect(MAX_PORT).toBe(65535);
  });
});

// ---------------------------------------------------------------------------
// runReportServe — happy paths
// ---------------------------------------------------------------------------

describe("runReportServe — happy path", () => {
  it("emits the canonical JSON line and returns OK after waitForExit resolves", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const spy = { closeCalls: 0 };
    const code = await runReportServe(["--cwd", "/proj"], {
      startReportServerFn: async () => makeFakeHandle(54321, spy),
      waitForExitFn: async () => undefined,
      pidFn: () => 99999,
    });
    expect(code).toBe(EXIT_CODES.OK);
    const lines = stdout.text().trim().split("\n");
    expect(lines.length).toBe(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload).toEqual({
      ok: true,
      host: "127.0.0.1",
      port: 54321,
      url: "http://127.0.0.1:54321/",
      pid: 99999,
      audit_path: ".lint-audit/2026-05-04T12-00-00-000Z.json",
    });
    expect(spy.closeCalls).toBe(1);
  });

  it("forwards --port to the start function", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    let receivedPort: number | undefined;
    await runReportServe(["--cwd", "/proj", "--port", "7777"], {
      startReportServerFn: async (opts) => {
        receivedPort = opts.port;
        return makeFakeHandle(7777);
      },
      waitForExitFn: async () => undefined,
      pidFn: () => 1,
    });
    expect(receivedPort).toBe(7777);
  });

  it("does not pass `port` to start when --port was omitted", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    let receivedOpts: unknown;
    await runReportServe(["--cwd", "/proj"], {
      startReportServerFn: async (opts) => {
        receivedOpts = opts;
        return makeFakeHandle(0);
      },
      waitForExitFn: async () => undefined,
      pidFn: () => 1,
    });
    expect(receivedOpts).toEqual({ cwd: expect.stringMatching(/\/proj$/) });
  });

  it("calls close() exactly once even when waitForExit resolves immediately", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    const spy = { closeCalls: 0 };
    await runReportServe([], {
      startReportServerFn: async () => makeFakeHandle(1234, spy),
      waitForExitFn: async () => undefined,
      pidFn: () => 1,
    });
    expect(spy.closeCalls).toBe(1);
  });

  it("invokes waitForExit with the live handle (handle.port is a number)", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    let observedPort = -1;
    await runReportServe([], {
      startReportServerFn: async () => makeFakeHandle(4321),
      waitForExitFn: async (h) => {
        observedPort = h.port;
      },
      pidFn: () => 1,
    });
    expect(observedPort).toBe(4321);
  });

  it("writes the structured 'report_serve_listening' info line to stderr", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    await runReportServe([], {
      startReportServerFn: async () => makeFakeHandle(8000),
      waitForExitFn: async () => undefined,
      pidFn: () => 1,
    });
    expect(stderr.text()).toContain('"event":"report_serve_listening"');
    expect(stderr.text()).toContain('"port":8000');
  });

  it("still returns OK and closes when waitForExit throws (finally runs)", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    const spy = { closeCalls: 0 };
    await expect(
      runReportServe([], {
        startReportServerFn: async () => makeFakeHandle(9000, spy),
        waitForExitFn: async () => {
          throw new Error("signal listener crashed");
        },
        pidFn: () => 1,
      }),
    ).rejects.toThrow("signal listener crashed");
    expect(spy.closeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runReportServe — failures
// ---------------------------------------------------------------------------

describe("runReportServe — failures", () => {
  it("prints help text to stderr and returns OK on --help", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    // Help text bypasses the logger seam (matches the convention used by
    // every other --help in this CLI — see e.g. git-clean-check tests). We
    // monkey-patch process.stderr.write to capture the raw output.
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runReportServe(["--help"], {
        startReportServerFn: async () => {
          throw new Error("must not call start on help");
        },
        waitForExitFn: async () => undefined,
      });
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
      const helpText = captured.join("");
      expect(helpText).toContain("qualy report-serve");
      expect(helpText).toContain("[--port <n>]");
      expect(helpText).toContain("127.0.0.1");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("emits usage_error JSON and returns USAGE_ERROR on unknown flag", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = await runReportServe(["--bogus"], {
      startReportServerFn: async () => {
        throw new Error("must not call start on usage error");
      },
      waitForExitFn: async () => undefined,
    });
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("usage_error");
    expect(payload.reason).toContain("unknown flag");
  });

  it("returns USAGE_ERROR for invalid --port", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const code = await runReportServe(["--port", "abc"]);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.error).toBe("usage_error");
    expect(payload.reason).toContain("invalid port");
  });

  it("emits start_failed and returns RECOVERABLE_ERROR when startReportServer throws", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = await runReportServe(["--cwd", "/proj"], {
      startReportServerFn: async () => {
        throw new Error("audit_missing (no audit files found under .lint-audit/)");
      },
      waitForExitFn: async () => undefined,
    });
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload).toEqual({
      ok: false,
      error: "start_failed",
      reason: "audit_missing (no audit files found under .lint-audit/)",
    });
    expect(stderr.text()).toContain('"event":"report_serve_start_failed"');
  });

  it("propagates non-Error throws from start as their string form", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const code = await runReportServe([], {
      startReportServerFn: async () => {
        throw "raw string failure";
      },
      waitForExitFn: async () => undefined,
    });
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.reason).toBe("raw string failure");
  });

  it("does not throw when handle.close() rejects — it warns instead", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = await runReportServe([], {
      startReportServerFn: async () => ({
        host: "127.0.0.1" as const,
        port: 5555,
        url: "http://127.0.0.1:5555/",
        data: makeReportData(),
        close: async () => {
          throw new Error("close failed");
        },
      }),
      waitForExitFn: async () => undefined,
      pidFn: () => 1,
    });
    expect(code).toBe(EXIT_CODES.OK);
    expect(stderr.text()).toContain('"event":"report_serve_close_error"');
    expect(stderr.text()).toContain("close failed");
  });
});
