# Estratégia de coverage por runner

Reference contract para `cli/src/commands/install/coverage.ts` (SPEC §3 — Estratégia de coverage). É o documento canônico para responder "como o qualy decide o que escrever no `vitest.config.ts` ou no `jest.config.json` do projeto-alvo, e por quê?".

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §3 (Estratégia de coverage + tabela de metas), `cli/src/commands/install/coverage.ts` (orquestrador), `cli/src/commands/detect-test-runner.ts` (probe de runner + thresholds existentes), `cli/src/lib/ts-config-edit.ts` (edição via ts-morph), `cli/src/presets/coverage/{vitest,jest}.<stage>.{ts,json}` (valores numéricos), `docs/thresholds.md` §6 (tabela canônica de números), `docs/stages.md` (heurística que escolhe o estágio), ADR 0005 (relação `/lint:report` × coverage report do runner — pendente)

## 1. Propósito

Antes de bloquear nada, o qualy precisa **medir**. Coverage é o sinal mais barato e universal de "este código está testado o suficiente para confiar quando refatoro". Mas: cada runner expõe um shape diferente (`vitest.config.ts#test.coverage` vs `jest.config.json#coverageThreshold.global`), e o usuário **frequentemente já tem** thresholds configurados — sobrescrever cega quebra o contrato implícito ("eu já decidi 60%, não me empurra 90%").

Esta skill resolve dois problemas:

1. **Detectar antes de propor.** Antes de qualquer write, `detect-test-runner` lê o que o projeto já tem (config + thresholds existentes) e o harness mostra ao usuário. Defaults só entram quando o usuário concorda.
2. **Aplicar com cirurgia.** Edição via ts-morph (vitest) ou merge JSON (jest) preserva sibling keys (`testMatch`, `transform`, `setupFiles`). O qualy nunca reescreve um config inteiro — só insere/atualiza o subtree de coverage.

**Invariante.** Mesmo runner detectado + mesmo estágio + mesmo conteúdo de config inicial → mesmo conteúdo final. Coverage é determinístico; reruns são noop quando os valores já batem (`presets-coverage.test.ts` + `install-coverage.test.ts` travam o lock).

## 2. Mapa estrutural

Seis arquivos de preset (2 runners × 3 estágios) versionados em `cli/src/presets/coverage/`:

```
greenfield ──────────┬─→ vitest.greenfield.ts        (export default {...}, lido via ts-morph)
                     └─→ jest.greenfield.json        (parse JSON, fonte numérica de verdade)

brownfield-moderate ─┬─→ vitest.brownfield.ts
                     └─→ jest.brownfield.json

legacy ──────────────┬─→ vitest.legacy.ts            (carrega `_warnOnly: true`)
                     └─→ jest.legacy.json            (carrega `_warnOnly: true`)
```

`install-coverage` resolve **sempre** os números via `jest.<stage>.json#coverageThreshold.global` (mesmo no caminho vitest) — esse arquivo é a única fonte numérica de verdade. `presets-coverage.test.ts` trava cross-runner consistency byte-a-byte: se vitest e jest divergem, o teste falha antes de chegar no usuário.

Os arquivos vitest carregam metadata adicional (provider/reporter literais no shape `test.coverage.{...}`) porque vão direto para `applyVitestCoverage`; os arquivos jest carregam o shape `coverageThreshold.global` que é o que jest espera.

## 3. Fluxo do install-coverage

```
detect-test-runner ──→ runner ∈ {vitest, jest, none}
                       │
   ┌───────────────────┼───────────────────────┐
   │                   │                       │
"none"               "vitest"                 "jest"
   │                   │                       │
noop                resolve stage         resolve stage
                    (explicit | detect)   (explicit | detect)
                       │                       │
                    read jest.<stage>.json  read jest.<stage>.json
                    (= thresholds + warnOnly) (= thresholds + warnOnly)
                       │                       │
                    findExistingFile          findExistingFile
                    (vitest.config.{ts,mts,…})(jest.config.json | js | none)
                       │                       │
                    ┌──┴──┐                ┌──┴──┐
                    found  none             json  js     none
                      │     │                │    │      │
                ts-morph  skeleton          merge reject merge into
                edit      + edit            json         package.json#jest
                      │     │                │           │
                   safeWriteFile          safeWriteFile  safeWriteFile
```

Etapas chave:

1. **Resolução de runner.** `detect-test-runner` (read-only). `--runner <name>` força explicit (skip detect). `runner === "none"` retorna noop com `action: "noop"`, `stage: opts.stage ?? null`, `thresholds: opts.thresholds ?? null` — coverage **não** é instalado quando não há runner; o harness é quem pergunta "quer adotar Vitest?".
2. **Resolução de estágio.** `--stage <name>` força explicit; senão `detectStage()` (mesma heurística de `docs/stages.md`). Falha de detecção bubble-up como `stage_detection_failed` (`RECOVERABLE_ERROR`).
3. **Resolução de thresholds.** `--thresholds <json>` (caller-composed override) tem precedência. Quando ausente, lê `cli/src/presets/coverage/jest.<stage_slug>.json#coverageThreshold.global`. Slug mapping: `brownfield-moderate → brownfield` (preset filenames usam slug curto; nome do estágio segue `detect-stage`).
4. **`warnOnly` flag.** Sempre lido do jest preset (mesmo na rota vitest). Quando `--thresholds` é explicit + `--stage` ausente, `warnOnly = false` (não há preset de onde tirar). Quando `--thresholds` + `--stage` ambos presentes, ainda lemos o preset **só** para extrair o flag.
5. **Aplicação.** Vitest → `applyVitest` (ts-morph). Jest → `applyJest` (JSON merge ou package.json merge ou rejeição de JS/TS).

## 4. Caminho vitest

### 4.1 Edição de config existente

`findExistingFile` testa `vitest.config.{ts,mts,cts,js,mjs,cjs}` na ordem listada. Primeiro hit vence — convenção do ecossistema vitest.

`applyVitestCoverage(source, patch)` (em `cli/src/lib/ts-config-edit.ts`) usa ts-morph para:

- Localizar a chamada `defineConfig({...})` ou o `export default {...}`.
- Garantir o subtree `test.coverage.{provider, reporter, thresholds}`.
- Mergear o patch sem tocar em sibling keys (`testMatch`, `setupFiles`, `globals`, `pool`, `transform`, etc).
- Comparar leaf-by-leaf: se `provider`, todos os elementos de `reporter`, e todas as 4 chaves de `thresholds` já batem, retorna `changed: false` → `action: "noop"`, `written: null`. Skip do write inteiro.

Comentários e formatação do arquivo original são preservados (ts-morph manipula a AST + reemite). Diff visualmente mínimo: o usuário vê só o subtree coverage no `git diff`.

### 4.2 Skeleton fallback

Quando nenhum vitest config existe, escreve este skeleton:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {},
});
```

Em seguida, `applyVitestCoverage` aplica o patch normalmente. O resultado é um arquivo válido contendo só o coverage block do qualy. Created vs updated marcado no output (`action: "created"`, `written.merged: false`).

Por que não apenas escrever um arquivo final pronto? Para que **um único caminho** seja o canônico de inserção (ts-morph). Bypassar quebraria invariantes de formatação que `applyVitestCoverage` mantém (ordem de chaves, indentação, vírgula trailing).

### 4.3 Provider e reporter

Hardcoded em `coverage.ts`:

```ts
const REPORTERS = ["text", "json", "json-summary", "html"] as const;
const PROVIDER  = "v8";
```

`provider: "v8"` casa com `@vitest/coverage-v8` que o usuário precisa instalar manualmente (ou via `install-deps` quando ampliado — hoje `install-deps` cobre só a trinca lint/format/quality-metrics; ampliação é tracking issue separado). Istanbul é ~3× mais lento e exige instrumentação em build step; v8 lê direto do V8 inspector.

Reporters fixos:

- `text` → terminal output durante `npm test --coverage`.
- `json` → consumível por ferramentas externas.
- `json-summary` → **crítico**: `coverage/coverage-summary.json` é o que `cli/src/report/data-loader.ts` lê para popular o card de coverage no `/lint:report` (e o que `audit.ts` enriquece em `tooling.coverage`). Remover `json-summary` quebra o report.
- `html` → exploração humana em `coverage/index.html`.

A lista é canônica (`presets-coverage.test.ts` valida ordem e conteúdo exatos).

## 5. Caminho jest

Ordem de tentativa em `applyJest`:

1. `jest.config.json` existe? → `applyJestJson` (caminho preferido).
2. Algum `jest.config.{ts,js,mts,mjs,cts,cjs}` existe? → **rejeita** com `jest_js_config_unsupported` + reason explicando como o usuário aplica manualmente.
3. Senão → `applyJestPackageJson` (merge em `package.json#jest`).

### 5.1 Por que rejeitar JS/TS jest configs

`jest.config.js` é um `module.exports = { ... }` arbitrário — pode incluir `require()` dinâmicos, spreads, transformers parametrizados. Editar via ts-morph é viável mas **regular**: cada config selvagem é um caso. Em vez de gerar bug latente, `install-coverage` para e devolve uma reason acionável (`apply the coverage block manually or migrate to jest.config.json`).

Esta é uma decisão consciente de escopo MVP. Tracking de upgrade futuro:

- Detectar shape simples (`module.exports = { ... }` sem spread/require) → ts-morph com whitelist.
- Cair para o erro atual em qualquer outra forma.

Por enquanto: o harness recebe a reason, o usuário escolhe entre aplicar manualmente ou migrar config para JSON.

### 5.2 Merge em jest.config.json

`mergeIntoJest(existing, thresholds)`:

- `collectCoverage: true` (forçado).
- `coverageProvider: "v8"` (forçado — alinhado com vitest, evita instrumentação Babel).
- `coverageReporters: [...REPORTERS]` (mesma lista que vitest, mesmo contrato com data-loader).
- `coverageThreshold.global.{lines, functions, branches, statements}` recebe os 4 valores.

Sibling keys (`testMatch`, `transform`, `moduleNameMapper`, etc) são preservadas — o merge é shallow no top level + targeted no subtree de coverage. `changed: false` quando todos os 4 leaves de threshold + os 3 campos top-level já batem → `action: "noop"`.

### 5.3 Merge em package.json#jest

Quando não há `jest.config.json` nem JS/TS config, mas há `package.json`, o merge entra em `package.json#jest`. Lógica idêntica ao jest.config.json — só muda o arquivo destino.

Quando `package.json#jest` está ausente, é criado. Quando presente, sibling keys (`preset`, `setupFilesAfterEach`, etc) são preservadas; só `coverageThreshold.global`, `coverageProvider`, `coverageReporters`, `collectCoverage` são tocados.

### 5.4 Auto-criação de jest.config.json?

**Não.** Diferente do vitest skeleton, `install-coverage` não cria `jest.config.json` do zero. Razão: jest é mais opinionado sobre onde a config vive; criar um arquivo novo quando o usuário usa `package.json#jest` quebraria a convenção do projeto. O caminho `applyJestPackageJson` cobre o caso "sem config standalone" sem introduzir novo arquivo.

## 6. Thresholds e warn-only

Os números completos vivem em **`docs/thresholds.md` §6** (tabela canônica cross-runner + racionalização por estágio). Cross-ref direto para evitar drift:

- Tabela: `docs/thresholds.md` §6 (canônica).
- Provider/reporter lock: `docs/thresholds.md` §6.1.
- Por que cada número: `docs/thresholds.md` §6.4.

### 6.1 O flag `_warnOnly`

Vitest e jest **não suportam** `warn` nativo em coverage threshold — abaixo do teto, exit code é non-zero independente de severidade. Para o estágio legacy (40/40/30/40 como meta de progresso, não gate), os presets carregam `_warnOnly: true`.

`install-coverage` lê o flag e o **propaga no output** (`warnOnly: boolean`). O qualy CLI **não** atua sobre o flag por si — quem decide é o harness:

- **Caminho A (default).** Escrever os valores normalmente. `npm test` falha quando o coverage atual está abaixo do teto. Usuário aceita o sinal e aprende qual percentual subir.
- **Caminho B.** Emitir um wrapper soft-check (script auxiliar `npm run coverage:soft` que roda coverage e degrada exit-code para warn). PLAN §Fase 5 anota isto como tracking — fora do escopo MVP do `install-coverage`.

A presença do flag é o **interruptor**; sua semântica downstream é responsabilidade do harness e do `lint:setup` (skill).

### 6.2 Override explícito

`--thresholds '{"lines":N,"functions":N,"branches":N,"statements":N}'` substitui completamente os valores do preset. O flag `_warnOnly` ainda é lido **se** `--stage` também for explícito (precisa do preset de algum lugar). Quando só `--thresholds` é passado (sem `--stage`), `warnOnly` cai para `false` — o caller é responsável por decidir o threshold *e* a semântica.

Output marca `thresholdsSource: "explicit" | "preset"` para o harness/audit poderem rastrear procedência (`docs/lint-decisions.md` registra a decisão).

## 7. Loop de feedback com `/lint:audit` e `/lint:report`

Os reporters fixos (§4.3) plantam dois arquivos em `coverage/`:

- `coverage/coverage-summary.json` (formato istanbul `total.<dim>.pct`).
- `coverage/index.html` (exploração visual humana).

`/lint:audit` (`cli/src/commands/audit.ts:540-560`) popula `tooling.coverage` lendo:

- **`configured`** + **`thresholds`** ← `detect-test-runner` (probe estático do config — não roda nada).
- **Valores reais (`lines`, `functions`, etc)** ← `coverage/coverage-summary.json` quando presente (audit não roda `npm test`; assume que o usuário rodou recentemente).

`/lint:report` (via `cli/src/report/data-loader.ts:loadCoverage`) parsa o mesmo `coverage-summary.json` para renderizar o card de coverage. Quando o arquivo está ausente ou malformado, o card **degrada graciosamente** (esconde) — sem erro, sem rerun automático.

Este desacoplamento (write threshold ≠ run coverage ≠ read summary) é proposital: `install-coverage` é determinístico e rápido; `npm test --coverage` é caro e fica fora do path crítico de instalação.

## 8. Output do install-coverage

Shape canônico (PLAN §Contratos CLI):

```jsonc
{
  "ok": true,
  "cwd": "/abs/path",
  "runner": "vitest",                    // vitest | jest | none
  "stage": "brownfield-moderate",        // ou null se runner=none e --stage ausente
  "stageSource": "detected",             // explicit | detected | n/a
  "thresholds": { "lines": 70, "functions": 70, "branches": 60, "statements": 70 },
  "thresholdsSource": "preset",          // explicit | preset | n/a
  "warnOnly": false,                     // true só em legacy preset (sem --thresholds explícito)
  "written": {
    "path": "/abs/path/vitest.config.ts",
    "bytes": 412,
    "recorded": true,                    // entrada criada em .qualy/manifest.json
    "merged": true,                      // edit em arquivo existente (não created)
    "changed": true                      // false em noop runs (idempotência)
  },
  "action": "updated"                    // updated | noop | created
}
```

Em failure: `{ ok: false, error: <code>, reason: <message> }` (sempre stderr para human, JSON para machine via `output()`).

Códigos de erro: `usage_error` (4), `stage_detection_failed` / `preset_read_failed` / `preset_malformed` / `config_read_failed` / `config_edit_failed` / `config_malformed` / `package_json_missing` / `package_json_malformed` / `jest_js_config_unsupported` / `write_failed` (1), com exit `DIRTY_TREE` (3) quando `--strict` + working tree dirty.

## 9. Como o usuário discorda

Ordem do mais cirúrgico ao mais drástico:

1. **Editar o config diretamente** (`vitest.config.ts` ou `jest.config.json`) depois de `/lint:setup`. Os valores são versionados; revisão de PR é o gate. Se o usuário baixar `lines: 70 → 60`, `lint:audit` próxima rodada vai notar o gap entre threshold e o default do estágio em `recommendations[]`.
2. **`--thresholds <json>` em `/lint:setup`** quando o usuário sabe de antemão que quer custom. `thresholdsSource: "explicit"` aparece no output e o harness loga em `.lint-decisions.md`.
3. **`--stage <explicit>`** quando o usuário discorda da classificação (ver `docs/stages.md` §8). Coverage thresholds passam a vir do preset do estágio escolhido.
4. **Editar `cli/src/presets/coverage/jest.<stage>.json`** (e o vitest correspondente, mantendo cross-runner identity) + abrir PR. Quebra `presets-coverage.test.ts` se a tabela em `docs/thresholds.md` §6 não for atualizada junto. CI bloqueia.

`install-coverage` **nunca** afrouxa thresholds existentes silenciosamente: o caminho jest faz comparison field-by-field e propõe os valores do preset; quem decide entre manter, adotar default, ou definir custom é o harness via `AskUserQuestion` (SPEC §3 — "se já existir threshold, mostra valor atual antes de perguntar"). Esta skill apenas executa a decisão.

## 10. Drift e versionamento

Locks em três níveis:

1. **`cli/tests/unit/presets-coverage.test.ts`** — trava metadata (`$schema`/`_comment`), provider, reporters, thresholds por estágio × runner, presença/ausência do flag `_warnOnly`, cross-runner consistency byte-a-byte. Mudou um número no preset sem atualizar `docs/thresholds.md` §6 → CI verde. Mudou só `docs/thresholds.md` §6 sem o preset → este teste falha (a tabela do teste vem de `docs/thresholds.md` §6).
2. **`cli/tests/unit/install-coverage.test.ts`** — trava o fluxo: vitest skeleton fallback, ts-morph preserva sibling keys, JSON merge em jest, package.json merge, rejeição de JS/TS, idempotência (rerun → noop), `warnOnly` propaga, `--thresholds` override.
3. **`cli/src/lib/ts-config-edit.ts` tests** — trava o behavior do ts-morph (preserva comentários, ordem de chaves, formatação).

Mudanças válidas:

- Apertar/afrouxar threshold em um estágio: editar JSON+TS preset de ambos runners → atualizar `docs/thresholds.md` §6 → atualizar `presets-coverage.test.ts` matriz → ADR (se for mudança opinada substantiva).
- Mudar provider (`v8 → istanbul`): editar `coverage.ts` constants + atualizar `install-deps` para incluir `@vitest/coverage-istanbul` / `babel-plugin-istanbul` + atualizar §4.3 + ADR justificando o regredir performance.
- Adicionar reporter (`lcov` p.ex.): editar `REPORTERS` em `coverage.ts` + atualizar todos os 6 presets (para manter cross-runner identity) + atualizar §4.3 + atualizar `data-loader` se o reporter novo for consumido pelo report.

Mudanças NÃO válidas sem discussão:

- Cross-runner divergence (vitest com 70/jest com 75 no mesmo estágio): viola invariante de `presets-coverage.test.ts` e quebra mental model do usuário multi-runner.
- Auto-decidir warn-only em estágio diferente de legacy: o flag é semântica de estágio, não de execução. Adicionar em brownfield/greenfield exige ADR + revisão da estratégia inteira.
- Suporte a JS/TS jest config sem whitelist explícita: regridi para o caso "edit-everything" é onde bugs nascem.

Versão atual: v1 (qualy MVP, 2026-05-04). Próxima revisão pode reabrir §5.1 (suporte parcial a JS jest configs) e §6.1 (caminho B do soft-check wrapper).
