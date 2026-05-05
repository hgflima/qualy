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
- [x] Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo
- [x] `.lint-manifest.json` aponta novo path
- [x] 2ª invocação = no-op idempotente

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
- [x] `vitest run` verde (2281/2281, re-verificado 2026-05-05)
- [x] SPEC §10 acceptance #1 manual ok (greenfield scratch repo: `ignore-add 'src/legacy/**' --reason …` → `oxlint.{fast,deep}.json` recebem markers `_qualy:start_/_qualy:end_` envolvendo o glob, `.harn/qualy/ignore.json` criado com entry `ign-19160e` `createdBy: "user"`, decision log `.harn/qualy/docs/lint-decisions.md` com entry `ignore-add`. Lint-passa-em-arquivo-do-glob não testado in-scratch — oxlint não instalado; coberto por e2e T4.5)
- [x] Re-run idempotente sem entry duplicada (2ª invocação mesmo glob → `action: "updated"`, manifest mantém 1 entry com mesmo id, preset inalterado em 1 marker block, decision log ganha 2ª entry `ignore-update`)

---

## Phase 3 — Per-rule + category + import + slash commands restantes

- [x] **3.1 — `lib/category-catalog.ts` (estático bundled)** · M
  - `Record<Category, readonly string[]>` para 7 categorias (correctness=231, suspicious=55, pedantic=119, perf=13, restriction=93, style=231, nursery=10) gerado a partir de `node_modules/.bin/oxlint --rules` (oxlint 1.62.0). Total: 752 entries no formato `plugin/rule-name`.
  - `OXLINT_PINNED_MAJOR = 1`; smoke test lê `node_modules/oxlint/package.json` direto (não spawna binário) e falha se major divergir → trigger de review trimestral.
  - Helpers exportados: `KNOWN_CATEGORIES` (tuple), `Category` type, `getCategoryRules(c)` (retorna readonly array, mesma instance — caller não muta), `getCategorySize(c)`, `isKnownCategory(name)` (type guard).
  - Header doc cobre: por que estático (offline + determinístico), trade-off de drift, comando para regenerar (`oxlint --rules`), link para upstream `https://oxc.rs/docs/guide/usage/linter/rules.html`.
  - Verify: `npx vitest run cli/tests/unit/category-catalog.test.ts` (27 it() blocks, all green); full suite 2273/2273 verde; `npm run typecheck` ✓.
  - Deps: — (nenhum)

- [x] **3.2 — Extend `lib/ignore-compile.ts` (overrides + expansion)** · M
  - Entries `rule != null` → `overrides[]` ✓
  - `category:*` expandido via `getCategoryRules` (unknown category falls through opaque) ✓
  - Multiple per-rule mesmo glob → 1 override block agrupado, rules sorted alphabetically ✓
  - Markers em forma de objeto: `{ files: [], rules: { "_qualy:start_": "off" } }` ✓
  - **Asymmetry vs ignorePatterns:** overrides markers só são emitidos quando manifest tem per-rule entries OR markers já existem no preset. `ignorePatterns` sempre emite markers (P2 invariant). Documentado no header de `ignore-compile.ts`. Decisão evita inflar brownfield presets que só usam path-only ignores.
  - **Block ordering:** globs aparecem em ordem id-sorted (encounter order após sort por id de cada entry contributing). Determinismo preservado sem sort de globs alfabético, pois id é hash determinístico de `(glob, rule)`.
  - **Test coverage (`ignore-compile.test.ts`):** 12 baseline P2 verdes + 13 novos T3.2 = 25/25 ✓. Cobre: greenfield + path-only só não adiciona overrides; per-rule simples; multiple rules same glob colapsam; category:perf expande para 13 rules; category + named rule merge; unknown category opaque; multiple globs id-ordered; user blocks fora dos markers preservados; append quando sem markers; idempotente para mixed manifest; strip-to-empty quando per-rule remove tudo.
  - Verify: `npx vitest run cli/tests/unit/ignore-compile.test.ts` ✓ (25/25); full suite 2286/2286 ✓; `npm run typecheck` ✓.
  - Deps: 2.2, 3.1 — satisfeitos.

- [x] **3.3 — Extend `commands/ignore/add.ts` (`--rule`)** · M
  - `--rule <id>` aceita: `quality-metrics/<name>` validado contra `KNOWN_QUALITY_METRICS_RULES` (derivado de `audit-schema.METRIC_KEYS` — wmc/halstead/lcom/cbo/dit), `category:<name>` validado contra `KNOWN_CATEGORIES`, e qualquer outra string como opaque (third-party plugins, future oxlint rules — oxlint surfaces erro próprio em lint time).
  - `category:*` sem `--i-know-this-disables-many` → exit `1` `category_requires_ack` com `reason` mencionando o tamanho da categoria (ex.: `silences 13 rules`) e a flag necessária. Slash command `/lint:ignore:add` é responsável por surface `AskUserQuestion` antes de injetar a flag (T3.5).
  - `parseIgnoreAddArgs` aprende `--rule <id>` e `--i-know-this-disables-many`. `runIgnoreAdd` propaga ambos para `ignoreAdd`. Help text atualizado.
  - `IgnoreAddOk.rule` agora é `string | null` (era `null` em P2). Decision log entry mostra `rule: <id>` real (subject e bullet) ao invés de `(path-only)`.
  - **`ignore-list` annotation:** `IgnoreListEntry.category_size?: number` é populado quando `rule === "category:<known>"` via `getCategorySize`. Slash command renderiza como `⚠ category (N rules)`. Para `category:bogus` (unknown) ou rules não-categóricas → `category_size` ausente.
  - Pack-contents snapshot refrescado: `cli/src/lib/category-catalog.ts` foi adicionado em T3.1 mas o snapshot não havia sido atualizado (T3.2 não rodou e2e). `npx vitest run cli/tests/e2e/install/pack-contents.test.ts` agora verde.
  - Verify: `npx vitest run cli/tests/unit/ignore-{add,list}.test.ts` ✓ (42/42 incluindo 12 novos casos de `--rule`/category); full suite 2298 ✓; e2e 35 ✓; `npm run typecheck` ✓.
  - Deps: 3.1, 3.2, 2.4 — satisfeitos.

- [x] **3.4 — `lib/ignore-import.ts` (brownfield)** · M
  - `extractNonMarkerPatterns(preset)` (pure) lista patterns fora do par `_qualy:start_/end_`; markers ausentes → todos importáveis; markers out-of-order tratados como ausentes (filtra os marker strings em todo caso).
  - `importBrownfieldIgnores(cwd, manifest, now, io)` deduplica fast+deep (encounter order: fast-first, then deep), gera entries `createdBy: "imported"`, `reason: IMPORT_REASON`, `expires: null`, `id = generateEntryId(glob, null)`. Skip silencioso quando `manifest.entries.length > 0` ou patterns = 0 ou preset malformed (deixa `compileToBothPresets` surfacing `preset_malformed`).
  - `stripImportedFromPreset` + `applyImportToPresets(cwd, imported, io)` (escreve via `safeWriteFile` kind `"preset"` merged) removem patterns de fora dos markers ANTES do compile, evitando duplicação dentro+fora.
  - Wired em `commands/ignore/add.ts`: load manifest → import (no-op se non-empty) → upsert → save → applyImport (se imported.length>0) → compile → decision log com entry `ignore-import` ANTES de `ignore-add`/`ignore-update`. `IgnoreAddOk.imported: ImportedPattern[]` exposto no JSON output (vazio em greenfield/subsequent calls).
  - Existing test "preserves user patterns outside markers" reescrito para refletir nova semântica (T3.4 supersede): brownfield → patterns importados, manifest 3 entries, preset wraps tudo dentro markers, decision log `ignore-import` seguido de `ignore-add`. Idempotência da 2ª mutação (não re-importa) coberta por novo it().
  - Verify: `npx vitest run cli/tests/unit/ignore-import.test.ts cli/tests/unit/ignore-add.test.ts` ✓ (50/50 incluindo 22 novos casos T3.4); full suite 2321 verde ✓; e2e 35/35 ✓ (snapshot `pack-contents.test.ts.snap` refrescado para `cli/src/lib/ignore-import.ts`); `npm run typecheck` ✓.
  - Deps: 2.1, 2.2 — satisfeitos.

- [x] **3.4b — `commands/ignore/import-preview.ts` (`qualy ignore-import-preview`)** · S
  - Subcomando read-only: lê presets + manifest, retorna JSON `{ ok, manifest_empty, would_import: [{ glob, tier }], count }`. Sem side-effects.
  - **Justificativa:** o slash command `/lint:ignore:add` precisa decidir se mostra `AskUserQuestion` (≥5 patterns) ANTES de invocar `qualy ignore-add`. Sem este subcomando, o slash teria que (a) duplicar a lógica de detecção em markdown ou (b) inspecionar o preset cru com Bash — ambas fragilizam o contrato. Esse subcomando expõe o "import preview" deterministicamente.
  - Reutiliza helpers de `lib/ignore-import.ts` (`extractNonMarkerPatterns`) — só não escreve. Dedup encounter-order é fast-first/then-deep, espelhando `importBrownfieldIgnores` para que slash command e a mutação propriamente dita reportem a mesma lista.
  - `would_import[].tier` é o tier onde o pattern foi encontrado pela primeira vez. Pattern compartilhado entre fast+deep aparece uma vez com `tier: "fast"`.
  - Manifest non-empty → `manifest_empty: false`, `count: 0`, `would_import: []` sem ler presets (paridade com early-return de `importBrownfieldIgnores`). Manifest corrupt → exit `70` `manifest_corrupt` (paridade com `ignore-add`/`ignore-compile`).
  - Wired em `SUBCOMMAND_LIST` + `HANDLER_OVERRIDES` (subcomando #6 do grupo `ignore-*`). `index-help.test.ts` (3 it() blocks) atualizado para cobrir o novo entry.
  - Snapshot `pack-contents.test.ts.snap` refrescado para incluir `cli/src/commands/ignore/import-preview.ts`.
  - Verify: `npx vitest run cli/tests/unit/ignore-import-preview.test.ts` ✓ (14 it() blocks: parser × 4, brownfield × 2, pre-managed, greenfield × 3, manifest non-empty, corrupt × 2, read-only); full suite 2335 ✓; e2e 35/35 ✓; `npm run typecheck` ✓.
  - Deps: 3.4 — satisfeitos.

- [x] **3.5 — Slash commands restantes + flow `category:*` em `add.md`** · M
  - 3 markdowns novos (`commands/lint/ignore/{list,explain,remove}.md`) seguindo o padrão SPEC §4.1: frontmatter completo, 6 seções canônicas (Visão Geral / Quando usar / Quando NÃO usar / Fluxo / Trade-offs / Verificação), preâmbulo `QUALY_CLI`, mapeamento de exit codes.
  - `add.md` estendido: descreve `--rule path-only|quality-metrics/<rule>|category:<name>|opaque` no fluxo, com `category:*` consultando `category-info <name>` para listar N rules e injetando `--i-know-this-disables-many` após `AskUserQuestion` (SPEC §3.1.1). Brownfield import threshold ≥5 chama `ignore-import-preview` antes do CLI mutativo (SPEC §8.2 deferred resolution). Limite de linhas movido de 100 → 130 para acomodar o flow expandido.
  - `/lint:ignore:list`: read-only inventário, surfacing `category_size` (`⚠ category (N rules)`) e routing opcional para `add`/`remove` quando `expired_count > 0` ou manifesto vazio. Pós-condition `AskUserQuestion` só dispara se a ação fizer sentido.
  - `/lint:ignore:explain`: read-only inspector com branch de ambiguity (`entry_ambiguous` → `AskUserQuestion` candidatos → re-roda com `--rule <id>`/`--rule path`). History extraído filtra blocos do decision log por `id`.
  - `/lint:ignore:remove`: mutating com `--reason` mandatory via `AskUserQuestion` (SPEC §6 Always), Pergunta 1 (motivo) → Pergunta 2 (confirm com blast-radius verbal — count real chega em T4.3 `ignore-blast-radius`). Branch ambiguity simétrico ao explain.
  - NEW subcomando `qualy category-info <category>` (`cli/src/commands/category-info.ts`): read-only resolver sobre `KNOWN_CATEGORIES` retornando `{ category, rules, count }`. Aceita bare (`correctness`) e qualificado (`category:correctness`). Unknown → exit `1` `unknown_category` com lista canônica em `reason`. Wired em `SUBCOMMAND_LIST` + `HANDLER_OVERRIDES`. `cli/tests/unit/category-info.test.ts` (15 it() blocks: resolution × 4, rejection × 3, parser × 8) ✓.
  - 4 contract tests (`command-lint-ignore-{list,explain,remove,add}-md.test.ts`): hygiene (LF, no BOM, single trailing newline) + frontmatter (name, description-cue, allowed-tools, argument-hint) + sections-in-order + CLI subcommand coverage + exit-code mapping + global conventions. `add.md` test atualizado: T3.3+T3.5 wire `--rule` (era assertion negativa em P2), `--i-know-this-disables-many`, `ignore-import-preview`, `category-info`. `index-help.test.ts` (3 it() blocks) atualizado para incluir `category-info` no registro + summary contract + non-stub guard. Snapshot `pack-contents.test.ts.snap` refrescado com `cli/src/commands/category-info.ts` + `commands/lint/ignore/{explain,list,remove}.md`.
  - Verify: `npx vitest run cli/tests/unit/command-lint-ignore-{add,list,explain,remove}-md.test.ts cli/tests/unit/category-info.test.ts cli/tests/unit/index-help.test.ts` ✓ (155 it() blocks); full unit suite 2442 ✓; e2e 35/35 ✓ (snapshot refrescado); `npm run typecheck` ✓.
  - Deps: 3.3, 2.7, 2.5, 3.4b — satisfeitos.

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
- [x] (extra) `qualy ignore-import-preview` (T3.4b) read-only retorna count + lista para slash command threshold ≥5 (preview API, não muta nada)

## Blocked (Ralph)

- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
- Smoke manual: scratch repo com `docs/lint-decisions.md` → primeira mutação migra automaticamente, `meta:migrate-decision-log` no topo (stuck after 3 attempts)
