/**
 * qualy coverage preset · runner=vitest · stage=greenfield · generated=2026-05-03
 *
 * Partial vitest config carrying coverage thresholds calibrated for greenfield
 * projects per SPEC §3 (Estratégia de coverage). Consumed by `install-coverage`:
 * the threshold values are extracted via ts-morph and merged into the target
 * project's existing `vitest.config.ts`. Provider is `v8` to match the
 * `@vitest/coverage-v8` package installed by `install-deps`.
 *
 * Greenfield: high coverage targets — code is new, tests should ship with it.
 * Drift between this file and the SPEC §3 table is locked by
 * `cli/tests/unit/presets-coverage.test.ts`.
 */
export default {
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
} as const;
