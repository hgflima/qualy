/**
 * qualy coverage preset · runner=vitest · stage=brownfield · generated=2026-05-03
 *
 * Partial vitest config carrying coverage thresholds calibrated for brownfield
 * (moderate) projects per SPEC §3 (Estratégia de coverage). Consumed by
 * `install-coverage`: the threshold values are extracted via ts-morph and
 * merged into the target project's existing `vitest.config.ts`. Provider is
 * `v8` to match the `@vitest/coverage-v8` package installed by `install-deps`.
 *
 * Brownfield: pragmatic targets — meaningful but not aspirational; coverage
 * grows incrementally as legacy paths get covered.
 * Drift between this file and the SPEC §3 table is locked by
 * `cli/tests/unit/presets-coverage.test.ts`.
 */
export default {
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
} as const;
