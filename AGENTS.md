# Operational Learnings

This file contains project-specific guidance Ralph has learned through observation.

Start minimal. Add entries only when Ralph exhibits repeated failures or needs specific guidance that is not derivable from the code or specs.

## Project Layout

- Specs (source of truth): `.harn/docs/mvp/SPEC.md`, `.harn/docs/mvp/PLAN.md`
- Application source: `src/`
- Implementation plan (Ralph-managed): `IMPLEMENTATION_PLAN.md`

## Build / Test Commands

Stack: Node.js / TypeScript. Package manager will be detected from the lockfile at runtime (bun → pnpm → yarn → npm).

Validation suite per iteration:
- typecheck (`tsc --noEmit` or equivalent)
- lint (eslint / biome / oxlint)
- tests (vitest / jest)
- build

All four must pass before commit.

## Known Patterns

(empty — populate as patterns emerge)

## Constraints

- Repo uses npm workspaces (`"workspaces": ["cli"]` in root `package.json`).
  Single lockfile at the root; do NOT recreate `cli/package-lock.json`. Run
  `npm install` from the root to install everything (vitest/typescript hoist
  to root `node_modules/`; cli-only deps stay under `cli/node_modules/` only
  if npm decides not to hoist them). Validation suite from the root:
  - `npm run typecheck` (delegates to `@qualy/cli` workspace → `tsc --noEmit`)
  - `npm test` (root `vitest run` against `cli/tests/unit/**`)
  - `npm run lint` / `npm run build` are still placeholder echoes until the
    relevant phases land.
