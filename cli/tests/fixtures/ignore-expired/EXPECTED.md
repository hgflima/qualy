# Fixture: `ignore-expired/`

Synthetic project where `.harn/qualy/ignore.json` is pre-populated with **one expired entry** (lint-ignore SPEC §10 #5, T4.2). Exercises the `qualy audit` expired-warning path.

## Shape

- `package.json` declares `oxlint` and `typescript` as `devDependencies`.
- `tsconfig.json` minimal strict configuration.
- `oxlint.fast.json` + `oxlint.deep.json` — pre-compiled state with `_qualy:start_ … _qualy:end_` markers wrapping `src/legacy/**` (matches what `compileToBothPresets` would produce after `ignore-add`).
- `.harn/qualy/ignore.json` — manifest version 1 with **one** entry:
  ```json
  {
    "id": "ign-19160e",
    "glob": "src/legacy/**",
    "rule": null,
    "reason": "Legacy module slated for rewrite — temporarily silenced during the migration.",
    "expires": "2025-06-01",
    "createdAt": "2024-12-01T00:00:00.000Z",
    "createdBy": "user"
  }
  ```
  - `id` matches `generateEntryId("src/legacy/**", null)` → `ign-19160e`. Test must not hardcode it elsewhere; recompute via the helper if shape changes.
  - `expires: "2025-06-01"` is well before the project clock (current date: 2026-05-05) → `findExpired` always classifies it as expired in CI/dev.
- `src/legacy/old-module.ts` — body uses `debugger;` so the ignore is observably load-bearing.
- `src/index.ts` — clean code outside the ignored slice.

## `.git` materialization

This fixture cannot ship with a nested `.git/`. Tests materialize via `cli/tests/fixtures/_materialize.ts`:

```sh
git init -q --initial-branch=main
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: ignore-expired"
```

`.harn/qualy/ignore.json` is committed at materialization time so the manifest is part of the working tree from t=0 — no `--strict` dirty-tree gate will fire.

## Use cases

- **SPEC §10 #5 / T4.2** — `qualy audit` in this tree emits a `logger.warn("ignore_expired", { id: "ign-19160e", glob: "src/legacy/**", expires: "2025-06-01", days_overdue: <int> })` to stderr AND populates `AuditOk.ignore_warnings = [{ id, glob, expires, days_overdue }]`. `result.ok` stays `true` (warnings never break audit).
- **T4.1 drift gate** — manifest mtime ≤ preset mtime at materialization, so the drift check is a no-op (`presets_fresh`). Tests that want to force a recompile should `touch` the manifest after materialization.
- **`qualy ignore-list --expired`** — exits `1` with the expired entry; `qualy ignore-list` (no flag) shows status `expired` for `ign-19160e`.

## What this fixture intentionally does NOT include

- Any active (non-expired) entry — keeps the surface narrow so `findExpired` returns exactly one item.
- A `quality-metrics`-flagged entry — the per-rule path is exercised by other unit-level fixtures (in-memory). The expired warning is tier-agnostic.
- Manual edits between manifest mtime and preset mtimes — drift is a separate concern (T4.1) and tests that need it should manipulate timestamps post-materialization rather than baking them in.
- A `.git/` checked into the parent repo — see "materialization" above.
