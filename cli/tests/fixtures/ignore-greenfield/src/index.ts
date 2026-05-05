/** Clean module — no violations. Coexists with `src/legacy/old-module.ts`
 *  to demonstrate that `qualy ignore-add 'src/legacy/**'` only silences the
 *  legacy slice, leaving the rest of `src/` linted as usual. */
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
