/**
 * Sample under `src/old/**` — intentionally violates oxlint rules so the
 * pre-existing `ignorePatterns: ["src/old/**"]` is observably load-bearing.
 * `debugger;` triggers `correctness/no-debugger` if the ignore is dropped.
 */
export function legacyHandler(value: number): number {
  debugger;
  return value * 2;
}
