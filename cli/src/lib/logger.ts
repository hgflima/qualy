/**
 * Structured logger for the qualy CLI.
 *
 * Stdout is reserved for the command's canonical JSON output (PLAN.md
 * §Princípios: "CLI sempre emite JSON em stdout, erros estruturados em
 * stderr"). Stderr carries one JSON object per line (NDJSON) so harness
 * subagents can parse or display progress without colliding with the
 * stdout payload.
 *
 * Conventions:
 *   - One `output()` call per command. Extra stdout writes break parsers.
 *   - Use `logger.{debug,info,warn,error}(event, fields?)` for everything else.
 *   - Levels honor `QUALY_LOG_LEVEL` (silent|error|warn|info|debug). Default: info.
 */
import type { Writable } from "node:stream";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_LEVEL: LogLevel = "info";

function readEnvLevel(): LogLevel {
  const raw = process.env["QUALY_LOG_LEVEL"];
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return DEFAULT_LEVEL;
}

let currentLevel: LogLevel = readEnvLevel();
let stderrStream: Writable = process.stderr;
let stdoutStream: Writable = process.stdout;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Test-only seam. Reset by passing `process.stderr` / `process.stdout`. */
export function setStreams(streams: { stderr?: Writable; stdout?: Writable }): void {
  if (streams.stderr) stderrStream = streams.stderr;
  if (streams.stdout) stdoutStream = streams.stdout;
}

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  event: string;
  [key: string]: unknown;
}

function emit(level: Exclude<LogLevel, "silent">, event: string, fields?: LogFields): void {
  if (LEVEL_ORDER[currentLevel] < LEVEL_ORDER[level]) return;
  const record: LogRecord = {
    ...(fields ?? {}),
    ts: new Date().toISOString(),
    level,
    event,
  };
  stderrStream.write(JSON.stringify(record) + "\n");
}

export const logger = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

/**
 * Writes the canonical command output as JSON to stdout.
 *
 * Call exactly once per command. The harness (`commands/*.md`) and subagents
 * parse this single JSON document — additional stdout writes will break them.
 */
export function output(value: unknown): void {
  stdoutStream.write(JSON.stringify(value) + "\n");
}
