# Tasks — Reparar pipeline `quality-metrics`

> Companion de `PLAN.md`. Cada Task ≤ 30 min focados. Verificar `npm test` verde entre tasks.
>
> **Verificação universal entre tasks:**
> ```bash
> PATH="./node_modules/.bin:$PATH" oxlint --config oxlint.deep.json --format json . 2>&1 | head -5
> ```
> Esperado: stdout começa com `{` (Phase 1+) ou diagnostics JSON; nunca `Failed to parse oxlint configuration file` após T1.1+T1.2 aplicadas em conjunto.

---

## Phase 1 — Oxlint volta a parsear e carregar o plugin

### T1.1 — Mover stage-meta de `_comment` para `.lint-manifest.json` (XS)

**Description:** `_comment` é rejeitado pelo schema de `oxlint 1.62.0`. Mover o conteúdo (`stage`) para um campo de topo `stage` no `.lint-manifest.json` (já é qualy-only, já é gravado pelo install). Atualizar `rules/list.ts` para ler de lá.

**Acceptance criteria:**
- [ ] `cli/src/lib/manifest.ts` aceita campo opcional `stage: string` no topo, validado no read.
- [ ] `cli/src/commands/install/oxlint.ts` grava `stage` no manifest após escrever os presets.
- [ ] `cli/src/commands/rules/list.ts:250` (`readStageFromComment`) é renomeada para `readStageFromManifest` e lê `manifest.stage`. Quando ausente, retorna `null` (não quebra).
- [ ] Comentários e doc internos atualizados.

**Verification:**
- [ ] `rg '"_comment"' skills/lint/cli/src/` volta vazio (fora de tests/CHANGELOG).
- [ ] `npm test -- rules-list` verde — output preserva `stage` correto após install.
- [ ] `npm test` total verde.

**Dependencies:** None

**Files:**
- `skills/lint/cli/src/lib/manifest.ts`
- `skills/lint/cli/src/commands/install/oxlint.ts`
- `skills/lint/cli/src/commands/rules/list.ts`
- `skills/lint/cli/tests/unit/rules-list.test.ts` (atualizar fixtures)

**Scope:** XS

---

### T1.2 — Limpar os 6 presets: drop `_comment`, switch para `jsPlugins` (XS)

**Description:** Edição direta dos 6 JSONs estáticos: remover `_comment`, trocar `"plugins": ["quality-metrics"]` por `"jsPlugins": ["quality-metrics"]`. Os built-in `categories` continuam intactos.

**Acceptance criteria:**
- [ ] `cli/src/presets/oxlint/{greenfield,brownfield-moderate,legacy}.{fast,deep}.json` (6 arquivos):
  - [ ] sem `_comment`
  - [ ] sem `"plugins": [...]` (chave removida)
  - [ ] com `"jsPlugins": ["quality-metrics"]`
- [ ] Snapshots e fixtures de tests atualizados em conjunto (não em commit separado).

**Verification:**
- [ ] Após T1.1 + T1.2 + T1.3 instalados, `oxlint --config oxlint.deep.json --format json .` **não** falha com `unknown field _comment` nem `Unknown plugin: 'quality-metrics'`.
- [ ] `npm test -- presets` verde.

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

### T1.3 — `install-oxlint` patcha `jsPlugins` com path absoluto resolvido (S)

**Description:** Bare specifier não resolve no oxlint 1.62.0. Em `install-oxlint`, após ler o preset estático e antes de chamar `safeWriteFile`, fazer `require.resolve("quality-metrics", { paths: [opts.cwd] })` e substituir `"quality-metrics"` em `jsPlugins[]` pelo path absoluto resolvido. Se o resolve falhar (pacote não instalado), retornar `error: "quality_metrics_missing"` apontando para `/lint:setup`.

**Acceptance criteria:**
- [ ] `installOxlint` resolve o path em runtime e re-grava o JSON com `jsPlugins: ["/abs/path/.../dist/index.js"]`.
- [ ] Se `require.resolve` lançar, retorna `{ ok: false, error: "quality_metrics_missing", reason: ... }` com exit `RECOVERABLE_ERROR`.
- [ ] Test seam: `deps.resolveModule?: (id, paths) => string` com default `require.resolve`.
- [ ] Idempotente: re-executar com `node_modules` no mesmo lugar produz o mesmo path.

**Verification:**
- [ ] `npm test -- install-oxlint` verde, incluindo cobertura do branch "module not resolvable".
- [ ] `qualy install-oxlint` num projeto fresh + `oxlint --config oxlint.deep.json --format json .` carrega o plugin (a próxima falha esperada vem do B4 — rule names — coberta na Phase 2).

**Dependencies:** T1.2

**Files:**
- `skills/lint/cli/src/commands/install/oxlint.ts`
- `skills/lint/cli/tests/unit/install-oxlint.test.ts`
- `docs/adrs/0011-oxlint-jsplugin-resolution.md` (NEW — doc da decisão "path absoluto via require.resolve")

**Scope:** S

---

### Checkpoint Phase 1

- [ ] `oxlint --config oxlint.deep.json --format json .` num projeto fresh emite JSON (mesmo que rejeitando rule names — esperado).
- [ ] `npm test` verde.
- [ ] ADR 0011 mergeada.

---

## Phase 2 — Audit ingere diagnostics de quality-metrics

### T2.1 — Colapsar `halstead-volume`/`halstead-effort` em `halstead` nos 6 presets (XS)

**Description:** O plugin exporta uma única rule `halstead` com options `{maxVolume, maxEffort}`. Substituir as duas linhas existentes nos 6 presets por uma única.

**Acceptance criteria:**
- [ ] Cada `*.deep.json` substitui:
  ```json
  "quality-metrics/halstead-volume": ["warn", { "max": <V> }],
  "quality-metrics/halstead-effort": ["warn", { "max": <E> }],
  ```
  por:
  ```json
  "quality-metrics/halstead": ["warn", { "maxVolume": <V>, "maxEffort": <E> }]
  ```
- [ ] `*.fast.json` que continham as duas rules também colapsadas.
- [ ] Valores `<V>`/`<E>` preservam os thresholds atuais por stage (greenfield 800/300; brownfield-moderate 1000/400; legacy preserva).
- [ ] Fixtures de tests atualizados.

**Verification:**
- [ ] `rg 'halstead-volume|halstead-effort' skills/lint/cli/src/presets/` volta vazio.
- [ ] `oxlint --config oxlint.deep.json --format json .` carrega presets sem erro de rule desconhecida.
- [ ] `npm test -- presets` verde.

**Dependencies:** T1.3

**Files:** os mesmos 6 presets de T1.2 + snapshots.

**Scope:** XS

---

### T2.2 — Atualizar `METRIC_RULE_TO_KEY` e listas canônicas de rules (S)

**Description:** Sincronizar audit + rules + recs com o conjunto real de 5 rules (`wmc, halstead, lcom, cbo, dit`).

**Acceptance criteria:**
- [ ] `audit.ts:96-103`: chaves `"halstead-volume"` e `"halstead-effort"` removidas; `"halstead": "halstead"` é a única entrada para halstead. **Q1 (PLAN):** manter ou não os aliases legacy — default **sim**, manter por compatibilidade com audits antigos persistidos.
- [ ] Listas canônicas em `rules/list.ts`, `rules/explain.ts`, `recs/generate.ts`, `recs/blast-radius.ts` enumeram 5 rules (não 6).
- [ ] `audit-schema.ts`: nenhuma mudança esperada (`by_metric.halstead` já existe como single key — confirmar via test).

**Verification:**
- [ ] `npm test -- audit` verde — incluindo test novo que verifica `metricKeyFromRule("quality-metrics/halstead") === "halstead"`.
- [ ] `npm test -- rules` verde.
- [ ] `qualy rules-list` em projeto recém-setupado mostra exatamente 5 rules `quality-metrics/*`.

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

### T2.3 — `metricKeyFromRule` aceita ambos `ns/rule` e `ns(rule)` (S)

**Description:** Bug 5 da investigação. Oxlint emite `code: "quality-metrics(wmc)"` (parens), mas o parser do audit em `audit.ts:454-462` só aceita `ns/rule`. Tolerar ambas as formas.

**Acceptance criteria:**
- [ ] `metricKeyFromRule` reconhece:
  - `quality-metrics/wmc` (forma slash, p.ex. ESLint output ou logs internos)
  - `quality-metrics(wmc)` (forma parens, p.ex. oxlint JSON)
  - `quality-metrics(halstead)` mapeia para `halstead`
- [ ] Teste unitário cobre ambos formatos para todas as 5 rules + 1 case negativo (`eslint(no-shadow)` retorna `null`).

**Verification:**
- [ ] `npm test -- audit` verde, especialmente `metricKeyFromRule.test.ts`.
- [ ] `qualy audit --tier deep` em fixture com WMC>20 plantado preenche `by_metric.wmc.top[0].file`.

**Dependencies:** T2.2

**Files:**
- `skills/lint/cli/src/commands/audit.ts:454-462`
- `skills/lint/cli/tests/unit/audit-metric-key-from-rule.test.ts` (NEW ou append)

**Scope:** S

---

### Checkpoint Phase 2

- [ ] `qualy audit --tier deep` em fixture sintético (classe 25 métodos) preenche `by_metric.wmc.top[0]` com `file`/`value` reais.
- [ ] `npm test` verde.
- [ ] Cobertura `audit.ts` ≥ 90%.

---

## Phase 3 — Tooling reportado corretamente

### T3.1 — `@oxc-project/quality-metrics` → `quality-metrics` em todos os call sites (XS)

**Description:** Bug 6. `install-deps` instala `quality-metrics` (unscoped, correto), mas `audit.ts:85`, `status.ts:76` e `recs/generate.ts:251,255,261` referenciam `@oxc-project/quality-metrics` (scoped, fantasma — não existe no npm). Resultado: `tooling.quality_metrics` sempre `null`.

**Acceptance criteria:**
- [ ] `audit.ts:85` (`TRACKED_PACKAGES.quality_metrics`) usa `"quality-metrics"`.
- [ ] `status.ts:76` (mesma constante) usa `"quality-metrics"`.
- [ ] `recs/generate.ts:251,255,261` (mensagens + chave de rec) usam `"quality-metrics"`.
- [ ] Mensagens ao usuário citam `quality-metrics` (sem o prefixo `@oxc-project/`).

**Verification:**
- [ ] `rg '@oxc-project/quality-metrics' skills/lint/cli/src/` volta vazio.
- [ ] `qualy status` num projeto com `quality-metrics` instalado mostra `versions.quality_metrics: "0.1.1"`.
- [ ] `qualy audit` retorna `tooling.quality_metrics === "0.1.1"`.
- [ ] `npm test` verde, incluindo testes unitários de `status` e `recs-generate`.

**Dependencies:** None (paralelizável com Phase 1/2)

**Files:**
- `skills/lint/cli/src/commands/audit.ts`
- `skills/lint/cli/src/commands/status.ts`
- `skills/lint/cli/src/commands/recs/generate.ts`
- testes unitários correspondentes

**Scope:** XS

---

### Checkpoint Phase 3

- [ ] Sem inconsistência entre `install-deps` e os detectores.
- [ ] `qualy audit` reporta `tooling.quality_metrics` corretamente.
- [ ] `npm test` verde.

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

| Phase | Tasks | Tamanho | Goal |
|-------|-------|---------|------|
| 1 | T1.1, T1.2, T1.3 | XS+XS+S (~1h) | Oxlint parse + plugin loaded |
| 2 | T2.1, T2.2, T2.3 | XS+S+S (~1.5h) | Audit agrega diagnostics em `by_metric.*` |
| 3 | T3.1 | XS (~20min) | `tooling.quality_metrics` correto |
| 4 | T4.1, T4.2 | S+M (~1.5h) | Erros explícitos + e2e regressão |

**Caminho mínimo para destravar `/lint:audit` agora:** Phase 1 + Phase 2 (Phase 3 é independente e barata; Phase 4 protege contra regressão futura — fazer no mesmo PR ou em PR separado).

**Paralelização:** T3.1 não depende de Phase 1/2 e pode ir em commit/PR separado. Phase 1 → 2 → 4 são sequenciais; T2.1 e T2.2 são parcialmente paralelizáveis se o conflict no `audit.ts` for resolvido depois.

## Referências

- `PLAN.md` (este diretório) — bugs, decisões, dependency graph.
- `.harn/docs/fixes/TASKS-quality-metrics.md` — investigação original (depreca este; mantém por histórico).
- `node_modules/quality-metrics/configs/oxlint.{fast,deep}.json` — formato canônico do plugin.
- `node_modules/oxlint/configuration_schema.json` — schema da config.
