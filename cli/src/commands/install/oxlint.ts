/**
 * `install-oxlint` — write `oxlint.fast.json` and `oxlint.deep.json` to the
 * target project root, copied byte-for-byte from the in-source preset bundled
 * for the detected (or explicitly chosen) stage.
 *
 * SPEC §3 + §4: presets live at `cli/src/presets/oxlint/<stage>.<tier>.json`
 * and are the single source of truth for stage thresholds. This command is the
 * only authorized writer for the two `oxlint.*.json` files in target projects.
 *
 * Behavior:
 *   1. Resolve stage — `--stage <name>` if provided, otherwise call
 *      `detectStage()` and use its classification.
 *   2. Read both preset files from the qualy install (resolved relative to
 *      this module via `import.meta.url`).
 *   3. Write both files via `safeWriteFile` (manifest-tracked, kind="preset",
 *      respects `--strict` working-tree gate).
 *
 * Idempotency: re-running on the same stage rewrites identical bytes and
 * `recordEntry` deduplicates the manifest entry by path (replaces the prior
 * row, bumping `created_at`). Switching stages is also safe — the old preset
 * file is overwritten in place.
 *
 * Output (PLAN §Contratos CLI – install commands):
 *   { ok, cwd, stage, written: [{ path, bytes, recorded }] }
 *
 * Exit codes:
 *   - OK                — both files written.
 *   - USAGE_ERROR       — unknown flag or invalid `--stage`.
 *   - RECOVERABLE_ERROR — stage detection failed, preset missing, write failed.
 *   - DIRTY_TREE        — `--strict` set and working tree is dirty.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, type ExitCode } from "../../lib/exit-codes.ts";
import { type SafeIO, safeWriteFile } from "../../lib/fs-safe.ts";
import { logger, output } from "../../lib/logger.ts";
import { type Stage, detectStage } from "../detect-stage.ts";

const STAGES: readonly Stage[] = ["greenfield", "brownfield-moderate", "legacy"];
const TIERS = ["fast", "deep"] as const;

type Tier = (typeof TIERS)[number];

/**
 * Absolute path to `cli/src/presets/oxlint/`. Resolved at module load from
 * `import.meta.url` so the command works regardless of where the qualy CLI is
 * installed (project-local copy, `~/.claude/`, dev symlink — see ADR 0009).
 */
const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "presets", "oxlint");

export interface InstallOxlintOptions {
  readonly cwd: string;
  /** Explicit stage. When omitted, `detectStage()` is invoked. */
  readonly stage?: Stage;
  /** Refuse to write if the working tree is dirty. */
  readonly strict?: boolean;
}

export interface InstallOxlintWritten {
  readonly path: string;
  readonly tier: Tier;
  readonly bytes: number;
  readonly recorded: boolean;
}

export interface InstallOxlintOk {
  readonly ok: true;
  readonly cwd: string;
  readonly stage: Stage;
  readonly stageSource: "explicit" | "detected";
  readonly written: readonly InstallOxlintWritten[];
}

export interface InstallOxlintErr {
  readonly ok: false;
  readonly error: string;
  readonly reason?: string;
}

export type InstallOxlintResult = InstallOxlintOk | InstallOxlintErr;

export interface InstallOxlintDeps {
  /** Override preset directory (for tests). Defaults to the bundled directory. */
  readonly presetsDir?: string;
  /** Read preset bytes (test seam). */
  readonly readFileFn?: (path: string) => string;
  /** Pass-through to `safeWriteFile` for FS / git seams. */
  readonly safeIO?: SafeIO;
  /** Test seam for `detectStage` so install can be unit-tested without a real repo. */
  readonly detectStageFn?: typeof detectStage;
}

function defaultRead(p: string): string {
  return readFileSync(p, "utf8");
}

function presetPath(presetsDir: string, stage: Stage, tier: Tier): string {
  return join(presetsDir, `${stage}.${tier}.json`);
}

function targetPath(tier: Tier): string {
  return `oxlint.${tier}.json`;
}

export function installOxlint(
  opts: InstallOxlintOptions,
  deps: InstallOxlintDeps = {},
): InstallOxlintResult {
  const presetsDir = deps.presetsDir ?? PRESETS_DIR;
  const readFileFn = deps.readFileFn ?? defaultRead;

  let stage: Stage;
  let stageSource: "explicit" | "detected";
  if (opts.stage !== undefined) {
    stage = opts.stage;
    stageSource = "explicit";
  } else {
    const detect = (deps.detectStageFn ?? detectStage)({ cwd: opts.cwd });
    if (!detect.ok) {
      return { ok: false, error: "stage_detection_failed", reason: detect.error };
    }
    stage = detect.stage;
    stageSource = "detected";
  }

  const written: InstallOxlintWritten[] = [];
  for (const tier of TIERS) {
    const src = presetPath(presetsDir, stage, tier);
    let content: string;
    try {
      content = readFileFn(src);
    } catch (err) {
      return {
        ok: false,
        error: "preset_read_failed",
        reason: `${src}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const dest = targetPath(tier);
    const writeRes = safeWriteFile(
      opts.cwd,
      dest,
      content,
      { kind: "preset", strict: opts.strict ?? false },
      deps.safeIO,
    );
    if (!writeRes.ok) {
      return { ok: false, error: "write_failed", reason: `${dest}: ${writeRes.error}` };
    }
    written.push({
      path: writeRes.value.path,
      tier,
      bytes: writeRes.value.bytes,
      recorded: writeRes.value.recorded,
    });
  }

  return { ok: true, cwd: opts.cwd, stage, stageSource, written };
}

export interface ParsedArgs {
  readonly cwd: string;
  readonly stage?: Stage;
  readonly strict: boolean;
}

export type ArgParseResult =
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string };

function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export function parseInstallOxlintArgs(
  argv: readonly string[],
  defaultCwd: string,
): ArgParseResult {
  let cwd = defaultCwd;
  let stage: Stage | undefined;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --cwd" };
      }
      cwd = resolve(defaultCwd, value);
      i++;
      continue;
    }
    if (arg === "--stage") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        return { ok: false, error: "missing value for --stage" };
      }
      if (!isStage(value)) {
        return {
          ok: false,
          error: `invalid stage: ${value} (expected: ${STAGES.join("|")})`,
        };
      }
      stage = value;
      i++;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ok: false, error: "help" };
    }
    return { ok: false, error: `unknown flag: ${String(arg)}` };
  }
  return { ok: true, value: { cwd, ...(stage !== undefined ? { stage } : {}), strict } };
}

export function runInstallOxlint(argv: readonly string[]): ExitCode {
  const parsed = parseInstallOxlintArgs(argv, process.cwd());
  if (!parsed.ok) {
    if (parsed.error === "help") {
      process.stderr.write(
        "qualy install-oxlint [--cwd <path>] [--stage <name>] [--strict]\n" +
          "\n" +
          "Writes oxlint.fast.json and oxlint.deep.json from the stage preset.\n" +
          "Stage is detected via detect-stage when --stage is omitted.\n" +
          "Stages: greenfield | brownfield-moderate | legacy.\n" +
          "Exit codes: 0 ok, 1 detection/write failure, 3 dirty tree (--strict), 4 usage.\n",
      );
      return EXIT_CODES.OK;
    }
    logger.error("usage_error", { command: "install-oxlint", reason: parsed.error });
    output({ ok: false, error: "usage_error", reason: parsed.error });
    return EXIT_CODES.USAGE_ERROR;
  }

  const result = installOxlint(parsed.value);
  if (!result.ok) {
    logger.error("install_oxlint_failed", { reason: result.reason ?? result.error });
    output(result);
    if (result.error === "write_failed" && result.reason?.includes("working tree is dirty")) {
      return EXIT_CODES.DIRTY_TREE;
    }
    return EXIT_CODES.RECOVERABLE_ERROR;
  }

  output(result);
  logger.info("install_oxlint_ok", {
    stage: result.stage,
    stageSource: result.stageSource,
    files: result.written.length,
  });
  return EXIT_CODES.OK;
}
