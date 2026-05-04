# ADR 0003 — Heurística determinística de detecção de estágio (greenfield / brownfield-moderate / legacy)

- Status: aceito
- Data: 2026-05-04
- Relacionados: ADR 0001 (oxc-only v1), ADR 0006 (CLI determinístico com harness fino), ADR 0008 (rationale híbrida)

## Contexto

O SPEC do `/lint` (`.harn/docs/mvp/SPEC.md`) condiciona quase tudo o que é escrito no projeto-alvo ao **estágio** classificado:

- §3 linhas 191-198 — *"Os thresholds variam por estágio (`greenfield`, `brownfield-moderate`, `legacy`) e são calibrados em presets versionados."*
- §3 estratégia de coverage — vitest/jest thresholds por estágio (90/90/80/90 → 70/70/60/70 → 40/40/30/40).
- §6 Always linha 388 — *"Sempre justificar a classificação de estágio com os sinais brutos coletados."*
- §6 Never linha 412 — *"Nunca aplicar thresholds sem detectar o estágio primeiro."*

Aplicar threshold de greenfield em código legado gera 200 erros no primeiro `npm run lint` e o usuário desinstala em 5 minutos. Aplicar threshold de legacy em código novo deixa passar débito que a equipe nunca vai pagar. A escolha não é cosmética — é o ponto onde o produto entrega valor ou frustra.

A pergunta arquitetural é: **como decidir o estágio de um projeto sem perguntar ao usuário, e como tornar essa decisão suficientemente transparente para que ele discorde com base em evidência?**

Sinais relevantes:

- O `/lint:setup` precisa rodar offline, em <30s (PLAN §Verification line 478), sem GitHub API, sem coverage real (que exigiria `npm test`). Qualquer sinal que dependa de rede ou subprocesso pesado está fora.
- Qualquer sinal "esperto" (`git shortlog`, branch protection, autores) introduz ruído de bots, force-pushes e perfis corporativos — falsos positivos migram projetos para o estágio errado *com convicção*.
- O usuário precisa **discordar** quando achar que o veredito está errado. Sem `signals` brutos no output, ele teria de adivinhar o que disparou a classificação.
- Brownfield é o caso comum (a maioria dos repos do mundo); greenfield e legacy são as fronteiras. A heurística precisa ser **conservadora nas fronteiras**: greenfield exige *três* gates simultâneos; legacy exige *idade alta* AND *um* co-trigger.
- A heurística é consultada por `detect-stage`, `status`, `install-oxlint`, `install-coverage`, `audit` e `recs/generate` — drift de constantes silenciosamente quebra calibração em seis lugares.
- E2E precisa ser determinístico: `now` injetável, sem dependência de relógio do CI, datas pinnadas em `2025-01-01T00:00:00Z` (ver `materializeFixture`).

## Decisão

Em v1, **a heurística de estágio é puramente determinística, alimentada por seis sinais brutos read-only, com thresholds versionados em código e classificação avaliada em ordem de prioridade fixa**.

Implicações concretas:

1. **Seis sinais brutos** — coletados em `cli/src/commands/detect-stage.ts`:
   - `first_commit_date` / `age_days` (via `firstCommitDate(cwd)` em `lib/git.ts`)
   - `source_files` (count via `lsFilesByExt(cwd, ["ts","tsx","js","jsx"])`)
   - `loc` (semântica `wc -l` — `text.match(/\n/g)?.length`, **não** `split('\n').length`)
   - `churn_90d` (via `churn90d(cwd)`)
   - `has_tests` (probe de `test/`, `tests/`, `__tests__/` OR `detectTestRunner.runner !== "none"`)
   - `todo_count` / `todo_density_per_100_loc` (regex `\b(TODO|FIXME|HACK)\b`, normalizado por 100 LOC)
   - Plus auxiliar: `linter_present` (via `detectExistingLinter`).
2. **Thresholds versionados em `STAGE_THRESHOLDS`** (`detect-stage.ts:51`):
   - `GREENFIELD_MAX_AGE_DAYS = 183` ("< 6 meses", 6 × 30.4375)
   - `GREENFIELD_MAX_LOC = 5_000`
   - `LEGACY_MIN_AGE_DAYS = 1_095` ("> 3 anos", 3 × 365.25)
   - `LEGACY_MIN_LOC = 50_000`
   - `LEGACY_MAX_TODO_DENSITY_PER_100_LOC = 1.0`
3. **Classificação em três regras avaliadas em ordem de prioridade** (primeira que casa vence):
   - **Greenfield** (3 gates AND): `age_days < 183  AND  loc < 5_000  AND  !linter_present`. `age_days === null` (repo vazio) **passa** o gate de idade — day-zero scaffolding cai em greenfield.
   - **Legacy** (1 gate AND 1-de-3 disjuntos): `age_days > 1_095  AND  (loc > 50_000  OR  todo_density > 1.0  OR  !has_tests)`. `age_days === null` **falha** aqui — sem commits não há "> 3 anos".
   - **Brownfield-moderate** (default): tudo que sobra.
4. **`reasoning` é string legível ao lado de `signals`**: SPEC §6 Always linha 388 trava obrigatoriedade de auditoria. Quem decide programaticamente lê `signals`; quem audita lê `reasoning` e confirma — ou refuta — contra evidência.
5. **`now` é injetável**: `DetectStageDeps.now` permite testes pinarem o relógio. E2E (`materializeFixture` + `nowAtCommit = () => new Date(COMMIT_DATE_ISO)`) garantem `age_days = 0` reproduzível.
6. **Classificação não consulta data atual diretamente** — ela usa o `now` do `Deps`. Mesmo conjunto de sinais → mesma classificação, sempre. Invariante exposta em `docs/stages.md` §1.
7. **Sinais não usados são deliberadamente excluídos**: número de autores, tamanho de `node_modules`, presença de CI, branch protection rules, coverage real. Justificativa por sinal documentada em `docs/stages.md` §6 — a lista do "Não" é tão importante quanto a lista do "Sim".
8. **Override explícito via `--stage`** em `install-oxlint` / `install-coverage`: `stageSource: "explicit" | "detected"` aparece no output, deixando rastro auditável quando o usuário discorda da heurística (sem flag de bypass silencioso).

A composição final é:

```
detect-stage
  → coleta 6 sinais brutos (read-only, <30s, offline)
  → classifyStage(signals) [pure]
      → tenta greenfield (3 gates AND)
      → senão tenta legacy (age + 1-de-3 OR)
      → senão brownfield-moderate (default)
  → emite { stage, signals, reasoning } com exit OK

install-oxlint / install-coverage / audit / recs-generate
  → consomem stage + signals
  → presets versionados (cli/src/presets/{oxlint,coverage}/<stage>.*) carregam thresholds
```

## Consequências

**Positivas**

- **Reprodutibilidade total**: mesmos sinais → mesma classificação → mesma cadeia de presets → mesmo audit. Zero drift entre máquinas, CI, pair programming.
- **`reasoning` legível** (SPEC §6 Always 388) — usuário discorda com evidência: "LOC 18430 not < 5000" deixa claro qual gate falhou.
- **Sinais offline e <30s**: detector roda em qualquer máquina, sem rede, sem subprocesso de coverage real, sem GitHub API.
- **Conservadorismo nas fronteiras**: greenfield exige 3 gates simultâneos (idade jovem + código pequeno + sem linter prévio) — projeto único cai aqui apenas no caminho day-zero. Legacy exige idade alta E um co-trigger — repo de 5 anos com testes e LOC controlada NÃO é legacy automaticamente, é brownfield. Brownfield é o atrator natural; greenfield e legacy são exceções defensáveis.
- **Calibração centralizada**: `STAGE_THRESHOLDS` é lookup table única. Mudança em um threshold é PR de 1 linha + atualização da tabela em `docs/stages.md` §4 e dos testes. Drift impossível silencioso.
- **Compatibilidade com fixtures e2e**: `materializeFixture` + `nowAtCommit` reproduzem comportamento byte-a-byte (assert lockados em `cli/tests/unit/detect-stage.test.ts` + `detectors-fixtures.test.ts`).
- **`age_days = null` tratado consistentemente** (passa greenfield, falha legacy) — repo recém-`git init` é greenfield, alinhado com day-zero scaffolding intent.
- **Override via `--stage explicit` é discoverable**: `stageSource: "explicit"` no output abre rastro para o `lint-decisions.md` log (Phase 5) — discordar da heurística é parte do produto, não bypass silencioso.

**Negativas / tradeoffs**

- **Heurística é heurística, não verdade**: projeto de 4 meses com 8k LOC sem linter (caso comum em startup) cai em brownfield-moderate (LOC > 5k); subjetivamente alguns donos chamariam de greenfield. Mitigado por `--stage greenfield` explícito + reasoning string deixar claro qual gate falhou.
- **`age_days === null` cai em greenfield mesmo com 50k LOC se sem linter** — extremo improvável (50k LOC sem nenhum commit é cenário de testing in-place com `git init` recente), mas tecnicamente possível. O gate `loc < 5000` de greenfield protege contra isso na prática.
- **TODO density é falsificável**: `// TODO: refactor everything` em 100 arquivos pode passar projeto de brownfield para legacy em projeto pequeno. Mitigado por LOC normalization (100 LOC com 5 TODOs = 5/100 = warn-level; o threshold é 1.0/100 LOC). Reasoning explicita o número.
- **Constantes ancoradas em "6 meses" / "3 anos" são arbitrárias**: 183d (6×30.4375) e 1095d (3×365.25) são round-numbers culturais, não derivados empiricamente. Aceitável porque ADR 0008 (rationale híbrida) já mistura determinismo com prosa enriquecida — usuário lê a justificativa em `docs/stages.md` §2 e decide se discorda com `--stage`.
- **`linter_present` participa só do gate greenfield**: brownfield e legacy ignoram-no. Decisão consciente — se um repo legacy de 5 anos tem ESLint configurado, o estágio ainda é legacy (ESLint não muda a complexidade do código). O sinal serve apenas para filtrar greenfield, onde "sem linter prévio" é parte da definição de day-zero.
- **`has_tests` é probe binário** — não distingue "1 teste" de "1000 testes". Aceitável porque a SPEC trata `has_tests` como gate (presença/ausência), não como medida de qualidade.

## Alternativas consideradas

- **Heurística baseada em ML** (cluster sobre LOC + churn + idade). Rejeitada: não é determinística, exige modelo treinado por linguagem, e o usuário não consegue contestar "modelo X classificou em estágio Y" como pode contestar "LOC 18430 not < 5000".
- **Pedir ao usuário em uma `AskUserQuestion`** ("Greenfield, Brownfield ou Legacy?"). Rejeitada: contraria PLAN §Princípios — o detector é read-only e roda em background do `/lint:setup`. A pergunta reaparece toda vez que o usuário roda `/lint:status` ou troca de máquina, sendo ruído. SPEC §6 Always 388 ainda pede `signals` brutos no output mesmo com pergunta.
- **Apenas dois estágios (greenfield vs legacy)**. Rejeitada: 80% dos repos do mundo são brownfield-moderate. Forçar para greenfield gera reclamação imediata no primeiro `npm run lint`; forçar para legacy descarta WMC/CBO em error severity onde poderia bloquear regressão. Brownfield-moderate é o ponto-de-equilíbrio.
- **Quatro ou mais estágios**. Rejeitada: matriz de presets (preset × stage × tier) ficaria grande demais (`6 × 4 × 2 = 48` arquivos), e a granularidade extra não traz valor (a fronteira "moderate vs not-quite-legacy" é ruidosa demais para detectar deterministicamente).
- **Sinais "espertos" via GitHub API** (issues abertas, PR rate, contributor turnover). Rejeitada: quebra offline-first, exige token, latência variável. ROI baixo: nada do que esses sinais medem é melhor preditor de estágio do que LOC + idade + tests.
- **Coverage real (rodar `npm test --coverage`) como sinal**. Rejeitada: violaria budget <30s, exigiria `node_modules/` populado, e coverage atual não é estável (varia por CI/local). `detectTestRunner` lê apenas thresholds **declarados** — coverage real fica para `lint:audit`.
- **Pedir LOC do projeto como ground truth**, ignorando o detector quando o usuário fornece. Rejeitada: complexa interface (`--loc 50000 --age-days 1500`?), não escala para 6 sinais, e na prática o usuário discordaria de 1-2 gates específicos, não de todos. `--stage explicit` cobre o caso real.
- **Esquecer ordem de prioridade e usar score-based** (greenfield = X pontos, legacy = Y pontos, escolhe o maior). Rejeitada: regras AND/OR são auditáveis (cada gate é binário e conhecido); score precisa de pesos, e pesos abrem espaço para "rebalanceamento" implícito que quebra reproduzibilidade.

## Verificação

- **Constantes lockadas**: `STAGE_THRESHOLDS` em `cli/src/commands/detect-stage.ts:51` é a fonte única; alterações exigem atualizar `docs/stages.md` §4 e a tabela canônica de `docs/thresholds.md`. Drift detectado pelo teste de constantes em `cli/tests/unit/detect-stage.test.ts`.
- **Heurística completa**: `cli/tests/unit/detect-stage.test.ts` (18 testes) cobre greenfield default, brownfield (linter prévio em repo jovem, mid-age mid-size), legacy via 3 triggers separados (LOC>50k, no tests, TODO density>1/100), idade só não basta para legacy, repo vazio → greenfield, falha de ls-files, has_tests via vitest config sem dirs, todo_density null em LOC=0, word-boundary do TODO regex (`todoList` não matcheia), linter detectado via devDependencies.
- **Determinismo**: `cli/tests/unit/detectors-fixtures.test.ts` materializa fixtures via `materializeFixture` (timestamp pinnado em `2025-01-01T00:00:00Z`) e injeta `now=commit_date` para reproduzir `age_days=0`; valida classificação contra `EXPECTED.md` de cada fixture (greenfield-ts, brownfield-eslint-prettier, jest-with-coverage, legacy-monorepo cenário A e B, unsupported-python).
- **`legacy-monorepo` cenário B** valida explicitamente os disjuntos legacy: com `now=commit+1500d`, dispara `age_days > 1095 AND (TODO density 1.43 > 1 OR no_tests)`. Drift na ordem de prioridade ou no AND/OR quebra o assert.
- **`reasoning` é parte do contrato**: testes em `detect-stage.test.ts` asserem substrings específicas (`"LOC ... > 50000"`, `"no tests detected"`, `"prior linter present"`) — drift na string quebra. Mensagem ao usuário fica audit-grade.
- **Override `--stage explicit`**: `cli/tests/unit/install-oxlint.test.ts` cobre `stageSource: "explicit"` vs `"detected"`, garantindo que a discordância do usuário deixa rastro no output canônico.
- **E2E**: `cli/tests/e2e/setup-greenfield.test.ts` exercita o caminho greenfield contra fixture; cobertura cruzada em `cli/tests/e2e/setup-rollback-brownfield.test.ts` para brownfield. Detector é o gate de pré-condição em ambos.
- **Documentação como lock secundário**: `docs/stages.md` (§3 sinais, §4 regras de classificação, §7 edge cases) e `docs/thresholds.md` (tabela calibrada por estágio) carregam tabelas que devem coincidir byte-a-byte com `STAGE_THRESHOLDS`. Drift em qualquer dos três (código, stages.md, thresholds.md) é PR review surface.
