# Tasks: tsx-runtime-fix

> Executable checklist derived from [PLAN.md](./PLAN.md) and [SPEC.md](./SPEC.md).
> Mark items as you complete them. Do not skip checkpoints.

## Phase 1 — Runtime Fix

### Task 1: package.json — engines + tsx dep + build noop message

- [x] Add `"tsx": "^4.19.0"` to `dependencies` in root `package.json`
- [x] Change `engines.node` from `">=22.6.0"` to `">=20.0.0"`
- [x] Update `scripts.build` echo string: replace strip-types reference with tsx wording (still noop, exit 0)
- [x] Run `npm install` — confirms no engine warning and `node_modules/tsx/` appears

### Task 2: bin/qualy.mjs — rewrite shim to use tsx

- [x] Add `import { createRequire } from "node:module";`
- [x] Resolve tsx CLI: `const tsxBin = createRequire(import.meta.url).resolve("tsx/cli");`
- [x] Replace spawn args from `["--experimental-strip-types", entry, ...rest]` to `[tsxBin, entry, ...rest]`
- [x] Update header comment to explain the `node_modules/` strip-types barrier (the **why**)
- [x] Keep exit/signal forwarding logic byte-identical
- [x] Verify locally: `./bin/qualy.mjs --version` prints `0.1.0` exit 0
- [x] Verify: `grep -c experimental-strip-types bin/qualy.mjs` returns `0`

### ✅ Checkpoint A — Manual Smoke Post-Install

- [x] `npm pack` in REPO_ROOT → produces `hgflima-qualy-0.1.0.tgz`
- [x] In `mktemp -d`: `npm init -y && npm install /abs/path/hgflima-qualy-0.1.0.tgz`
- [x] `./node_modules/.bin/qualy --version` exits 0 with version on stdout, **no** `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on stderr
- [x] In another `mktemp -d` with `git init`: same install, then `./node_modules/.bin/qualy install --scope local --dry-run` exits 0 with non-empty stdout

→ If any of the above fails, return to Task 2 before proceeding.

---

## Phase 2 — Lock the Regression

### Task 3: cli/tests/e2e/install/installed-tarball.test.ts — new e2e

- [x] Create file `cli/tests/e2e/install/installed-tarball.test.ts`
- [x] `beforeAll`: run `npm pack` once, store tarball path; create tmp project (`mkdtempSync`) with `npm init -y && npm install <tarball>`
- [x] `beforeAll` (second): create tmp git repo with `git init` + same install, for the install-cmd test
- [x] Set `process.env.npm_config_cache` to a tmp path so vitest parallel runs don't fight over `~/.npm`
- [x] Test 1: `./node_modules/.bin/qualy --version` exits 0, stdout matches `/^\d+\.\d+\.\d+/`
- [x] Test 2: `./node_modules/.bin/qualy install --scope local --dry-run` in git repo exits 0, stdout contains expected plan marker (e.g., `"dry_run": true` from JSON)
- [x] Test 2: assert stderr does **not** contain `ERR_UNSUPPORTED`
- [x] `afterAll`: rm -rf both tmpdirs and tarball
- [x] Run `npx vitest run cli/tests/e2e/install/installed-tarball.test.ts` → green
- [x] Sanity reverse: `git stash` Task 2, re-run new suite → must fail with strip-types error; `git stash pop` and reconfirm pass

### ✅ Checkpoint B — Suite Green + Snapshot Sane

- [x] `npm test` (unit) passes
- [x] `npm run test:e2e` passes with 33+ tests (32 prior + ≥1 new suite)
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm pack --dry-run` produces tarball with no `cli/dist/`, no `node_modules/tsx/`, no build artifacts
- [x] `pack-contents.test.ts.snap` did **not** regress (zero diff expected — files: list unchanged)

→ If snapshot regressed unexpectedly, pause and investigate before `--update`.

---

## Phase 3 — Documental Coherence

### Task 4: ADRs

#### Task 4a: Create docs/adrs/0011-tsx-runtime.md

- [x] Header: title `# ADR 0011 — tsx as TS runtime` (or equivalent), `Status: aceito`, `Data: 2026-05-05`, `Relacionados: ADR 0007 (superseded), ADR 0010 D3 (amended)`
- [x] Section: **Contexto** — cite the bug `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, explain that Node refuses to strip types under `node_modules/` by design
- [x] Section: **Decisão** — tsx via spawn, resolved by `createRequire(import.meta.url).resolve("tsx/cli")`, no fallback
- [x] Section: **Consequências** — what changes vs ADR 0007 (drops strip-types, adds tsx ~1MB to deps), vs ADR 0010 D3 (same shim, different runtime)
- [x] Section: **Alternativas consideradas** — bundle via esbuild (rejected — violates "no build step"), strip-types workaround (none exists), Node version bump (doesn't resolve, by design)
- [x] Section: **Verificação** — points to `installed-tarball.test.ts` + manual smoke

#### Task 4b: Update docs/adrs/0007-runtime-ts-strip-types.md

- [x] Add header line: `- Status: superseded by ADR 0011 (2026-05-05)`
- [x] Preserve all historical content as-is (no rewrites)

#### Task 4c: Update docs/adrs/0010-npm-distribution.md

- [x] Add cross-link note in `### D3` section (~2 lines) pointing to ADR 0011
- [x] No other content changes

#### Verify Task 4 cluster

- [x] `grep -l "0011" docs/adrs/*.md` lists 3 files
- [x] `grep "superseded by ADR 0011" docs/adrs/0007-runtime-ts-strip-types.md` returns 1 line

### Task 5: .harn/docs/npx-installer/SPEC.md §8 — rename + new criterion

- [x] Replace 4 literal `qualy` → `@hgflima/qualy` occurrences in §8 (the package-name ones — verify with `grep -n` before/after)
- [x] Add new bullet to §8: `- [ ] Binário publicado executa pós-`npm install` em projeto limpo (cli/tests/e2e/install/installed-tarball.test.ts).`
- [x] No edits outside §8

#### Verify Task 5

- [x] `grep -c '@hgflima/qualy' .harn/docs/npx-installer/SPEC.md` increased by ≥4
- [x] `grep installed-tarball .harn/docs/npx-installer/SPEC.md` returns ≥1 line

### Task 6: CHANGELOG.md — [Unreleased] entry

- [x] Under `## [Unreleased]`, add `### Changed` (or `### Fixed`) sub-section
- [x] Bullet covers: runtime swap (`--experimental-strip-types` → `tsx`), engines drop to `>=20.0.0`, link to ADR 0011, bug-fix mention (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for installed packages)
- [x] Match Keep a Changelog 1.1.0 tone of existing entries

#### Verify Task 6

- [x] `grep -A 5 '## \[Unreleased\]' CHANGELOG.md` shows the new entry
- [x] Markdown renders cleanly

---

## ✅ Checkpoint C — Success Criteria Sweep (SPEC §9)

Walk through every criterion from SPEC §9 and confirm each:

- [x] `bin/qualy.mjs` resolves via `createRequire(import.meta.url).resolve("tsx/cli")`
- [x] `package.json` lists `"tsx": "^4.19.0"` in `dependencies`
- [x] `engines.node` = `">=20.0.0"`
- [x] `npm install` + `./node_modules/.bin/qualy --version` → exit 0, no `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`
- [x] `cli/tests/e2e/install/installed-tarball.test.ts` exists and passes
- [x] `npm test` and `npm run test:e2e` both green
- [x] `npm pack --dry-run` → no `cli/dist/`, no `node_modules/tsx/`, no build artifacts
- [x] `docs/adrs/0011-tsx-runtime.md` exists with full structure
- [x] `docs/adrs/0007-runtime-ts-strip-types.md` has `superseded by ADR 0011` line
- [x] `docs/adrs/0010-npm-distribution.md` D3 cross-links to ADR 0011
- [x] `.harn/docs/npx-installer/SPEC.md` §8: 4 `qualy` → `@hgflima/qualy` + new criterion
- [x] `CHANGELOG.md` `[Unreleased]` documents the runtime change
- [x] Manual smoke: `npm pack` → `cd $(mktemp -d) && npm init -y && npm install <tgz> && ./node_modules/.bin/qualy install --scope local --dry-run` → exit 0 in git repo

→ All 13 must be green before marking the spec delivered.

---

## Out of Scope (per SPEC §10)

These are deliberately **not** part of this work:

- Decision on republish strategy (`unpublish 0.1.0` vs bump `0.1.1`)
- Migration of CLI assets / project layout
- CLI core refactor or new subcommands
- Updating `actions/checkout@v4` / `setup-node@v4` in `publish.yml`
- Renaming the package back to unscoped `qualy`
