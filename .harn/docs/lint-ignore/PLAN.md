# PLAN — `lint-ignore`

**SPEC:** `.harn/docs/lint-ignore/SPEC.md`
**Owner:** @hgflima
**Created:** 2026-05-05
**Final artifacts (após approval):** copiar este plano para `.harn/docs/lint-ignore/PLAN.md` e expandir checklist para `.harn/docs/lint-ignore/TASKS.md` (preferência do user — memória).

---

## Context

Implementar `qualy ignore <verb>` (CLI determinístico) + `/lint:ignore:<verb>` (slash commands) sobre um manifesto auditável `.harn/qualy/ignore.json` que compila para `oxlint.{fast,deep}.json` entre markers `_qualy:start_/end_`. Toda exclusão tem `reason` obrigatório, `expires` opcional, e fica registrada em decision log append-only.

**Por que agora:** hoje exclusões viram buraco escondido em config (sem motivo, sem expiry, sem rastro). A SPEC trata isso como dívida técnica auditável — equivalente do que `/lint:rules:*` já faz para rules.

**Acoplamento:** migra `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` (alinha com convenção `.harn/qualy/*` que outras partes do qualy já usam — preferência registrada do user).

**Decisões fechadas com o user:**
- Brownfield import auto-silencioso até 4 patterns; com ≥5, slash command confirma via `AskUserQuestion` (CLI puro segue silencioso).
- Catálogo de `category:*` é estático bundled em `cli/src/lib/category-catalog.ts` com smoke test contra `node_modules/oxlint` major version.

---

## Architecture decisions

1. **Reuse máximo dos helpers existentes:** `safeWriteFile`, `dirtyFiles`, `parseDefensive`, `stringifyPretty`, `EXIT_CODES`, `logger`, `output`, e os utilitários de decision log que hoje vivem em `recs/apply.ts` + `rules/add.ts`. Phase 1 extrai esses utilitários para `lib/decision-log.ts` (uma única source of truth).
2. **CLI dispatch:** seguir convenção dash-separated (`ignore-add`, `ignore-remove`, `ignore-list`, `ignore-explain`, `ignore-compile`, `ignore-blast-radius`) registrada em `HANDLER_OVERRIDES` Map e `SUBCOMMAND_LIST` (`cli/src/index.ts:78,117`).
3. **Args parsing manual loop**, não commander — espelha `parseRulesAddArgs`. Retorno discriminated `{ ok, value } | { ok: false, error }`.
4. **Compilation idempotente determinística:** sort por `id`, markers entre seções, conteúdo fora dos markers preservado byte-a-byte.
5. **Drift check via mtime** em `qualy lint`/`audit`: se `mtime(ignore.json) > mtime(preset)` → recompila; senão pula. Custo <5ms.
6. **Blast radius via fast-glob (Node `node:fs.glob` ou `fast-glob`)** — `oxlint --print-files` confirmado inexistente (só `--print-config`). Helper `commands/ignore/blast-radius.ts` interno, slash commands consomem via JSON.
7. **Markers em `overrides[]`:** como override é array de objects, sentinelas viram `{ files: [], rules: { "_qualy:start_": "off" } }` e `{ files: [], rules: { "_qualy:end_": "off" } }`.

---

## Dependency graph

```
Phase 1 — Foundation (chassis)
  exit-codes/logger/fs-safe/git/json (existentes)
        │
        ▼
  lib/paths.ts (NEW)  ──┐
  lib/decision-log.ts (NEW, extraído de rules/add.ts + recs/apply.ts)
  lib/decision-log-migration.ts (NEW)
        │
        ▼  rules/add.ts, rules/remove.ts, recs/apply.ts (UPDATE: import constants)

Phase 2 — Path-only ignore vertical slice
  lib/ignore-manifest.ts (NEW)
        │
        ▼
  lib/ignore-compile.ts (NEW, só ignorePatterns[])
        │
        ▼
  commands/ignore/{compile,add,list,remove,explain}.ts (NEW)
  index.ts (UPDATE: 5 subcomandos)
        │
        ▼
  commands/lint/ignore/add.md (NEW)

Phase 3 — Per-rule + category + import + slash commands restantes
  lib/category-catalog.ts (NEW, estático bundled)
  lib/ignore-compile.ts (EXTEND: overrides[] + category expansion)
  lib/ignore-import.ts (NEW)
  commands/ignore/add.ts (EXTEND: --rule, --i-know-this-disables-many)
  commands/lint/ignore/{remove,list,explain}.md (NEW)

Phase 4 — Polish + e2e
  lib/ignore-drift.ts (NEW)
  audit.ts (UPDATE: drift check + expired warnings)
  commands/ignore/blast-radius.ts (NEW)
  cli/tests/fixtures/ignore-{greenfield,brownfield,expired}/ (NEW)
  cli/tests/e2e/ignore-flow.test.ts (NEW)
```

---

## Phase 1 — Foundation

Sem feature visível ainda. Extrai/centraliza utilitários e introduz a migração one-time do decision log. Próxima mutação de `rules:*` ou `recs:apply` move `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` automaticamente.

### Task 1.1 — `lib/paths.ts` com constants centralizadas — S
**O que:** Single source of truth para paths.
**Acceptance:**
- Exports: `DECISION_LOG_PATH`, `LEGACY_DECISION_LOG_PATH`, `IGNORE_MANIFEST_PATH`, `PRESET_PATHS = { fast, deep }`, `IGNORE_MARKER_START = "_qualy:start_"`, `IGNORE_MARKER_END = "_qualy:end_"`.
- Tipo-only `as const`.

**Verify:** `npx vitest run cli/tests/unit/paths.test.ts`
**Files:** `cli/src/lib/paths.ts`, `cli/tests/unit/paths.test.ts`
**Deps:** —

### Task 1.2 — Extrair `lib/decision-log.ts` — M
**O que:** Mover `ENTRIES_START`, `ENTRIES_END`, `loadOrInitDecisions`, `insertEntryBetweenMarkers`, `formatDecisionEntry` de `recs/apply.ts` (~454,487) e `rules/add.ts` (~565,582). Generalizar `formatDecisionEntry({ timestamp, kind, fields, reason })` aceitando `kind ∈ {rule-add, rule-remove, rec-apply, ignore-add, ignore-update, ignore-remove, ignore-import, meta:migrate-decision-log}`.
**Acceptance:**
- Os 3 call-sites importam do novo módulo, comportamento inalterado.
- `cli/tests/unit/decision-log.test.ts` cobre format + idempotência.
- Testes existentes (`recs-apply`, `rules-add`, `rules-remove`, `rules-decisions-format`) verdes sem mudança de assertions.

**Verify:** `npx vitest run cli/tests/unit/decision-log.test.ts cli/tests/unit/{recs-apply,rules-add,rules-remove}.test.ts`
**Files:** `cli/src/lib/decision-log.ts` (NEW); UPDATE imports em `recs/apply.ts`, `rules/add.ts`, `rules/remove.ts`.
**Deps:** 1.1

### Task 1.3 — `lib/decision-log-migration.ts` — M
**O que:** `migrateDecisionLogIfNeeded(cwd, deps): { ok: true; migrated: bool } | { ok: false; error: 'decision_log_conflict' | 'migration_io_failed' }`. Estados: só legacy (mv ou git mv + append `meta:migrate-decision-log`); ambos (refuse com erro claro); só novo / nenhum (no-op).
**Acceptance:**
- DI para `existsFn`, `gitMvFn`, `mvFn`, `mkdirFn`, `writeFn`, `readFn`, `now`, `dirtyFilesFn`. Defaults usam `node:fs` + `execFileSync('git', ['mv', ...])`.
- `git ls-files --error-unmatch <legacy>` decide entre `git mv` e `mv`.
- Manifest entry `kind: "decisions"` registrada para `lint-uninstall`.
- 5 cenários testados: tracked/untracked/conflict/só-novo/nenhum.

**Verify:** `npx vitest run cli/tests/unit/decision-log-migration.test.ts`
**Files:** `cli/src/lib/decision-log-migration.ts`, `cli/tests/unit/decision-log-migration.test.ts`
**Deps:** 1.1, 1.2

### Task 1.4 — Wire migração em `rules/add.ts`, `rules/remove.ts`, `recs/apply.ts` — S
**O que:** Cada entry-point chama `migrateDecisionLogIfNeeded(cwd)` antes do `loadOrInitDecisions`. Substitui `DECISIONS_REL` hardcoded por `DECISION_LOG_PATH`. Em `decision_log_conflict` → exit `1` com `output({ ok: false, error: 'decision_log_conflict', reason })`.
**Acceptance:**
- `git grep "docs/lint-decisions.md"` só matcha `paths.ts` (LEGACY) e `decision-log-migration.ts`.
- Fixtures de testes existentes ajustados para asserter path novo `.harn/qualy/docs/lint-decisions.md`.

**Verify:** `npx vitest run cli/tests/unit/{rules-add,rules-remove,recs-apply}.test.ts && npx vitest run cli/tests/e2e/`
**Files:** `cli/src/commands/rules/add.ts`, `rules/remove.ts`, `recs/apply.ts`; fixtures de teste ajustadas.
**Deps:** 1.3

### Task 1.5 — Refs de slash commands + template — S
**O que:** Substituir `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` em `commands/lint/rules/{add,remove}.md`, `commands/lint/update.md`, e comentário em `cli/src/templates/lint-decisions.md.tpl:7`.
**Acceptance:**
- `grep -rn "docs/lint-decisions.md" commands/` vazio.
- Testes de markdown (`agent-lint-installer-md.test.ts`, `command-lint-update-md.test.ts`) atualizados.

**Verify:** `npx vitest run cli/tests/unit/{agent-lint-installer-md,command-lint-update-md}.test.ts`
**Files:** os 4 arquivos acima.
**Deps:** 1.4

### ✅ Checkpoint Phase 1
- `npx vitest run` 100% verde.
- Smoke manual em scratch repo com `docs/lint-decisions.md` pré-existente: `qualy rules-add quality-metrics/cbo --reason test` → arquivo migra automaticamente, entry `meta:migrate-decision-log` no topo, `rule-add` em seguida. Segunda invocação = no-op.
- `.lint-manifest.json` aponta novo path.

---

## Phase 2 — Path-only ignore (vertical slice end-to-end)

Implementa só `entry.rule === null`. End-to-end: `qualy ignore-add src/legacy/** --reason "x"` cria entrada, recompila preset, `qualy lint` ignora arquivos do glob.

### Task 2.1 — `lib/ignore-manifest.ts` — M
**O que:** Tipos + load/save/validate/upsert/remove. Pure (FS via DI).
**Acceptance:**
- `IgnoreEntry { id, glob, rule, reason, expires, createdAt, createdBy }`, `IgnoreManifest { version: 1, entries: [] }`.
- `loadIgnoreManifest`, `saveIgnoreManifest` (via `safeWriteFile` com `kind: "ignore"`), `generateEntryId(glob, rule)` = `"ign-" + sha256(glob + "|" + (rule ?? "")).slice(0,6)`, `upsertEntry` (action: added|updated por id), `removeEntries(predicate)`, `validateGlob`, `validateExpires(s, now)` (rejeita passado), `findExpired(manifest, now)`.
- `ManifestEntryKind` em `fs-safe.ts:55` estendido com `"ignore"`.

**Verify:** `npx vitest run cli/tests/unit/ignore-manifest.test.ts` cobrindo determinismo de id, idempotência de upsert, rejeição de data passada, round-trip de save/load.
**Files:** `cli/src/lib/ignore-manifest.ts`, `cli/src/lib/fs-safe.ts` (extend union), `cli/tests/unit/ignore-manifest.test.ts`
**Deps:** 1.1, 1.2

### Task 2.2 — `lib/ignore-compile.ts` (path-only) — M
**O que:** `compileToPreset(currentPreset, manifest, opts) → { ok, proposed, changed }`. Phase 2 só processa `rule === null` para `ignorePatterns[]`. Markers preservados; conteúdo fora dos markers byte-a-byte. `compileToBothPresets(cwd, manifest, deps)` orquestra fast+deep, escreve só quando `changed`.
**Acceptance:**
- `ignorePatterns: [IGNORE_MARKER_START, ...patterns sorted by id, IGNORE_MARKER_END]`.
- Idempotente: 2ª execução com mesmo input → `changed: false`.
- 0 entradas → markers vazios pair-up.
- Pre-existing user patterns fora dos markers preservados verbatim.
- Entries com `rule != null` ignoradas em P2 (deferidas a P3).

**Verify:** `npx vitest run cli/tests/unit/ignore-compile.test.ts`
**Files:** `cli/src/lib/ignore-compile.ts`, `cli/tests/unit/ignore-compile.test.ts`
**Deps:** 2.1, 1.1

### Task 2.3 — `commands/ignore/compile.ts` (`qualy ignore-compile [--check]`) — S
**O que:** Handler thin. `--check` → exit `1` se drift; sem flag → escreve quando changed.
**Acceptance:**
- Output `{ ok, cwd, files_changed, in_sync? | applied? }`.
- Não exposto em slash command (SPEC §3.5).

**Verify:** `npx vitest run cli/tests/unit/ignore-compile-cmd.test.ts`
**Files:** `cli/src/commands/ignore/compile.ts`, `cli/tests/unit/ignore-compile-cmd.test.ts`
**Deps:** 2.2

### Task 2.4 — `commands/ignore/add.ts` (path-only) — M
**O que:** Primeira mutação visível. Phase 2 só `qualy ignore-add <glob> --reason <txt> [--expires] [--strict]`. Flow: parse → `migrateDecisionLogIfNeeded` → `loadIgnoreManifest` → upsert → `saveIgnoreManifest` → `compileToBothPresets` → `appendDecision({ kind: ignore-add | ignore-update, ... })`.
**Acceptance:**
- Idempotente: re-add atualiza `reason`/`expires`, `kind: "ignore-update"`.
- Exit codes: 0 ok; 1 invalid glob/reason/expires; 2 dirty + `--strict`; 4 usage.
- Reuso `dirtyFiles` para `--strict`.

**Verify:** `npx vitest run cli/tests/unit/ignore-add.test.ts` + smoke `node --experimental-strip-types cli/src/index.ts ignore-add 'src/legacy/**' --reason x --cwd /tmp/scratch`.
**Files:** `cli/src/commands/ignore/add.ts`, `cli/tests/unit/ignore-add.test.ts`
**Deps:** 2.1, 2.2, 2.3, 1.4

### Task 2.5 — `commands/ignore/{list,remove,explain}.ts` — M
**O que:** `list` (read-only, `--expired`/`--path`/`--json`), `remove` (mandatory `--reason`, `--rule` para disambiguation), `explain` (entry + history do decision log).
**Acceptance:**
- `list --expired` exit `1` se há vencidas, `0` se não (útil em CI — SPEC §10).
- `remove`: ambiguidade (múltiplas entries no mesmo glob) → exit `1` com `entry_ambiguous` instruindo `--rule`.
- `explain`: entry not found → exit `1`.
- Manifest vazio: `list` imprime `(no entries)`, `remove`/`explain` exit `1` com `entry_not_found`.
- Surface aceita `--rule` em todos os 3 (parse válido); semântica plena vem em P3.

**Verify:** `npx vitest run cli/tests/unit/ignore-{list,remove,explain}.test.ts`
**Files:** 3 handlers + 3 tests.
**Deps:** 2.1, 2.2, 2.3

### Task 2.6 — Wire dispatch em `index.ts` — S
**O que:** Adicionar 5 entries em `SUBCOMMAND_LIST` (`cli/src/index.ts:78`) e `HANDLER_OVERRIDES` (`:117`): `ignore-add`, `ignore-remove`, `ignore-list`, `ignore-explain`, `ignore-compile`.
**Acceptance:**
- `qualy --help` lista os 5.
- Snapshot de `index-help` atualizado.

**Verify:** `node --experimental-strip-types cli/src/index.ts --help | grep ignore-` (5 linhas).
**Files:** `cli/src/index.ts`, `cli/tests/unit/index-help.test.ts` (extend)
**Deps:** 2.3, 2.4, 2.5

### Task 2.7 — Slash command `/lint:ignore:add` (path-only) — S
**O que:** Markdown frontmatter + flow `AskUserQuestion` (uma pergunta por vez): glob (se ausente) → reason com 4 opções (legacy/generated/vendored/Other) → expires (No expiry recomendado / 90d / 180d / custom) → confirma → delega `qualy ignore-add ... --strict` via Bash.
**Acceptance:**
- `allowed-tools: Bash, AskUserQuestion`.
- Refuse em stack não-suportado (parity `/lint:rules:add`).
- Test `command-lint-ignore-add-md.test.ts` espelhando padrão `command-lint-uninstall-md.test.ts`.

**Verify:** `npx vitest run cli/tests/unit/command-lint-ignore-add-md.test.ts`
**Files:** `commands/lint/ignore/add.md`, test correspondente.
**Deps:** 2.4, 2.6

### ✅ Checkpoint Phase 2
- `vitest run` verde.
- SPEC §10 acceptance #1 manual: `qualy ignore-add 'src/legacy/**' --reason test` → `oxlint.fast.json` tem `ignorePatterns: [_qualy:start_, "src/legacy/**", _qualy:end_]`, `.harn/qualy/ignore.json` populado, `lint-decisions.md` com entry `ignore-add`.
- Re-run idempotente sem entry duplicada.

---

## Phase 3 — Per-rule + category + import + slash commands restantes

### Task 3.1 — `lib/category-catalog.ts` (estático bundled) — M
**O que:** Hardcoded `Record<Category, readonly string[]>` espelhando categorias documentadas do oxlint (correctness, suspicious, pedantic, perf, restriction, style, nursery). Smoke test pin contra `node_modules/oxlint/package.json` major version.
**Acceptance:**
- `getCategoryRules(category)`, `getCategorySize(category)`, `KNOWN_CATEGORIES`.
- Smoke test falha se major version do oxlint instalada ≠ versão registrada no header do arquivo (sinal pra review trimestral).
- Header doc no arquivo: "Atualize manualmente quando oxlint major mudar; consulte https://oxc.rs/docs/guide/usage/linter/rules.html".

**Verify:** `npx vitest run cli/tests/unit/category-catalog.test.ts`
**Files:** `cli/src/lib/category-catalog.ts`, `cli/tests/unit/category-catalog.test.ts`
**Deps:** —

### Task 3.2 — Extend `lib/ignore-compile.ts` com `overrides[]` + expansion — M
**O que:** Entries com `rule != null` viram `overrides[]`. `category:*` expandido via `getCategoryRules`. Multiple per-rule entries com mesmo glob agrupadas em um único override block. Markers em forma de objeto: `{ files: [], rules: { "_qualy:start_": "off" } }`.
**Acceptance:**
- Per-rule simples: 1 entry → 1 override block.
- Category: 1 entry `category:correctness` → 1 override block com N rules expandidas.
- Mesmo glob, múltiplas rules: agrupadas em 1 override.
- Phase 2 path-only tests verdes.

**Verify:** `npx vitest run cli/tests/unit/ignore-compile.test.ts`
**Files:** `cli/src/lib/ignore-compile.ts`, test estendido.
**Deps:** 2.2, 3.1

### Task 3.3 — Extend `commands/ignore/add.ts` com `--rule` — M
**O que:** Wire `--rule <id>` + `--i-know-this-disables-many`. Validação: `quality-metrics/*` em `KNOWN_RULES` (de `rules/add.ts`); `category:<name>` em `KNOWN_CATEGORIES`; outros namespaces aceitos como opaque (oxlint valida em runtime).
**Acceptance:**
- `--rule category:correctness` sem `--i-know-this-disables-many` → exit `1` com `category_requires_ack`, `reason` incluindo count.
- Com ambos → entry `rule: "category:correctness"` no manifest, expandido no preset.
- `ignore-list` mostra `category:*` com sufixo `⚠ category (N rules)`.

**Verify:** `npx vitest run cli/tests/unit/ignore-{add,list}.test.ts`
**Files:** UPDATE `commands/ignore/add.ts`, `commands/ignore/list.ts`; testes estendidos.
**Deps:** 3.1, 3.2, 2.4

### Task 3.4 — `lib/ignore-import.ts` (brownfield) — M
**O que:** Primeira mutação detecta `ignorePatterns[]` fora dos markers em `oxlint.fast.json` ou `oxlint.deep.json`. Cada non-marker pattern → entry `createdBy: "imported"`, `reason: "Imported from oxlint preset on first qualy ignore mutation"`, `expires: null`. Decision log: 1 entry batch `ignore-import` com `count` + array de `{ glob, id }`.
**Acceptance:**
- Detecta "fora dos markers" parseando array e localizando índices `_qualy:start_/end_`. Sem markers → todos os patterns importados.
- Hooked em `commands/ignore/add.ts` na 1ª mutação quando manifest está vazio.
- Após import, patterns originais removidos de fora-dos-markers (próxima compile re-emite dentro).
- Skipped em invocações subsequentes (manifest non-empty).

**Verify:** `npx vitest run cli/tests/unit/ignore-import.test.ts` cobrindo brownfield (3 patterns), greenfield (0), pre-managed (0).
**Files:** `cli/src/lib/ignore-import.ts`, UPDATE `commands/ignore/add.ts`, test.
**Deps:** 2.1, 2.2

### Task 3.5 — Slash commands `/lint:ignore:{remove,list,explain}` + flow `category:*` em `add.md` — M
**O que:**
- 3 markdowns novos seguindo padrão SPEC §4.1.
- `add.md` estende: detecta `--rule category:*` antes do CLI, resolve N via `qualy ignore-blast-radius` (P4) ou via JSON output do `category-catalog` (subcomando `qualy category-info <name>`? — decisão: criar subcomando read-only `qualy category-info <name>` retornando `{ category, rules, count }`), `AskUserQuestion`: "isso vai desligar N rules em `<glob>`. Confirma?", em yes injeta `--i-know-this-disables-many`.
- **Brownfield import threshold (decisão do user):** `add.md` detecta antes do CLI (via dry-run JSON do CLI ou inspeção do preset); se ≥5 patterns importáveis, `AskUserQuestion` confirma. <5 segue silencioso.
- `/lint:ignore:remove` confirma com blast radius ("removendo essa exclusão expõe N novos arquivos ao lint"), captura `--reason` mandatório.
- `/lint:ignore:list` no prompts.
- `/lint:ignore:explain` no prompts.

**Acceptance:** Frontmatter parity, fixture-based markdown tests por command.
**Verify:** `npx vitest run cli/tests/unit/command-lint-ignore-{add,remove,list,explain}-md.test.ts`
**Files:** `commands/lint/ignore/{remove,list,explain}.md`, UPDATE `commands/lint/ignore/add.md`, NEW `cli/src/commands/category-info.ts` + test, 4 markdown tests.
**Deps:** 3.3, 2.7, 2.5

### ✅ Checkpoint Phase 3
- SPEC §10 #2, #6, #9, #10, #11 verdes manualmente.
- Decision log com entries para `ignore-add`, `ignore-update`, `ignore-remove`, `ignore-import`.

---

## Phase 4 — Polish + e2e

### Task 4.1 — Drift check em `audit.ts` — M
**O que:** `lib/ignore-drift.ts` com `checkDriftAndRecompile(cwd, deps)` via `statSync` mtimes. `commands/audit.ts` invoca no topo do pipeline antes de oxlint. Se manifest ausente → no-op.
**Acceptance:**
- Log `logger.info("ignore_recompile_drift", { files_changed })` quando recompila.
- Test: fixture com `ignore.json` newer que presets → presets reescritos antes do audit.

**Verify:** `npx vitest run cli/tests/unit/{ignore-drift,audit}.test.ts`
**Files:** `cli/src/lib/ignore-drift.ts`, UPDATE `commands/audit.ts`, 2 tests.
**Deps:** 2.2, 3.2

### Task 4.2 — Expired warning em `audit` — S
**O que:** Após compile, `findExpired(manifest, now)` → `logger.warn` em stderr + entries em `audit.ignore_warnings: [{ id, glob, expires, days_overdue }]`. Nunca bloqueia (SPEC §6 Always — never break build).
**Acceptance:** Fixture com expired entry → audit JSON contém `ignore_warnings[0].id`.
**Verify:** `npx vitest run cli/tests/unit/audit.test.ts`
**Files:** UPDATE `commands/audit.ts`, test estendido.
**Deps:** 4.1, 2.1

### Task 4.3 — Blast radius helper — M
**O que:** `commands/ignore/blast-radius.ts` (subcomando interno `qualy ignore-blast-radius <glob>`) → `{ files_in_glob, sample: first-10 }`. Usa `node:fs.glob` (Node 22+) ou `fast-glob`. Exclui `node_modules`, `.git`, `dist`, `.harn`, `.lint-audit`, `.lint-backup`. Slash commands `/lint:ignore:add` e `/lint:ignore:remove` invocam antes da confirmação.
**Acceptance:**
- Output JSON `{ ok: true, cwd, files_in_glob, sample }`.
- Slash commands consomem via Bash + parse.

**Verify:** `npx vitest run cli/tests/unit/ignore-blast-radius.test.ts` + smoke `node --experimental-strip-types cli/src/index.ts ignore-blast-radius 'cli/src/**'`.
**Files:** `cli/src/commands/ignore/blast-radius.ts`, UPDATE `cli/src/index.ts`, UPDATE `commands/lint/ignore/{add,remove}.md`.
**Deps:** 2.6

### Task 4.4 — Fixtures `ignore-{greenfield,brownfield,expired}` — S
**O que:** 3 fixtures espelhando layout de `cli/tests/fixtures/greenfield-ts/`, com `_materialize.ts` + `package.json` + `tsconfig.json` + `oxlint.fast.json` + sample source com violation conhecida.
**Acceptance:**
- `ignore-greenfield/`: clean.
- `ignore-brownfield/`: `oxlint.fast.json` com `ignorePatterns: ["src/old/**"]` fora dos markers.
- `ignore-expired/`: `.harn/qualy/ignore.json` pré-populado com entry expired.

**Verify:** `npx vitest run cli/tests/unit/materialize.test.ts`
**Files:** 3 diretórios em `cli/tests/fixtures/`.
**Deps:** —

### Task 4.5 — `cli/tests/e2e/ignore-flow.test.ts` (12 acceptance criteria) — M
**O que:** E2E espelhando `setup-greenfield.test.ts`. Cada um dos 12 criteria do SPEC §10 vira um `it()`.
**Acceptance:** Materializa fixture → `runCli(...)` → asserções contra JSON output e estado do FS.

**Verify:** `npx vitest run cli/tests/e2e/ignore-flow.test.ts`
**Files:** `cli/tests/e2e/ignore-flow.test.ts`
**Deps:** 4.1, 4.2, 4.3, 4.4 + todo P2/P3

### Task 4.6 — README + CHANGELOG — S
**O que:** Seção `## Lint Ignore` no README com 3 exemplos (path-only, per-rule, category com confirmação). CHANGELOG entry referenciando SPEC.
**Files:** `README.md`, `CHANGELOG.md`.
**Deps:** 4.5

### ✅ Checkpoint Phase 4 (final)
- Os 12 acceptance criteria de SPEC §10 verdes em e2e.
- `vitest run` 100% pass.
- Smoke perf: `qualy lint` em repo sem manifest com overhead ≤50ms.
- README + CHANGELOG atualizados.

---

## Risks & mitigations

| # | Risk | Prob | Impact | Mitigation |
|---|------|------|--------|------------|
| a | Catálogo `category:*` estático drifta de oxlint | Med | Med | Smoke test pinned por major version (Task 3.1) sinaliza review trimestral; documentar no header do arquivo. |
| b | `oxlint --print-files` inexistente — blast radius aproximado | Low | Low | Confirmado via `--help`. Usa fast-glob com label "files affected" (não "currently violating"). Iteração futura pode adicionar `oxlint --format json` filter. |
| c | Decision-log conflict (legacy + new coexistem) trava mutações | Low | High | Refuse com mensagem clara + cure one-liner: `cat docs/lint-decisions.md >> .harn/qualy/docs/lint-decisions.md && rm docs/lint-decisions.md`. Documentar em `add.md` dos slash commands. |
| d | Drift check (mtime) falha por clock skew / git checkout | Med | Low | (1) toda mutação força compile independente de mtime. (2) recompile é idempotente (~5ms). (3) `--force-recompile` em `ignore-compile`. (4) README documenta que edits manuais a `ignore.json` triggam auto-recompile. |

---

## Parallelization

- **P1 sequencial** (1.1 → 1.2 → 1.3 → 1.4 → 1.5).
- **P2:** 2.1 e 2.2 paralelizáveis após 1.1; 2.3–2.5 após 2.2; 2.6 após 2.5; 2.7 após 2.6.
- **P3:** 3.1 paralelo a P2 (não depende). 3.2 → 3.3 sequencial. 3.4 paralelo a 3.3 (depende só de 2.1/2.2). 3.5 último.
- **P4:** 4.1, 4.3, 4.4 paralelizáveis. 4.2 depende de 4.1. 4.5 espera todos. 4.6 último.

---

## Verification (end-to-end)

Para validar o feature inteiro pronto:
1. `npx vitest run` — unit + e2e green.
2. Em `/tmp/scratch-greenfield`: `qualy ignore-add 'src/legacy/**' --reason test` → `oxlint.fast.json` ignorePatterns ok, manifest ok, decision log ok.
3. Em `/tmp/scratch-brownfield` com `oxlint.fast.json` tendo 7 patterns user-authored fora de markers: rodar `/lint:ignore:add 'src/x/**' --reason test` → slash command pergunta sobre import (≥5), confirma, importa, depois adiciona o novo glob.
4. `qualy ignore-add 'src/x/**' --rule category:correctness --reason "y"` sem ack → exit 1 com count. Com `--i-know-this-disables-many` → expandido no override.
5. Edit manual em `ignore.json`, rodar `qualy lint` → drift check recompila antes; rodar de novo sem edit → skip.
6. Entry com `expires: 2026-04-01` (passada) → `qualy lint` warning stderr + exclusão ainda ativa.

---

## Files referenced (primary)

- SPEC: `/Users/henriquelima/dev/personal/qualy/.harn/docs/lint-ignore/SPEC.md`
- Reuse: `cli/src/lib/{exit-codes,fs-safe,git,json,logger}.ts`
- Pattern reference: `cli/src/commands/rules/{add,remove,explain}.ts`, `recs/apply.ts`
- Dispatch: `cli/src/index.ts:78,117`
- Slash command pattern: `commands/lint/rules/{add,remove}.md`
- Test framework: `vitest`; layout em `cli/tests/{unit,e2e,fixtures}/`

---

## Open scope (NÃO incluído — out of v1)

Lista da SPEC §11 + decisões deste plano:
- `qualy ignore renew <id> --until ...`
- `/lint:report` integration (mostrar painel de ignores)
- Bulk operations (`qualy ignore prune --expired-since 30d`)
- Severity overrides per-path (downgrade error → warn)
- Per-package overrides em monorepos
- `qualy migrate-decision-log --force-merge` (em caso de conflict)
