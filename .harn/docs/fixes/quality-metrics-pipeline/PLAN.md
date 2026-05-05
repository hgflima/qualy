# Plan — Reparar pipeline `quality-metrics` no `/lint:audit`

> Status: 2026-05-05. Substitui (e corrige) `.harn/docs/fixes/TASKS-quality-metrics.md`.
> Bugs validados empiricamente em `oxlint 1.62.0` + `quality-metrics 0.1.1`.

---

## Status de execução (2026-05-05, fim da sessão)

| Phase | Task | Status | Commit |
|-------|------|--------|--------|
| 1 | T1.1 — manifest gains `stage` field; install-oxlint writes; rules-list reads | ✅ done | `e1bad99` |
| 1 | T1.2 — clean 6 presets (drop `_comment`, `plugins` → `jsPlugins`) | ✅ done | `1abc1ce` |
| 1 | T1.3 — `install-oxlint` patches `jsPlugins` w/ absolute path (ADR 0012) | ✅ done | `dad7022` |
| 2 | T2.1 — collapse halstead pair + fix `lcom` option name | ✅ done | `33f60f1` |
| 2 | T2.2 — `METRIC_RULE_TO_KEY` + rule lists collapsed to 5 canonical rules | ✅ done | `98b9d46` |
| 2 | T2.3 — `metricKeyFromRule` aceita `ns/rule` E `ns(rule)` | ✅ done | _(ver TASKS.md tabela de commits)_ |
| 3 | T3.1 — substituir `@oxc-project/quality-metrics` → `quality-metrics` | ⬜ pending | — |
| 4 | T4.1 — audit distingue `preset_invalid` de `oxlint_missing` | ⬜ pending | — |
| 4 | T4.2 — e2e install + audit detecta violação real plantada | ⬜ pending | — |

**Estado da árvore (final da sessão):**
- `npm test` verde — 2072 testes passando (+24 novos em `audit-metric-key-from-rule.test.ts`).
- `npm run typecheck` verde.
- `oxlint --config oxlint.deep.json --format json .` neste repo carrega o plugin e emite diagnostics reais com `code: "quality-metrics(halstead)"` (Phase 1 + T2.1 verificadas empiricamente).
- Phase 2 ✅ completa — `metricKeyFromRule` agora aceita ambas formas, audit já agrega em `by_metric.*`.
- ADR 0012 mergeada (`docs/adrs/0012-oxlint-jsplugin-resolution.md`).

**Bugs descobertos fora do escopo do PLAN original (já fixados):**
- `lcom` aceita `{maxLcom}`, **não** `{max}` — corrigido em T2.1 nos 3 deep presets + nos baselines de `rules/list.ts` e `rules/explain.ts`.
  - **Pendência conhecida:** `rules/add.ts` ainda usa `max` para lcom (writeria preset inválido). Não corrigido aqui — exigiria refactor de compound options.
- `rules/add.ts` baseline e `KNOWN_RULES` perderam halstead (em vez de manter como max-único quebrado) — comentário no source documenta o motivo: compound options não suportadas pela UX `--max <n>`.
- `rules/explain.ts` migrou de `_comment` → manifest stage para alinhar com `rules/list.ts` (orthogonal a T2.2 mas necessário para consistência após T1.1; checkpoint da Phase 1 garantia que `_comment` deixa de ser fonte de verdade).
- `recs/generate.ts` `pickPresetRule` é agora metric-aware via `METRIC_OPTION_KEY` (lê `maxVolume` para halstead, `maxLcom` para lcom) — sem isso a heurística de raise/lower-threshold para halstead/lcom retornava `null`.

**Pendências para retomar:**
1. T3.1 — `rg '@oxc-project/quality-metrics' skills/lint/cli/src/` ainda retorna matches em `audit.ts:85`, `status.ts:76`, `recs/generate.ts:251,255,261`. Paralelizável; XS.
2. T4.1 + T4.2 — Phase 4 (defesa em profundidade). Precisa de T3.1 mergeada antes do e2e fazer sentido.

---

## Overview

Hoje `/lint:audit --tier deep` num repo de 161 arquivos / 62k LOC reporta `errors=0, warnings=0, tooling.quality_metrics=null`. Causa raiz: **uma cadeia de 6 bugs** entre os presets estáticos, o ingestor de diagnostics do audit e os detectores de tooling. Cada bug esconde o próximo — os 4 do preset bloqueiam o oxlint de carregar; o 5º (formato `code` parens vs slash) impede o audit de agregar diagnostics mesmo se o oxlint funcionar; o 6º (nome scoped fantasma) deixa `tooling.quality_metrics` sempre null.

**Goal:** `/lint:audit --tier deep` num fixture com violação plantada (classe com 25 métodos) preenche `by_metric.wmc.top[0]` com o file/value reais e reporta `tooling.quality_metrics === "0.1.1"`. Regressão coberta por e2e.

---

## Bugs a corrigir (cada um verificado contra código + runtime)

| # | Bug | Onde | Evidência |
|---|-----|------|-----------|
| **B1** | `_comment` rejeitado pelo schema oxlint 1.62.0 | 6× `cli/src/presets/oxlint/<stage>.<tier>.json` + leitura em `cli/src/commands/rules/list.ts:250` | `oxlint --config ... --format json .` → `unknown field '_comment', expected one of $schema, plugins, jsPlugins, ...` |
| **B2** | `plugins: ["quality-metrics"]` deveria ser `jsPlugins` (o array `plugins` é só built-in) | mesmos 6 presets | Após remover `_comment`: `Unknown plugin: 'quality-metrics'`. O próprio `node_modules/quality-metrics/configs/oxlint.deep.json` usa `jsPlugins`. |
| **B3** | Bare specifier `"quality-metrics"` não resolve em `jsPlugins` | mesmos 6 presets (estratégia de path) | Com `jsPlugins:["quality-metrics"]`: `Cannot find module 'quality-metrics'`. Com path absoluto → carrega. |
| **B4** | `quality-metrics/halstead-volume` + `halstead-effort` não existem; o plugin exporta **uma** rule `halstead` com `{maxVolume, maxEffort}` | mesmos 6 presets + `cli/src/commands/audit.ts:96-103` (`METRIC_RULE_TO_KEY`) + listagens em `rules/list.ts`, `rules/explain.ts`, `recs/generate.ts`, `recs/blast-radius.ts` | `node_modules/quality-metrics/configs/oxlint.fast.json` usa `quality-metrics/halstead` |
| **B5** | `metricKeyFromRule` (`audit.ts:454`) só aceita `ns/rule`, mas oxlint emite `code: "ns(rule)"` (parênteses) — diagnostics nunca caem em `by_metric.*` | `cli/src/commands/audit.ts:454-462` | Oxlint JSON real: `"code":"quality-metrics(wmc)"`. `rule.indexOf("/") === -1` → retorna `null`. |
| **B6** | `@oxc-project/quality-metrics` (scoped, fantasma) usado em `TRACKED_PACKAGES` e mensagens, mas `install-deps` instala `quality-metrics` (unscoped) | `audit.ts:85`, `status.ts:76`, `recs/generate.ts:251,255,261` | `tooling.quality_metrics` sempre `null` mesmo com pacote instalado. |
| **B7** | Audit retorna `oxlint_missing` quando preset está inválido — mensagem confusa | `audit.ts:151,664-670` | Parse error tem stdout vazio + stderr não vazio → cai no branch "binary missing". Usuário não recebe orientação real. |
| **B8** | Sem e2e que prova install + audit detecta violação real | `cli/tests/e2e/` | Ausência permitiu B1-B6 passarem por dias. |

---

## Architecture decisions

1. **Editar os 6 presets JSON diretamente.** Não há "gerador" — `cli/src/commands/install/oxlint.ts` apenas copia byte-for-byte de `cli/src/presets/oxlint/<stage>.<tier>.json`. As 3 stages reais (não 4 como o doc antigo sugeria) são `greenfield`, `brownfield-moderate`, `legacy`.

2. **Stage-meta sai do `_comment`** e vai para `.lint-manifest.json` (campo de topo `stage: <name>`). O manifest já é qualy-only e já é gravado pelo install. `rules/list.ts:250` passa a lê-lo de lá; quando ausente, `stage: null` e o output mantém o contrato.

3. **`jsPlugins` recebe path absoluto resolvido em runtime** (Opção B do TASKS antigo, formalizada via ADR 0011). O `install-oxlint` chama `require.resolve("quality-metrics", { paths: [cwd] })` e re-grava o JSON em `oxlint.{fast,deep}.json` com o path concreto. Tradeoff: quebra ao mover `node_modules` entre máquinas — mitigado por `qualy install-oxlint` ser idempotente e re-executável após `npm ci`. Opção (A) (path relativo `./node_modules/...`) foi descartada por quebrar quando oxlint é invocado de subpasta. Opção (C) (config JS) foi descartada por adicionar superfície (oxlint marca config TS/JS como experimental).

4. **`metricKeyFromRule` aceita ambos formatos.** Pequena tolerância no parser do audit em vez de re-mapear no source de output do oxlint — minimiza risco de regressão se o formato mudar entre versões.

5. **`preset_invalid` é um erro distinto** de `oxlint_missing`. Detecção por inspeção de `stderr` por strings âncora (`Failed to parse oxlint configuration file`, `Unknown plugin`, `Cannot find module`, `Unknown rule`). Mensagem de erro orienta o usuário a `/lint:setup` ou `/lint:rollback`.

6. **E2E vive em `cli/tests/e2e/install/audit-detects-real-violation.test.ts`** — usa tmp dir, instala via primitivas (`installDeps` + `installOxlint`), gera `src/big-class.ts`, roda `runAudit` e asserta `by_metric.wmc.top[0].file === "src/big-class.ts"`. Smoke test puro contra regressão de toda a cadeia.

---

## Dependency graph

```
B1 (presets _comment)              ──┐
B2 (plugins → jsPlugins)             ├── desbloqueia oxlint parse
B3 (path resolution + ADR 0011)    ──┘
                                       │
                                       ▼
B4 (halstead unificado nos 6 JSONs + audit/rules/recs)
                                       │
                                       ▼
B5 (metricKeyFromRule aceita ns(rule))
                                       │
                                       ▼
        Audit pipeline funciona end-to-end ✓
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
B6 (nome scoped → unscoped em audit/status/recs)         B7 (preset_invalid)
                │                                             │
                └──────────────────────┬──────────────────────┘
                                       ▼
                                  B8 (e2e regressão)
```

---

## Vertical slicing

Cada Phase encerra num **estado verificável** (oxlint parse / audit ingest / tooling reportado / e2e verde). Tasks dentro de uma Phase compartilham um único critério de "ainda funciona".

### Phase 1 — Oxlint volta a parsear e carregar o plugin (B1+B2+B3)
Todas as tasks da Phase 1 deixam o oxlint num estado mais saudável. Verificação universal:
```bash
PATH="./node_modules/.bin:$PATH" oxlint --config oxlint.deep.json --format json . 2>&1 | head -5
```
Phase 1 está completa quando o comando acima emite **JSON**, não `Failed to parse ...`.

### Phase 2 — Audit ingere diagnostics de quality-metrics (B4+B5)
`qualy audit --tier deep` num fixture sintético (classe 25 métodos) preenche `by_metric.wmc.top[0]`.

### Phase 3 — Tooling reportado corretamente (B6)
`qualy status` em projeto com `quality-metrics` instalado mostra `versions.quality_metrics: "0.1.1"` (não null). `recs-generate` cita o nome correto.

### Phase 4 — Defesa em profundidade (B7+B8)
Preset deliberadamente quebrado falha com `error: "preset_invalid"` + reason acionável. E2E real (install→audit) verde.

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Path absoluto no preset quebra ao clonar repo / mudar máquina | Médio | `qualy install-oxlint` é idempotente — basta re-rodar pós `npm ci`. ADR 0011 documenta. |
| Mudança em `METRIC_RULE_TO_KEY` quebra audits antigos persistidos em `.lint-audit/<ts>.json` | Baixo | `audit-schema.ts` valida `version`. Schema fica igual; só o aggregator muda. |
| `metricKeyFromRule` aceitar 2 formatos esconde regressão de upstream | Baixo | Test unitário cobre ambos formatos com snapshot. |
| Detecção de `preset_invalid` por string-match em stderr é frágil entre versões do oxlint | Médio | Cobertura por test unitário com fixtures de stderr; degrada para `oxlint_missing` se nenhuma âncora bater. |
| E2E roda `npm install` no tmp dir → lento | Baixo | Test usa `--prefer-offline` + cache npm; alternativa: copiar `node_modules` symlink se ficar > 30s. |

---

## Open questions

Nenhuma bloqueia o início da Phase 1. Resolver durante Phase 2:

- **Q1:** Manter `halstead-volume`/`halstead-effort` como aliases legados no `METRIC_RULE_TO_KEY` para audits gravados com presets antigos? (Default proposto: **sim**, custa 2 linhas e protege snapshots históricos.)

Resolver antes da Phase 4:

- **Q2:** O fixture do e2e usa fast ou deep tier? (Default proposto: **deep**, é o caminho que falhou em produção.)

---

## Out of scope

- Refatorar `cli/src/commands/install/oxlint.ts` para virar gerador real (hoje é cópia). Suficiente que `install-oxlint` faça o `require.resolve` em runtime e patche o JSON antes de gravar.
- Mudar contratos de `audit-schema.ts` (`by_metric.halstead` continua single key).
- Fixar versão do `quality-metrics` no `install-deps` (já está unscoped correto).
- Documentar o pipeline em README (entra no follow-up `/lint:report` se necessário).

---

## Checkpoints

- **Após Phase 1** (B1+B2+B3): `oxlint --config oxlint.deep.json --format json .` produz JSON. `npm test` verde.
- **Após Phase 2** (B4+B5): `qualy audit --tier deep` num fixture com violação WMC plantada preenche `by_metric.wmc.top[0]`. `npm test` verde.
- **Após Phase 3** (B6): `qualy status` reporta `versions.quality_metrics`. Sem `@oxc-project/quality-metrics` no source (exceto CHANGELOG). `npm test` verde.
- **Após Phase 4** (B7+B8): preset propositalmente quebrado retorna `error: "preset_invalid"`. E2E verde. `npm test` verde + cobertura ≥ 90% nos 4 módulos tocados.

---

## Files likely touched

**Presets (6):**
- `skills/lint/cli/src/presets/oxlint/greenfield.{fast,deep}.json`
- `skills/lint/cli/src/presets/oxlint/brownfield-moderate.{fast,deep}.json`
- `skills/lint/cli/src/presets/oxlint/legacy.{fast,deep}.json`

**CLI source:**
- `skills/lint/cli/src/commands/install/oxlint.ts` (path resolution + manifest write)
- `skills/lint/cli/src/commands/audit.ts` (METRIC_RULE_TO_KEY, metricKeyFromRule, TRACKED_PACKAGES, preset_invalid)
- `skills/lint/cli/src/commands/status.ts` (TRACKED_PACKAGES)
- `skills/lint/cli/src/commands/recs/generate.ts` (nome scoped)
- `skills/lint/cli/src/commands/rules/{list,explain}.ts` (rule names + stage-meta source)
- `skills/lint/cli/src/commands/recs/blast-radius.ts` (rule names)

**Manifest:**
- `skills/lint/cli/src/lib/manifest.ts` (campo `stage`)

**Tests:**
- `skills/lint/cli/tests/unit/audit.test.ts` (metricKeyFromRule)
- `skills/lint/cli/tests/unit/install-oxlint.test.ts` (path resolution)
- `skills/lint/cli/tests/e2e/install/audit-detects-real-violation.test.ts` (NEW)

**Docs:**
- `docs/adrs/0011-oxlint-jsplugin-resolution.md` (NEW)
