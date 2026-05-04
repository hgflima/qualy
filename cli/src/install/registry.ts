/**
 * `npm view @hgflima/qualy version` wrapper used by `qualy update` (TASKS 2.3 + SPEC §3).
 *
 * `fetchLatestVersion()` returns a discriminated result so the caller can map
 * each registry failure mode to a user-facing message without juggling errno
 * strings. The actual `npm view` invocation is hidden behind a `RunNpmView`
 * test seam — unit tests inject a fake outcome instead of spawning a real
 * `npm` process. Defaults to a 5s timeout enforced by `setTimeout` + `kill`
 * (no AbortController on the child — `kill` is portable across Node versions
 * and survives `child_process.spawn`'s narrow signal support).
 *
 * Error mapping (TASKS 2.3 — keep stable, the 4 error kinds drive UX in
 * `update.ts`):
 *
 *   - stderr matches `/E401|E403|ENEEDAUTH/`        → `auth`
 *   - stderr matches `/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/` or `timedOut`
 *                                                    → `network`
 *   - stdout empty, `null`, or non-semver           → `mirror`
 *   - any other non-zero exit                       → `unknown`
 */
import { spawn } from "node:child_process";

export type RegistryFetchErrKind = "network" | "auth" | "mirror" | "unknown";

export type RegistryFetchOk = { readonly ok: true; readonly version: string };

export type RegistryFetchErr = {
  readonly ok: false;
  readonly kind: RegistryFetchErrKind;
  readonly message: string;
};

export type RegistryFetchResult = RegistryFetchOk | RegistryFetchErr;

export type NpmViewOutcome = {
  /** Process exit code (`null` if killed before exit). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Spawn-level errors (e.g. `ENOENT` when `npm` is not on PATH). */
  readonly spawnError?: NodeJS.ErrnoException;
};

export type RunNpmView = (input: {
  readonly timeoutMs: number;
}) => Promise<NpmViewOutcome>;

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

export async function fetchLatestVersion(opts: {
  readonly timeoutMs: number;
  readonly runNpmView?: RunNpmView;
}): Promise<RegistryFetchResult> {
  const run = opts.runNpmView ?? defaultRunNpmView;
  const r = await run({ timeoutMs: opts.timeoutMs });

  if (r.spawnError !== undefined) {
    if (r.spawnError.code === "ENOENT") {
      return {
        ok: false,
        kind: "network",
        message: "npm CLI not found on PATH",
      };
    }
    return { ok: false, kind: "unknown", message: r.spawnError.message };
  }

  if (r.timedOut) {
    return {
      ok: false,
      kind: "network",
      message: `npm view timed out after ${opts.timeoutMs}ms`,
    };
  }

  const stderr = r.stderr;
  if (/E401|E403|ENEEDAUTH/.test(stderr)) {
    return {
      ok: false,
      kind: "auth",
      message: stderr.trim() || "registry rejected request",
    };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(stderr)) {
    return {
      ok: false,
      kind: "network",
      message: stderr.trim() || "network error reaching registry",
    };
  }

  if (r.code !== 0) {
    return {
      ok: false,
      kind: "unknown",
      message:
        stderr.trim() || `npm view exited with code ${String(r.code)}`,
    };
  }

  const out = r.stdout.trim();
  if (out === "" || out === "null" || !SEMVER_RE.test(out)) {
    return {
      ok: false,
      kind: "mirror",
      message:
        out === ""
          ? "registry returned empty output"
          : `registry returned non-semver: ${out}`,
    };
  }
  return { ok: true, version: out };
}

const defaultRunNpmView: RunNpmView = (input) =>
  new Promise<NpmViewOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let resolved = false;

    const finish = (outcome: NpmViewOutcome): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("npm", ["view", "@hgflima/qualy", "version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        spawnError: err as NodeJS.ErrnoException,
      });
    });
    child.on("exit", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
