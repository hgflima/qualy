/**
 * Ignore-manifest persistence — pure read/write/upsert/validate helpers
 * (lint-ignore SPEC §2.1, PLAN T2.1).
 *
 * The manifest at `.harn/qualy/ignore.json` is the single source of truth for
 * `qualy ignore-*` commands. Presets (`oxlint.{fast,deep}.json`) are derived
 * from this manifest by `lib/ignore-compile.ts` (T2.2). Decision-log entries
 * trail mutations (T2.4 wires it together).
 *
 * Design notes:
 *   - Pure module: every FS interaction routes through `SafeIO` (the same seam
 *     used by `fs-safe.ts`) so unit tests need not touch disk.
 *   - Entry id is deterministic: `ign-` + first 6 hex chars of
 *     `sha256(glob + "|" + (rule ?? ""))`. Same `(glob, rule)` always yields
 *     the same id — that is what lets `upsertEntry` decide
 *     `added` vs `updated` without keeping a side index.
 *   - `expires` is a calendar date (YYYY-MM-DD), not a timestamp — exclusions
 *     are reviewed in human-time, not millisecond-time. `findExpired` treats
 *     "expired" as `expires < startOfDay(now)` (same-day = still valid).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type SafeIO,
  type SafeResult,
  safeWriteFile,
} from "./fs-safe.ts";
import { parseDefensive, stringifyPretty } from "./json.ts";
import { IGNORE_MANIFEST_PATH } from "./paths.ts";

export const IGNORE_MANIFEST_VERSION = 1 as const;

export type IgnoreCreatedBy = "user" | "imported";

export interface IgnoreEntry {
  /** Stable, deterministic id derived from `(glob, rule)`. */
  readonly id: string;
  /** Glob pattern (oxlint/gitignore-compatible). */
  readonly glob: string;
  /** `null` = path-only exclusion; string = per-rule (`quality-metrics/wmc`,
   *  `category:correctness`, `eslint/no-debugger`, …). */
  readonly rule: string | null;
  readonly reason: string;
  /** `YYYY-MM-DD` calendar date or `null` for no expiry. */
  readonly expires: string | null;
  /** ISO-8601 timestamp of first creation (preserved across updates). */
  readonly createdAt: string;
  readonly createdBy: IgnoreCreatedBy;
}

export interface IgnoreManifest {
  readonly version: typeof IGNORE_MANIFEST_VERSION;
  readonly entries: readonly IgnoreEntry[];
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// id generation
// ---------------------------------------------------------------------------

/** Deterministic short id. The same `(glob, rule)` always produces the same id. */
export function generateEntryId(glob: string, rule: string | null): string {
  const key = `${glob}|${rule ?? ""}`;
  const hash = createHash("sha256").update(key).digest("hex");
  return `ign-${hash.slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGlob(glob: unknown): ValidationResult {
  if (typeof glob !== "string") {
    return { ok: false, error: "glob must be a string" };
  }
  if (glob.trim().length === 0) {
    return { ok: false, error: "glob is empty" };
  }
  return { ok: true };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts `null` (no expiry) or `YYYY-MM-DD` strictly in the future of `now`. */
export function validateExpires(
  expires: string | null,
  now: Date,
): ValidationResult {
  if (expires === null) return { ok: true };
  if (typeof expires !== "string" || !ISO_DATE_RE.test(expires)) {
    return {
      ok: false,
      error: `expires must match YYYY-MM-DD (got: ${String(expires)})`,
    };
  }
  // Parse calendar date as UTC midnight; same-day or future is allowed.
  const ms = Date.parse(`${expires}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `expires is not a valid date: ${expires}` };
  }
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (ms < startOfToday) {
    return { ok: false, error: `expires is in the past: ${expires}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Upsert / remove
// ---------------------------------------------------------------------------

export interface UpsertInput {
  readonly glob: string;
  readonly rule: string | null;
  readonly reason: string;
  readonly expires: string | null;
  readonly createdBy: IgnoreCreatedBy;
  readonly now: Date;
}

export interface UpsertResult {
  readonly action: "added" | "updated";
  readonly manifest: IgnoreManifest;
  readonly entry: IgnoreEntry;
}

/** Idempotent insert: if `(glob, rule)` already exists, replace `reason`/
 *  `expires`/`createdBy` while preserving `createdAt`. */
export function upsertEntry(
  manifest: IgnoreManifest,
  input: UpsertInput,
): UpsertResult {
  const id = generateEntryId(input.glob, input.rule);
  const existing = manifest.entries.find((e) => e.id === id);
  const createdAt = existing?.createdAt ?? input.now.toISOString();
  const next: IgnoreEntry = {
    id,
    glob: input.glob,
    rule: input.rule,
    reason: input.reason,
    expires: input.expires,
    createdAt,
    createdBy: input.createdBy,
  };
  const filtered = manifest.entries.filter((e) => e.id !== id);
  return {
    action: existing ? "updated" : "added",
    manifest: { version: IGNORE_MANIFEST_VERSION, entries: [...filtered, next] },
    entry: next,
  };
}

export interface RemoveResult {
  readonly manifest: IgnoreManifest;
  readonly removed: readonly IgnoreEntry[];
}

export function removeEntries(
  manifest: IgnoreManifest,
  predicate: (e: IgnoreEntry) => boolean,
): RemoveResult {
  const removed: IgnoreEntry[] = [];
  const kept: IgnoreEntry[] = [];
  for (const e of manifest.entries) {
    if (predicate(e)) removed.push(e);
    else kept.push(e);
  }
  return {
    manifest: { version: IGNORE_MANIFEST_VERSION, entries: kept },
    removed,
  };
}

// ---------------------------------------------------------------------------
// Expired
// ---------------------------------------------------------------------------

/** Returns entries whose `expires` is strictly before the start of `now`'s day. */
export function findExpired(
  manifest: IgnoreManifest,
  now: Date,
): readonly IgnoreEntry[] {
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const out: IgnoreEntry[] = [];
  for (const e of manifest.entries) {
    if (e.expires === null) continue;
    if (!ISO_DATE_RE.test(e.expires)) continue;
    const ms = Date.parse(`${e.expires}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) continue;
    if (ms < startOfToday) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isValidEntry(e: unknown): e is IgnoreEntry {
  if (e === null || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["glob"] === "string" &&
    (o["rule"] === null || typeof o["rule"] === "string") &&
    typeof o["reason"] === "string" &&
    (o["expires"] === null || typeof o["expires"] === "string") &&
    typeof o["createdAt"] === "string" &&
    (o["createdBy"] === "user" || o["createdBy"] === "imported")
  );
}

/** Reads `.harn/qualy/ignore.json`. Returns `null` for missing/malformed/
 *  unsupported-version — callers treat that as "no manifest yet". */
export function loadIgnoreManifest(
  cwd: string,
  io: SafeIO = {},
): IgnoreManifest | null {
  const existsFn = io.existsFn ?? ((p: string) => existsSync(p));
  const readFileFn =
    io.readFileFn ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const path = join(cwd, IGNORE_MANIFEST_PATH);
  if (!existsFn(path)) return null;
  const raw = readFileFn(path);
  if (raw === null) return null;
  const parsed = parseDefensive<{ version?: unknown; entries?: unknown }>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
    return null;
  }
  if (parsed.value.version !== IGNORE_MANIFEST_VERSION) return null;
  const rawEntries = Array.isArray(parsed.value.entries)
    ? (parsed.value.entries as unknown[])
    : [];
  const entries: IgnoreEntry[] = [];
  for (const e of rawEntries) {
    if (!isValidEntry(e)) continue;
    entries.push({
      id: e.id,
      glob: e.glob,
      rule: e.rule,
      reason: e.reason,
      expires: e.expires,
      createdAt: e.createdAt,
      createdBy: e.createdBy,
    });
  }
  return { version: IGNORE_MANIFEST_VERSION, entries };
}

/** Writes the manifest via `safeWriteFile` so the lint-manifest registers it
 *  with `kind: "ignore"` for `lint-uninstall`. */
export function saveIgnoreManifest(
  cwd: string,
  manifest: IgnoreManifest,
  io: SafeIO = {},
): SafeResult<{ readonly path: string }> {
  const content = stringifyPretty(manifest);
  const r = safeWriteFile(
    cwd,
    IGNORE_MANIFEST_PATH,
    content,
    { kind: "ignore" },
    io,
  );
  if (!r.ok) return r;
  return { ok: true, value: { path: r.value.path } };
}

