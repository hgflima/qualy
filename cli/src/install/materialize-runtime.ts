/**
 * Materializes a self-sufficient `@hgflima/qualy` runtime under
 * `${target}/skills/lint/` so slash commands can resolve `bin/qualy.mjs`
 * with all production deps available locally (Bug 1) and with a valid
 * `package.json` two levels up from the entrypoint (Bug 2).
 *
 * Steps (TASKS.md Task 3):
 *   1. Ensure `${target}/skills/lint/` exists.
 *   2. Write a minimal stub `package.json` ({"name":"qualy-runtime","private":true})
 *      iff absent — npm needs *some* manifest in cwd to install into. Never
 *      overwrites: an existing user file is left intact and `stubCreated`
 *      comes back `null`. The path of the freshly written stub (when we did
 *      create it) is returned in `stubCreated` so the caller (Task 4) can
 *      register it in the install manifest as kind `"other"`.
 *   3. Spawn `npm install --omit=dev --no-save --no-audit --no-fund <packageSpec>`
 *      in that directory. `stdio` for stdout is inherited so users see npm
 *      progress; stderr is teed (forwarded to `process.stderr` and captured
 *      in-memory) so this module can classify failures into a stable error
 *      taxonomy without losing the user-visible feedback.
 *
 * Always uses `npm` regardless of the project's package manager — PLAN §2 picks
 * npm to guarantee a flat `node_modules/` layout (pnpm's symlink farm would
 * confuse Node's ESM resolver inside `.claude/skills/lint/`).
 *
 * `--dry-run` returns `{ ok: true, stubCreated: null, runtimePath }` without
 * writing the stub or spawning npm — used by `qualy install --dry-run`.
 *
 * The CLI runs `npm` directly via `spawn(npmBin, [...args], { cwd })`. Args
 * are passed as an array (no shell interpolation), so a malicious
 * `packageSpec` like `'foo; rm -rf /'` is handed to npm verbatim and rejected
 * by npm itself rather than executed by the shell. The caller is still
 * expected to validate `packageSpec` against the `@hgflima/qualy@<semver>`
 * shape (TASKS Task 3 critério #6 — defense in depth, but the validation
 * itself lives at the call site).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MaterializeRuntimeArgs = {
  /** Scope root. Function joins `skills/lint/` internally. */
  readonly target: string;
  /** Spec passed to `npm install` (e.g. `@hgflima/qualy@0.3.4`). */
  readonly packageSpec: string;
  readonly dryRun: boolean;
  /** Test seam — defaults to a real `npm install` spawn. */
  readonly runNpmInstall?: RunNpmInstall;
};

export type MaterializeRuntimeOk = {
  readonly ok: true;
  /**
   * Relative path (from `target`) of the stub `package.json` we wrote, or
   * `null` if a `package.json` was already present (or `dryRun`).
   */
  readonly stubCreated: string | null;
  /** Absolute path to `${target}/skills/lint/`. */
  readonly runtimePath: string;
};

export type MaterializeRuntimeErrCode =
  | "EQUALY_INSTALL_NETWORK"
  | "EQUALY_INSTALL_FS"
  | "EQUALY_INSTALL_UNKNOWN";

export type MaterializeRuntimeErr = {
  readonly ok: false;
  readonly error: MaterializeRuntimeErrCode;
  readonly reason: string;
};

export type MaterializeRuntimeResult =
  | MaterializeRuntimeOk
  | MaterializeRuntimeErr;

export type NpmInstallOutcome = {
  /** Process exit code (`null` if killed before exit). */
  readonly code: number | null;
  /** stderr captured during the run (also forwarded to `process.stderr`). */
  readonly stderr: string;
  /** Spawn-level errors (e.g. `ENOENT` when `npm` is not on PATH). */
  readonly spawnError?: NodeJS.ErrnoException;
};

export type RunNpmInstall = (input: {
  readonly cwd: string;
  readonly packageSpec: string;
}) => Promise<NpmInstallOutcome>;

const STUB_PACKAGE_JSON = `${JSON.stringify(
  { name: "qualy-runtime", private: true },
  null,
  2,
)}\n`;

export async function materializeRuntime(
  args: MaterializeRuntimeArgs,
): Promise<MaterializeRuntimeResult> {
  const runtimePath = join(args.target, "skills", "lint");

  if (args.dryRun) {
    return { ok: true, stubCreated: null, runtimePath };
  }

  try {
    mkdirSync(runtimePath, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: "EQUALY_INSTALL_FS",
      reason: `cannot create ${runtimePath}: ${(err as Error).message}`,
    };
  }

  const stubAbs = join(runtimePath, "package.json");
  let stubCreated: string | null = null;
  if (!existsSync(stubAbs)) {
    try {
      writeFileSync(stubAbs, STUB_PACKAGE_JSON, "utf8");
      stubCreated = join("skills", "lint", "package.json");
    } catch (err) {
      return {
        ok: false,
        error: "EQUALY_INSTALL_FS",
        reason: `cannot write ${stubAbs}: ${(err as Error).message}`,
      };
    }
  }

  const run = args.runNpmInstall ?? defaultRunNpmInstall;
  const outcome = await run({
    cwd: runtimePath,
    packageSpec: args.packageSpec,
  });

  if (outcome.spawnError !== undefined) {
    if (outcome.spawnError.code === "ENOENT") {
      return {
        ok: false,
        error: "EQUALY_INSTALL_UNKNOWN",
        reason: "npm CLI not found on PATH",
      };
    }
    return {
      ok: false,
      error: classifyErrnoToError(outcome.spawnError.code),
      reason: outcome.spawnError.message,
    };
  }

  if (outcome.code !== 0) {
    const stderr = outcome.stderr;
    return {
      ok: false,
      error: classifyStderrToError(stderr),
      reason:
        stderr.trim() ||
        `npm install exited with code ${String(outcome.code)}`,
    };
  }

  return { ok: true, stubCreated, runtimePath };
}

function classifyErrnoToError(
  code: string | undefined,
): MaterializeRuntimeErrCode {
  if (code === undefined) return "EQUALY_INSTALL_UNKNOWN";
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOSPC" ||
    code === "EROFS"
  ) {
    return "EQUALY_INSTALL_FS";
  }
  return "EQUALY_INSTALL_UNKNOWN";
}

function classifyStderrToError(stderr: string): MaterializeRuntimeErrCode {
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/.test(stderr)) {
    return "EQUALY_INSTALL_NETWORK";
  }
  if (/E401|E403|ENEEDAUTH|registry/i.test(stderr)) {
    return "EQUALY_INSTALL_NETWORK";
  }
  if (/EACCES|EPERM|ENOSPC|EROFS/.test(stderr)) {
    return "EQUALY_INSTALL_FS";
  }
  return "EQUALY_INSTALL_UNKNOWN";
}

const defaultRunNpmInstall: RunNpmInstall = (input) =>
  new Promise<NpmInstallOutcome>((resolve) => {
    let stderr = "";
    let resolved = false;

    const finish = (outcome: NpmInstallOutcome): void => {
      if (resolved) return;
      resolved = true;
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "npm",
        [
          "install",
          "--omit=dev",
          "--no-save",
          "--no-audit",
          "--no-fund",
          input.packageSpec,
        ],
        { cwd: input.cwd, stdio: ["ignore", "inherit", "pipe"] },
      );
    } catch (err) {
      finish({
        code: null,
        stderr: "",
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }

    child.stderr?.on("data", (d: Buffer | string) => {
      const s = String(d);
      stderr += s;
      process.stderr.write(s);
    });
    child.on("error", (err) => {
      finish({
        code: null,
        stderr,
        spawnError: err as NodeJS.ErrnoException,
      });
    });
    child.on("exit", (code) => {
      finish({ code, stderr });
    });
  });
