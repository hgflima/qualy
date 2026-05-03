# Fixture: `jest-with-coverage/`

Synthetic TypeScript project with **Jest already configured** and an **existing coverage threshold** (`coverageThreshold.global.lines = 60`). Anchors SPEC §7.3 acceptance: "Detecta Jest + coverage threshold existente (ex: lines 60). Mostra valor atual e o default do estágio detectado, pergunta qual usar." — i.e. `/lint:setup` MUST surface the existing threshold so the user can keep, replace, or customize it.

## Shape

- 3 TypeScript source files under `src/` (`index.ts`, `math.ts`, `string-utils.ts`).
- 1 TypeScript test file under `__tests__/` (`math.test.ts`).
- 1 CommonJS Jest config at the root (`jest.config.js`) with `coverageThreshold.global.lines: 60`.
- `package.json` declares `jest`, `ts-jest`, `@types/jest`, and `typescript` in `devDependencies`. No `dependencies`. No ESLint / Prettier / Biome / dprint configs or deps.
- 130 LOC total across the 4 `.ts` files + the `.js` config file (counted with `wc -l` semantics — `\n` characters per file — matching the `detect-stage` LOC counter at `cli/src/commands/detect-stage.ts:140`).

Zero `TODO` / `FIXME` / `HACK` markers, so `todo_density_per_100_loc === 0` and the brownfield/legacy classifications are not contaminated by unrelated triggers.

The fixture deliberately uses **CommonJS** (`module.exports = ...`) for `jest.config.js` and omits `"type": "module"` from `package.json`: that is the realistic Jest brownfield shape, and it exercises the JS-config text-regex branch of `detect-test-runner` (`readThresholdsFromText`), as opposed to the JSON-parse branch used for `jest.config.json` or `package.json#jest`.

## `.git` materialization

This fixture cannot ship with a nested `.git/` (the parent qualy repo would refuse to track it). Tests that need a working tree materialize the fixture into a temp directory via `cli/tests/fixtures/_materialize.ts`:

```ts
const fx = materializeFixture("jest-with-coverage");
// → fx.dir is a fresh temp dir with a single deterministic commit
// → cleanup with fx.cleanup()
```

## Expected detector output

After materialization with **one commit dated `2025-01-01T00:00:00Z`** (the helper default) and `now` injected as the same instant (so `age_days === 0`):

### `detect-stack` (SPEC §1)

```jsonc
{
  "supported": true,
  "extensions": { "ts": 4, "tsx": 0, "js": 1, "jsx": 0 },
  "blockers": []
}
```

The `js: 1` count is `jest.config.js` itself; the four `.ts` files are the three sources plus the `__tests__/math.test.ts`. Exit code: `OK` (0).

### `detect-existing-linter` (SPEC §1.2)

```jsonc
{
  "linters": [],
  "formatters": []
}
```

Jest is intentionally not in the linter/formatter catalogue — it's a test runner, surfaced only by `detect-test-runner`. Exit code: `OK` (0).

### `detect-test-runner` (SPEC §3 — primary acceptance for this fixture)

```jsonc
{
  "runner": "jest",
  "candidates": {
    "vitest": { "configs": [], "pkg_dep": false, "thresholds": null, "thresholds_source": null },
    "jest": {
      "configs": ["jest.config.js"],
      "pkg_dep": true,
      "thresholds": { "lines": 60, "functions": null, "branches": null, "statements": null },
      "thresholds_source": "jest.config.js"
    }
  },
  "coverage": {
    "configured": true,
    "current_thresholds": { "lines": 60, "functions": null, "branches": null, "statements": null },
    "current_values": null,
    "source": "jest.config.js"
  }
}
```

Threshold extraction path: `jest.config.js` is read as text (does not end in `.json`), `readThresholdsFromText` finds the `coverageThreshold` and `global` container keys, and within the 600-char window after each container picks up `lines: 60`. The other three keys (`functions`, `branches`, `statements`) stay `null` because the fixture only sets `lines`.

Exit code: `OK` (0). This is the signal that drives the "keep / adopt stage default / custom" prompt in the future `commands/lint/setup.md` (SPEC §7.3 — "preserva escolha do usuário").

### `git-clean-check`

```jsonc
{ "clean": true, "dirty_files": [] }
```

Exit code: `OK` (0). True only after the materialization commit; before `git add -A` + commit, the tree is dirty by definition.

### `detect-stage` (SPEC §3)

```jsonc
{
  "stage": "greenfield",
  "signals": {
    "first_commit_date": "2025-01-01T00:00:00.000Z",
    "age_days": 0,
    "source_files": 5,
    "loc": 130,
    "churn_90d": 1,
    "has_tests": true,
    "todo_count": 0,
    "todo_density_per_100_loc": 0,
    "linter_present": false
  },
  "reasoning": "age 0d < 183d AND LOC 130 < 5000 AND no prior linter"
}
```

Classification rationale: `age_days < 183` AND `loc < 5000` AND `linter_present === false` ⇒ **greenfield**. Jest does not count as a "linter" (not in the `detect-existing-linter` catalogue), so its presence does NOT push the project to brownfield. `has_tests: true` is set both by the `__tests__/` dir probe and by `detect-test-runner` returning `jest` — either signal alone would suffice.

Exit code: `OK` (0).

### `status`

```jsonc
{
  "ok": true,
  "stage": { "detected": "greenfield", /* ... */ },
  "coverage": {
    "runner": "jest",
    "configured": true,
    "current_thresholds": { "lines": 60, "functions": null, "branches": null, "statements": null },
    "source": "jest.config.js"
  },
  "presets": { "fast": false, "deep": false },
  "hooks": { /* all probes report not-installed */ },
  "theme": "linear-design-md"
}
```

Exit code: `OK` (0). Theme falls back to the SPEC §4 default because no `.lint-manifest.json` exists yet — qualy has not been installed in this fixture.

## What this fixture intentionally does NOT include

- Any ESLint / Prettier / Biome / dprint config or dep — keeps `linter_present === false` so stage stays at `greenfield`. The point of the fixture is to isolate the Jest + threshold-preservation branch, not the lint-replacement branch (that's `brownfield-eslint-prettier/`).
- Any `vitest.config.*`, `vite.config.*`, or `vitest` dep — exercises the unambiguous Jest-wins branch of `detect-test-runner`'s `pickRunner`.
- A `jest.config.ts` or `jest.config.json` variant — those threshold-extraction branches (text-regex on TS source, JSON parse on JSON config) live in `detect-test-runner.test.ts`, not in a dedicated fixture.
- A `package.json#jest` inline config — same rationale; covered by unit tests.
- Per-glob `coverageThreshold` entries (e.g. `"./src/**"`) — v1 of `detect-test-runner` only surfaces `coverageThreshold.global` (see `cli/src/commands/detect-test-runner.ts:225`).
- Any qualy artifact (`oxlint.fast.json`, `.claude/hooks/`, `.lint-manifest.json`, etc.) — fixture represents the **pre-`/lint:setup`** state.
- A `.git/` checked into the parent repo — see "materialization" above.
