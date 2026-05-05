# Fixture: `ignore-brownfield/`

Synthetic brownfield project — oxlint is already installed AND the user has manually authored `"ignorePatterns": ["src/old/**"]` in both `oxlint.fast.json` and `oxlint.deep.json` *outside* qualy markers (lint-ignore SPEC §10 #6, T3.4).

## Shape

- 2 TypeScript source files:
  - `src/index.ts` — clean code.
  - `src/old/legacy.ts` — uses `debugger;` so `correctness/no-debugger` flags it whenever `src/old/**` is not ignored.
- `oxlint.fast.json` and `oxlint.deep.json` — same body as the greenfield preset templates **plus** a top-level `"ignorePatterns": ["src/old/**"]` field. **No** `_qualy:start_` / `_qualy:end_` markers — the pattern is purely user-authored, exactly the brownfield case the import flow needs to recognise.
- **No** `.harn/qualy/ignore.json` — manifest is empty until first mutation triggers import.
- **No** `.harn/qualy/docs/lint-decisions.md` — created by the first mutation, which appends `ignore-import` (one entry per imported pattern) before any `ignore-add` / `ignore-update`.

## `.git` materialization

This fixture cannot ship with a nested `.git/`. Tests materialize via `cli/tests/fixtures/_materialize.ts`:

```sh
git init -q --initial-branch=main
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: ignore-brownfield"
```

## Use cases

- **SPEC §10 #6** — first `qualy ignore-add 'src/foo/**' --reason …` triggers `importBrownfieldIgnores`: the pre-existing `src/old/**` becomes a manifest entry with `createdBy: "imported"`, `reason: IMPORT_REASON`, deterministic id `ign-…`. Both presets are rewritten so the pattern lives **inside** `_qualy:start_/end_` markers and is no longer duplicated outside.
- **`qualy ignore-import-preview`** — read-only mode reports `manifest_empty: true`, `would_import: [{ glob: "src/old/**", tier: "fast" }]`, `count: 1` (dedup across fast+deep — fast wins).
- **Idempotency** — second mutation finds `manifest.entries.length > 0` and skips import; decision log gets only `ignore-add`/`ignore-update`, no second `ignore-import`.

## What this fixture intentionally does NOT include

- A `_qualy:start_` block in either preset — that would mean qualy already manages the manifest, which is a different scenario (greenfield-managed).
- Multiple imported patterns — kept to one for shape clarity. Tests that need ≥5 patterns to exercise the SPEC §8.2 threshold synthesize them in-memory rather than baking them in.
- A `.git/` checked into the parent repo — see "materialization" above.
