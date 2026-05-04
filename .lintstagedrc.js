/**
 * qualy · lint-staged config (example) · pre-commit pipeline
 *
 * Copy or symlink as `.lintstagedrc.js` (or merge into an existing
 * `lint-staged` config) so `.husky/pre-commit` runs three steps on
 * staged source files:
 *
 *   1. `oxfmt --write`                        — format in place
 *   2. `oxlint --config oxlint.fast.json`     — correctness + suspicious
 *   3. `oxlint --config oxlint.deep.json`     — quality-metrics (slower)
 *
 * Ordering invariant (SPEC §4): fast tier runs BEFORE deep tier so cheap
 * rule violations fail the commit immediately and the deep tier (which
 * loads `quality-metrics` + `ts-morph` and is materially slower) only
 * runs against files that already passed the fast pass.
 *
 * lint-staged appends the staged file paths to each command, so each
 * line above is invoked once with the survivors of the glob filter.
 *
 * Requires the project to opt into ES modules (`"type": "module"` in
 * `package.json`) — if the project is CommonJS, rename to
 * `.lintstagedrc.mjs` instead.
 *
 * @see https://github.com/lint-staged/lint-staged
 */
export default {
  "*.{ts,tsx,js,jsx}": [
    "oxfmt --write",
    "oxlint --config oxlint.fast.json",
    "oxlint --config oxlint.deep.json",
  ],
};
