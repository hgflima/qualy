# Estágios do projeto e heurística de detecção

Reference contract para `cli/src/commands/detect-stage.ts` (SPEC §3 + PLAN §Fase 1 + ADR 0003 — futura).

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §3 (heurística + thresholds + coverage), `cli/src/commands/detect-stage.ts` (implementação canônica), `cli/src/presets/oxlint/` (presets calibrados por estágio), `docs/thresholds.md` (tabela completa por métrica), `docs/coverage.md` (estratégia de coverage), ADR 0003 (justificativa da heurística — pendente)

## 1. Propósito

Antes de instalar qualquer linter, formatter ou coverage threshold, qualy classifica o repositório em **um de três estágios** — `greenfield`, `brownfield-moderate`, `legacy`. O estágio é a chave que seleciona:

- Qual preset oxlint copiar (`cli/src/presets/oxlint/<stage>.{fast,deep}.json`).
- Quais valores de coverage propor (`cli/src/presets/coverage/{vitest,jest}.<stage>.{ts,json}`).
- Que peso dar às severidades (greenfield bloqueia, legacy avisa).

Aplicar threshold de greenfield em código legado gera 200 erros no primeiro `npm run lint` e o usuário desinstala em 5 minutos. Aplicar threshold de legacy em código novo deixa passar débito que a equipe nunca vai pagar. A heurística existe para **escolher um ponto de partida defensável**, e o detector emite os sinais brutos junto com a classificação para o usuário discordar com base em evidência (SPEC §6 Always — "Sempre justificar a classificação de estágio com os sinais brutos coletados").

**Invariante.** Mesmo conjunto de sinais → mesma classificação. A classificação não consulta data atual diretamente; ela usa `now` injetável para que testes/snapshots reproduzam exatamente o mesmo veredito.

## 2. Os três estágios

### Greenfield

Projeto novo, ainda em day-zero ou primeiras semanas. **Pouco código, pouca história, sem opinião prévia sobre estilo.** Custo de "apertar" thresholds é baixo: o developer ainda não tem 200 classes para refactor, então um `WMC max=15` força arquitetura saudável desde o início.

Default: thresholds rígidos, severidade `error` em correctness/CBO/WMC, coverage 90/90/80/90.

### Brownfield moderado

A maioria dos repos. **Já tem identidade, talvez tenha linter prévio, base de código não trivial mas governável.** Não dá para apertar como greenfield (vai gerar refactor de 2 semanas no primeiro dia), mas também não vale relaxar como legacy (a equipe ainda consegue corrigir débito incrementalmente).

Default: thresholds intermediários (WMC 20, CBO 10), severidade `error` mantida em correctness/CBO/WMC, coverage 70/70/60/70.

### Legacy (legado pesado)

Repos com idade > 3 anos onde **algum sinal indica que pagar débito é caro**: muito código (>50k LOC), muito TODO/HACK acumulado, ou ausência de testes (refactor cego é arriscado). O objetivo do qualy aqui não é "levar para greenfield" — é **medir** sem bloquear.

Default: thresholds afrouxados (WMC 40, CBO 20), tudo em `warn` (correctness inclusive — não bloquear refactor por unused-vars em código que ninguém entende mais), coverage 40/40/30/40 (legacy carrega flag `_warnOnly:true` nos presets de coverage).

## 3. Sinais brutos coletados

`detectStage()` coleta seis sinais (mais um auxiliar) por execução. Todos são read-only e não escrevem em disco.

| Sinal | Origem | Default em falha |
|---|---|---|
| `first_commit_date` | `firstCommitDate(cwd)` em `cli/src/lib/git.ts` (`git log --reverse --format=%cI \| head -1`) | `null` (repo vazio ou sem commits) |
| `age_days` | `nowFn() - first_commit_date`, `Math.floor(ms / 86_400_000)` | `null` quando `first_commit_date` é `null`; clamp em 0 se `now` < commit |
| `source_files` | `lsFilesByExt(cwd, ["ts","tsx","js","jsx"]).length` | hard-fail (`ok: false`) — git ls-files é o único sinal que pode quebrar |
| `loc` | Soma de `text.match(/\n/g)?.length` por arquivo (semântica `wc -l`, não `split('\n').length`) | 0 (arquivos ilegíveis são contabilizados em `source_files` mas não em LOC) |
| `churn_90d` | `churn90d(cwd)` (`git log --since='90 days ago' --pretty=oneline \| wc -l`) | 0 (mas git fail bubbles up) |
| `has_tests` | `existsSync(test/) \|\| tests/ \|\| __tests__/` OU `detectTestRunner(cwd).runner !== "none"` | `false` |
| `todo_count` | `text.match(/\b(TODO\|FIXME\|HACK)\b/g)?.length` somado por arquivo | 0 |
| `todo_density_per_100_loc` | `todo_count / (loc / 100)` | `null` quando `loc === 0` (evita divisão por zero) |
| `linter_present` *(auxiliar)* | `detectExistingLinter(cwd).linters.length > 0 \|\| .formatters.length > 0` | `false` |

**Por que `\b` no TODO regex.** Sem word-boundary, identificadores como `todoList`, `unfix_me`, `hackerNews` falsam o sinal. Como TODO density é triangular (entra em três regras: greenfield exclude, legacy include, brownfield default), false-positives migrariam projetos para legacy sem evidência real.

**Por que `\n` count em vez de `split('\n').length`.** Um arquivo de 10 linhas terminado sem newline final tem `split('\n').length === 11` (último elemento string vazia), inflando LOC silenciosamente. Match por `\n` espelha `wc -l` exatamente.

**Por que `text.length` não é usado.** LOC é métrica de quantidade de linhas, não bytes; minified code tem 1 linha gigante e legitimamente não é "5k LOC".

## 4. Regras de classificação

Avaliadas em **ordem de prioridade**. A primeira regra que casa vence. Defaults vivem em `STAGE_THRESHOLDS` (`detect-stage.ts:51`):

```ts
GREENFIELD_MAX_AGE_DAYS:                183    // "< 6 meses" (6 × 30.4375)
GREENFIELD_MAX_LOC:                     5_000
LEGACY_MIN_AGE_DAYS:                    1_095  // "> 3 anos" (3 × 365.25)
LEGACY_MIN_LOC:                         50_000
LEGACY_MAX_TODO_DENSITY_PER_100_LOC:    1.0
```

### Regra 1: greenfield

```
age_days < 183       AND  loc < 5_000  AND  !linter_present
```

`age_days === null` (repo vazio) **passa** o teste de idade — um repo recém-`git init` é tratado como "0 dias" e cai em greenfield se sem código e sem linter, o que casa com intent de scaffolding day-zero.

### Regra 2: legacy

```
age_days > 1_095     AND  (loc > 50_000  OR  todo_density > 1.0  OR  !has_tests)
```

`age_days === null` **falha** o teste de idade aqui (não há "> 1095 days" sem commits). Os disjuntos são independentes — um single trigger basta para legacy. Reasoning string lista todos os triggers que dispararam ("LOC 60k > 50k OR no tests detected"), facilitando auditoria.

### Regra 3: brownfield moderado (default)

Tudo que não casou com greenfield nem legacy. O reasoning enumera **por que** greenfield falhou e **por que** legacy falhou, então o operador entende a posição da fronteira ("age 200d not < 183d; LOC 8k not < 5k; age 200d not > 1095d").

## 5. Output do detector

```jsonc
{
  "ok": true,
  "cwd": "/abs/path",
  "stage": "brownfield-moderate",
  "signals": {
    "first_commit_date": "2024-08-15T12:00:00Z",
    "age_days": 627,
    "source_files": 142,
    "loc": 18_430,
    "churn_90d": 87,
    "has_tests": true,
    "todo_count": 12,
    "todo_density_per_100_loc": 0.07,
    "linter_present": true
  },
  "reasoning": "default classification (age 627d not < 183d; LOC 18430 not < 5000; prior linter present; age 627d not > 1095d)"
}
```

`reasoning` é **string legível** — não é estruturada para parsing. Quem precisa decidir programaticamente lê `signals` direto. Quem audita lê `reasoning` para confirmar que a classificação faz sentido contra a evidência.

Em failure (apenas `git ls-files` quebrando): `{ ok: false, error: "<git stderr>" }` com exit code `RECOVERABLE_ERROR` (1). USAGE_ERROR (4) cobre apenas flags inválidas.

## 6. Sinais não usados (e por quê)

A SPEC §3 lista seis sinais; o detector implementa todos. Mas há sinais óbvios que **deliberadamente** ficam fora:

- **Número de autores (`git shortlog -s`).** Tentador como proxy para "projeto compartilhado vs solo", mas mistura ruído de bots, autores legados que saíram, force-pushes que sumiram com history. ROI baixo para complexidade de threshold.
- **Tamanho do `node_modules` ou número de deps.** Ortogonal a maturidade — projetos greenfield modernos puxam 800 deps no `npm init`, projetos legacy podem ter 12. Não discrimina.
- **Presença de CI (`.github/workflows`, `.gitlab-ci.yml`).** Brownfield e legacy frequentemente já tem CI; greenfield raramente. Mas usar isso para classificar significa "se o usuário tem CI, vamos relaxar threshold", o que é exatamente o oposto do que ele quer.
- **Branch protection rules.** Requer chamada GitHub API; quebra offline-first do detector.
- **Coverage atual real (não threshold configurado).** Requer rodar a suite, o que viola read-only / tempo <30s do detector. `detectTestRunner` lê apenas thresholds **declarados** em config — coverage real fica para `lint:audit`.

## 7. Edge cases conhecidos

| Cenário | Classificação | Por quê |
|---|---|---|
| Repo recém-`git init`, sem commit | `greenfield` | `age_days = null` passa o gate; `loc = 0` passa; `!linter_present` passa. Day-zero scaffolding cai em greenfield e ganha thresholds rígidos. |
| Repo de 5 anos com 200 LOC | `legacy` se `!has_tests` ou se `todo_density > 1.0`; senão `brownfield-moderate` | Idade sozinha não dispara legacy — precisa de um co-trigger. |
| Repo de 4 meses com 8k LOC sem linter | `brownfield-moderate` | Falha greenfield (LOC > 5k). Falha legacy (age < 1095d). Cai no default. |
| Repo de 2 anos, ESLint configurado, 3k LOC | `brownfield-moderate` | Falha greenfield (`linter_present` é o único motivo aqui — LOC e idade passariam). Reasoning explicita "prior linter present". |
| Repo legacy com testes recentes (`has_tests=true`) e LOC < 50k e TODO density baixa | `brownfield-moderate` (não legacy) | Nenhum disjunto da regra legacy disparou; idade alta sozinha não basta. |
| Pure-Vue / pure-Svelte / pure-Python | classificação rodaria, mas `detect-stack` já barrou antes | Stage é informacional em stacks não-suportadas; o gate é `detect-stack` (`UNSUPPORTED_STACK = 2`). |

## 8. Como o usuário discorda

Saída do `detect-stage` (e do `status`) inclui `signals` + `reasoning`. Quando o usuário acha que o estágio está errado:

1. Lê o `reasoning` ("LOC 18430 not < 5000").
2. Decide se a métrica está distorcida (ex: 12k LOC são auto-gerados de protobuf — deveriam ser excluídos do contador).
3. Pode rodar `qualy install-oxlint --stage <stage>` para forçar um preset diferente; `stageSource` no output passa a ser `"explicit"` em vez de `"detected"`, deixando rastro em `.lint-decisions.md` (Phase 5 logging) e no audit.
4. Para mudar permanentemente, ajusta diretamente os arquivos `oxlint.fast.json` / `oxlint.deep.json` copiados — eles são versionáveis (SPEC §3 — "tudo copiado é versionável; nada gerado on-the-fly").

A heurística não tenta ser "esperta" — ela é determinística e explicável. A inteligência fica em quem lê o output.

## 9. Drift e versionamento

Mudanças nas constantes de `STAGE_THRESHOLDS` ou na ordem das regras quebram comportamento observável. Esta tabela e a suite `cli/tests/unit/detect-stage.test.ts` são os locks: alterar uma constante exige atualizar ambos. Mudanças maiores (adicionar quarto estágio, novo sinal) abrem ADR (cross-ref ADR 0003 — pendente).

Versão atual: v1 (qualy MVP, 2026-05-04). Próximas revisões expandem `signals` mas não removem campos — consumidores (audit JSON, harness) podem confiar na estabilidade do shape.
