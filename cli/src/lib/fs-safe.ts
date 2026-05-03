/**
 * Manifest-aware safe file writer for the qualy CLI.
 *
 * PLAN §Contratos CLI obs.: "Todas as escritas em arquivos do projeto-alvo
 * passam por safe-write.ts que: (i) verifica working tree limpo se `--strict`,
 * (ii) registra arquivos tocados num manifest `.lint-manifest.json` p/
 * uninstall completo."
 *
 * Responsibilities:
 *   - Validate the target path lives under `cwd` (rejects absolute paths and
 *     `..` escapes — the install commands receive paths derived from preset
 *     names and we never want a malformed preset to write outside the project).
 *   - Optionally assert the git working tree is clean before writing
 *     (`strict: true` — defense-in-depth on top of the harness-level
 *     `git-clean-check`).
 *   - Append every successful write to `.lint-manifest.json` so `uninstall`
 *     can remove exactly what we created. The manifest itself is excluded.
 *
 * Non-goals (kept for later phases):
 *   - Backups of pre-existing files (Phase 3 — `backup-create`).
 *   - Auto-merge of `package.json#scripts` / `.claude/settings.json`
 *     (Phase 2 — `install-scripts`/`install-hook`; they call `safeWriteFile`
 *     with `merged: true` to record that uninstall must NOT delete the file
 *     blindly).
 *
 * Test seam: every FS / git interaction goes through the optional `SafeIO`
 * injection so unit tests can run without touching disk or spawning git.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { dirtyFiles } from "./git.ts";
import { parseDefensive, stringifyPretty } from "./json.ts";

export const MANIFEST_FILENAME = ".lint-manifest.json";
export const MANIFEST_VERSION = "1" as const;

/**
 * Categorical tag stored alongside each manifest entry. Uninstall (Phase 3)
 * uses it to decide deletion strategy: "preset"/"hook"/"husky"/"lintstaged"/
 * "decisions"/"backup" are owned by qualy and deleted; "settings"/"scripts"/
 * "coverage"/"dep" are merged into pre-existing files and require surgical
 * removal instead.
 *
 * "dep" entries are virtual (path = `package.json#devDependencies/<name>`) —
 * the package manager is the writer of `package.json`, and we record one entry
 * per installed package so uninstall can `pkg-manager remove` exactly the set
 * we added. They are flagged `merged: true` so uninstall never deletes
 * `package.json`.
 *
 * "backup" entries are written by `backup-create` under `.lint-backup/<ts>/`
 * and are the input to `backup-restore`. Uninstall deletes them by default;
 * `--keep-backup` preserves the directory.
 */
export type ManifestEntryKind =
  | "preset"
  | "hook"
  | "settings"
  | "husky"
  | "lintstaged"
  | "scripts"
  | "coverage"
  | "decisions"
  | "template"
  | "dep"
  | "backup"
  | "other";

export interface ManifestEntry {
  /** Path relative to the project root, POSIX-normalized for cross-platform stability. */
  readonly path: string;
  readonly kind: ManifestEntryKind;
  /** ISO-8601 timestamp of the most recent write that recorded this entry. */
  readonly created_at: string;
  /** True when qualy merged into a pre-existing user file (uninstall must not delete). */
  readonly merged?: boolean;
}

export interface Manifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly created_at: string;
  readonly updated_at: string;
  /** Persisted theme choice (read by `status`). Phase 6 will extend the field set. */
  readonly theme?: string;
  readonly entries: readonly ManifestEntry[];
}

export type SafeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SafeWriteOptions {
  /** Refuse to write if the git working tree is dirty (or git fails). */
  readonly strict?: boolean;
  /** Manifest entry tag — defaults to `"other"` when omitted. */
  readonly kind?: ManifestEntryKind;
  /** Mark the entry as a merge into a pre-existing file (uninstall keeps it). */
  readonly merged?: boolean;
  /** Optional file mode (e.g. `0o755` for `post-edit.sh`). */
  readonly mode?: number;
  /**
   * Skip manifest registration. Used by `backup-restore` which writes back to
   * user-owned files (the original locations) — those are never qualy-owned.
   */
  readonly skipManifest?: boolean;
}

export interface SafeWriteOk {
  /** POSIX-normalized path relative to cwd. */
  readonly path: string;
  /** Absolute path that was written. */
  readonly absolute: string;
  readonly bytes: number;
  readonly recorded: boolean;
}

/**
 * Injection seam for tests. Each function falls back to a real `node:fs` /
 * `git.ts` implementation when an override is not provided.
 */
export interface SafeIO {
  readonly existsFn?: (path: string) => boolean;
  readonly readFileFn?: (path: string) => string | null;
  readonly writeFileFn?: (path: string, content: string, mode?: number) => void;
  readonly mkdirFn?: (path: string) => void;
  readonly removeFn?: (path: string) => void;
  readonly dirtyFilesFn?: (cwd: string) => SafeResult<readonly string[]>;
  readonly now?: () => Date;
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

function defaultRead(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function defaultWrite(p: string, content: string, mode?: number): void {
  if (typeof mode === "number") {
    writeFileSync(p, content, { mode });
  } else {
    writeFileSync(p, content);
  }
}

function defaultMkdir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function defaultRemove(p: string): void {
  rmSync(p, { force: true });
}

function defaultDirtyFiles(cwd: string): SafeResult<readonly string[]> {
  const r = dirtyFiles(cwd);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

export function manifestPath(cwd: string): string {
  return join(cwd, MANIFEST_FILENAME);
}

/**
 * Resolves `relPath` to an absolute path under `cwd` and rejects anything
 * that escapes (absolute input, `..` segments after normalization, empty
 * after normalization).
 */
export function resolveSafePath(cwd: string, relPath: string): SafeResult<string> {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, error: "path is empty" };
  }
  if (isAbsolute(relPath)) {
    return { ok: false, error: `path must be relative: ${relPath}` };
  }
  const abs = resolve(cwd, relPath);
  const rel = relative(cwd, abs);
  if (rel === "" || rel === ".") {
    return { ok: false, error: `path resolves to cwd itself: ${relPath}` };
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `path escapes cwd: ${relPath}` };
  }
  return { ok: true, value: abs };
}

/**
 * POSIX-normalize a relative path so the manifest is stable across Windows
 * and POSIX checkouts of the same repo. We only ever produce relatives via
 * `path.relative` here, so the only platform-specific char to fix is `\`.
 */
function toPosixRel(rel: string): string {
  return rel.split("\\").join("/");
}

function isValidEntry(e: unknown): e is ManifestEntry {
  if (e === null || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o["path"] === "string" &&
    (o["path"] as string).length > 0 &&
    typeof o["kind"] === "string" &&
    (o["kind"] as string).length > 0 &&
    typeof o["created_at"] === "string"
  );
}

function emptyManifest(now: Date): Manifest {
  const iso = now.toISOString();
  return {
    version: MANIFEST_VERSION,
    created_at: iso,
    updated_at: iso,
    entries: [],
  };
}

/**
 * Reads `.lint-manifest.json`. Returns `null` when the file is missing,
 * unreadable, malformed, or carries a different `version` — callers should
 * treat that as "no manifest yet" and `recordEntry` will create a fresh one.
 *
 * Entries that fail shape validation are silently dropped (forward-compat:
 * a future qualy version may add fields, an older version reading the file
 * should still operate on the entries it understands).
 */
export function loadManifest(cwd: string, io: SafeIO = {}): Manifest | null {
  const existsFn = io.existsFn ?? defaultExists;
  const readFileFn = io.readFileFn ?? defaultRead;
  const path = manifestPath(cwd);
  if (!existsFn(path)) return null;
  const raw = readFileFn(path);
  if (raw === null) return null;
  const parsed = parseDefensive<Partial<Manifest> & Record<string, unknown>>(raw);
  if (!parsed.ok) return null;
  const v = parsed.value;
  if (v === null || typeof v !== "object") return null;
  if (v.version !== MANIFEST_VERSION) return null;

  const rawEntries = Array.isArray(v.entries) ? (v.entries as unknown[]) : [];
  const entries: ManifestEntry[] = [];
  for (const e of rawEntries) {
    if (!isValidEntry(e)) continue;
    const merged = (e as { merged?: unknown }).merged === true;
    entries.push({
      path: e.path,
      kind: e.kind as ManifestEntryKind,
      created_at: e.created_at,
      ...(merged ? { merged: true } : {}),
    });
  }

  const created_at = typeof v.created_at === "string" ? v.created_at : new Date(0).toISOString();
  const updated_at = typeof v.updated_at === "string" ? v.updated_at : created_at;
  const theme = typeof v.theme === "string" && v.theme.length > 0 ? v.theme : undefined;

  return {
    version: MANIFEST_VERSION,
    created_at,
    updated_at,
    ...(theme !== undefined ? { theme } : {}),
    entries,
  };
}

function writeManifest(cwd: string, manifest: Manifest, io: SafeIO): void {
  const writeFileFn = io.writeFileFn ?? defaultWrite;
  const mkdirFn = io.mkdirFn ?? defaultMkdir;
  const path = manifestPath(cwd);
  mkdirFn(dirname(path));
  writeFileFn(path, stringifyPretty(manifest));
}

/**
 * Idempotently records an entry. Re-recording the same `path` replaces the
 * prior entry (preserves single-source-of-truth ordering and bumps
 * `created_at` to "most recent write").
 */
export function recordEntry(cwd: string, entry: ManifestEntry, io: SafeIO = {}): void {
  const now = io.now ? io.now() : new Date();
  const cur = loadManifest(cwd, io) ?? emptyManifest(now);
  const filtered = cur.entries.filter((e) => e.path !== entry.path);
  const next: Manifest = {
    ...cur,
    updated_at: now.toISOString(),
    entries: [...filtered, entry],
  };
  writeManifest(cwd, next, io);
}

/** No-op if the entry is absent or the manifest does not exist. */
export function removeEntry(cwd: string, posixRelPath: string, io: SafeIO = {}): void {
  const cur = loadManifest(cwd, io);
  if (!cur) return;
  const filtered = cur.entries.filter((e) => e.path !== posixRelPath);
  if (filtered.length === cur.entries.length) return;
  const now = io.now ? io.now() : new Date();
  writeManifest(cwd, { ...cur, updated_at: now.toISOString(), entries: filtered }, io);
}

/**
 * Patches top-level manifest fields (currently only `theme`). Creates the
 * manifest if it does not exist yet.
 */
export function setManifestField(
  cwd: string,
  patch: { theme?: string },
  io: SafeIO = {},
): void {
  const now = io.now ? io.now() : new Date();
  const cur = loadManifest(cwd, io) ?? emptyManifest(now);
  const next: Manifest = {
    ...cur,
    ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    updated_at: now.toISOString(),
  };
  writeManifest(cwd, next, io);
}

/** Idempotent — no-op if the manifest is already absent. */
export function deleteManifest(cwd: string, io: SafeIO = {}): void {
  const removeFn = io.removeFn ?? defaultRemove;
  removeFn(manifestPath(cwd));
}

/**
 * Writes a file under `cwd` and registers the relative path in the manifest.
 *
 * Validation (in order):
 *   1. `relPath` is relative and stays under `cwd` (resolveSafePath).
 *   2. If `strict: true`, the git working tree must be clean.
 *   3. Parent directories are created (`mkdir -p`).
 *   4. The file is written.
 *   5. The manifest is updated (skipped for the manifest file itself).
 *
 * Returns a discriminated result so install commands can surface the failure
 * to the harness without throwing.
 */
export function safeWriteFile(
  cwd: string,
  relPath: string,
  content: string,
  opts: SafeWriteOptions = {},
  io: SafeIO = {},
): SafeResult<SafeWriteOk> {
  const resolved = resolveSafePath(cwd, relPath);
  if (!resolved.ok) return resolved;
  const abs = resolved.value;

  if (opts.strict) {
    const dirty = (io.dirtyFilesFn ?? defaultDirtyFiles)(cwd);
    if (!dirty.ok) return { ok: false, error: `git check failed: ${dirty.error}` };
    if (dirty.value.length > 0) {
      return {
        ok: false,
        error: `working tree is dirty (${dirty.value.length} file(s))`,
      };
    }
  }

  const writeFileFn = io.writeFileFn ?? defaultWrite;
  const mkdirFn = io.mkdirFn ?? defaultMkdir;
  try {
    mkdirFn(dirname(abs));
    writeFileFn(abs, content, opts.mode);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const posixRel = toPosixRel(relative(cwd, abs));
  const isManifest = posixRel === MANIFEST_FILENAME;

  let recorded = false;
  if (!isManifest && !opts.skipManifest) {
    const now = io.now ? io.now() : new Date();
    recordEntry(
      cwd,
      {
        path: posixRel,
        kind: opts.kind ?? "other",
        created_at: now.toISOString(),
        ...(opts.merged ? { merged: true } : {}),
      },
      io,
    );
    recorded = true;
  }

  return {
    ok: true,
    value: {
      path: posixRel,
      absolute: abs,
      bytes: Buffer.byteLength(content, "utf8"),
      recorded,
    },
  };
}
