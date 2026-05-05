/** Clean module — no violations. The brownfield case has user-authored
 *  `ignorePatterns: ["src/old/**"]` in the oxlint preset (outside qualy
 *  markers); the first `qualy ignore-*` mutation must import that pattern
 *  into `.harn/qualy/ignore.json` with `createdBy: "imported"`. */
export function add(a: number, b: number): number {
  return a + b;
}
