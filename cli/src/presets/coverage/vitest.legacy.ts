/**
 * qualy coverage preset · runner=vitest · stage=legacy · generated=2026-05-03 · warn-only
 *
 * Partial vitest config carrying coverage thresholds calibrated for legacy
 * projects per SPEC §3 (Estratégia de coverage). Consumed by `install-coverage`:
 * the threshold values are extracted via ts-morph and merged into the target
 * project's existing `vitest.config.ts`. Provider is `v8` to match the
 * `@vitest/coverage-v8` package installed by `install-deps`.
 *
 * Legacy "warn-only" semantics: vitest does not natively distinguish warn vs
 * error on coverage thresholds — it fails the run if values fall below the
 * configured floor. SPEC §3 marks these targets as warn-only because legacy
 * projects often start below them; `install-coverage` is expected to honor
 * that by either (a) writing these values and letting the user override the
 * `--coverage` failure exit, or (b) emitting a soft-check shell wrapper.
 * The `_warnOnly: true` flag is the contract install-coverage reads.
 * Drift between this file and the SPEC §3 table is locked by
 * `cli/tests/unit/presets-coverage.test.ts`.
 */
export default {
  _warnOnly: true,
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40,
      },
    },
  },
} as const;
