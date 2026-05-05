/**
 * Sample file under `src/legacy/**` (intentionally violates oxlint rules) —
 * exists so tests can call `qualy ignore-add 'src/legacy/**' --reason …` and
 * verify the glob matches a real file. The body uses `debugger;` (caught by
 * `correctness/no-debugger`) so when the ignore is active oxlint passes, and
 * when removed oxlint surfaces the violation.
 */
export function legacyEntry(value: number): number {
  debugger;
  return value;
}
