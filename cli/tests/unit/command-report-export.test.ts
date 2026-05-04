/**
 * Contract tests for `cli/src/commands/report/export.ts`
 * (IMPLEMENTATION_PLAN.md Phase 6 — wraps `report/export.ts` for the
 * `/lint:report` snapshot acceptance scenario, SPEC §7.7).
 *
 * What is locked here (the wrapper layer; pure helpers and the redactor are
 * already locked by `report-export.test.ts`):
 *   - Argv parser accepts `--cwd`, `--no-redact`, `--name`, `--help`/`-h`
 *     and rejects unknown/malformed flags with stable error tags.
 *   - `--name` rejects path separators and dot-stems (no escape outside
 *     `quality-report/`).
 *   - `runReportExport` emits exactly one canonical JSON document on stdout
 *     with shape `{ ok, cwd, path, bytes, redacted }` on success.
 *   - Defaults: redact is on (SPEC §6), `--no-redact` flips it off.
 *   - Failure tags from `exportReport` (audit_missing, write_failed,
 *     asset_read_failed, assembly_failed, invalid_cwd) propagate as
 *     `{ ok:false, error, reason? }` with `RECOVERABLE_ERROR`.
 *   - Unexpected throws return `INTERNAL_ERROR`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import {
  parseReportExportArgs,
  runReportExport,
} from "../../src/commands/report/export.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { setStreams } from "../../src/lib/logger.ts";
import type {
  ExportDeps,
  ExportOptions,
  ExportResult,
} from "../../src/report/export.ts";

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
// Stub helpers
// ---------------------------------------------------------------------------

function okExport(over: Partial<ExportResult & { ok: true }> = {}): ExportResult {
  return {
    ok: true,
    path: "quality-report/2026-05-04T12-00-00-000Z.html",
    bytes: 1234,
    redacted: true,
    ...over,
  } as ExportResult;
}

interface CallSpy {
  calls: Array<{ opts: ExportOptions; deps: ExportDeps | undefined }>;
}

function makeStub(
  result: ExportResult | (() => ExportResult | Promise<ExportResult>),
): { fn: (opts: ExportOptions, deps?: ExportDeps) => Promise<ExportResult>; spy: CallSpy } {
  const spy: CallSpy = { calls: [] };
  const fn = async (opts: ExportOptions, deps?: ExportDeps): Promise<ExportResult> => {
    spy.calls.push({ opts, deps });
    return typeof result === "function" ? await result() : result;
  };
  return { fn, spy };
}

// ---------------------------------------------------------------------------
// parseReportExportArgs
// ---------------------------------------------------------------------------

describe("parseReportExportArgs", () => {
  it("returns defaults (cwd from arg, redact=true) for empty argv", () => {
    expect(parseReportExportArgs([], "/cwd")).toEqual({
      ok: true,
      value: { cwd: "/cwd", redact: true },
    });
  });

  it("resolves --cwd against the default cwd", () => {
    const r = parseReportExportArgs(["--cwd", "subdir"], "/root");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cwd).toMatch(/\/root\/subdir$/);
  });

  it("rejects --cwd without a value", () => {
    expect(parseReportExportArgs(["--cwd"], "/x")).toEqual({
      ok: false,
      error: "missing value for --cwd",
    });
  });

  it("rejects --cwd with empty string", () => {
    expect(parseReportExportArgs(["--cwd", ""], "/x")).toEqual({
      ok: false,
      error: "missing value for --cwd",
    });
  });

  it("flips redact off on --no-redact", () => {
    const r = parseReportExportArgs(["--no-redact"], "/cwd");
    expect(r).toEqual({ ok: true, value: { cwd: "/cwd", redact: false } });
  });

  it("accepts --name <stem>", () => {
    const r = parseReportExportArgs(["--name", "snapshot-prod"], "/cwd");
    expect(r).toEqual({
      ok: true,
      value: { cwd: "/cwd", redact: true, filenameStem: "snapshot-prod" },
    });
  });

  it("rejects --name without a value", () => {
    expect(parseReportExportArgs(["--name"], "/x")).toEqual({
      ok: false,
      error: "missing value for --name",
    });
  });

  it("rejects --name with empty string", () => {
    expect(parseReportExportArgs(["--name", ""], "/x")).toEqual({
      ok: false,
      error: "missing value for --name",
    });
  });

  it("rejects --name containing a forward slash (escape attempt)", () => {
    const r = parseReportExportArgs(["--name", "../etc/passwd"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid --name");
  });

  it("rejects --name containing a backslash", () => {
    const r = parseReportExportArgs(["--name", "a\\b"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid --name");
  });

  it("rejects --name = '.' or '..'", () => {
    expect(parseReportExportArgs(["--name", "."], "/x").ok).toBe(false);
    expect(parseReportExportArgs(["--name", ".."], "/x").ok).toBe(false);
  });

  it("returns the help sentinel for --help", () => {
    expect(parseReportExportArgs(["--help"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("returns the help sentinel for -h", () => {
    expect(parseReportExportArgs(["-h"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("rejects unknown flags", () => {
    const r = parseReportExportArgs(["--bogus"], "/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown flag");
  });

  it("combines --cwd, --no-redact, and --name", () => {
    const r = parseReportExportArgs(
      ["--cwd", "subdir", "--no-redact", "--name", "v2"],
      "/root",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.redact).toBe(false);
      expect(r.value.filenameStem).toBe("v2");
      expect(r.value.cwd).toMatch(/\/root\/subdir$/);
    }
  });
});

// ---------------------------------------------------------------------------
// runReportExport — happy paths
// ---------------------------------------------------------------------------

describe("runReportExport — happy path", () => {
  it("emits the canonical JSON line and returns OK on success", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const { fn } = makeStub(
      okExport({
        path: "quality-report/2026-05-04T12-00-00-000Z.html",
        bytes: 5678,
        redacted: true,
      }),
    );
    const code = await runReportExport(["--cwd", "/proj"], { exportReportFn: fn });
    expect(code).toBe(EXIT_CODES.OK);
    const lines = stdout.text().trim().split("\n");
    expect(lines.length).toBe(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload).toEqual({
      ok: true,
      cwd: expect.stringMatching(/\/proj$/),
      path: "quality-report/2026-05-04T12-00-00-000Z.html",
      bytes: 5678,
      redacted: true,
    });
  });

  it("forwards cwd, redact=true, and no filenameStem by default", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    const { fn, spy } = makeStub(okExport());
    await runReportExport(["--cwd", "/proj"], { exportReportFn: fn });
    expect(spy.calls.length).toBe(1);
    const opts = spy.calls[0]?.opts;
    expect(opts?.redact).toBe(true);
    expect(opts?.filenameStem).toBeUndefined();
    expect(opts?.cwd).toMatch(/\/proj$/);
  });

  it("forwards redact=false on --no-redact and surfaces redacted=false", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const { fn, spy } = makeStub(okExport({ redacted: false }));
    const code = await runReportExport(["--no-redact"], { exportReportFn: fn });
    expect(code).toBe(EXIT_CODES.OK);
    expect(spy.calls[0]?.opts.redact).toBe(false);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.redacted).toBe(false);
  });

  it("forwards --name as filenameStem", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    const { fn, spy } = makeStub(okExport({ path: "quality-report/v2.html" }));
    await runReportExport(["--name", "v2"], { exportReportFn: fn });
    expect(spy.calls[0]?.opts.filenameStem).toBe("v2");
  });

  it("writes the structured 'report_export_written' info line to stderr", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const { fn } = makeStub(okExport({ bytes: 999 }));
    await runReportExport([], { exportReportFn: fn });
    expect(stderr.text()).toContain('"event":"report_export_written"');
    expect(stderr.text()).toContain('"bytes":999');
  });
});

// ---------------------------------------------------------------------------
// runReportExport — failures
// ---------------------------------------------------------------------------

describe("runReportExport — failures", () => {
  it("prints help text to stderr and returns OK on --help", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const { fn } = makeStub(() => {
        throw new Error("must not call exportReport on help");
      });
      const code = await runReportExport(["--help"], { exportReportFn: fn });
      expect(code).toBe(EXIT_CODES.OK);
      expect(stdout.text()).toBe("");
      const helpText = captured.join("");
      expect(helpText).toContain("qualy report-export");
      expect(helpText).toContain("--no-redact");
      expect(helpText).toContain("quality-report/");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("emits usage_error JSON and returns USAGE_ERROR on unknown flag", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const code = await runReportExport(["--bogus"], {
      exportReportFn: async () => {
        throw new Error("must not call");
      },
    });
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.error).toBe("usage_error");
    expect(payload.reason).toContain("unknown flag");
  });

  it("returns USAGE_ERROR for invalid --name", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const code = await runReportExport(["--name", "../escape"], {
      exportReportFn: async () => {
        throw new Error("must not call");
      },
    });
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.error).toBe("usage_error");
    expect(payload.reason).toContain("invalid --name");
  });

  it("propagates audit_missing as RECOVERABLE_ERROR", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const { fn } = makeStub({
      ok: false,
      error: "audit_missing",
      reason: "no audit files found under .lint-audit/",
    });
    const code = await runReportExport(["--cwd", "/proj"], { exportReportFn: fn });
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload).toEqual({
      ok: false,
      error: "audit_missing",
      reason: "no audit files found under .lint-audit/",
    });
    expect(stderr.text()).toContain('"event":"report_export_failed"');
  });

  it("propagates write_failed with reason", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const { fn } = makeStub({
      ok: false,
      error: "write_failed",
      reason: "EACCES: permission denied",
    });
    const code = await runReportExport([], { exportReportFn: fn });
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.error).toBe("write_failed");
    expect(payload.reason).toBe("EACCES: permission denied");
  });

  it("propagates asset_read_failed and assembly_failed faithfully", async () => {
    setStreams({ stdout: new StringSink(), stderr: new StringSink() });
    for (const tag of ["asset_read_failed", "assembly_failed", "invalid_cwd"] as const) {
      const stdout = new StringSink();
      setStreams({ stdout, stderr: new StringSink() });
      const { fn } = makeStub({ ok: false, error: tag, reason: `${tag} reason` });
      const code = await runReportExport([], { exportReportFn: fn });
      expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
      const payload = JSON.parse(stdout.text().trim());
      expect(payload.error).toBe(tag);
      expect(payload.reason).toBe(`${tag} reason`);
    }
  });

  it("omits `reason` when exportReport returned no reason", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const { fn } = makeStub({ ok: false, error: "audit_missing" });
    const code = await runReportExport([], { exportReportFn: fn });
    expect(code).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload).toEqual({ ok: false, error: "audit_missing" });
    expect("reason" in payload).toBe(false);
  });

  it("returns INTERNAL_ERROR when exportReport throws unexpectedly", async () => {
    const stdout = new StringSink();
    const stderr = new StringSink();
    setStreams({ stdout, stderr });
    const code = await runReportExport([], {
      exportReportFn: async () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload).toEqual({
      ok: false,
      error: "internal_error",
      reason: "disk full",
    });
    expect(stderr.text()).toContain('"event":"report_export_unexpected"');
  });

  it("propagates non-Error throws as their string form", async () => {
    const stdout = new StringSink();
    setStreams({ stdout, stderr: new StringSink() });
    const code = await runReportExport([], {
      exportReportFn: async () => {
        throw "raw string failure";
      },
    });
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.reason).toBe("raw string failure");
  });
});
