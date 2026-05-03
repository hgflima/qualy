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
 * Scope is intentionally narrow for now — `cli/tests/e2e/` is added in Fase 7.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["cli/tests/unit/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
