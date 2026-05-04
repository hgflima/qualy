/**
 * Version primitives for the qualy harness installer.
 *
 * `readPackageVersion()` locates the root `package.json` (the one with
 * `"name": "qualy"`) by walking up from this module's directory. It must
 * skip the inner `cli/package.json` (whose name is `@qualy/cli`).
 *
 * `checkNodeVersion()` is the runtime pre-flight: every install/uninstall/
 * update path runs it before touching the filesystem so the user gets a
 * clear MISSING_DEPENDENCY error instead of a stack trace from
 * `--experimental-strip-types` on an old Node.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_NODE_VERSION = "22.6.0" as const;

export type NodeVersionCheck =
  | { ok: true }
  | { ok: false; found: string; required: typeof REQUIRED_NODE_VERSION };

/**
 * Walks up from `startDir` until it finds a `package.json` whose `"name"`
 * field equals `"qualy"`. Returns the `version` field. Throws if the root
 * is not reachable (no qualy package.json found before hitting `/`).
 *
 * `startDir` defaults to the directory of this module — exposed only so
 * tests can exercise the not-found path against a synthetic tmpdir.
 */
export function readPackageVersion(startDir?: string): string {
  const start = startDir ?? dirname(fileURLToPath(import.meta.url));
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === "qualy") {
        if (typeof parsed.version !== "string" || parsed.version.length === 0) {
          throw new Error(
            `qualy package.json at ${candidate} is missing a string "version" field`,
          );
        }
        return parsed.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `unable to locate qualy root package.json (walked up from ${start}); ` +
          `the installer must be invoked from within the qualy distribution`,
      );
    }
    dir = parent;
  }
}

/**
 * Returns `{ ok: true }` when the running Node satisfies the minimum
 * harness requirement, otherwise `{ ok: false, found, required }`.
 *
 * `version` defaults to `process.versions.node`; tests pass a literal
 * string to exercise edge cases without spawning a different Node.
 */
export function checkNodeVersion(version?: string): NodeVersionCheck {
  const found = version ?? process.versions.node;
  const cmp = compareSemverTriple(found, REQUIRED_NODE_VERSION);
  if (cmp >= 0) return { ok: true };
  return { ok: false, found, required: REQUIRED_NODE_VERSION };
}

function compareSemverTriple(a: string, b: string): number {
  const pa = parseTriple(a);
  const pb = parseTriple(b);
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2] - pb[2];
}

function parseTriple(v: string): [number, number, number] {
  const core = v.split("-")[0]!.split("+")[0]!;
  const parts = core.split(".");
  if (parts.length < 3) {
    throw new Error(`invalid semver: "${v}" (expected MAJOR.MINOR.PATCH)`);
  }
  const triple: [number, number, number] = [
    Number.parseInt(parts[0]!, 10),
    Number.parseInt(parts[1]!, 10),
    Number.parseInt(parts[2]!, 10),
  ];
  for (const n of triple) {
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`invalid semver: "${v}" (non-numeric component)`);
    }
  }
  return triple;
}
