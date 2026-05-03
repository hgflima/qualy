import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import {
  getLogLevel,
  logger,
  output,
  setLogLevel,
  setStreams,
  type LogLevel,
} from "../../src/lib/logger.ts";

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  lines(): string[] {
    return this.text().split("\n").filter((l) => l.length > 0);
  }
}

describe("logger", () => {
  let err: CaptureStream;
  let out: CaptureStream;
  let prevLevel: LogLevel;

  beforeEach(() => {
    err = new CaptureStream();
    out = new CaptureStream();
    setStreams({ stderr: err, stdout: out });
    prevLevel = getLogLevel();
    setLogLevel("info");
  });

  afterEach(() => {
    setLogLevel(prevLevel);
    setStreams({ stderr: process.stderr, stdout: process.stdout });
  });

  it("writes structured JSON lines to stderr with ts/level/event fields", () => {
    logger.info("setup.started", { stage: "greenfield" });
    const lines = err.lines();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record["level"]).toBe("info");
    expect(record["event"]).toBe("setup.started");
    expect(record["stage"]).toBe("greenfield");
    expect(typeof record["ts"]).toBe("string");
    expect(() => new Date(record["ts"] as string).toISOString()).not.toThrow();
  });

  it("does not write to stdout for log calls", () => {
    logger.error("boom");
    expect(out.text()).toBe("");
  });

  it("respects level ordering — debug suppressed at info", () => {
    setLogLevel("info");
    logger.debug("noisy");
    logger.info("kept");
    const lines = err.lines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("kept");
  });

  it("silent level suppresses everything including errors", () => {
    setLogLevel("silent");
    logger.error("nope");
    logger.info("nope");
    expect(err.text()).toBe("");
  });

  it("debug level emits all four severities", () => {
    setLogLevel("debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(err.lines()).toHaveLength(4);
  });

  it("output() writes a single JSON line to stdout, nothing to stderr", () => {
    output({ ok: true, count: 3 });
    expect(out.text()).toBe('{"ok":true,"count":3}\n');
    expect(err.text()).toBe("");
  });

  it("reserved keys (event, level, ts) win over user-supplied fields", () => {
    logger.warn("real-event", { event: "shadow", level: "shadow", custom: 1 });
    const record = JSON.parse(err.lines()[0]!) as Record<string, unknown>;
    expect(record["event"]).toBe("real-event");
    expect(record["level"]).toBe("warn");
    expect(record["custom"]).toBe(1);
  });
});
