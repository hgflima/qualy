# Fixture: `ignore-greenfield/`

Synthetic project that represents the **starting point of the lint-ignore happy path** (lint-ignore SPEC §10 #1, #9). The oxlint stack is already installed (both `oxlint.fast.json` and `oxlint.deep.json` exist), but `.harn/qualy/ignore.json` does not — every `qualy ignore-*` command runs against a clean manifest.

## Shape

- 2 TypeScript source files:
  - `src/index.ts` — clean code (no violations).
  - `src/legacy/old-module.ts` — uses `debugger;` so `correctness/no-debugger` flags it under the greenfield preset.
- `package.json` declares `oxlint` and `typescript` as `devDependencies` (no runtime deps, no test runner).
- `tsconfig.json` minimal strict configuration.
- `oxlint.fast.json` + `oxlint.deep.json` — byte-for-byte the greenfield preset templates (no qualy markers, no `ignorePatterns`, no `overrides`).
- **No** `.harn/qualy/ignore.json` — the manifest is greenfield.
- **No** `.harn/qualy/docs/lint-decisions.md` — created by the first mutation.

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests materialize the fixture into a temp directory via `cli/tests/fixtures/_materialize.ts`, which runs:

```sh
git init -q --initial-branch=main
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: ignore-greenfield"
```

## Use cases

This fixture exercises:

- **SPEC §10 #1** — `qualy ignore-add 'src/legacy/**' --reason …` creates the manifest, recompiles both presets with `_qualy:start_ … _qualy:end_` markers, oxlint passes on `src/legacy/old-module.ts`.
- **SPEC §10 #9** — re-running the same `ignore-add` is idempotent: `action: "updated"`, manifest still has 1 entry with the same id, decision log gains an `ignore-update` entry.
- **SPEC §10 #2** — `qualy ignore-add 'src/legacy/**' --rule quality-metrics/wmc --reason …` lands in `overrides[]` instead of `ignorePatterns[]`.

## What this fixture intentionally does NOT include

- Any pre-existing `ignorePatterns` outside markers — that is the `ignore-brownfield/` fixture's job.
- Any `.harn/qualy/ignore.json` — that is the `ignore-expired/` fixture's job.
- A test runner / coverage config — irrelevant to ignore semantics.
- A `.git/` checked into the parent repo — see "materialization" above.
