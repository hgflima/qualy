# Fixture: `legacy-monorepo/`

Synthetic project that represents the **legacy** end of the qualy stage spectrum (SPEC §3, §5 T1, §7.11). Models a multi-package pnpm monorepo with the cruft typical of a 3-year-old codebase: scattered `TODO`/`FIXME`/`HACK` markers, no test setup, no linter. Doubles as the **performance budget** fixture for `lint-auditor` (SPEC §7.11 — must run < 30s on 10k+ LOC).

## Shape

- pnpm workspace at the root: `pnpm-workspace.yaml` declares `packages/*`; root `package.json` is `private`, `packageManager: "pnpm@9.12.0"`.
- 3 packages under `packages/`:
  - `@legacy-monorepo/auth` — `index.ts` (barrel) + `jwt.ts`, `session.ts`, `permissions.ts`.
  - `@legacy-monorepo/core` — `index.ts` (barrel) + `store.ts`, `events.ts`, `scheduler.ts`, `cache.ts`.
  - `@legacy-monorepo/api` — `index.ts` (barrel) + `router.ts`, `handlers.ts`, `middleware.ts`. Declares workspace deps on `@legacy-monorepo/auth` and `@legacy-monorepo/core`.
- 13 TypeScript source files total (3 barrels + 10 implementation modules), all `.ts`.
- 11468 LOC total (counted with `wc -l` semantics, matching `cli/src/commands/detect-stage.ts:140`). Above the 10k LOC threshold of SPEC §7.11.
- 164 `TODO`/`FIXME`/`HACK` markers spread across the implementation modules. Density 1.43 / 100 LOC, deliberately above the 1.0 threshold so the legacy classification fires via the TODO trigger (SPEC §3).
- **No** test runner config, **no** linter / formatter config, **no** dependencies in any `package.json` (besides workspace links). The fixture represents pre-`/lint:setup` state for a project that never adopted a quality toolchain.

## What the synthetic source looks like

Each non-barrel module follows the same template:

- A header comment block referencing the package + file + module kind + TODO budget.
- 4 `export interface <File>Record000N` declarations (Record 1..4), all structurally identical — these inflate the LOC count realistically without introducing nominal type drift.
- An `export class <File>Manager` with ~30 mutator methods (each ~15 LOC) that maintain an `index: Map<string, ...>` and an append-only history buffer.
- 25 `export function <file>HelperNN` pure helpers performing arithmetic accumulation with traces.

The code is deliberately repetitive — it is **not** runtime-exercised; the fixture only needs to look plausible to the detectors, which read bytes (LOC, `\b(TODO|FIXME|HACK)\b` matches, file extensions). Fixtures are excluded from typecheck (`cli/tsconfig.json#exclude`) and from vitest (`vitest.config.ts#test.include`), so type-level coherence is not enforced.

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests that need a working tree materialize the fixture into a temp directory via `cli/tests/fixtures/_materialize.ts`, which runs:

```sh
git init -q --initial-branch=main
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: legacy-monorepo"
```

with `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` defaulting to `2025-01-01T00:00:00Z` (single deterministic commit).

**Churn caveat.** SPEC §5 T1 describes the fixture as having "churn alto via commits sintéticos". The current `_materialize.ts` produces a single root commit, so `churn_90d` is `0` against this fixture. Multi-commit synthetic history is deferred — when added, it should extend `_materialize.ts` rather than ship a pre-built `.git/` (the latter would still be untrackable inside the parent repo). Tests that specifically need to exercise the churn signal can either (a) inject a custom git runner via `setGitRunner`, or (b) drive synthetic commits in the materialized temp dir before running the detector.

## Expected detector output

After materialization with the default commit date `2025-01-01T00:00:00Z`:

### `detect-stack` (SPEC §1)

```jsonc
{
  "supported": true,
  "extensions": { "ts": 13, "tsx": 0, "js": 0, "jsx": 0 },
  "blockers": []
}
```

Exit code: `OK` (0). All 13 source files are `.ts`; no `pyproject.toml`/`go.mod`/`Cargo.toml`/`Vue|Svelte` blockers.

### `detect-existing-linter` (SPEC §1.2)

```jsonc
{ "linters": [], "formatters": [] }
```

Exit code: `OK` (0). No `.eslintrc*`, no `.prettierrc*`, no `biome.json`, no `dprint.json`, no `package.json#eslintConfig` / `#prettier`, no linter/formatter packages declared anywhere in the workspace. This fixture exercises the "nothing to migrate" branch of the `lint-migrator` flow.

### `detect-test-runner` (SPEC §3)

```jsonc
{
  "runner": "none",
  "candidates": {
    "vitest": { "configs": [], "pkg_dep": false, "thresholds": null, "thresholds_source": null },
    "jest":   { "configs": [], "pkg_dep": false, "thresholds": null, "thresholds_source": null }
  },
  "coverage": {
    "configured": false,
    "current_thresholds": null,
    "current_values": null,
    "source": null
  }
}
```

Exit code: `OK` (0). No vitest/jest configs anywhere in the workspace, no test deps. The "no tests" branch of the legacy classification rule fires from this signal alone (see `detect-stage` below).

### `git-clean-check`

```jsonc
{ "clean": true, "dirty_files": [] }
```

Exit code: `OK` (0). True only after the materialization commit; before `git add -A` + commit, the tree is dirty by definition.

### `detect-stage` (SPEC §3 — primary acceptance for this fixture)

The classification depends on the `now` reference passed to the detector. Two scenarios are documented:

#### Scenario A — `now` equals the commit date (default for unit tests)

```jsonc
{
  "stage": "brownfield-moderate",
  "signals": {
    "first_commit_date": "2025-01-01T00:00:00.000Z",
    "age_days": 0,
    "source_files": 13,
    "loc": 11468,
    "churn_90d": 0,
    "has_tests": false,
    "todo_count": 164,
    "todo_density_per_100_loc": 1.4300662713637948,
    "linter_present": false
  },
  "reasoning": "default classification (LOC 11468 not < 5000; age 0d not > 1095d)"
}
```

Falls through to brownfield because:
- Greenfield rule fails on `loc=11468 ≥ 5000` (LOC ceiling).
- Legacy rule fails on `age_days=0 ≤ 1095` (age floor).

#### Scenario B — `now` injected ≥ 1095 days after commit (legacy classification)

Pass e.g. `now: () => new Date("2029-02-09T00:00:00Z")` (≥ 1500 days after commit) to drive the legacy verdict:

```jsonc
{
  "stage": "legacy",
  "signals": {
    "first_commit_date": "2025-01-01T00:00:00.000Z",
    "age_days": 1500,
    "source_files": 13,
    "loc": 11468,
    "churn_90d": 0,
    "has_tests": false,
    "todo_count": 164,
    "todo_density_per_100_loc": 1.4300662713637948,
    "linter_present": false
  },
  "reasoning": "age 1500d > 1095d AND (TODO/HACK density 1.43 > 1/100 LOC OR no tests detected)"
}
```

Both legacy disjuncts fire (TODO density 1.43 > 1.0 **and** `has_tests=false`); either alone is sufficient. LOC is `11468`, below the 50k LOC disjunct, so the LOC trigger does **not** fire — kept this way deliberately so the LOC threshold remains exercisable by a future, larger fixture.

Exit code: `OK` (0).

### `status` (Scenario B — legacy)

```jsonc
{
  "ok": true,
  "stage": { "detected": "legacy", /* ...mirrors detect-stage Scenario B... */ },
  "coverage": { "runner": "none", "configured": false /* ... */ },
  "presets": { "fast": false, "deep": false },
  "hooks": { /* all probes report not-installed */ },
  "theme": "linear-design-md"
}
```

Exit code: `OK` (0). Theme falls back to the SPEC §4 default because no `.lint-manifest.json` exists yet — qualy has not been installed in this fixture.

## What this fixture intentionally does NOT include

- Any test file, test runner config, or test runner dep — the "no tests" branch of `detect-stage` is the primary trigger for the legacy classification here.
- Any linter / formatter config or dep — keeps `linter_present=false`, meaning the legacy verdict is never accidentally inherited from a brownfield linter signal.
- Any qualy artifact (`oxlint.fast.json`, `.claude/hooks/`, `.lint-manifest.json`, `docs/lint-decisions.md`, etc.) — fixture represents the **pre-`/lint:setup`** state.
- A `.git/` checked into the parent repo — see "materialization" above.
- Multi-commit history — see "Churn caveat" above. The fixture name says "churn alto via commits sintéticos"; the current materialization helper produces one commit. The TODO-density and no-tests legacy triggers are sufficient to satisfy SPEC §3 without simulated churn.
- Real workspace tooling (TS project references, build scripts, `tsconfig.json` per package). The fixture is not buildable — it exists for byte-level detector probes and the lint-auditor performance budget, not for runtime execution.
