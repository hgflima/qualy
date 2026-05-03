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

- `vitest.config.ts` lives at the repo root but `vitest` is only installed in
  `cli/node_modules/`, so `npx vitest` from either root or `cli/` fails to load
  the config (`Cannot find package 'vitest'`). Until vitest is hoisted (root
  devDep or workspaces), unit tests must be invoked through the cli prefix in
  a way that resolves both the binary and the package — current root scripts
  remain placeholder `echo` stubs that exit 0 (per Priority 1 task in
  `IMPLEMENTATION_PLAN.md`). Validate Phase 0 work by running the dispatcher
  directly: `node --experimental-strip-types cli/src/index.ts --help` plus
  `npm run typecheck --prefix cli`.
