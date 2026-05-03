# Fixture: `brownfield-eslint-prettier/`

Synthetic project that represents the **brownfield** end of the qualy stage spectrum (SPEC §3, §5 T1, §7.2). Models the realistic case where a TypeScript codebase already runs ESLint + Prettier and `/lint:setup` must offer to back them up before replacing them with the oxc stack.

## Shape

- 8 TypeScript source files under `src/`, all `.ts`, plain Node-targeted code, no framework.
- `package.json` declares `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint-config-prettier`, `prettier`, and `typescript` as `devDependencies`. No `dependencies`. No test runner.
- `.eslintrc.json` (legacy ESLint config) at the root, extending `eslint:recommended`, `@typescript-eslint/recommended`, and `prettier`.
- `.prettierrc.json` at the root.
- 5071 LOC total across `src/*.ts` (counted with `wc -l` semantics, matching `detect-stage` LOC counter — see `cli/src/commands/detect-stage.ts:140`). Deliberately above the 5000 LOC greenfield ceiling so classification cannot collapse to greenfield even if `linter_present` evidence were ignored.

Zero `TODO` / `FIXME` / `HACK` markers in any source file: keeps `todo_density_per_100_loc === 0`, isolating the brownfield classification to the linter signal (and LOC margin) rather than mixing in the legacy TODO trigger.

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests that need a working tree materialize the fixture into a temp directory and run:

```sh
git init -q
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: brownfield-eslint-prettier"
```

The materialization helper belongs to a later task (`tests/fixtures/_materialize.ts`); this file documents the contract so the helper, when added, has a single source of truth.

## Expected detector output

After materialization with **one commit dated "now"**:

### `detect-stack` (SPEC §1)

```jsonc
{
  "supported": true,
  "extensions": { "ts": 8, "tsx": 0, "js": 0, "jsx": 0 },
  "blockers": []
}
```

Exit code: `OK` (0).

### `detect-existing-linter` (SPEC §1.2 — primary acceptance for this fixture)

```jsonc
{
  "linters": [
    { "name": "eslint", "configs": [".eslintrc.json"], "pkg_dep": true }
  ],
  "formatters": [
    { "name": "prettier", "configs": [".prettierrc.json"], "pkg_dep": true }
  ]
}
```

Exit code: `OK` (0). This is the signal that drives the `lint-migrator` flow in `/lint:setup` (SPEC §1.2 — backup nomeado em `.lint-backup/<timestamp>/` antes de substituir).

Notes on what is intentionally omitted:

- `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` are not in `pkgNames` for `eslint` (catalogue only matches the root `eslint` package), so they bump the same `pkg_dep` flag to `true` indirectly only via the presence of `eslint` itself.
- `eslint-config-prettier` is irrelevant to detection — it is just a config preset, not a linter/formatter binary, and is not in any `pkgNames` list.
- No `package.json#eslintConfig` or `package.json#prettier` inline configs are declared, so neither virtual `package.json#<key>` entry appears in `configs`.

### `detect-test-runner` (SPEC §3)

```jsonc
{
  "runner": "none",
  "candidates": {
    "vitest": { /* configs: [], pkg_dep: false */ },
    "jest":   { /* configs: [], pkg_dep: false */ }
  },
  "coverage": {
    "configured": false,
    "current_thresholds": null,
    "current_values": null,
    "source": null
  }
}
```

Exit code: `OK` (0). No test runner deps, no `vitest.config.*`, no `jest.config.*`, no `package.json#vitest`/`#jest` inline configs.

### `git-clean-check`

```jsonc
{ "clean": true, "dirty_files": [] }
```

Exit code: `OK` (0). True only after the materialization commit; before `git add -A` + commit, the tree is dirty by definition.

### `detect-stage` (SPEC §3 — primary acceptance)

```jsonc
{
  "stage": "brownfield-moderate",
  "signals": {
    "first_commit_date": "<ISO of materialization commit>",
    "age_days": 0,
    "source_files": 8,
    "loc": 5071,
    "churn_90d": 1,
    "has_tests": false,
    "todo_count": 0,
    "todo_density_per_100_loc": 0,
    "linter_present": true
  },
  "reasoning": "default classification (LOC 5071 not < 5000; prior linter present; age 0d not > 1095d)"
}
```

Classification rationale:

- Greenfield rule fails on **two** independent grounds: `loc=5071 ≥ 5000` (LOC ceiling) AND `linter_present=true`. Either alone disqualifies greenfield.
- Legacy rule fails on `age_days=0 ≤ 1095` (age floor).
- Falls through to `brownfield-moderate`.

Exit code: `OK` (0).

### `status`

```jsonc
{
  "ok": true,
  "stage": { "detected": "brownfield-moderate", /* ... */ },
  "coverage": { "runner": "none", "configured": false, /* ... */ },
  "presets": { "fast": false, "deep": false },
  "hooks": { /* all probes report not-installed */ },
  "theme": "linear-design-md"
}
```

Exit code: `OK` (0). Theme falls back to the SPEC §4 default because no `.lint-manifest.json` exists yet — qualy has not been installed in this fixture.

## What this fixture intentionally does NOT include

- Any test file, test runner config, or test runner dep — exercises the "no tests" path of `detect-test-runner` and `detect-stage` while still classifying as brownfield (linter signal is sufficient).
- Any `TODO` / `FIXME` / `HACK` comments — exercises `todo_density_per_100_loc === 0` so the brownfield verdict is not contaminated by the legacy TODO-density trigger.
- Any qualy artifact (`oxlint.fast.json`, `.claude/hooks/`, `.lint-manifest.json`, etc.) — fixture represents the **pre-`/lint:setup`** state.
- A `.git/` checked into the parent repo — see "materialization" above.
- ESLint **flat config** (`eslint.config.js`) — fixture deliberately uses the legacy `.eslintrc.json` form to exercise that branch of `detect-existing-linter`. A flat-config sibling fixture can be added later if needed.
- Biome / dprint configs — those formatter detection paths are covered by unit tests, not by a dedicated fixture.
