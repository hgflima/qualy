# Contrato JSON do audit

Reference contract para `.lint-audit/<safe-timestamp>.json` — payload produzido por `/lint:audit` e consumido por `/lint:update` e `/lint:report` (SPEC §3 + ADR 0008).

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §3 (contrato canônico), `cli/src/lib/audit-schema.ts` (zod, fonte da validação), `cli/src/commands/audit.ts` (produtor), `cli/src/commands/recs/generate.ts` + `recs/apply.ts` (consumidores), `cli/src/report/data-loader.ts` (consumidor), `docs/recs-heuristics.md` (heurísticas que derivam `recommendations[]`), `docs/stages.md` (`stage` + `stage_signals`), `docs/thresholds.md` (origem de `rules_active[]`), `docs/coverage.md` (origem de `tooling.coverage`), ADR 0008 (`recommendations[]` é a fonte única de update)

## 1. Propósito

Toda execução de `/lint:audit` grava um arquivo `.lint-audit/<timestamp>.json` no repositório-alvo. Esse arquivo é o **único contrato** entre os três subsistemas que olham para o estado de qualidade do código:

- `/lint:update` itera `recommendations[]` e oferece `apply / skip / explain` por item (ADR 0008).
- `/lint:report` projeta `violations`, `tooling.coverage`, `stage_signals` e a série temporal dos audits anteriores.
- `recs/generate` (parte da pipeline de audit) lê `violations` + `rules_active` + `stage` para derivar candidatos determinísticos antes do `lint-auditor` enriquecer `rationale`.

**Invariantes.**

- Todo audit válido passa em `auditPayloadSchema.parse()` (`cli/src/lib/audit-schema.ts`) sem ajuste — drift entre código e doc quebra a suíte vitest do `audit.test.ts`.
- `version` é literal `"1"`; consumidores DEVEM gate (refuse-and-explain) antes de ler payloads de outras versões. Bump = breaking change com instrução clara em CHANGELOG e ADR.
- `generated_at` é ISO-8601 UTC com `Z` final (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`); o nome do arquivo usa o `safe-timestamp` (mesma stamp com `:` e `.` substituídos por `-`).
- O produtor é determinístico modulo (i) timestamp, (ii) versões instaladas em `node_modules/`, (iii) saída do oxlint. Mesmo repo + mesmas configs + mesmo binário → mesmo payload exceto `generated_at`.

Se você está editando o schema, este é o documento que precisa subir junto. Se você está adicionando um campo, faça-o em três pontos travados: `audit-schema.ts` (zod), `audit.ts` (produtor), este arquivo (referência humana).

## 2. Mapa estrutural

```jsonc
{
  "version": "1",                                    // §3
  "generated_at": "2026-05-04T14:22:11Z",            // §3
  "stage": "brownfield-moderate",                    // §4
  "stage_signals": { /* docs/stages.md §3 */ },      // §4
  "tooling": { /* §5 */ },
  "violations": { /* §6 */ },
  "rules_active": [ /* §7 */ ],
  "recommendations": [ /* §8 */ ]
}
```

Sete chaves no top-level. Nenhuma é opcional. Adicionar uma oitava é **breaking** (consumidores podem ter exhaustive checks); adicionar opcional dentro de subobjeto não é breaking, mas merece nota neste arquivo + bump no zod sem bump de `version`.

Tamanhos típicos observados em fixtures: 4–20 KB para `greenfield-ts`, 30–80 KB para `brownfield-eslint-prettier`, até ~250 KB para `legacy-monorepo` (`top[]` capado em 5 por métrica controla o crescimento).

## 3. Versionamento

`version` é o único toggle de compatibilidade entre produtor e consumidores.

- v1 (atual): este documento. Schema fechado em `auditPayloadSchema`.
- Bumps planejados: nenhum. Se a v2 precisar quebrar formato, o ADR correspondente substituirá ADR 0008 e este arquivo terá uma seção §3.x detalhando o diff.

Política de leitor:

```ts
if (audit.version !== "1") {
  // surface RECOVERABLE_ERROR `audit_version_unsupported` and stop.
  // Never silently coerce — drift in `recommendations[].patch` shape can
  // delete or rewrite presets in the user's repo.
}
```

`/lint:update`, `/lint:report` e `audit-latest` aplicam essa guard antes de qualquer leitura. Drift sobre payload v0 ou v2 → exit code 1, sem fallback.

## 4. `stage` e `stage_signals`

`stage` ∈ {`greenfield`, `brownfield-moderate`, `legacy`}. Calibração e regras de classificação em `docs/stages.md` §2 e §4.

`stage_signals` é um `Record<string, unknown>` deliberadamente loose — o detector pode adicionar sinais novos sem bump de `version`. Os sinais canônicos hoje (cf. `docs/stages.md` §3):

- `first_commit_date` — string ISO-8601 ou `null` (repo vazio).
- `age_days` — `number | null`.
- `source_files` — `number` (extensões `ts/tsx/js/jsx`).
- `loc` — `number` (semântica `wc -l`).
- `churn_90d` — `number` de commits nos últimos 90 dias.
- `linter_present` — `boolean`.
- `tests_present` — `boolean`.
- `todo_density` — `number` (TODO+FIXME+HACK ÷ LOC × 100, 2 casas).

Consumidores DEVEM ler defensivamente: `if ("loc" in stage_signals && typeof stage_signals.loc === "number") { … }`. O `lint-auditor` cita esses sinais por nome no `rationale`, então remover um sinal exige sweep nos templates do agent.

## 5. `tooling`

Bloco shape-fixo (ao contrário de `stage_signals`):

```jsonc
{
  "oxlint":           "1.4.2" | null,    // node_modules/oxlint/package.json#version
  "oxfmt":            "0.3.0-alpha" | null,
  "quality_metrics":  "0.6.0" | null,    // pacote @oxc-project/quality-metrics
  "test_runner":      "vitest" | "jest" | "none",
  "coverage": {
    "configured":   true,
    "lines":        67.4,                 // medição corrente (opcional, sem providers ainda)
    "functions":    71.2,
    "branches":     58.8,
    "statements":   67.0,
    "thresholds": {                      // o que está configurado, não o medido
      "lines":      70,
      "functions":  70,
      "branches":   60,
      "statements": 70
    }
  }
}
```

Notas operacionais:

- Versões `null` indicam pacote ausente em `<cwd>/node_modules/`. `recs/generate` traduz qualquer `null` em recomendação `fix-tooling`.
- `coverage.configured` é binário: `true` se `detect-test-runner` encontrou `coverage.thresholds` no config; `false` em greenfield sem coverage. Os campos numéricos atuais são informativos, podem estar ausentes hoje (audit v1 não roda o runner com `--coverage`) — o report ainda os aceita por forward-compat.
- `coverage.thresholds` espelha exatamente o que `detect-test-runner` extraiu do `vitest.config.*`/`jest.config.*`. `null` em uma chave significa "configurado em outras chaves mas não nesta"; ausência da chave significa "não configurado". `recs/generate` distingue os dois casos.
- `test_runner === "none"` desliga `tighten-coverage`/`loosen-coverage` em `recs/generate` (não há onde escrever).

## 6. `violations`

Origem: parsing do stdout do oxlint pelo `audit.ts`. Estrutura:

```jsonc
{
  "summary": {
    "errors":         12,
    "warnings":       47,
    "files_affected": 18
  },
  "by_metric": {
    "wmc":      { "violations": 4, "max_seen": 38, "top": [...] },
    "halstead": { "violations": 6, "max_seen_volume": 1840, "top": [...] },
    "lcom":     { "violations": 5, "top": [...] },
    "cbo":      { "violations": 9, "top": [...] },
    "dit":      { "violations": 1, "top": [...] }
  }
}
```

Regras canônicas:

- `summary.errors` + `summary.warnings` ≥ Σ `violations` por métrica (diagnostics fora de `quality-metrics/*` só contam no summary).
- `summary.files_affected` é o `Set` size — não sobe linearmente com `errors+warnings`.
- `by_metric` tem **exatamente 5 chaves** fixas (`wmc`, `halstead`, `lcom`, `cbo`, `dit`); novas métricas exigem bump de schema. Cada chave SEMPRE existe (ausência = `{ violations: 0, top: [] }`).
- `top[]` tem no máximo 5 entradas por métrica, ordenadas por `value` desc (`TOP_PER_METRIC = 5` em `audit.ts`). Empate quebra pela ordem do oxlint (estável dentro do diagnostic stream, não garantida entre runs).
- `max_seen_volume` aparece **apenas** sob `halstead` (a métrica composta usa volume); demais métricas usam `max_seen`. Schema dá ambos como opcionais para preservar forward-compat se halstead-effort virar primário.

`top[].class` é opcional: presente para métricas per-class (WMC, LCOM, CBO, DIT), ausente para halstead (per-file). `top[].value` e `top[].max` são opcionais para tolerar oxlint outputs antigos sem campos numéricos — o produtor preserva `undefined` em vez de coalescer para 0.

`/lint:report` usa `by_metric.<m>.top[]` para alimentar `ChartTreemap` (área = `value`, cor = severidade). `recs/generate` lê `max_seen` para decidir `raise-threshold` (cf. `docs/recs-heuristics.md` §6.1).

## 7. `rules_active`

Array — origem é a leitura combinada de `oxlint.fast.json` + `oxlint.deep.json` no cwd.

```jsonc
[
  { "rule": "category:correctness", "severity": "error", "origin": "preset:brownfield-moderate:fast" },
  { "rule": "quality-metrics/wmc",  "severity": "error", "options": { "max": 20 }, "origin": "preset:brownfield-moderate:deep" },
  { "rule": "quality-metrics/dit",  "severity": "warn",  "options": { "max": 5  }, "origin": "user-override:2026-04-12" }
]
```

Convenções:

- `rule` é a chave canônica do oxlint. Categorias do preset (`categories.<name>`) são serializadas como `category:<name>` (sintético) para o consumer ver em uma única lista. Rules genuínas mantêm o slash do oxlint (`quality-metrics/wmc`, `import/no-cycle`, etc).
- `severity` ∈ {`error`, `warn`, `off`}. `off` é raro (presets não desabilitam rules sem motivo) mas válido.
- `options` é opcional e loose (`Record<string, unknown>`). Para rules quality-metrics o shape canônico é `{ max: <number> }`; ESLint-ported rules carregam shapes próprios. Não existe schema fechado por rule — `recs/apply` faz parsing local quando precisa editar.
- `origin` é a string de procedência. Hoje canônica em três formas:
  - `preset:<stage>:<tier>` — quando o `_comment` do preset declara `stage=<name>` (calibração de fábrica).
  - `preset:<tier>` — preset sem tag de stage (raro, normalmente teste).
  - `user-override:<YYYY-MM-DD>` — escrito por `rules/add` ou `rules/remove` quando edita o preset; carrega a data da decisão.
- A ordem do array é determinística: categorias primeiro (sort lexicográfico) → rules (sort lexicográfico) → tier `fast` antes de `deep`. Não confiar nessa ordem para semântica — usar `rule` como chave única por consumidor.

`recs/generate` separa `rules_active` por `origin`: `preset:*` é ajustável (gera `raise-threshold`/`lower-threshold`), `user-override:*` é intocável (a decisão humana fica) — cross-ref `docs/recs-heuristics.md` §2.

## 8. `recommendations`

ADR 0008 trava: `recommendations[]` é a **única fonte** que `/lint:update` consome. `candidates[]` (output transitório de `recs/generate`) NÃO mora no payload final.

```jsonc
{
  "id":          "rec-001",                   // §8.1
  "type":        "raise-threshold",           // §8.2
  "title":       "WMC max está em 20 …",
  "rationale":   "Distribuição empírica permite …",
  "blast_radius": {
    "files_newly_violating":     3,
    "files_currently_violating": 4
  },
  "patch": { /* §8.3 */ },
  "severity":    "suggest",                   // suggest | recommend | critical
  "applies_to":  "oxlint.fast.json"
}
```

### 8.1 IDs

`id` é estável por audit. O gerador (`recs/generate`) deriva IDs determinísticos no padrão `rec-<type>-<metric|key>-<tier|runner>` (cf. `docs/recs-heuristics.md` §4); o `lint-auditor` preserva o ID enquanto enriquece `rationale`. `recs/apply` usa `id` como chave de lookup. Drift de ID = comando idempotente vira não-idempotente.

### 8.2 Types e policies

| `type` | Patch shape (§8.3) | Auto-aplicável? | Exige `--reason`? | Kind no manifest |
|---|---|---|---|---|
| `raise-threshold`   | `{ rule, max }`           | sim | não | `threshold-raise` |
| `lower-threshold`   | `{ rule, max }`           | sim | **sim** | `threshold-lower` |
| `add-rule`          | `{ rule, max, severity? }`| sim | não | `rule-add` |
| `remove-rule`       | `{ rule }`                | sim | **sim** | `rule-remove` |
| `tighten-coverage`  | `{ runner, key, threshold }` | sim | não | `rec-apply` |
| `loosen-coverage`   | `{ runner, key, threshold }` | sim | **sim** | `coverage-lower` |
| `enable-tier`       | livre                     | **não** (delega ao harness) | n/a | `rec-apply` |
| `fix-tooling`       | livre                     | **não** (delega ao harness) | n/a | `rec-apply` |

Fonte da tabela: `cli/src/commands/recs/apply.ts:75-99` — qualquer drift contra essa fonte deve falhar o teste deste documento.

Policies derivadas:

- `severity: critical` (ex.: hook PostToolUse quebrado, peer-dep faltando) sobe ao topo da fila no `/lint:update` antes de `recommend` e `suggest`.
- `enable-tier` e `fix-tooling` saem do CLI: `recs/apply` retorna `unsupported_type` e o orquestrador (`commands/lint/update.md`) delega para `lint-installer` ou para um setup manual.
- Types em `REASON_REQUIRED_TYPES` (`lower-threshold`, `remove-rule`, `loosen-coverage`) só aplicam com `--reason "<texto>"`; ausência → `RECOVERABLE_ERROR`. Cross-ref SPEC §6 Always.

### 8.3 `patch`

`patch` é `Record<string, unknown>` no schema — opaco em zod, narrowed em runtime por `recs/apply`. Shapes canônicos hoje:

```jsonc
// raise-threshold | lower-threshold
{ "rule": "quality-metrics/wmc", "max": 14 }

// add-rule
{ "rule": "import/no-cycle", "max": 1, "severity": "warn" }

// remove-rule
{ "rule": "no-console" }

// tighten-coverage | loosen-coverage
{ "runner": "vitest", "key": "lines", "threshold": 80 }

// enable-tier | fix-tooling
// shape livre — delegated to harness, validated only by the harness orchestrator
```

`applies_to` discrimina o arquivo-alvo do patch:

- `"oxlint.fast.json"` ou `"oxlint.deep.json"` para qualquer type que mexe em preset oxlint.
- `"vitest"` ou `"jest"` para `tighten-coverage`/`loosen-coverage` — `recs/apply` resolve o config concreto via `findExisting(VITEST_CONFIG_CANDIDATES)` ou edita `package.json#jest`.
- Strings livres (ex.: `"hook"`, `"deps"`) para `enable-tier`/`fix-tooling`, lidas pelo harness.

`blast_radius` chega populado pelo `recs/blast-radius` (oxlint dry-run com config proposta) ou pelo gerador quando o sinal é puro contagem; SPEC §6 Always exige campo presente, mesmo com `0` em ambos.

## 9. Como o usuário discorda

Os três pontos onde a fila de recomendações é negociada com o humano:

1. `/lint:update` → `apply | skip | explain` por item (`AskUserQuestion`).
2. `recs/apply --dry-run` (cf. `recs/blast-radius`) — vê a edição final sem escrever em disco.
3. `docs/lint-decisions.md` — cada `apply` faz append com timestamp, `id`, `--reason` quando exigido. É o contraponto editorial ao `recommendations[]` automático.

Skip de recomendação NÃO modifica o audit: o JSON é imutável depois de gravado. O próximo `/lint:audit` recalcula recommendations a partir do estado atual; se a config já foi mexida, a recomendação correspondente desaparece (ou muda forma).

## 10. Drift e versionamento

Quem edita o quê:

- `cli/src/lib/audit-schema.ts` — o schema zod **é** o contrato. Toda mudança de shape começa aqui.
- `cli/src/commands/audit.ts` — produtor. Tem que continuar produzindo payload válido contra o schema.
- `cli/src/commands/recs/{generate,apply,blast-radius}.ts`, `cli/src/commands/audit-latest.ts`, `cli/src/report/data-loader.ts` — consumidores. Cada um mantém suas próprias guards de versão e leitura defensiva.
- Este documento — referência humana. Atualizar junto com o schema, não depois. Drift entre `audit-schema.ts` e este arquivo é falha de PR (cf. ADR 0006: docs versionadas com o código).

Suíte de regressão: `cli/tests/unit/audit*.test.ts` valida produção contra o schema; `cli/tests/e2e/audit-recommendations.test.ts` valida o pipeline `audit → recs-generate → lint-auditor (rationale) → recs-apply`. Quebras nesses suites = drift entre código e este doc.
