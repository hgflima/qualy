# Fixture: `greenfield-ts/`

Synthetic project that represents the **greenfield** end of the qualy stage spectrum (SPEC §3, §5 T1, §7.1).

## Shape

- 5 TypeScript source files under `src/`, all `.ts`, plain Node-targeted code, no framework.
- Single minimal `package.json` with no `dependencies` / `devDependencies`. No linter, no formatter, no test runner declared.
- 420 LOC total across `src/*.ts` (counted with `wc -l` semantics, matching `detect-stage` LOC counter — see `cli/src/commands/detect-stage.ts:140`).

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests that need a working tree materialize the fixture into a temp directory and run:

```sh
git init -q
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: greenfield-ts"
```

The materialization helper belongs to a later task (`tests/fixtures/_materialize.ts`); this file documents the contract so the helper, when added, has a single source of truth.

## Expected detector output

After materialization with **one commit dated "now"**:

### `detect-stack` (SPEC §1)

```jsonc
{
  "supported": true,
  "extensions": { "ts": 5, "tsx": 0, "js": 0, "jsx": 0 },
  "blockers": []
}
```

Exit code: `OK` (0).

### `detect-existing-linter` (SPEC §1.2)

```jsonc
{
  "linters": [],
  "formatters": []
}
```

Exit code: `OK` (0).

### `detect-test-runner` (SPEC §3)

```jsonc
{
  "runner": null,
  "candidates": { "vitest": { /* empty */ }, "jest": { /* empty */ } },
  "coverage": {
    "configured": false,
    "current_thresholds": null,
    "current_values": null,
    "source": null
  }
}
```

Exit code: `OK` (0).

### `git-clean-check`

```jsonc
{ "clean": true, "dirty_files": [] }
```

Exit code: `OK` (0).

### `detect-stage` (SPEC §3 — primary acceptance)

```jsonc
{
  "stage": "greenfield",
  "signals": {
    "first_commit_date": "<ISO of materialization commit>",
    "age_days": 0,
    "source_files": 5,
    "loc": 420,
    "churn_90d": 1,
    "has_tests": false,
    "todo_count": 0,
    "todo_density_per_100_loc": 0,
    "linter_present": false
  },
  "reasoning": "..."
}
```

Classification rationale: `age_days < 183` AND `loc < 5000` AND `linter_present === false` ⇒ **greenfield**.

Exit code: `OK` (0).

### `status`

`stage.detected === "greenfield"`, `coverage.runner === null`, `theme === "linear-design-md"`, no presets, no hooks. Exit code: `OK` (0).

## What this fixture intentionally does NOT include

- Any test file or test runner config — exercises the "no tests" path of `detect-test-runner` and `detect-stage`.
- Any `TODO`/`FIXME`/`HACK` comments — exercises `todo_density_per_100_loc === 0`.
- Any linter / formatter config or dep — exercises the greenfield gate (`linter_present === false`).
- A `.git/` checked into the parent repo — see "materialization" above.
