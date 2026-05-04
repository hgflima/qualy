/**
 * Root vitest config (PLAN.md §Verification).
 *
 * Single test runner for the whole repo. Discovers both the unit suites under
 * `cli/tests/unit/**` and the e2e suites under `cli/tests/e2e/**`; the
 * `package.json` scripts narrow the run via positional path filters:
 *   - `npm test`         → `vitest run cli/tests/unit`
 *   - `npm run test:e2e` → `vitest run cli/tests/e2e`
 * Combined cycles (`npm test && npm run test:e2e`) keep the two tiers
 * independently bisectable while still sharing one config + one node_modules.
 *
 * The suite imports CLI sources directly (`../../src/lib/...`) and runs without
 * a build step (Node ≥ 22.6 + `--experimental-strip-types`; see ADR 0007).
 *
 * Why root, not `cli/`: PLAN explicitly puts the config at the workspace root
 * so the harness `.md` files and CI invoke `vitest` from one place. The
 * `cli/package.json` test scripts delegate up to the root via `npm --prefix ..`.
 *
 * E2e suites materialize fixtures (cp + `git init` + commit) and exercise the
 * install-* layers / dispatcher subprocess against real on-disk trees, so they
 * pay the round-trip cost; today's set still runs in well under a minute.
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
      coverage: {
          provider: "v8",
          reporter: ["text", "json", "json-summary", "html"],
          thresholds: {
              lines: 70,
              functions: 70,
              branches: 60,
              statements: 70
        }
    }
},
});
