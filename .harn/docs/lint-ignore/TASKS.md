# TASKS — `lint-ignore`

Checklist executável derivado de `PLAN.md`. Marque conforme avança. Cada task é S (≤3 arquivos, ~1h) ou M (≤5 arquivos, ~2h).

**SPEC:** `./SPEC.md` · **PLAN:** `./PLAN.md`

---

## Phase 1 — Foundation (chassis)

- [x] **1.1 — `lib/paths.ts`** · S
  - Exports `DECISION_LOG_PATH`, `LEGACY_DECISION_LOG_PATH`, `IGNORE_MANIFEST_PATH`, `PRESET_PATHS`, `IGNORE_MARKER_START`, `IGNORE_MARKER_END`
  - Verify: `npx vitest run cli/tests/unit/paths.test.ts`

- [x] **1.2 — Extrair `lib/decision-log.ts`** · M
  - Mover `ENTRIES_START/END`, `loadOrInitDecisions`, `insertEntryBetweenMarkers`, `formatDecisionEntry` de `recs/apply.ts` (~454,487) e `rules/add.ts` (~565,582)
  - Generalizar `formatDecisionEntry({ timestamp, kind, fields, reason })` para 8 kinds
  - UPDATE imports em `rules/add.ts`, `rules/remove.ts`, `recs/apply.ts` (sem mudança de comportamento)
  - Verify: `npx vitest run cli/tests/unit/{decision-log,recs-apply,rules-add,rules-remove}.test.ts`
  - Deps: 1.1

- [x] **1.3 — `lib/decision-log-migration.ts`** · M
  - `migrateDecisionLogIfNeeded(cwd, deps)` com 5 estados (tracked/untracked/conflict/só-novo/nenhum)
  - DI: `existsFn`, `gitMvFn`, `mvFn`, `mkdirFn`, `writeFn`, `readFn`, `now`
  - Manifest entry `kind: "decisions"` para uninstall — registrado pelo próximo `safeWriteFile` em rules/recs/ignore (ADR existing)
  - Verify: `npx vitest run cli/tests/unit/decision-log-migration.test.ts`
  - Deps: 1.1, 1.2

- [ ] **1.4 — Wire migração nos 3 entry-points** · S
  - Chamar `migrateDecisionLogIfNeeded(cwd)` antes de `loadOrInitDecisions` em `rules/add.ts`, `rules/remove.ts`, `recs/apply.ts`
  - Substituir `DECISIONS_REL` hardcoded por `DECISION_LOG_PATH`
  - Em `decision_log_conflict` → exit `1` com error claro
  - Ajustar fixtures de teste para path novo
  - Verify: `git grep "docs/lint-decisions.md"` só matcha `paths.ts` + `migration.ts`; `npx vitest run cli/tests/unit/{rules-add,rules-remove,recs-apply}.test.ts`
  - Deps: 1.3

- [ ] **1.5 — Refs de slash commands + template** · S
  - Substituir `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` em `commands/lint/rules/{add,remove}.md`, `commands/lint/update.md`, `cli/src/templates/lint-decisions.md.tpl:7`
  - Verify: `grep -rn "docs/lint-decisions.md" commands/` vazio; `npx vitest run cli/tests/unit/{agent-lint-installer-md,command-lint-update-md}.test.ts`
  - Deps: 1.4

### ✅ Checkpoint Phase 1
- [ ] `npx vitest run` 100% verde
- [ ] Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo
- [ ] `.lint-manifest.json` aponta novo path
- [ ] 2ª invocação = no-op idempotente

---

## Phase 2 — Path-only ignore (vertical slice)

- [ ] **2.1 — `lib/ignore-manifest.ts`** · M
  - Tipos `IgnoreEntry`, `IgnoreManifest { version: 1, entries }`
  - `loadIgnoreManifest`, `saveIgnoreManifest` (via `safeWriteFile` kind `"ignore"`), `generateEntryId`, `upsertEntry`, `removeEntries`, `validateGlob`, `validateExpires`, `findExpired`
  - Estender `ManifestEntryKind` em `fs-safe.ts:55` com `"ignore"`
  - Verify: `npx vitest run cli/tests/unit/ignore-manifest.test.ts` (id determinismo, upsert idempotente, expires passada, round-trip)
  - Deps: 1.1, 1.2

- [ ] **2.2 — `lib/ignore-compile.ts` (path-only)** · M
  - `compileToPreset(currentPreset, manifest, opts) → { ok, proposed, changed }` só para `rule === null`
  - Markers + sort por id + idempotente
  - `compileToBothPresets(cwd, manifest, deps)` orquestra fast+deep
  - Verify: `npx vitest run cli/tests/unit/ignore-compile.test.ts`
  - Deps: 2.1, 1.1

- [ ] **2.3 — `commands/ignore/compile.ts`** · S
  - `qualy ignore-compile [--check]`; `--check` → exit `1` se drift
  - Verify: `npx vitest run cli/tests/unit/ignore-compile-cmd.test.ts`
  - Deps: 2.2

- [ ] **2.4 — `commands/ignore/add.ts` (path-only)** · M
  - `qualy ignore-add <glob> --reason <txt> [--expires] [--strict]`
  - Flow: parse → migrate → load → upsert → save → compile → append decision
  - Idempotente (re-add atualiza, kind `ignore-update`)
  - Exit codes: 0 ok / 1 invalid / 2 dirty+strict / 4 usage
  - Verify: `npx vitest run cli/tests/unit/ignore-add.test.ts`
  - Deps: 2.1, 2.2, 2.3, 1.4

- [ ] **2.5 — `commands/ignore/{list,remove,explain}.ts`** · M
  - `list` (`--expired` exit `1`/`0`, `--path`, `--json`)
  - `remove` (mandatory `--reason`, `--rule` para disambiguation; ambíguo → exit `1`)
  - `explain` (entry + history; not-found → exit `1`)
  - Surface aceita `--rule` em todos (semântica plena vem em P3)
  - Verify: `npx vitest run cli/tests/unit/ignore-{list,remove,explain}.test.ts`
  - Deps: 2.1, 2.2, 2.3

- [ ] **2.6 — Wire dispatch em `index.ts`** · S
  - 5 entries em `SUBCOMMAND_LIST` (`:78`) e `HANDLER_OVERRIDES` (`:117`)
  - Verify: `node --experimental-strip-types cli/src/index.ts --help | grep ignore-` (5 linhas)
  - Deps: 2.3, 2.4, 2.5

- [ ] **2.7 — Slash command `/lint:ignore:add` (path-only)** · S
  - Frontmatter + `AskUserQuestion` flow (glob → reason 4 opções → expires)
  - Refuse em stack não-suportado
  - Verify: `npx vitest run cli/tests/unit/command-lint-ignore-add-md.test.ts`
  - Deps: 2.4, 2.6

### ✅ Checkpoint Phase 2
- [ ] `vitest run` verde
- [ ] SPEC §10 acceptance #1 manual ok (greenfield: add → preset markers + manifest + decision log)
- [ ] Re-run idempotente sem entry duplicada

---

## Phase 3 — Per-rule + category + import + slash commands restantes

- [ ] **3.1 — `lib/category-catalog.ts` (estático bundled)** · M
  - `Record<Category, readonly string[]>` para 7 categorias (correctness, suspicious, pedantic, perf, restriction, style, nursery)
  - Smoke test pin contra `node_modules/oxlint` major version
  - Header doc: review trimestral manual
  - Verify: `npx vitest run cli/tests/unit/category-catalog.test.ts`
  - Deps: —

- [ ] **3.2 — Extend `lib/ignore-compile.ts` (overrides + expansion)** · M
  - Entries `rule != null` → `overrides[]`
  - `category:*` expandido via `getCategoryRules`
  - Multiple per-rule mesmo glob → 1 override block agrupado
  - Markers em forma de objeto: `{ files: [], rules: { "_qualy:start_": "off" } }`
  - Verify: `npx vitest run cli/tests/unit/ignore-compile.test.ts` (P2 path-only verdes + novos)
  - Deps: 2.2, 3.1

- [ ] **3.3 — Extend `commands/ignore/add.ts` (`--rule`)** · M
  - Validar `quality-metrics/*` em `KNOWN_RULES`, `category:<name>` em `KNOWN_CATEGORIES`, outros opaque
  - `category:*` sem `--i-know-this-disables-many` → exit `1` `category_requires_ack`
  - `ignore-list` mostra sufixo `⚠ category (N rules)`
  - Verify: `npx vitest run cli/tests/unit/ignore-{add,list}.test.ts`
  - Deps: 3.1, 3.2, 2.4

- [ ] **3.4 — `lib/ignore-import.ts` (brownfield)** · M
  - Detecta non-marker patterns em presets, importa com `createdBy: "imported"`
  - Decision log: 1 batch entry `ignore-import`
  - Hook em `commands/ignore/add.ts` na 1ª mutação (manifest vazio)
  - Skip em invocações subsequentes
  - Verify: `npx vitest run cli/tests/unit/ignore-import.test.ts` (brownfield 3, greenfield 0, pre-managed 0)
  - Deps: 2.1, 2.2

- [ ] **3.5 — Slash commands restantes + flow `category:*` em `add.md`** · M
  - 3 markdowns: `/lint:ignore:{remove,list,explain}`
  - `add.md` estende: `--rule category:*` → `AskUserQuestion` confirma N rules → injeta `--i-know-this-disables-many`
  - Brownfield import threshold ≥5 → `AskUserQuestion` confirma; <5 silencioso
  - `/lint:ignore:remove`: blast radius + `--reason` mandatory via `AskUserQuestion`
  - NEW subcomando `qualy category-info <name>` (read-only) → JSON `{ category, rules, count }`
  - Verify: `npx vitest run cli/tests/unit/command-lint-ignore-{add,remove,list,explain}-md.test.ts`
  - Deps: 3.3, 2.7, 2.5

### ✅ Checkpoint Phase 3
- [ ] SPEC §10 #2 (per-rule), #6 (brownfield import), #9 (re-add update), #10 (category sem ack), #11 (slash + category) verdes
- [ ] Decision log com entries `ignore-add`, `ignore-update`, `ignore-remove`, `ignore-import`

---

## Phase 4 — Polish + e2e

- [ ] **4.1 — Drift check em `audit.ts`** · M
  - `lib/ignore-drift.ts` com `checkDriftAndRecompile(cwd, deps)` via `statSync` mtimes
  - `commands/audit.ts` invoca no topo do pipeline
  - Manifest ausente → no-op
  - Log `ignore_recompile_drift` quando recompila
  - Verify: `npx vitest run cli/tests/unit/{ignore-drift,audit}.test.ts`
  - Deps: 2.2, 3.2

- [ ] **4.2 — Expired warning em `audit`** · S
  - `findExpired` → `logger.warn` stderr + `audit.ignore_warnings: [{ id, glob, expires, days_overdue }]`
  - Nunca bloqueia (SPEC §6)
  - Verify: `npx vitest run cli/tests/unit/audit.test.ts` (fixture com expired entry)
  - Deps: 4.1, 2.1

- [ ] **4.3 — Blast radius helper** · M
  - `commands/ignore/blast-radius.ts` (subcomando `qualy ignore-blast-radius <glob>`)
  - `node:fs.glob` ou `fast-glob`; exclui `node_modules`, `.git`, `dist`, `.harn`, `.lint-audit`, `.lint-backup`
  - Slash commands `/lint:ignore:{add,remove}` consomem antes da confirmação
  - Verify: `npx vitest run cli/tests/unit/ignore-blast-radius.test.ts` + smoke
  - Deps: 2.6

- [ ] **4.4 — Fixtures** · S
  - `cli/tests/fixtures/ignore-greenfield/` (clean)
  - `cli/tests/fixtures/ignore-brownfield/` (preset com `ignorePatterns: ["src/old/**"]` fora dos markers)
  - `cli/tests/fixtures/ignore-expired/` (manifest pré-populado com expired)
  - Cada um: `_materialize.ts` + `package.json` + `tsconfig.json` + `oxlint.fast.json` + sample com violation
  - Verify: `npx vitest run cli/tests/unit/materialize.test.ts`
  - Deps: —

- [ ] **4.5 — `cli/tests/e2e/ignore-flow.test.ts`** · M
  - 12 `it()` blocks, um por SPEC §10 acceptance criterion
  - Verify: `npx vitest run cli/tests/e2e/ignore-flow.test.ts`
  - Deps: 4.1, 4.2, 4.3, 4.4 + todo P2/P3

- [ ] **4.6 — README + CHANGELOG** · S
  - README seção `## Lint Ignore` (3 exemplos: path-only, per-rule, category com confirmação)
  - CHANGELOG entry referenciando SPEC
  - Deps: 4.5

### ✅ Checkpoint Phase 4 (final)
- [ ] 12 acceptance criteria de SPEC §10 verdes em e2e
- [ ] `vitest run` 100% pass
- [ ] Perf: `qualy lint` overhead ≤50ms em repo sem manifest
- [ ] README + CHANGELOG atualizados

---

## SPEC §10 acceptance criteria — tracker direto

- [ ] #1 — `qualy ignore-add 'src/legacy/**' --reason x` cria entrada, recompila, lint passa em arquivo do glob
- [ ] #2 — `--rule quality-metrics/wmc` desabilita só essa rule; outras ainda disparam no path
- [ ] #3 — `qualy ignore-list` mostra status (active/expired) correto
- [ ] #4 — `--expired` exit `1` com vencidas, `0` sem
- [ ] #5 — Entrada vencida → warning stderr em `lint`/`audit`, exclusão ainda ativa
- [ ] #6 — Brownfield import na 1ª mutação com `createdBy: "imported"`
- [ ] #7 — `/lint:ignore:{add,remove,list,explain}` end-to-end via slash command harness
- [ ] #8 — Dirty + `--strict` → exit `2` com mensagem `git stash`
- [ ] #9 — Re-add idempotente (atualiza in-place, `ignore-update`)
- [ ] #10 — `category:*` sem `--i-know-this-disables-many` → exit `1` com tamanho da categoria
- [ ] #11 — Slash command com `category:*` lista N rules + `AskUserQuestion`
- [ ] #12 — Drift: edit manual em `ignore.json` recompila no próximo `lint`; sem mudança pula
- [ ] (extra) Migração one-time `docs/lint-decisions.md` → `.harn/qualy/docs/`; conflict → exit `1`
