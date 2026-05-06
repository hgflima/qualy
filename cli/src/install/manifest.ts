/**
 * Atomic read/write for the harness install manifest.
 *
 * Lives at `${scopeRoot}/.lint-manifest.json` (SPEC §3 + §4 — same filename
 * as the legacy lint-stack manifest, but disambiguated by the presence of a
 * `scope` field). `readManifest` returns `null` when the file is absent and
 * **throws** when it exists but lacks `scope` — that means it belongs to the
 * lint-stack installer (`cli/src/lib/fs-safe.ts`), and the harness installer
 * must refuse to mutate it.
 *
 * `writeManifest` writes to `<file>.tmp.<rand>` and then `renameSync`s into
 * place so a crashed install never leaves a half-written manifest behind
 * (SPEC §6 — "registrar toda mutação no manifest" depends on this being
 * crash-safe).
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Scope } from "./scope.ts";

export const MANIFEST_FILENAME = ".lint-manifest.json";
export const MANIFEST_VERSION = "1" as const;

export type ManifestEntryKind =
  | "skill"
  | "command"
  | "agent"
  | "cli"
  | "runtime-node-modules"
  | "other";

export type ManifestEntry = {
  path: string;
  sha256: string;
  kind: ManifestEntryKind;
};

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  scope: Scope;
  harness_version: string;
  installer: "npx" | "install.sh";
  installed_at: string;
  entries: ManifestEntry[];
};

export function manifestPath(scopeRoot: string): string {
  return join(scopeRoot, MANIFEST_FILENAME);
}

export function readManifest(scopeRoot: string): Manifest | null {
  const path = manifestPath(scopeRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `manifest at ${path} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`manifest at ${path} is not a JSON object`);
  }
  if (!("scope" in parsed)) {
    throw new Error(
      `manifest at ${path} has no "scope" field — this looks like a ` +
        `lint-stack manifest (cli/src/lib/fs-safe.ts), not a harness ` +
        `manifest. Refusing to read; the harness installer never touches ` +
        `lint-stack manifests.`,
    );
  }
  return parsed as Manifest;
}

export function writeManifest(scopeRoot: string, manifest: Manifest): void {
  const path = manifestPath(scopeRoot);
  const tmp = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    writeFileSync(tmp, body, { encoding: "utf8" });
  } catch (err) {
    safeUnlink(tmp);
    throw err;
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    safeUnlink(tmp);
    throw err;
  }
}

export function deleteManifest(scopeRoot: string): void {
  safeUnlink(manifestPath(scopeRoot));
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
