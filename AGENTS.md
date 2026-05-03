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

- `cli/package.json` pins `chartjs-plugin-treemap@^3.1.0`, which 404s on the npm
  registry. Until the version is corrected (or the dep moved to a later phase
  that actually needs it — Fase 6 / report), `npm install --prefix cli` fails
  end-to-end and `tsc`/`vitest` cannot be run from disk. Until then, validate
  Phase 0 work by running the dispatcher directly:
  `node --experimental-strip-types cli/src/index.ts --help` and the
  package-level placeholder scripts (`npm run typecheck|lint|test|build`).
