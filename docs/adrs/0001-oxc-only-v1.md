# ADR 0001 — Stack suportada em v1: apenas oxc (TS/TSX/JS/JSX)

- Status: aceito
- Data: 2026-05-03
- Relacionados: ADR 0002 (backup nomeado para rollback), ADR 0003 (heurística de estágio), ADR 0006 (CLI determinístico com harness fino)

## Contexto

O SPEC do `/lint` (`.harn/docs/mvp/SPEC.md` §1) declara:

> **Stack suportada (v1).** Apenas linguagens cobertas pelo oxc: TypeScript, TSX, JavaScript, JSX. Qualquer outra (Python, Go, Rust, Vue/Svelte com SFCs, etc.) → erro explícito "stack não suportada nesta versão" + sugestão de issue.

E no §1 "Não-objetivos" reforça:

> - Suportar ESLint puro como destino (oxc é o único path).
> - Suportar linters de outras linguagens (Ruff, Clippy, Golangci-lint).
> - Suportar Vue/Svelte SFCs até oxc cobrir nativamente.

Essas linhas são restrições de produto, mas a decisão de fundo é arquitetural: **qual a fronteira de entrada do `/lint`?** Aceitar tudo e degradar graciosamente em stacks parciais? Ou recusar de pé qualquer projeto que o oxc não cubra integralmente?

A escolha tem efeito-cascata em quase todo o resto do produto:

- `cli/src/commands/detect-stack.ts` precisa decidir entre `supported`/`unsupported` (binário) ou um espectro `supported/partial/unsupported` (gradiente). O comando hoje retorna binário com exit code `2` (`UNSUPPORTED_STACK`).
- Os presets `cli/src/presets/oxlint/*.json` declaram `correctness`, `suspicious` e 6 rules `quality-metrics/*` calibradas — todas via parser do oxc. Suporte parcial obrigaria preset gateway por linguagem.
- O hook `cli/src/templates/post-edit.sh` filtra `$CLAUDE_FILE_PATHS` para `*.ts|*.tsx|*.js|*.jsx` (SPEC §4 line 313). Suporte parcial obrigaria múltiplos hooks ou case-statement por linguagem.
- O envelope cobre o produto inteiro: SKILL.md, todos os `commands/lint/*.md` e `agents/lint-*.md` enumeram `TS/TSX/JS/JSX` como gate de pré-condição. Mudar isso mexe em ≥10 arquivos do harness.
- `quality-metrics` (o plugin oxc que dá WMC, Halstead, LCOM, CBO, DIT) só roda dentro do parser do oxc — fora dele, métricas estruturais do `/lint:audit` exigiriam parser+collector próprio por linguagem.

A pergunta é: **qual o conjunto mínimo de linguagens que faz sentido suportar em v1, e por que recusamos as demais agora em vez de oferecer cobertura parcial?**

Sinais relevantes:

- O nicho declarado em SPEC §1: *"desenvolvedores que rodam Claude Code em projetos TS/TSX/JS/JSX"*. Stack secundária está fora do problema-alvo.
- O `quality-metrics` é o motivo principal de existir do produto (PLAN §Context line 33). Ele só dá output útil sob o parser do oxc.
- O `oxlint` v1 já cobre `correctness`/`suspicious` para TS/TSX/JS/JSX com qualidade estável — mas Vue/Svelte SFC, Astro, MDX, etc., dependem de plugins não-oxc que reintroduziriam ESLint na pilha.
- Cobertura parcial (ex: rodar oxc só nos `.ts/.tsx` de um projeto Vue) deixa metade do projeto sem feedback estrutural — pior do que rejeitar e mandar o usuário para outra ferramenta com mensagem explícita.
- Comunidade oxc tem roadmap aberto para Vue/Svelte e MDX; suporte futuro fica natural quando o parser cobrir nativamente (SPEC §8 open question).

## Decisão

Em v1, **a única stack aceita pelo `/lint` é projeto Node.js cuja superfície de código relevante é exclusivamente `.ts`/`.tsx`/`.js`/`.jsx`**, e qualquer outra stack é recusada com `exit code 2` (`UNSUPPORTED_STACK`) sem escrita.

Implicações concretas:

1. **Detecção é binária**: `cli/src/commands/detect-stack.ts` combina dois sinais — extensões via `git ls-files` (`.ts`/`.tsx`/`.js`/`.jsx` somam ≥ 1) e blockers via probe de marcadores de outras linguagens (`pyproject.toml`, `setup.py`, `Pipfile`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle(.kts)`, `mix.exs`, `*.vue`, `*.svelte`). `supported = blockers.length === 0 && tsFamily > 0`. Não há bandeira `partial`.
2. **A ausência de `package.json` não é blocker per se** (alguns scripts utilitários TS rodam sem ele) — o gate é "tem código TS/JS detectável e zero blockers". Mas o `install.sh` (ADR 0009) e o `install-deps`/`install-scripts` exigem `package.json`; quando ele falta, falham com erros recuperáveis específicos, não com `UNSUPPORTED_STACK`.
3. **Vue/Svelte SFC, Astro, MDX, JSX/TSX dentro de `.html`** ficam todos como blockers — independentemente de o projeto também conter `.ts` válidos. Suporte parcial degradaria silenciosamente: o developer não saberia que metade da árvore não está sendo lintada.
4. **Mensagem de recusa é explícita e actionable**: o stdout do `detect-stack` declara `blockers: [{ kind, file }]`, e o harness (`commands/lint/setup.md`, `SKILL.md`) instrui o usuário a abrir issue indicando a stack — input sinalizado para roadmap, não silenciamento.
5. **Não-objetivos travados em código**: nenhum subcomando do CLI aceita flag `--allow-unsupported` ou `--force`. O bypass só existe via fork do detector — explícito o suficiente para que o usuário entenda o que está abrindo mão.
6. **Roadmap declarado**: SPEC §8 lista *"Suporte a Vue/Svelte SFC quando oxc cobrir"* como open question. A entrada vem por upgrade do oxc e adição de extensão à allow-list de `detect-stack`, sem mudar a arquitetura.

## Consequências

**Positivas**

- **Mensagem de erro forte > suporte parcial frustrante**: developers em projeto não-suportado sabem em segundos que precisam usar outra ferramenta, em vez de descobrir após `/lint:setup` que metade do código não roda no hook.
- **Presets calibrados são possíveis**: thresholds em `cli/src/presets/oxlint/*` (greenfield/brownfield/legacy × fast/deep) podem assumir uma única árvore de regras (`correctness`, `suspicious`, 6 `quality-metrics/*`) sem matriz cruzada por linguagem.
- **Hook `post-edit.sh` é trivial**: case-statement único de 4 extensões; sem branching por toolchain.
- **Cobertura de teste é finita**: 5 fixtures (`greenfield-ts/`, `brownfield-eslint-prettier/`, `legacy-monorepo/`, `jest-with-coverage/`, `unsupported-python/`) cobrem o produto inteiro. Adicionar Ruby ou Go duplicaria a matriz.
- **Manutenção delimitada**: bug em parser/preset afeta TS/JS apenas; sem regressão multi-linguagem.
- **`quality-metrics` rende seu valor máximo**: WMC, Halstead V/E, LCOM, CBO, DIT só fazem sentido com AST consistente — o oxc fornece para JS family.
- **Idempotência reforçada**: `detect-stack` retornando binário evita o caso "rodei o setup, mas só metade dos arquivos foi configurada" que confundiria `/lint:rollback` e `/lint:uninstall`.

**Negativas / tradeoffs**

- **Surface area de adoção menor em v1**: projetos Vue/Svelte/Astro precisam esperar oxc cobrir ou ficam fora.
- **Monorepo misto bloqueado**: um único pacote em Python, Go, Rust ou Vue dentro de um monorepo TS já marca o projeto inteiro como `unsupported` — workaround é rodar `/lint:setup --cwd <pacote-ts>` por subdiretório (suportado pelo flag `--cwd` global).
- **Sem path graceful para "tenho 95% TS e 5% Vue, quero lintar só o TS"**: a ausência intencional de bypass é parte da decisão (ver Alternativas).
- **Compromisso com oxc como dependência crítica**: regressão upstream do oxc paralisa o produto inteiro até patch chegar — mitigado por (i) versão pinnada em `cli/package.json`, (ii) presets versionados em `cli/src/presets/`, (iii) `lint-decisions.md` como log de decisões locais que sobrevivem a downgrade de oxc.

## Alternativas consideradas

- **Aceitar tudo e oferecer cobertura parcial.** Rejeitada: developer em projeto Vue não percebe que SFCs ficaram sem feedback; expectativa de cobertura ≠ realidade. SPEC §6 line 380 exige *"recusar com mensagem explícita"* para stacks incompatíveis.
- **ESLint como fallback automático em stacks fora do oxc.** Rejeitada: SPEC §1 line 32 declara explicitamente "Suportar ESLint puro como destino" como não-objetivo, e ADR 0008 (rationale híbrida) já depende do parser do oxc para emitir `quality-metrics/*`. Adicionar ESLint duplicaria a pilha de presets/hook/coverage e violaria ADR 0006 (CLI determinístico).
- **Suporte gradual a Vue/Svelte via plugins oxc-experimental ou ESLint plugins.** Rejeitada para v1: aumenta o eixo de teste (matriz `oxc × pluginversão × stage`); diferida para quando o oxc cobrir SFCs nativamente (SPEC §8 + §10 line 485).
- **Flag `--force` para bypass do gate de stack.** Rejeitada: bypass silencioso vira o caminho default em monorepos mistos e quebra a narrativa "qualy = feedback estrutural confiável". O fork do detector continua como escape hatch para usuários avançados, e é explícito o suficiente.
- **Suporte a Python/Go/Rust via Ruff/Golangci-lint/Clippy embutidos.** Rejeitada: SPEC §1 line 33 declara não-objetivo. Cada toolchain tem cultura de configuração própria; embarcar três produtos em um mata coesão.

## Verificação

- `cli/src/commands/detect-stack.ts` retorna `supported: false` para a fixture `cli/tests/fixtures/unsupported-python/` (`pyproject.toml` + `.py`) com exit code `2`; assert lockado em `cli/tests/unit/detectors-fixtures.test.ts` e em `cli/tests/unit/detect-stack.test.ts`.
- `cli/tests/fixtures/unsupported-python/EXPECTED.md` documenta o contrato esperado dos 6 detectores nessa stack — o parecer "stack bloqueada por marker" é parte do contrato, não comportamento emergente.
- O hook `cli/src/templates/post-edit.sh` filtra exatamente `*.ts|*.tsx|*.js|*.jsx` — assert estático em `cli/tests/unit/templates-post-edit.test.ts` (extensões positivas + 5 negativas explícitas: `.py`, `.rs`, `.go`, `.vue`, `.svelte`).
- A cláusula "envelope `TS/TSX/JS/JSX`" aparece no frontmatter/corpo de `skills/lint/SKILL.md`, `commands/lint/setup.md`, `commands/lint/uninstall.md`, `commands/lint/rollback.md`, `agents/lint-detector.md`, `agents/lint-installer.md`, `agents/lint-migrator.md` — assert lockado em cada `cli/tests/unit/{skill,command,agent}-*-md.test.ts`.
- E2E: `cli/tests/e2e/setup-greenfield.test.ts` exercita o caminho feliz contra fixture TS-only; cobertura cruzada com `unsupported-python` confirma o `exit 2` em integração end-to-end (PLAN §Fase 1 verificação).
