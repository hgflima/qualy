/**
 * Per-fixture CLI snapshot suite (PLAN.md §Verification line 283 + IMPLEMENTATION_PLAN.md
 * §Fase 7 line 137).
 *
 * For every fixture under `cli/tests/fixtures/<name>/`, this suite:
 *   1. Materializes the blueprint (cp + `git init` + deterministic commit).
 *   2. Spawns the CLI binary (`node --experimental-strip-types cli/src/index.ts <sub>`)
 *      for each deterministic detector and captures its single stdout JSON document.
 *   3. Normalizes any cwd (the materialized temp path) to the literal `<cwd>`
 *      placeholder so snapshots are stable across runs and machines.
 *   4. Compares the normalized payload against the fixture's versioned
 *      `EXPECTED.json`.
 *
 * Why subprocess (not direct function calls): the existing e2e suites
 * (`setup-greenfield.test.ts` etc.) call install-* functions directly to keep
 * orchestration tests fast. This suite intentionally exercises the dispatcher
 * argv parsing + JSON stdout serialization end-to-end — regressions in either
 * surface would slip past the function-level e2e tests.
 *
 * Why only deterministic detectors (`detect-stack`, `detect-existing-linter`,
 * `detect-test-runner`, `git-clean-check`): the time-sensitive detectors
 * (`detect-stage`, `status`) have `age_days` / `churn_90d` / `current_thresholds`
 * fields that depend on `Date.now()` and on a working tree mutated mid-run by
 * other tests; they are covered by `detectors-fixtures.test.ts` which injects
 * `now` via the function-level seam.
 *
 * Update workflow: when intentionally changing CLI output shape, regenerate the
 * EXPECTED.json files with `QUALY_E2E_UPDATE=1 npm run test:e2e`. Diff the
 * resulting JSON files in the PR — drift is reviewable.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeFixture } from "../fixtures/_materialize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "..", "src", "index.ts");
const FIXTURES_ROOT = resolve(HERE, "..", "fixtures");

const UPDATE_MODE = process.env["QUALY_E2E_UPDATE"] === "1";

/**
 * Detectors covered. Each runs against every fixture's materialized cwd.
 *
 * Order is the same as `commands/lint/setup.md` enumerates them so a diff in
 * one detector is visually adjacent to the others.
 */
const SUBCOMMANDS = [
  "detect-stack",
  "detect-existing-linter",
  "detect-test-runner",
  "git-clean-check",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const FIXTURES: ReadonlyArray<string> = [
  "greenfield-ts",
  "brownfield-eslint-prettier",
  "jest-with-coverage",
  "legacy-monorepo",
  "unsupported-python",
];

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(sub: Subcommand, cwd: string): CliResult {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI_PATH, sub, "--cwd", cwd],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Replace any occurrence of the materialized temp path with `<cwd>` so the
 * snapshot is stable. Walks the JSON value recursively because some detectors
 * embed the path inside nested fields.
 */
function normalizeCwd<T>(value: T, cwd: string): T {
  if (typeof value === "string") {
    return (value === cwd ? "<cwd>" : value.split(cwd).join("<cwd>")) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeCwd(v, cwd)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeCwd(v, cwd);
    }
    return out as unknown as T;
  }
  return value;
}

interface ExpectedDoc {
  [sub: string]: {
    readonly exitCode: number;
    readonly stdout: unknown;
  };
}

function expectedPath(fixture: string): string {
  return join(FIXTURES_ROOT, fixture, "EXPECTED.json");
}

function loadExpected(fixture: string): ExpectedDoc | null {
  const p = expectedPath(fixture);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw) as ExpectedDoc;
}

function writeExpected(fixture: string, doc: ExpectedDoc): void {
  writeFileSync(expectedPath(fixture), JSON.stringify(doc, null, 2) + "\n", "utf8");
}

describe("fixture CLI snapshots", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) try { fn(); } catch { /* ignore */ }
    }
  });

  for (const fixture of FIXTURES) {
    describe(fixture, () => {
      it("matches EXPECTED.json for every deterministic detector", () => {
        const fx = materializeFixture(fixture);
        cleanups.push(fx.cleanup);

        const observed: ExpectedDoc = {};
        for (const sub of SUBCOMMANDS) {
          const r = runCli(sub, fx.dir);
          let parsed: unknown;
          try {
            parsed = JSON.parse(r.stdout);
          } catch (err) {
            throw new Error(
              `[${fixture}] ${sub}: stdout was not valid JSON\n` +
                `exit=${r.exitCode}\nstdout=${r.stdout}\nstderr=${r.stderr}\nparse_error=${String(err)}`,
            );
          }
          observed[sub] = {
            exitCode: r.exitCode,
            stdout: normalizeCwd(parsed, fx.dir),
          };
        }

        if (UPDATE_MODE) {
          writeExpected(fixture, observed);
          return;
        }

        const expected = loadExpected(fixture);
        if (!expected) {
          throw new Error(
            `[${fixture}] EXPECTED.json missing. Run with QUALY_E2E_UPDATE=1 to bootstrap.`,
          );
        }

        // Per-subcommand assert so the failure message names the offender.
        for (const sub of SUBCOMMANDS) {
          expect(observed[sub], `[${fixture}] ${sub}`).toEqual(expected[sub]);
        }
      });
    });
  }
});
