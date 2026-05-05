# TASKS — `lint-ignore`

Checklist executável derivado de `PLAN.md`. Marque conforme avança. Cada task é S (≤3 arquivos, ~1h) ou M (≤5 arquivos, ~2h).

**SPEC:** `./SPEC.md` · **PLAN:** `./PLAN.md`

## Cross-cutting decisions (descobertas no gap analysis 2026-05-05)

- **Exit codes vs SPEC:** `cli/src/lib/exit-codes.ts` é canônico. `DIRTY_TREE = 3` (SPEC §3.1 diz "2", desatualizado). `MISSING_DEPENDENCY = 5` (SPEC §3.1 diz "fatal: manifesto corrompido = 5" — usa-se `INTERNAL_ERROR = 70` ao invés). Tasks abaixo seguem o canônico do código; SPEC é upstream e não é editado aqui.
- **Sem `qualy lint`:** `SUBCOMMAND_LIST` não tem `lint`. Drift check + expired warnings (SPEC §10 #5/#12) entram só em `commands/audit.ts`.
- **Node engines `>=20`:** `node:fs.glob` estável só em Node 22 — T4.3 fica em `fast-glob`.
- **Decision-log migration silenciosa (deviation de SPEC §8.2):** SPEC §8.2 diz "Mover `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` … requer confirmação". PLAN T1.3/T1.4 implementaram silenciosa (sem prompt) para paridade com a decisão de "import silencioso até 4 patterns". Conflict (ambos existem) trava com exit `1` — esse é o único ponto que pede ação manual. Documentado aqui para evitar surpresa em revisão. Nenhuma task pendente — desvio aceito.
- **`qualy ignore-*` unwired até T2.6:** `index.ts` não dispatcha nenhum `ignore-*`. Mesmo com T2.3 done, `qualy ignore-compile` não é invocável via CLI hoje. Smoke manual de T2.3 fica bloqueado até T2.6. Os testes unitários de `ignore-compile-cmd.test.ts` continuam verdes pois testam o handler diretamente.
- **Marker discipline em manifest vazio:** `compileToPreset` emite `[_qualy:start_, _qualy:end_]` mesmo com `entries.length === 0` (PLAN T2.2 acceptance). `commands/ignore/compile.ts` evita isso quando manifest **inexistente** (no-op), mas escreve markers vazios quando manifest existe com 0 entries. Comportamento intencional — `ignore.json` nunca é deletado automaticamente (SPEC §6 Never line 363).

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

- [x] **1.4 — Wire migração nos 3 entry-points** · S
  - Chamar `migrateDecisionLogIfNeeded(cwd)` antes de `loadOrInitDecisions` em `rules/add.ts`, `rules/remove.ts`, `recs/apply.ts`
  - Substituir `DECISIONS_REL` hardcoded por `DECISION_LOG_PATH`
  - Em `decision_log_conflict` → exit `1` com error claro
  - Ajustar fixtures de teste para path novo
  - Verify: `git grep "docs/lint-decisions.md"` só matcha `paths.ts` + `migration.ts`; `npx vitest run cli/tests/unit/{rules-add,rules-remove,recs-apply}.test.ts`
  - Deps: 1.3

- [x] **1.5 — Refs de slash commands + template** · S
  - Substituir `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` em `commands/lint/rules/{add,remove}.md`, `commands/lint/update.md`, `cli/src/templates/lint-decisions.md.tpl:7`
  - Verify: `grep -rn "docs/lint-decisions.md" commands/` vazio; `npx vitest run cli/tests/unit/{agent-lint-installer-md,command-lint-update-md}.test.ts`
  - Deps: 1.4

### ✅ Checkpoint Phase 1
- [x] `npx vitest run` 100% verde (2182/2182, re-verificado 2026-05-05)
- [ ] Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo
- [ ] `.lint-manifest.json` aponta novo path
- [ ] 2ª invocação = no-op idempotente

> **Repo state (2026-05-05):** `/Users/henriquelima/dev/personal/qualy/docs/` não contém `lint-decisions.md`. Smoke manual exige criar fixture sintético em scratch repo — não pode ser feito in-tree.

---

## Phase 2 — Path-only ignore (vertical slice)

- [x] **2.1 — `lib/ignore-manifest.ts`** · M
  - Tipos `IgnoreEntry`, `IgnoreManifest { version: 1, entries }`
  - `loadIgnoreManifest`, `saveIgnoreManifest` (via `safeWriteFile` kind `"ignore"`), `generateEntryId`, `upsertEntry`, `removeEntries`, `validateGlob`, `validateExpires`, `findExpired`
  - Estender `ManifestEntryKind` em `fs-safe.ts:55` com `"ignore"`
  - Verify: `npx vitest run cli/tests/unit/ignore-manifest.test.ts` (id determinismo, upsert idempotente, expires passada, round-trip)
  - Deps: 1.1, 1.2

- [x] **2.2 — `lib/ignore-compile.ts` (path-only)** · M
  - `compileToPreset(currentPreset, manifest, opts) → { ok, proposed, changed }` só para `rule === null`
  - Markers + sort por id + idempotente
  - `compileToBothPresets(cwd, manifest, deps)` orquestra fast+deep
  - Verify: `npx vitest run cli/tests/unit/ignore-compile.test.ts`
  - Deps: 2.1, 1.1

- [x] **2.3 — `commands/ignore/compile.ts`** · S
  - `qualy ignore-compile [--check]`; `--check` → exit `1` se drift
  - Verify: `npx vitest run cli/tests/unit/ignore-compile-cmd.test.ts`
  - Deps: 2.2

- [x] **2.4 — `commands/ignore/add.ts` (path-only)** · M
  - `qualy ignore-add <glob> --reason <txt> [--expires] [--strict]`
  - Flow: parse → `migrateDecisionLogIfNeeded` → `loadIgnoreManifest` → `upsertEntry` → `saveIgnoreManifest` → `compileToBothPresets` → `appendDecisionEntry({ kind: "ignore-add" | "ignore-update" })`
  - Idempotente (re-add com mesmo `(glob, rule)` → `action: "updated"`, kind `ignore-update`)
  - Reuso `dirtyFiles` para `--strict` (mirror `rules-add.ts`)
  - **Phase 2 não importa brownfield** — `add.ts` aqui assume manifest greenfield ou pre-managed. Hook de `import-on-first-mutation` é T3.4 (`lib/ignore-import.ts`). Se manifesto vazio em projeto com patterns user-authored em `oxlint.fast.json`, esses patterns são preservados byte-a-byte fora dos markers (compile T2.2 já garante isso). Importação acontece só após T3.4 wirar o hook.
  - **Exit codes (canônicos `EXIT_CODES`):** 0 OK / 1 RECOVERABLE_ERROR (glob inválido, reason ausente, expires no passado) / 3 DIRTY_TREE (dirty + `--strict`) / 4 USAGE_ERROR / 70 INTERNAL_ERROR (manifesto corrompido — ver T2.8). **Nota:** SPEC §3.1 lista "2" para dirty+strict; segue-se a convenção do `exit-codes.ts` (DIRTY_TREE=3), igual a `rules-add` / `rules-remove`. SPEC §10 #8 deve ler "exit `3`".
  - Verify: `npx vitest run cli/tests/unit/ignore-add.test.ts`
  - Deps: 2.1, 2.2, 2.3, 1.4, 2.8

- [x] **2.5 — `commands/ignore/{list,remove,explain}.ts`** · M
  - `list` (`--expired` exit `1`/`0`, `--path`, `--json`)
  - `remove` (mandatory `--reason`, `--rule` para disambiguation; ambíguo → exit `1` `entry_ambiguous`; `--strict` recusa em working tree dirty com exit `3` DIRTY_TREE — paridade com `add` / `rules-remove`. SPEC §10 #8 lê "exit `3`")
  - `explain` (entry + history filtrado de `lint-decisions.md`; not-found → exit `1`)
  - Surface aceita `--rule` em todos (semântica plena vem em P3)
  - Manifesto vazio: `list` imprime `(no entries)` exit 0; `remove`/`explain` exit `1` `entry_not_found`
  - Verify: `npx vitest run cli/tests/unit/ignore-{list,remove,explain}.test.ts`
  - Deps: 2.1, 2.2, 2.3, 2.8
  - **Notes (Ralph 2026-05-05):** `--path <glob>` é igualdade literal (não picomatch — sem dependência adicional ainda); slot natural para `fast-glob` quando T4.3 chegar. `explain.history` parser identifica blocos por `- **id**: <id>` bullet; markers ausentes → `[]` (não erro). `--rule path` aceito como sinônimo de `null` em `remove`/`explain` para que slash command sempre passe seletor explícito.

- [x] **2.6 — Wire dispatch em `index.ts`** · S
  - 5 entries em `SUBCOMMAND_LIST` e `HANDLER_OVERRIDES`: `ignore-compile`, `ignore-add`, `ignore-list`, `ignore-remove`, `ignore-explain`
  - Criado `cli/tests/unit/index-help.test.ts` (3 it() blocks) — verifica registro, summaries e que nenhum handler é stub `notImplemented`. Justificado: T3.4b/T3.5/T4.3 adicionarão mais subcomandos.
  - Snapshot `pack-contents.test.ts.snap` atualizado para incluir `add.ts`, `explain.ts`, `list.ts`, `remove.ts` (eram emitidos no tarball desde T2.4/T2.5 mas o snap não tinha sido refrescado).
  - Verify: `node --experimental-strip-types cli/src/index.ts --help | grep ignore-` → 5 linhas ✓; `npx vitest run` → 2244 verde ✓; `npm run typecheck` ✓.
  - Deps: 2.3, 2.4, 2.5 — todos satisfeitos.

- [x] **2.7 — Slash command `/lint:ignore:add` (path-only)** · S
  - `commands/lint/ignore/add.md` (74 linhas) com frontmatter completo, 6 seções canônicas (Visão Geral / Quando usar / Quando NÃO usar / Fluxo / Trade-offs / Verificação) e flow `AskUserQuestion` em 3+ etapas (glob → reason 4 opções → expires 4 opções).
  - Refuse explícito em stack não-suportado (`detect-stack` exit `2`); refuse em manifesto corrompido (exit `70`); refuse em tree sujo + `--strict` com fluxo `git stash`.
  - `cli/tests/unit/command-lint-ignore-add-md.test.ts` (37 it() blocks): hygiene + frontmatter + sections-in-order + CLI preamble + subcommand coverage + AskUserQuestion contract + exit-code mapping + global conventions. **Path-only enforcement:** test bloqueia `--rule <valor>` na seção Fluxo (Phase 2 não promete).
  - Snapshot `pack-contents.test.ts.snap` refrescado com `commands/lint/ignore/add.md`.
  - Verify: `npx vitest run cli/tests/unit/command-lint-ignore-add-md.test.ts` ✓; full suite 2281 verde ✓; `npm run typecheck` ✓.
  - Deps: 2.4, 2.6 — satisfeitos.

- [x] **2.8 — Distinguish missing vs malformed em `loadIgnoreManifest`** · S
  - Hoje `loadIgnoreManifest` devolve `null` para ausente, JSON inválido OU `version != 1` (silencioso). SPEC §3.1 diz "exit `5` — fatal: manifesto corrompido"; precisamos diferenciar.
  - Mudança: trocar retorno por `LoadResult = { ok: true; manifest: IgnoreManifest | null } | { ok: false; error: "manifest_corrupt" | "manifest_unsupported_version"; reason: string }`
  - Callers (`commands/ignore/{add,remove,list,explain,compile}.ts`) → exit `70` (INTERNAL_ERROR) com `output({ ok: false, error: "manifest_corrupt", reason })`. Nota: SPEC fala em exit 5, mas EXIT_CODES.MISSING_DEPENDENCY=5 — usa-se INTERNAL_ERROR=70 como semântico mais próximo de "fatal/corrupted state".
  - Atualizar `cli/tests/unit/ignore-manifest.test.ts` para cobrir os 3 casos (missing → ok+null, malformed JSON → err `manifest_corrupt`, version != 1 → err `manifest_unsupported_version`).
  - Verify: `npx vitest run cli/tests/unit/ignore-manifest.test.ts cli/tests/unit/ignore-compile-cmd.test.ts`
  - Files: `cli/src/lib/ignore-manifest.ts`, `cli/src/commands/ignore/compile.ts` (consumir novo retorno).
  - Deps: 2.1, 2.2, 2.3

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

- [ ] **3.4b — `commands/ignore/import-preview.ts` (`qualy ignore-import-preview`)** · S
  - Subcomando read-only: lê presets + manifest, retorna JSON `{ ok, manifest_empty, would_import: [{ glob, tier }], count }`. Sem side-effects.
  - **Justificativa:** o slash command `/lint:ignore:add` precisa decidir se mostra `AskUserQuestion` (≥5 patterns) ANTES de invocar `qualy ignore-add`. Sem este subcomando, o slash teria que (a) duplicar a lógica de detecção em markdown ou (b) inspecionar o preset cru com Bash — ambas fragilizam o contrato. Esse subcomando expõe o "import preview" deterministicamente.
  - Reutiliza helpers de `lib/ignore-import.ts` (T3.4) — só não escreve.
  - Adicionar entry em `SUBCOMMAND_LIST`/`HANDLER_OVERRIDES` (1 a mais que T2.6).
  - Verify: `npx vitest run cli/tests/unit/ignore-import-preview.test.ts` cobrindo brownfield (returns count > 0), pre-managed (count = 0), greenfield (count = 0), manifest non-empty (count = 0, skip).
  - Files: `cli/src/commands/ignore/import-preview.ts`, test correspondente, UPDATE `cli/src/index.ts`.
  - Deps: 3.4

- [ ] **3.5 — Slash commands restantes + flow `category:*` em `add.md`** · M
  - 3 markdowns: `/lint:ignore:{remove,list,explain}`
  - `add.md` estende: `--rule category:*` → `AskUserQuestion` confirma N rules → injeta `--i-know-this-disables-many`
  - Brownfield import threshold ≥5 → invocar `qualy ignore-import-preview` (T3.4b) antes do CLI mutativo, mostrar `AskUserQuestion` com lista das N patterns; <5 silencioso
  - `/lint:ignore:remove`: blast radius + `--reason` mandatory via `AskUserQuestion`
  - NEW subcomando `qualy category-info <name>` (read-only) → JSON `{ category, rules, count }`. **Wire em `cli/src/index.ts`:** adicionar entry em `SUBCOMMAND_LIST` + `HANDLER_OVERRIDES` (1 a mais sobre os 5 do T2.6).
  - Verify: `npx vitest run cli/tests/unit/command-lint-ignore-{add,remove,list,explain}-md.test.ts cli/tests/unit/category-info.test.ts`
  - Files: 4 markdowns (`commands/lint/ignore/{add,remove,list,explain}.md`), `cli/src/commands/category-info.ts`, `cli/tests/unit/category-info.test.ts`, UPDATE `cli/src/index.ts`.
  - Deps: 3.3, 2.7, 2.5, 3.4b

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
  - **Nota:** SPEC §2.3 / §10 #5/#12 falam em `qualy lint` + `qualy audit`. O CLI só expõe `audit` (não há `lint` em `SUBCOMMAND_LIST`); drift check + expired warnings entram exclusivamente em `commands/audit.ts`. Se um `qualy lint` for adicionado depois (fora de v1), reaproveitar o mesmo helper.
  - Verify: `npx vitest run cli/tests/unit/{ignore-drift,audit}.test.ts`
  - Deps: 2.2, 3.2

- [ ] **4.2 — Expired warning em `audit`** · S
  - `findExpired` → `logger.warn` stderr + `audit.ignore_warnings: [{ id, glob, expires, days_overdue }]`
  - Nunca bloqueia (SPEC §6)
  - Verify: `npx vitest run cli/tests/unit/audit.test.ts` (fixture com expired entry)
  - Deps: 4.1, 2.1

- [ ] **4.3 — Blast radius helper** · M
  - `commands/ignore/blast-radius.ts` (subcomando `qualy ignore-blast-radius <glob>`)
  - **Dependência:** `fast-glob` (Node 22+ tem `node:fs.glob` estável; mas `package.json` `engines.node = ">=20.0.0"` — ficar em `fast-glob` para compatibilidade). Adicionar a `dependencies` em `package.json`.
  - Exclui `node_modules`, `.git`, `dist`, `.harn`, `.lint-audit`, `.lint-backup` por padrão
  - Slash commands `/lint:ignore:{add,remove}` consomem antes da confirmação
  - Output JSON `{ ok: true, cwd, files_in_glob, sample: first-10 }`
  - **Wire em `cli/src/index.ts`:** adicionar `ignore-blast-radius` em `SUBCOMMAND_LIST` + `HANDLER_OVERRIDES`.
  - Verify: `npx vitest run cli/tests/unit/ignore-blast-radius.test.ts` + smoke `node --experimental-strip-types cli/src/index.ts ignore-blast-radius 'cli/src/**'`
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
- [ ] Perf: `qualy audit` overhead ≤50ms em repo sem manifest (drift check skip path)
- [ ] README + CHANGELOG atualizados

---

## SPEC §10 acceptance criteria — tracker direto

- [ ] #1 — `qualy ignore-add 'src/legacy/**' --reason x` cria entrada, recompila, lint passa em arquivo do glob
- [ ] #2 — `--rule quality-metrics/wmc` desabilita só essa rule; outras ainda disparam no path
- [ ] #3 — `qualy ignore-list` mostra status (active/expired) correto
- [ ] #4 — `--expired` exit `1` com vencidas, `0` sem
- [ ] #5 — Entrada vencida → warning stderr em `audit` (SPEC fala em `lint` mas não há subcomando hoje — ver T4.1), exclusão ainda ativa
- [ ] #6 — Brownfield import na 1ª mutação com `createdBy: "imported"`
- [ ] #7 — `/lint:ignore:{add,remove,list,explain}` end-to-end via slash command harness (frontmatter + allowed-tools test, paridade com `command-lint-uninstall-md.test.ts`)
- [ ] #8 — Dirty + `--strict` → exit `3` (DIRTY_TREE — SPEC §3.1 lista "2"; canônico do projeto é 3, igual a `rules-add`/`rules-remove`) com mensagem `git stash`
- [ ] #9 — Re-add idempotente (atualiza in-place, `ignore-update`)
- [ ] #10 — `category:*` sem `--i-know-this-disables-many` → exit `1` com tamanho da categoria
- [ ] #11 — Slash command com `category:*` lista N rules + `AskUserQuestion`
- [ ] #12 — Drift: edit manual em `ignore.json` recompila no próximo `audit` (não há `qualy lint`); sem mudança pula
- [ ] (extra) Migração one-time `docs/lint-decisions.md` → `.harn/qualy/docs/`; conflict → exit `1`
- [ ] (extra) Manifesto corrompido (T2.8) → exit `70` com `error: "manifest_corrupt"` (SPEC §3.1 lista "5"; canônico é INTERNAL_ERROR=70 pois MISSING_DEPENDENCY=5 não é semanticamente correto)
- [ ] (extra) `qualy ignore-import-preview` (T3.4b) read-only retorna count + lista para slash command threshold ≥5 (preview API, não muta nada)

## Blocked (Ralph)

- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
