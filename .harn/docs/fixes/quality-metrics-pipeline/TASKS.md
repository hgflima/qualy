# Tasks — Reparar pipeline `quality-metrics`

> Companion de `PLAN.md`. Cada Task ≤ 30 min focados. Verificar `npm test` verde entre tasks.
>
> **Verificação universal entre tasks:**
> ```bash
> PATH="./node_modules/.bin:$PATH" oxlint --config oxlint.deep.json --format json . 2>&1 | head -5
> ```
> Esperado: stdout começa com `{` (Phase 1+) ou diagnostics JSON; nunca `Failed to parse oxlint configuration file` após T1.1+T1.2 aplicadas em conjunto.
>
> **Snapshot de progresso (2026-05-05):** T1.1, T1.2, T1.3, T2.1, T2.2, T2.3, T3.1 entregues — Phase 1, 2 e 3 ✅ completas. T4.1, T4.2 pendentes (Phase 4 — defesa em profundidade). Detalhes em `PLAN.md#status-de-execução`.

---

## Phase 1 — Oxlint volta a parsear e carregar o plugin

### T1.1 — Mover stage-meta de `_comment` para `.lint-manifest.json` (XS) ✅ DONE (`e1bad99`)

**Description:** `_comment` é rejeitado pelo schema de `oxlint 1.62.0`. Mover o conteúdo (`stage`) para um campo de topo `stage` no `.lint-manifest.json` (já é qualy-only, já é gravado pelo install). Atualizar `rules/list.ts` para ler de lá.

> **Nota de execução:** o "manifest" canônico é `cli/src/lib/fs-safe.ts` (não `manifest.ts`); o tipo `Manifest` ali ganhou `stage?: ManifestStage` e `setManifestField` aceita `{ stage }`.

**Acceptance criteria:**
- [x] `cli/src/lib/fs-safe.ts` aceita campo opcional `stage: ManifestStage` no topo, validado no read (rejeita strings desconhecidas).
- [x] `cli/src/commands/install/oxlint.ts` grava `stage` no manifest após escrever os presets via `setManifestField`.
- [x] `cli/src/commands/rules/list.ts` substituiu `readStageFromComment` por `readStageFromManifest` e lê `manifest.stage`. Quando ausente, retorna `null` (não quebra).
- [x] Comentários e doc internos atualizados (frase no JSDoc do `Manifest`).

**Verification:**
- [x] `rg '"_comment"' skills/lint/cli/src/presets/oxlint/` volta vazio (cumprido junto com T1.2).
- [x] `npm test -- rules-list` verde — origin tag `preset:<stage>:<tier>` ainda derivado do stage do manifest.
- [x] `npm test` total verde (2034 ao final de T1.1).

**Dependencies:** None

**Files:**
- `skills/lint/cli/src/lib/manifest.ts`
- `skills/lint/cli/src/commands/install/oxlint.ts`
- `skills/lint/cli/src/commands/rules/list.ts`
- `skills/lint/cli/tests/unit/rules-list.test.ts` (atualizar fixtures)

**Scope:** XS

---

### T1.2 — Limpar os 6 presets: drop `_comment`, switch para `jsPlugins` (XS) ✅ DONE (`1abc1ce`)

**Description:** Edição direta dos 6 JSONs estáticos: remover `_comment`, trocar `"plugins": ["quality-metrics"]` por `"jsPlugins": ["quality-metrics"]`. Os built-in `categories` continuam intactos.

**Acceptance criteria:**
- [x] `cli/src/presets/oxlint/{greenfield,brownfield-moderate,legacy}.{fast,deep}.json` (6 arquivos):
  - [x] sem `_comment`
  - [x] sem `"plugins": [...]` (chave removida) — `jsPlugins` substituiu nos 3 deeps; fasts não tinham plugins
  - [x] deeps com `"jsPlugins": ["quality-metrics"]`
- [x] Snapshots e fixtures de tests atualizados em conjunto (`presets-oxlint.test.ts`).

**Verification:**
- [x] Após T1.1 + T1.2 + T1.3, `oxlint --config oxlint.deep.json --format json .` **não** falha com `unknown field _comment` nem `Unknown plugin: 'quality-metrics'` (verificado empiricamente).
- [x] `npm test -- presets-oxlint` verde.

**Dependencies:** T1.1 (manifest stage field precisa existir antes do install gravar nele)

**Files:**
- `skills/lint/cli/src/presets/oxlint/greenfield.fast.json`
- `skills/lint/cli/src/presets/oxlint/greenfield.deep.json`
- `skills/lint/cli/src/presets/oxlint/brownfield-moderate.fast.json`
- `skills/lint/cli/src/presets/oxlint/brownfield-moderate.deep.json`
- `skills/lint/cli/src/presets/oxlint/legacy.fast.json`
- `skills/lint/cli/src/presets/oxlint/legacy.deep.json`
- `skills/lint/cli/tests/unit/presets-coverage.test.ts` (snapshots)

**Scope:** XS

---

### T1.3 — `install-oxlint` patcha `jsPlugins` com path absoluto resolvido (S) ✅ DONE (`dad7022`)

**Description:** Bare specifier não resolve no oxlint 1.62.0. Em `install-oxlint`, após ler o preset estático e antes de chamar `safeWriteFile`, fazer `require.resolve("quality-metrics", { paths: [opts.cwd] })` e substituir `"quality-metrics"` em `jsPlugins[]` pelo path absoluto resolvido. Se o resolve falhar (pacote não instalado), retornar `error: "quality_metrics_missing"` apontando para `/lint:setup`.

> **Nota de execução:** ADR registrada como `0012-oxlint-jsplugin-resolution.md` (não `0011`, pois o slot 0011 já estava ocupado por `tsx-runtime`).

**Acceptance criteria:**
- [x] `installOxlint` resolve o path em runtime (lazy: só na primeira tier que tem `jsPlugins`) e re-grava o JSON com `jsPlugins: ["/abs/path/.../dist/index.cjs"]`. Fast preset segue byte-exato.
- [x] Se `require.resolve` lançar, retorna `{ ok: false, error: "quality_metrics_missing", reason: ... }` com exit `RECOVERABLE_ERROR`.
- [x] Test seam: `deps.resolveModule?: (id, paths) => string` com default via `createRequire(import.meta.url).resolve`.
- [x] Idempotente: re-executar com `node_modules` no mesmo lugar produz o mesmo path.

**Verification:**
- [x] `npm test -- install-oxlint` verde, incluindo cobertura do branch `quality_metrics_missing`.
- [x] `qualy install-oxlint` neste repo + `oxlint --config oxlint.deep.json --format json .` carrega o plugin (próxima falha foi exatamente B4/rule names, coberta na Phase 2).

**Dependencies:** T1.2

**Files:**
- `skills/lint/cli/src/commands/install/oxlint.ts`
- `skills/lint/cli/tests/unit/install-oxlint.test.ts`
- `docs/adrs/0012-oxlint-jsplugin-resolution.md` (NEW — doc da decisão "path absoluto via require.resolve")

**Scope:** S

---

### Checkpoint Phase 1 ✅

- [x] `oxlint --config oxlint.deep.json --format json .` num projeto fresh emite JSON (após T2.1, emite diagnostics reais — Phase 1 sozinha já desbloqueia o parse).
- [x] `npm test` verde (2047 ao final de T1.3).
- [x] ADR 0012 mergeada.

---

## Phase 2 — Audit ingere diagnostics de quality-metrics

### T2.1 — Colapsar `halstead-volume`/`halstead-effort` em `halstead` nos 6 presets (XS) ✅ DONE (`33f60f1`)

**Description:** O plugin exporta uma única rule `halstead` com options `{maxVolume, maxEffort}`. Substituir as duas linhas existentes nos 6 presets por uma única.

> **Bônus descoberto durante a implementação:** `lcom` aceita `{maxLcom}`, **não** `{max}`. Os presets antigos só passavam pela validação porque o `_comment` quebrava o parse antes de chegar à validação de options. Corrigido inline nos 3 deep presets.

**Acceptance criteria:**
- [x] Cada `*.deep.json` substitui:
  ```json
  "quality-metrics/halstead-volume": ["warn", { "max": <V> }],
  "quality-metrics/halstead-effort": ["warn", { "max": <E> }],
  ```
  por:
  ```json
  "quality-metrics/halstead": ["warn", { "maxVolume": <V>, "maxEffort": <E> }]
  ```
- [x] `*.fast.json` não continham halstead (somente `categories`) — sem mudança necessária.
- [x] Valores preservados: greenfield 800/300; brownfield-moderate 1000/400; legacy 2000/1000.
- [x] Fixtures de tests atualizados (`presets-oxlint.test.ts` agora locks `halstead` + `lcom` com `maxLcom`).
- [x] **Bônus:** `lcom` corrigido para `{maxLcom: N}` nos 3 deep presets (greenfield 0, brownfield 2, legacy 4).

**Verification:**
- [x] `rg 'halstead-volume|halstead-effort' skills/lint/cli/src/presets/` volta vazio.
- [x] `oxlint --config oxlint.deep.json --format json .` carrega presets e emite diagnostics reais (verificado empiricamente — `code: "quality-metrics(halstead)"` aparece no output).
- [x] `npm test -- presets-oxlint` verde.

**Dependencies:** T1.3

**Files:** os mesmos 6 presets de T1.2 + snapshots.

**Scope:** XS

---

### T2.2 — Atualizar `METRIC_RULE_TO_KEY` e listas canônicas de rules (S) ✅ DONE (`98b9d46`)

**Description:** Sincronizar audit + rules + recs com o conjunto real de 5 rules (`wmc, halstead, lcom, cbo, dit`).

> **Notas de execução:**
> - **Q1 resolvida:** aliases legacy (`halstead-volume`, `halstead-effort`) **mantidos** em `METRIC_RULE_TO_KEY` para backward-compat com audits antigos persistidos.
> - `recs/blast-radius.ts` não tinha refs a halstead — sem mudança.
> - `BaselineRule`/`AvailableRule`/`DefaultForStage` ganharam `maxLcom?`, `maxVolume?`, `maxEffort?` opcionais.
> - `recs/generate.ts` `pickPresetRule` virou metric-aware (`METRIC_OPTION_KEY`) para ler `maxVolume` (halstead) / `maxLcom` (lcom).
> - `rules/add.ts` halstead removido de `STAGE_BASELINE_DEEP`/`KNOWN_RULES` — UX `--max <n>` não suporta compound options; documentado no source.
> - `rules/explain.ts` migrou `_comment` → manifest stage para alinhar com `rules/list.ts` após T1.1.

**Acceptance criteria:**
- [x] `audit.ts`: `halstead: "halstead"` adicionada; `halstead-volume`/`halstead-effort` mantidos como aliases legacy (Q1=sim).
- [x] Listas canônicas em `rules/list.ts`, `rules/explain.ts`, `recs/generate.ts` enumeram 5 rules.
- [x] `recs/blast-radius.ts`: sem refs a halstead, nenhuma mudança necessária.
- [x] `audit-schema.ts`: sem mudança (`by_metric.halstead` já era single key).

**Verification:**
- [x] `npm test -- audit` verde.
- [x] `npm test -- rules-list rules-explain` verde.
- [x] **Pendência leve:** o teste `metricKeyFromRule("quality-metrics/halstead") === "halstead"` propriamente dito vai aterrissar como parte de T2.3 (a função ainda é módulo-privada hoje).

**Dependencies:** T2.1

**Files:**
- `skills/lint/cli/src/commands/audit.ts`
- `skills/lint/cli/src/commands/rules/list.ts`
- `skills/lint/cli/src/commands/rules/explain.ts`
- `skills/lint/cli/src/commands/recs/generate.ts`
- `skills/lint/cli/src/commands/recs/blast-radius.ts`
- testes unitários correspondentes

**Scope:** S

---

### T2.3 — `metricKeyFromRule` aceita ambos `ns/rule` e `ns(rule)` (S) ✅ DONE

**Description:** Bug 5 da investigação. Oxlint emite `code: "quality-metrics(wmc)"` (parens), mas o parser do audit em `audit.ts:454-462` só aceitava `ns/rule`. Tolerada agora a forma com parênteses.

> **Estado de execução:** função exportada de `audit.ts`; novo arquivo `audit-metric-key-from-rule.test.ts` cobre 24 cenários (slash, parens, foreign namespaces, degenerate inputs).

**Acceptance criteria:**
- [x] `metricKeyFromRule` reconhece:
  - `quality-metrics/wmc` (forma slash, p.ex. ESLint output ou logs internos)
  - `quality-metrics(wmc)` (forma parens, p.ex. oxlint JSON)
  - `quality-metrics(halstead)` mapeia para `halstead`
- [x] Teste unitário cobre ambos formatos para todas as 5 rules + cases negativos (`eslint(no-shadow)`, `correctness/no-debugger`, parens unclosed, tail vazio, `null`, `""`, bare identifier sem namespace).

**Verification:**
- [x] `npm test` total verde — 2072 testes (74 arquivos), +24 novos.
- [x] `npm run typecheck` verde.
- [ ] `qualy audit --tier deep` em fixture com WMC>20 plantado preenche `by_metric.wmc.top[0].file` — verificação empírica fica para T4.2 (e2e), mas o pipeline lógico (parser + aggregator) está coberto pelos unit tests existentes em `audit.test.ts` que rodam diagnostics fixture através de `aggregateViolations`.

**Dependencies:** T2.2

**Files:**
- `skills/lint/cli/src/commands/audit.ts` (exporta `metricKeyFromRule`, aceita parens form)
- `skills/lint/cli/tests/unit/audit-metric-key-from-rule.test.ts` (NEW)

**Scope:** S

---

### Checkpoint Phase 2 ✅

- [x] `metricKeyFromRule` aceita ambas formas (`ns/rule` e `ns(rule)`); cobertura por 24 unit tests novos.
- [x] `npm test` verde após T2.1+T2.2+T2.3 (2072 testes).
- [ ] `qualy audit --tier deep` em fixture sintético (classe 25 métodos) preenche `by_metric.wmc.top[0]` com `file`/`value` reais — verificação empírica fica para T4.2 (e2e); pipeline lógico já coberto por unit tests.
- [ ] Cobertura `audit.ts` ≥ 90% — não medido ainda.

---

## Phase 3 — Tooling reportado corretamente

### T3.1 — `@oxc-project/quality-metrics` → `quality-metrics` em todos os call sites (XS) ✅ DONE

**Description:** Bug 6. `install-deps` instala `quality-metrics` (unscoped, correto), mas `audit.ts:85`, `status.ts:76` e `recs/generate.ts:271,275,281` referenciavam `@oxc-project/quality-metrics` (scoped, fantasma — não existe no npm). Resultado: `tooling.quality_metrics` sempre `null`.

**Acceptance criteria:**
- [x] `audit.ts` (`TRACKED_PACKAGES.quality_metrics`) usa `"quality-metrics"`.
- [x] `status.ts` (mesma constante) usa `"quality-metrics"`.
- [x] `recs/generate.ts` (`rec-fix-tooling-quality-metrics` title/evidence/suggested_change) usa `"quality-metrics"`.
- [x] Mensagens ao usuário citam `quality-metrics` (sem o prefixo `@oxc-project/`).

**Verification:**
- [x] `rg '@oxc-project/quality-metrics' skills/lint/cli/src/` volta vazio.
- [x] Testes `status.test.ts` e `audit.test.ts` atualizados (path do `node_modules/`); `install-deps.test.ts` mantido (testa parser `specName` com inputs arbitrários).
- [x] `npm test` verde — 2072 testes (74 arquivos).
- [x] `npm run typecheck` verde.

**Dependencies:** None (paralelizável com Phase 1/2)

**Files:**
- `skills/lint/cli/src/commands/audit.ts`
- `skills/lint/cli/src/commands/status.ts`
- `skills/lint/cli/src/commands/recs/generate.ts`
- testes unitários correspondentes

**Scope:** XS

---

### Checkpoint Phase 3 ✅

- [x] Sem inconsistência entre `install-deps` e os detectores (todos referenciam `quality-metrics`).
- [x] `npm test` verde (2072).
- [ ] `qualy audit` reporta `tooling.quality_metrics` corretamente — verificação empírica fica para T4.2 (e2e); contrato lógico já testado por unit tests em `audit.test.ts:556-583`.

---

## Phase 4 — Defesa em profundidade

### T4.1 — Audit distingue `preset_invalid` de `oxlint_missing` (S)

**Description:** Bug 7. Hoje qualquer falha de oxlint com stdout vazio cai em `oxlint_missing`. Inspecionar `stderr` por âncoras de erro de config e mapear para `error: "preset_invalid"` com `reason` acionável.

**Acceptance criteria:**
- [ ] Após o `runFn` em `audit.ts:663`, se `!run.ok && run.stdout.length === 0`:
  - se `run.stderr` matches `Failed to parse oxlint configuration file|Unknown plugin|Cannot find module|Unknown rule` → `{ ok:false, error:"preset_invalid", reason: <stderr trimmed primeira linha> }`.
  - caso contrário → `oxlint_missing` (comportamento atual).
- [ ] Mensagem do erro orienta: "Reinstale o preset com /lint:setup ou restaure backup com /lint:rollback".
- [ ] Exit code: `RECOVERABLE_ERROR` (`5` no `exit-codes.ts`).

**Verification:**
- [ ] `npm test -- audit-preset-invalid` verde, incluindo fixtures de stderr para 4 tipos de falha.
- [ ] Smoke manual: editar `oxlint.deep.json` para JSON quebrado, rodar `qualy audit --tier deep` → output JSON contém `error: "preset_invalid"` e mensagem inclui `/lint:setup`.

**Dependencies:** T2.3 (precisa do pipeline funcional para diferenciar bem)

**Files:**
- `skills/lint/cli/src/commands/audit.ts:660-670`
- `skills/lint/cli/tests/unit/audit-preset-invalid.test.ts` (NEW)

**Scope:** S

---

### T4.2 — E2E: install + audit detecta violação real plantada (M)

**Description:** Bug 8. Garantir via teste end-to-end que toda a cadeia funciona em conjunto. Smoke test contra regressão de B1-B6.

**Acceptance criteria:**
- [ ] Test em `cli/tests/e2e/install/audit-detects-real-violation.test.ts`.
- [ ] Setup: tmp dir, `package.json` mínimo (`{ "name":"fixture", "version":"0.0.0", "type":"module" }`), `tsconfig.json` mínimo, `src/big-class.ts` com classe que tem 25 métodos triviais (`m1() {} m2() {} ...`).
- [ ] Steps:
  1. `npm install --prefer-offline` (oxlint, oxfmt, quality-metrics, ts-morph) usando o registry padrão.
  2. Chamar `installOxlint({ cwd, stage: "greenfield" })`.
  3. Chamar `runAudit({ cwd, tier: "deep" })`.
- [ ] Asserções:
  - [ ] `payload.violations.summary.errors >= 1`.
  - [ ] `payload.violations.by_metric.wmc.top[0].file` termina com `src/big-class.ts`.
  - [ ] `payload.violations.by_metric.wmc.top[0].value >= 25`.
  - [ ] `payload.tooling.quality_metrics === "0.1.1"`.
- [ ] Test marcado `@e2e` para opt-in (não roda no `npm test` default).

**Verification:**
- [ ] `npm run test:e2e` verde.
- [ ] Test **falha** se T1.1, T1.2, T1.3, T2.1, T2.2, T2.3, ou T3.1 forem revertidas (smoke validado manualmente revertendo cada uma).

**Dependencies:** T3.1, T4.1

**Files:**
- `skills/lint/cli/tests/e2e/install/audit-detects-real-violation.test.ts` (NEW)
- `package.json` (script `test:e2e` se ainda não existir)

**Scope:** M

---

### Checkpoint Phase 4 (final)

- [ ] Audit não silencia falhas de preset.
- [ ] E2E real prova install + audit detecta violação real.
- [ ] `quality_metrics: null` no audit só aparece se o pacote de fato não está em `node_modules/`.
- [ ] `npm test` + `npm run test:e2e` verdes.
- [ ] Cobertura ≥ 90% em `audit.ts`, `install/oxlint.ts`, `recs/generate.ts`, `status.ts`.

---

## Sumário executivo

| Phase | Tasks | Tamanho | Goal | Status |
|-------|-------|---------|------|--------|
| 1 | T1.1, T1.2, T1.3 | XS+XS+S (~1h) | Oxlint parse + plugin loaded | ✅ done |
| 2 | T2.1, T2.2, T2.3 | XS+S+S (~1.5h) | Audit agrega diagnostics em `by_metric.*` | ✅ done |
| 3 | T3.1 | XS (~20min) | `tooling.quality_metrics` correto | ✅ done |
| 4 | T4.1, T4.2 | S+M (~1.5h) | Erros explícitos + e2e regressão | ⬜ pending |

**Caminho mínimo para destravar `/lint:audit` agora:** Phase 1 ✅ + Phase 2 ✅. Pipeline lógico completo — falta Phase 3 (label correto de `tooling.quality_metrics`) e Phase 4 (defesa em profundidade + e2e).

**Paralelização:** T3.1 não depende de Phase 1/2 e pode ir em commit/PR separado. Phase 4 sequencial após T3.1.

## Referências de commit

| Commit | Task | Descrição curta |
|--------|------|-----------------|
| `e1bad99` | T1.1 | manifest gains `stage`; install-oxlint writes; rules-list reads |
| `1abc1ce` | T1.2 | drop `_comment`, `plugins` → `jsPlugins` nos 6 presets |
| `dad7022` | T1.3 | `install-oxlint` resolve quality-metrics jsPlugins to absolute path |
| `33f60f1` | T2.1 | collapse halstead pair + fix lcom option name |
| `98b9d46` | T2.2 | `METRIC_RULE_TO_KEY` + rule lists collapsed to 5 canonical rules |
| `ae9b3dd` | T2.3 | `metricKeyFromRule` aceita parens form (`ns(rule)`) + 24 unit tests |

## Referências

- `PLAN.md` (este diretório) — bugs, decisões, dependency graph.
- `.harn/docs/fixes/TASKS-quality-metrics.md` — investigação original (depreca este; mantém por histórico).
- `node_modules/quality-metrics/configs/oxlint.{fast,deep}.json` — formato canônico do plugin.
- `node_modules/oxlint/configuration_schema.json` — schema da config.
