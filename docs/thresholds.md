# Tabela completa de thresholds por estágio + métrica

Reference contract para os 12 arquivos de preset versionados em `cli/src/presets/oxlint/` e `cli/src/presets/coverage/`. É o documento canônico para responder "qual valor deveria estar configurado num projeto X?".

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §3 (Calibração de thresholds por estágio + Estratégia de coverage), `cli/src/presets/oxlint/<stage>.{fast,deep}.json` (presets oxlint), `cli/src/presets/coverage/{vitest,jest}.<stage>.{ts,json}` (presets coverage), `docs/stages.md` (heurística que escolhe o estágio), `docs/coverage.md` (estratégia coverage por runner — futura), ADR 0003 (justificativa empírica dos cortes — pendente)

## 1. Propósito

Quando `/lint:setup` decide o estágio (via `detectStage` ou `--stage` explícito), ele **copia byte-a-byte** seis arquivos para o projeto-alvo: dois presets de oxlint (`oxlint.fast.json`, `oxlint.deep.json`) e um trecho de config de coverage (vitest ou jest, dependendo do runner detectado). Os valores numéricos vivem nos arquivos JSON/TS dentro de `cli/src/presets/`; este documento é a **referência humana** para aqueles arquivos.

Este documento serve três audiências:

1. **Usuário** que quer entender por que `WMC max=20` apareceu em `oxlint.deep.json` no projeto dele — vem ler aqui em vez de raciocinar sobre o que é "brownfield".
2. **Reviewer** de PR que vai mudar um threshold e precisa entender o ripple: muda `cli/src/presets/oxlint/legacy.deep.json` → quebra `cli/tests/unit/presets-oxlint.test.ts` → atualiza esta tabela e recompila o argumento.
3. **Agente** que invoca `/lint:rules:explain wmc` ou `/lint:update`: a recomendação carrega a tabela como racionalização legível.

**Invariante.** Os números desta tabela são **idênticos** aos JSON/TS dentro de `cli/src/presets/`. Se divergirem, a tabela está errada — a fonte de verdade são os arquivos de preset. A suite `cli/tests/unit/presets-{oxlint,coverage}.test.ts` trava o lock entre tabela e arquivos.

## 2. Mapa estrutural

Cada estágio carrega **dois tiers** de oxlint preset + **um arquivo** de coverage por runner:

```
greenfield ────┬─→ cli/src/presets/oxlint/greenfield.fast.json          (oxc só)
               ├─→ cli/src/presets/oxlint/greenfield.deep.json          (oxc + quality-metrics)
               ├─→ cli/src/presets/coverage/vitest.greenfield.ts        (se runner=vitest)
               └─→ cli/src/presets/coverage/jest.greenfield.json        (se runner=jest)

brownfield-moderate ─┬─→ … brownfield-moderate.fast.json
                     ├─→ … brownfield-moderate.deep.json
                     ├─→ vitest.brownfield.ts
                     └─→ jest.brownfield.json

legacy ───────┬─→ … legacy.fast.json
              ├─→ … legacy.deep.json
              ├─→ vitest.legacy.ts                                       (carrega `_warnOnly: true`)
              └─→ jest.legacy.json                                       (carrega `_warnOnly: true`)
```

`/lint:setup` copia exatamente **dois arquivos oxlint** (fast + deep) e **um arquivo coverage** (o que casa com o runner detectado). Coverage não é copiado quando `runner === "none"`.

## 3. Tier semantics — fast vs deep

A separação `.fast` / `.deep` existe por **custo de execução**, não por escopo conceitual:

| Tier | Plugins | Uso | Custo médio | Onde é invocado |
|---|---|---|---|---|
| **fast** | nenhum (só `categories`) | feedback rápido por arquivo | <50ms / file | PostToolUse hook (`post-edit.sh`), pre-commit pipeline (etapa 2) |
| **deep** | `quality-metrics` (WMC, Halstead, LCOM, CBO, DIT) | análise estrutural por classe | ~500ms / file | pre-commit pipeline (etapa 3, só em arquivos que sobreviveram ao fast), `npm run lint:deep`, `/lint:audit` |

O tier deep só carrega `plugins:["quality-metrics"]` — todas as 6 rules `quality-metrics/*` requerem esse plugin. Fast tier **nunca** referencia rules `quality-metrics/*` (lock travado em `presets-oxlint.test.ts`).

A ordem `fast antes de deep` em `lint-staged.config` é um invariante (`docs/stages.md` referencia, `cli/src/templates/lintstagedrc.example.js` implementa): pagar o custo deep só nos arquivos que já passaram no barato evita o pior caso de fail-after-expensive-analysis.

## 4. Categorias do oxc (fast tier)

Todos os presets fast só configuram `categories`. As categorias do oxc agregam dezenas de rules — por estágio, escolhemos a **severidade agregada**:

| Categoria | Greenfield | Brownfield moderado | Legado pesado |
|---|---|---|---|
| `correctness` | `error` | `error` | `warn` |
| `suspicious` | `warn` | `warn` | `warn` |

**Por que `correctness=warn` em legacy?** Um repo de >50k LOC com débito acumulado provavelmente tem dezenas de violações de `no-unused-vars`, `prefer-const`, etc. Subir como `error` bloqueia commits durante refactor sem oferecer caminho de escape. Em legacy a meta é **medir** sem bloquear; o usuário sobe para `error` manualmente via `/lint:rules:add` quando estiver pronto.

**Por que `suspicious` é sempre `warn`?** Suspicious flags coisas como `no-debugger`, `no-eval` — ruim em todo lugar, mas frequentemente resíduo legítimo de debugging. Warn é a escolha conservadora: aparece nos relatórios sem quebrar build.

**Categorias não configuradas pelos presets** (`pedantic`, `style`, `restriction`, `nursery`, `perf`): ficam no default do oxc (`off`). O usuário pode ativar via `/lint:rules:add` se quiser opt-in explícito — não impomos opinião por padrão.

## 5. Quality-metrics rules (deep tier)

Tabela canônica das 6 rules de complexidade. Severidade indica como cada estágio reage; `max` é o limite que dispara violação.

### 5.1 Tabela mestre

| Métrica | Greenfield | Brownfield moderado | Legado pesado |
|---|---|---|---|
| `quality-metrics/wmc` | `["error", { "max": 15 }]` | `["error", { "max": 20 }]` | `["warn", { "max": 40 }]` |
| `quality-metrics/halstead-volume` | `["warn", { "max": 800 }]` | `["warn", { "max": 1000 }]` | `["warn", { "max": 2000 }]` |
| `quality-metrics/halstead-effort` | `["warn", { "max": 300 }]` | `["warn", { "max": 400 }]` | `["warn", { "max": 1000 }]` |
| `quality-metrics/lcom` | `["warn", { "max": 0 }]` | `["warn", { "max": 2 }]` | `["warn", { "max": 4 }]` |
| `quality-metrics/cbo` | `["error", { "max": 8 }]` | `["error", { "max": 10 }]` | `["warn", { "max": 20 }]` |
| `quality-metrics/dit` | `["warn", { "max": 4 }]` | `["warn", { "max": 5 }]` | `["warn", { "max": 6 }]` |

**Ler como JSON real**: estes blocos são copiados verbatim para `oxlint.deep.json` no projeto-alvo. Cada entry segue o shape `[<severity>, <options>]` que oxc aceita.

### 5.2 Glossário das métricas

| Métrica | Mede | Por que importa |
|---|---|---|
| **WMC** (Weighted Methods per Class) | soma de complexidade ciclomática dos métodos da classe | classe com WMC alto faz "muita coisa" — alvo natural de Single Responsibility refactor |
| **Halstead Volume** | tamanho informacional (operators × operandos), proxy de "quanto há para ler" | volume alto → função difícil de entender mesmo se simples ciclomaticamente |
| **Halstead Effort** | esforço cognitivo estimado (`difficulty × volume`) | proxy de "quanto custa modificar com confiança" |
| **LCOM** (Lack of Cohesion of Methods) | quantos métodos da classe não compartilham campos | LCOM > 0 indica que a classe agrega responsabilidades não relacionadas |
| **CBO** (Coupling Between Objects) | quantas outras classes esta classe referencia/é referenciada por | acoplamento alto → mudança em uma trinca várias |
| **DIT** (Depth of Inheritance Tree) | profundidade da herança (Object = 0 ou 1, dependendo da convenção) | herança profunda esconde comportamento — composição costuma ser preferível |

### 5.3 Por que essa progressão de severidade?

| Métrica | Greenfield severity | Brownfield severity | Legacy severity | Racionalização |
|---|---|---|---|---|
| WMC | error | error | warn | "classe gigante" é red flag em todo estágio, mas em legacy refactor cego é arriscado — só avisa |
| Halstead (volume + effort) | warn | warn | warn | proxy estatístico — ruim para fail build, ótimo para visualizar tendência no `/lint:report` |
| LCOM | warn | warn | warn | métrica controvérsia (várias definições competem na literatura); warn em todo estágio reflete cautela |
| CBO | error | error | warn | acoplamento alto entre objetos é red flag arquitetural — força extração em greenfield/brownfield |
| DIT | warn | warn | warn | herança profunda é mais smell do que defeito — mostrar mas não bloquear |

WMC + CBO são as duas que sobem para `error` em greenfield/brownfield porque correlacionam mais fortemente com defeitos no campo (Basili et al. 1996; Subramanyam & Krishnan 2003).

### 5.4 Por que esses valores de `max`?

Os tetos vêm do README do `quality-metrics` (intervalos sugeridos por industry consensus) com a tabela do PLAN §3 ajustada para nossa heurística de três estágios:

- **WMC**: `15 / 20 / 40`. Literatura clássica (McCabe 1976, Henderson-Sellers 1996) coloca classes "saudáveis" entre 6–15. Brownfield acomoda o long tail da maioria dos repos; legacy abre para 40 porque god-classes de >50 raramente cabem em refactor única.
- **Halstead Volume**: `800 / 1000 / 2000`. Volume = N × log₂(η). Funções de ~30 linhas tipicamente caem entre 300–700; o teto greenfield de 800 captura métodos que estão começando a virar utilities monolíticas.
- **Halstead Effort**: `300 / 400 / 1000`. Effort cresce não-linearmente com difficulty; teto greenfield bloqueia funções com muitos branches + variáveis distintas.
- **LCOM**: `0 / 2 / 4`. LCOM=0 (greenfield) força classes coesas desde o dia zero — é o único valor "perfeito" da tabela, deliberadamente; brownfield/legacy abrem porque retroceder LCOM em código existente é caro.
- **CBO**: `8 / 10 / 20`. Estudos consistentemente mostram CBO>14 correlacionando com fault-proneness; teto greenfield bem abaixo desse joelho.
- **DIT**: `4 / 5 / 6`. DIT=4–5 é o joelho histórico onde frameworks Java/C# que abusam de herança começam a doer. Não bloqueamos porque eliminar herança em código TypeScript existente raramente vale a pena.

Justificativa empírica completa em ADR 0003 (pendente — esta task fixa a tabela; o ADR documentará a literatura).

### 5.5 Severidades fast tier (recapitulando)

Para evitar duplicação: o tier fast NÃO declara rules `quality-metrics/*`. Apenas as severidades agregadas de `categories.{correctness, suspicious}` (§4) entram em jogo. Isso significa:

- Em PostToolUse hook (fast), nenhuma violação de WMC/Halstead/LCOM/CBO/DIT é sinalizada — só correctness/suspicious do oxc.
- Em pre-commit (fast → deep), o pipeline chama deep apenas nos arquivos que sobreviveram ao fast.

## 6. Coverage thresholds

Tabela canônica para `cli/src/presets/coverage/{vitest,jest}.<stage>.{ts,json}`. Mesmos números cross-runner (lock travado em `presets-coverage.test.ts`):

| Estágio | lines | functions | branches | statements | warn-only? |
|---|---|---|---|---|---|
| Greenfield | 90 | 90 | 80 | 90 | não |
| Brownfield moderado | 70 | 70 | 60 | 70 | não |
| Legado pesado | 40 | 40 | 30 | 40 | **sim** (`_warnOnly: true`) |

### 6.1 Provider e reporters

Todos os presets carregam:

- `provider: "v8"` (vitest) / `coverageProvider: "v8"` (jest) — alinha com `@vitest/coverage-v8` que `install-deps` instala. v8 evita instrumentação de Babel/SWC e é ~3× mais rápido que istanbul.
- Reporters fixos: `["text", "json", "json-summary", "html"]`. `json-summary` é o que `/lint:audit` lê para popular `tooling.coverage` no JSON de auditoria; `html` para humano explorar; `text` para terminal.

### 6.2 O flag `_warnOnly`

Vitest e jest **não suportam** `warn` nativo em coverage threshold — abaixo do teto, o exit code é non-zero independente de severidade. Para legacy (onde 40% é meta de progresso, não gate), os presets carregam `_warnOnly: true` no JSON/TS. `install-coverage` lê esse flag e decide o caminho:

1. Escreve os valores e tolera exit code de fail (próximo `npm test` falha — usuário aceita o sinal).
2. Emite um wrapper soft-check (script auxiliar que roda coverage e classifica como warn em vez de fail).

A decisão entre (1) e (2) é responsabilidade de `install-coverage` e do harness — não desta tabela. A presença de `_warnOnly` é o **interruptor**.

### 6.3 Cross-runner consistency

Vitest e jest carregam **valores idênticos** por estágio (lock em `presets-coverage.test.ts`). Trocar de runner não muda o que o projeto exige — só onde o número vive (`vitest.config.ts#test.coverage.thresholds` vs `jest.config.{js,json}#coverageThreshold.global`).

### 6.4 Por que esses números?

- **Greenfield 90/90/80/90**: código novo deve nascer com testes; ainda dá tempo de escrever o teste antes do bug. Branches em 80 (não 90) reconhece que cobrir 100% dos branches em código defensivo (try/catch, guards) frequentemente exige testes de baixo valor.
- **Brownfield 70/70/60/70**: 70% é o joelho histórico onde "tem teste" deixa de ser questão moral e vira contrato. Branches em 60 acomoda código de glue/router que tipicamente tem coverage estrutural mais baixo.
- **Legacy 40/40/30/40 (warn-only)**: 40% é o piso onde "alguém olhou" ainda é detectável. Bloquear seria sabotar o próprio uso da skill — o sinal warn-only entra no `/lint:report` e move com o tempo.

Estratégia detalhada por runner em `docs/coverage.md` (futura).

## 7. Outros campos versionados

### 7.1 `$schema`

Cada preset oxlint carrega:

```json
"$schema": "./node_modules/oxlint/configuration_schema.json"
```

Path padrão de `oxlint init` (relativo ao `oxlint.{fast,deep}.json` no root do projeto-alvo). Quando o usuário abre o JSON no VS Code, o schema do oxlint instalado localmente provê autocomplete + validação.

### 7.2 `_comment`

Cada preset carrega:

```json
"_comment": "qualy preset · stage=<x> · tier=<y> · generated=2026-05-03"
```

Marca de provenance — humano que clica em `oxlint.deep.json` no editor entende imediatamente de onde veio. `presets-oxlint.test.ts` valida o formato exato (drift quebra ali).

### 7.3 Plugins

Apenas o tier deep declara `plugins: ["quality-metrics"]`. Fast tier não declara `plugins` (campo ausente, default = sem plugins).

## 8. Como o usuário discorda

Ordem de preferência (do mais cirúrgico ao mais drástico):

1. **Editar `oxlint.{fast,deep}.json` no projeto** depois de `/lint:setup`. Os arquivos são versionados; a edição fica em git diff e a equipe revisa. Para tornar permanente em outros projetos, contribuir o ajuste em `cli/src/presets/oxlint/`.
2. **`/lint:rules:add` ou `/lint:rules:remove`** para rules específicas — o motivo entra em `docs/lint-decisions.md` (append-only) com timestamp + autor.
3. **`/lint:update`** lê o último `.lint-audit/<ts>.json` e propõe `raise-threshold` / `lower-threshold` por métrica baseado em distribuição empírica do repo. `blast_radius` mostra quantos arquivos passam a violar / deixam de violar antes do user aceitar.
4. **`--stage <explicit>`** em `/lint:setup` se o usuário discorda fundamentalmente da classificação. O detector emite os sinais brutos (`docs/stages.md`); usuário rebate com evidência.
5. **Substituir os arquivos em `cli/src/presets/`** + abrir PR. Mudança no preset → quebra os testes de matriz (`presets-oxlint.test.ts`, `presets-coverage.test.ts`) → updates em `docs/thresholds.md` (este arquivo) precisam acompanhar. CI bloqueia merge sem ambos.

## 9. Drift e versionamento

Esta tabela é **derivada** dos arquivos JSON/TS dentro de `cli/src/presets/`. Locks em três níveis:

1. `cli/tests/unit/presets-oxlint.test.ts` (39 tests) trava metadata (`$schema`, `_comment`), severidades por estágio × rule (matriz exata), `max` por estágio × rule (matriz exata).
2. `cli/tests/unit/presets-coverage.test.ts` (51 tests) trava provider, reporters, thresholds por estágio × runner, presença/ausência do flag `_warnOnly`, cross-runner consistency.
3. `presets-oxlint.test.ts` adicionalmente assert que rules `quality-metrics/*` aparecem **apenas** no tier deep (drift de plugin entre tiers quebra ali).

Mudanças válidas:

- Apertar/afrouxar `max`: editar JSON → atualizar tabela §5.1 / §6 → atualizar testes de matriz → ADR (se for mudança opinada substantiva).
- Mudar severidade: idem, ainda mais cuidado em ADR (`error → warn` afrouxa contrato com usuário).
- Adicionar nova métrica `quality-metrics/*`: editar todos os 3 deep presets + tabela §5 + glossário §5.2 + tests + ADR justificando.

Mudanças NÃO válidas sem discussão:

- Mover threshold de greenfield para acima de brownfield (ou vice-versa): viola a invariante "estágios formam continuum de rigor".
- Quebrar cross-runner consistency em coverage (vitest≠jest): obrigaria usuários multi-runner a manter dois conjuntos mentais.
- Adicionar plugin novo (`quality-metrics` é o único hoje): força revisão da arquitetura "oxc-only v1" (ADR 0001 pendente).

Versão atual: `v1` (gerada em `2026-05-03`). Próxima versão revisita §5.1 (oxc-rules) e §6 (coverage) com base em empírica de uso real.
