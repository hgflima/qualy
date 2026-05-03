/**
 * Root vitest config (PLAN.md §Verification).
 *
 * Single test runner for the whole repo, rooted at `cli/tests/unit/**`. The
 * suite imports CLI sources directly (`../../src/lib/...`) and runs without a
 * build step (Node ≥ 22.6 + `--experimental-strip-types`; see ADR 0007).
 *
 * Why root, not `cli/`: PLAN explicitly puts the config at the workspace root
 * so the harness `.md` files and CI invoke `vitest` from one place. The
 * `cli/package.json` `test` script delegates here.
 *
 * Scope: unit suites under `cli/tests/unit/**` and the harness-orchestration
 * e2e suites under `cli/tests/e2e/**`. The latter materialize fixtures (cp +
 * `git init` + commit) and exercise install-* layers against real on-disk
 * trees, so they pay the round-trip cost; today's set is small enough that
 * the combined backpressure suite still runs in a few seconds.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cli/tests/unit/**/*.test.ts", "cli/tests/e2e/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
