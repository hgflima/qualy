# Fixture: `unsupported-python/`

Synthetic Python project that represents the **unsupported stack** refusal path (SPEC §1, §5 T1, §7.4). Models the case where a user invokes `/lint:setup` against a non-TS/JS project and the skill must refuse immediately with a clear message — no writes to the project.

## Shape

- `pyproject.toml` at the root (PEP 518/621, hatchling build backend) — this is the language marker that `detect-stack` matches against `UNSUPPORTED_MARKERS` (see `cli/src/commands/detect-stack.ts:44`).
- 3 Python source files under `src/unsupported_python/` (`__init__.py`, `main.py`, `utils.py`). They are present only for shape realism — `detect-stack` counts only `.ts/.tsx/.js/.jsx` (`SUPPORTED_FILE_EXTS` in `cli/src/commands/detect-stack.ts:61`), so the `.py` files do not appear in `signals`.
- No `package.json`. No `.git/` (see materialization below). No linter, formatter, or test runner config — irrelevant here, since `detect-stack` already rejects the project before any of those run in `/lint:setup`.

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests that need a working tree materialize the fixture into a temp directory and run:

```sh
git init -q
git add -A
git -c user.email=fixture@qualy.local -c user.name=fixture commit -q -m "fixture: unsupported-python"
```

The materialization helper belongs to a later task (`tests/fixtures/_materialize.ts`); this file documents the contract so the helper, when added, has a single source of truth.

## Expected detector output

After materialization with **one commit dated "now"**:

### `detect-stack` (SPEC §1 — primary acceptance for this fixture)

```jsonc
{
  "ok": true,
  "supported": false,
  "signals": {
    "tsFiles": 0,
    "tsxFiles": 0,
    "jsFiles": 0,
    "jsxFiles": 0,
    "hasPackageJson": false,
    "vueFiles": 0,
    "svelteFiles": 0
  },
  "blockers": [
    { "kind": "python", "file": "pyproject.toml" }
  ],
  "supportedLanguages": []
}
```

Exit code: `UNSUPPORTED_STACK` (2).

This is the signal that `/lint:setup` reads to abort with the standard "stack não suportada" message (SPEC §6: "Sempre detectar a stack antes de qualquer escrita; se incompatível com oxc, recusar com mensagem explícita listando o que oxc suporta"). The skill MUST NOT write any file to the project after observing exit `2` from `detect-stack`.

Notes on what is intentionally omitted from `blockers`:

- `setup.py` and `Pipfile` are also Python markers in `UNSUPPORTED_MARKERS`, but only `pyproject.toml` is present in this fixture (modern Python convention). Multi-marker variants belong to unit tests, not a dedicated fixture.

### `detect-existing-linter` (SPEC §1.2)

```jsonc
{ "linters": [], "formatters": [] }
```

Exit code: `OK` (0). No JS/TS linter or formatter could possibly be configured in a Python-only project — the catalogue (`eslint`, `prettier`, `biome`, `dprint`) only matches JS/TS tooling.

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

Exit code: `OK` (0). Same reason as `detect-existing-linter` — the catalogue only knows about JS/TS test runners. Python test runners (pytest, unittest) are out of scope for v1 (SPEC §1).

### `git-clean-check`

```jsonc
{ "clean": true, "dirty_files": [] }
```

Exit code: `OK` (0). True only after the materialization commit; before `git add -A` + commit, the tree is dirty by definition.

### `detect-stage` (SPEC §3)

This detector is **not the gate** for this fixture (`detect-stack` rejects first). For completeness, if a caller bypassed the gate and ran `detect-stage` anyway, it would classify as **greenfield**:

```jsonc
{
  "stage": "greenfield",
  "signals": {
    "first_commit_date": "<ISO of materialization commit>",
    "age_days": 0,
    "source_files": 0,
    "loc": 0,
    "churn_90d": 1,
    "has_tests": false,
    "todo_count": 0,
    "todo_density_per_100_loc": null,
    "linter_present": false
  },
  "reasoning": "age 0d < 183d AND LOC 0 < 5000 AND no prior linter"
}
```

Classification rationale (informational only — gate is `detect-stack`):

- `lsFilesByExt` returns 0 files (counts only `.ts/.tsx/.js/.jsx`); the `.py` files are invisible to it.
- `loc=0` ⇒ `todo_density_per_100_loc=null` (`scan.loc > 0 ? ... : null`, see `cli/src/commands/detect-stage.ts:286`).
- All three greenfield conditions hold (age, LOC, no linter), so the rule fires.

Exit code: `OK` (0).

### `status`

`stage.detected === "greenfield"` (per the above), `coverage.runner === "none"`, `theme === "linear-design-md"`, no presets, no hooks. Exit code: `OK` (0).

## What this fixture intentionally does NOT include

- A `package.json` — exercises the `hasPackageJson: false` path of `detect-stack`.
- Any `.ts/.tsx/.js/.jsx` file — exercises the "zero supported files" branch of `detect-stack` even before the marker check (the blocker is sufficient on its own, but the fixture proves both signals fire).
- Multiple language markers (e.g. `pyproject.toml` + `Pipfile`) — single-marker case is the realistic baseline; multi-marker is covered by unit tests.
- A `.git/` checked into the parent repo — see "materialization" above.
- Any qualy artifact (`oxlint.fast.json`, `.claude/hooks/`, `.lint-manifest.json`, etc.) — `/lint:setup` is supposed to abort before writing anything; the fixture represents the **pre-refusal** state.
