/**
 * Payload copy primitives for the harness installer.
 *
 * `walkPayload(source)` enumerates the four top-level directories the harness
 * ships (`skills/`, `commands/`, `agents/`, `cli/`) and yields every regular
 * file under them as a path relative to `source`. It deliberately skips
 * `cli/tests/` and `cli/node_modules/` (SPEC §4 — only the runtime payload is
 * shipped to the user's `.claude/`) and never follows symlinks. The latter
 * matters because the dev tree contains `skills/lint/cli` as a symlink back
 * to `cli/` for local iteration; following it would copy `cli/` twice (once
 * under its mapped target and once under the symlink).
 *
 * `sha256File(abs)` streams the file through `createHash('sha256')` instead
 * of buffering it whole — TASKS.md 1.4 calls this out explicitly because
 * skill assets can be large enough to matter.
 *
 * `mapTarget(rel, target)` translates a source-relative path into the
 * corresponding absolute path inside the target scope:
 *   - `cli/...`                 → `${target}/skills/lint/cli/...`
 *   - `skills|commands|agents/` → `${target}/...` (identity prepend)
 *
 * `copyPayload(args)` is the orchestrator. It is idempotent (sha256 match on
 * an existing target → `skipped`), respects `dryRun` (no bytes written), and
 * never touches files in the target that the source does not produce — the
 * "anti-orphan" guarantee the uninstall handler relies on so user-authored
 * files in `.claude/` are not collateral damage.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { ManifestEntryKind } from "./manifest.ts";

export type PathEntry = {
  rel: string;
  abs: string;
  sha256: string;
  kind: ManifestEntryKind;
};

export type CopyArgs = {
  source: string;
  target: string;
  dryRun: boolean;
};

export type CopyResult = {
  copied: PathEntry[];
  skipped: PathEntry[];
};

const TOP_LEVEL_DIRS = ["skills", "commands", "agents", "cli"] as const;

const SKIP_RELATIVE = new Set<string>([
  join("cli", "tests"),
  join("cli", "node_modules"),
]);

export function* walkPayload(source: string): Generator<string> {
  for (const top of TOP_LEVEL_DIRS) {
    const dir = join(source, top);
    if (!existsSync(dir)) continue;
    yield* walkDir(source, dir);
  }
}

function* walkDir(source: string, dir: string): Generator<string> {
  if (SKIP_RELATIVE.has(relative(source, dir))) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(source, full);
    } else if (entry.isFile()) {
      yield relative(source, full);
    }
  }
}

export function sha256File(abs: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const hash = createHash("sha256");
    const stream = createReadStream(abs);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveP(hash.digest("hex")));
    stream.on("error", rejectP);
  });
}

export function mapTarget(rel: string, target: string): string {
  const parts = rel.split(sep);
  if (parts[0] === "cli") {
    return join(target, "skills", "lint", ...parts);
  }
  return join(target, ...parts);
}

export async function copyPayload(args: CopyArgs): Promise<CopyResult> {
  const { source, target, dryRun } = args;
  const copied: PathEntry[] = [];
  const skipped: PathEntry[] = [];

  for (const sourceRel of walkPayload(source)) {
    const sourceAbs = join(source, sourceRel);
    const sha = await sha256File(sourceAbs);
    const targetAbs = mapTarget(sourceRel, target);
    const targetRel = relative(target, targetAbs);
    const entry: PathEntry = {
      rel: targetRel,
      abs: targetAbs,
      sha256: sha,
      kind: kindOf(sourceRel),
    };

    if (existsSync(targetAbs)) {
      const targetSha = await sha256File(targetAbs);
      if (targetSha === sha) {
        skipped.push(entry);
        continue;
      }
    }

    if (dryRun) {
      copied.push(entry);
      continue;
    }

    mkdirSync(dirname(targetAbs), { recursive: true });
    copyFileSync(sourceAbs, targetAbs);
    copied.push(entry);
  }

  return { copied, skipped };
}

function kindOf(sourceRel: string): ManifestEntryKind {
  const top = sourceRel.split(sep)[0];
  switch (top) {
    case "skills":
      return "skill";
    case "commands":
      return "command";
    case "agents":
      return "agent";
    case "cli":
      return "cli";
    default:
      return "other";
  }
}
