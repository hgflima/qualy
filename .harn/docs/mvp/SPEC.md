# SPEC — `/lint` skill

> Status: draft v1 · Autor: hgflima · Data: 2026-05-03

A skill `/lint` instala, desinstala e gerencia linters/formatters customizados ao projeto-alvo, com integração ao plugin [`quality-metrics`](https://github.com/hgflima/quality-metrics) e calibração de thresholds por estágio do projeto.

---

## 1. Objetivo

**Problema.** Configurar oxlint + oxfmt + `quality-metrics` (com hook `PostToolUse`, lint-staged, presets fast/deep e thresholds calibrados ao estágio do projeto) é repetitivo, propenso a erro e pouco visível para o agente. Linter "pronto pra loop agêntico" hoje é trabalho manual.

**O que a skill faz.** Em uma sessão guiada, a skill:

1. Detecta a stack do projeto-alvo e bloqueia se for incompatível com `oxc`.
2. Detecta linter/formatter existente e — com consentimento explícito do usuário — faz backup nomeado antes de substituir.
3. Classifica o estágio do projeto (greenfield / brownfield moderado / legado pesado) por heurística + confirmação.
4. Instala oxlint, oxfmt, `quality-metrics` (com `ts-morph` para tier deep), presets fast/deep, hook Claude Code `PostToolUse`, lint-staged + husky no pre-commit, e npm scripts — cada camada com opt-out individual.
5. Calibra thresholds das 5 métricas (WMC, Halstead, LCOM, CBO, DIT) conforme o estágio.
6. Configura **cobertura de testes** (detecta Vitest/Jest, adapta provider; pergunta meta de coverage; se já existir threshold, mostra valor atual antes de perguntar).
7. Permite **gerenciar rules ativas** (listar, adicionar, remover, explicar) por subcomandos dedicados.
8. Gera um **report visual de qualidade** (servidor local efêmero + export opcional versionável em `quality-report/`), com temas claro/escuro (default `linear.app/design-md`).
9. Audita o projeto periodicamente, sinalizando o que está degradado e o que melhorar — `/lint:update` aplica as recomendações com confirmação por item.
10. Suporta rollback e desinstalação por slash commands dedicados.

**Quem usa.** Desenvolvedores que rodam Claude Code em projetos TS/TSX/JS/JSX e querem fast feedback estrutural via lint/loop agêntico.

**Stack suportada (v1).** Apenas linguagens cobertas pelo oxc: TypeScript, TSX, JavaScript, JSX. Qualquer outra (Python, Go, Rust, Vue/Svelte com SFCs, etc.) → erro explícito "stack não suportada nesta versão" + sugestão de issue.

**Não-objetivos (v1).**

- Suportar ESLint puro como destino (oxc é o único path).
- Suportar linters de outras linguagens (Ruff, Clippy, Golangci-lint).
- Auto-fix de violações estruturais (são extrações/refatorações, não rewrites).
- Gerar dashboards/relatórios fora do loop do Claude Code.
- Suportar Vue/Svelte SFCs até oxc cobrir nativamente.

---

## 2. Commands (slash commands)

Skill principal: `/lint` (ponto de entrada conversacional, decide o que rodar).

Slash commands diretos (proativos, finos, delegam pra subagents):

| Comando | Propósito | Subagent invocado |
|---|---|---|
| `/lint:setup` | Fluxo guiado de instalação no projeto-alvo (detecção → confirmação → instalação por camadas, incluindo coverage e report). | `lint-detector` → `lint-installer` (e `lint-migrator` se houver linter prévio) |
| `/lint:audit` | **Análise estratégica** do estado do lint+qualidade no repo: roda fast+deep tier, avalia maturidade, e produz lista acionável — o que não está funcionando, o que pode melhorar, rules a adicionar/remover dado o estágio. Persiste resultado em `.lint-audit/<timestamp>.json` para `/lint:update` consumir. Não modifica configs. | `lint-auditor` |
| `/lint:update` | Lê o audit mais recente em `.lint-audit/` e aplica as recomendações **uma por vez** com `AskUserQuestion` (apply/skip/explain). Também atualiza versões de oxlint/oxfmt/quality-metrics e re-calibra thresholds se o estágio mudou. | `lint-installer` (modo update) |
| `/lint:report` | Sobe servidor local efêmero (`localhost:<porta>`) renderizando o report visual de qualidade — métricas, coverage, tendências, violações top-N, charts e animações. Suporta tema claro/escuro (default `linear.app/design-md`). Pergunta no fim se o usuário quer **exportar snapshot HTML self-contained** para `quality-report/<timestamp>.html` (versionável). | `lint-auditor` (gera dados) |
| `/lint:uninstall` | Remove tudo que `/lint:setup` instalou (linter, formatter, hooks, coverage, report). Se houver `.lint-backup/`, oferece restaurar o linter anterior. | `lint-migrator` (modo restore) |
| `/lint:rollback` | Restaura o backup mais recente em `.lint-backup/<timestamp>/` sem desinstalar oxc primeiro (escape hatch). | `lint-migrator` |
| `/lint:status` | Read-only: imprime versões instaladas, presets ativos, estágio detectado, thresholds vigentes, hooks configurados, meta de coverage atual, tema do report. | (sem subagent — leitura barata) |
| `/lint:rules:list` | Lista todas as rules ativas com origem (preset / customização do usuário), severidade e threshold. Mostra também rules disponíveis e desativadas. | (sem subagent) |
| `/lint:rules:add <rule>` | Adiciona uma rule específica ao preset ativo. Pergunta severidade e threshold. Faz dry-run para mostrar quantos arquivos passariam a falhar antes de aplicar. | `lint-installer` |
| `/lint:rules:remove <rule>` | Remove uma rule específica do preset ativo. Pergunta o motivo (registrado em `docs/lint-decisions.md` no projeto-alvo) e confirma. | `lint-installer` |
| `/lint:rules:explain <rule>` | Mostra descrição da rule, racional empírico, threshold atual, links para docs do `quality-metrics` ou oxlint. | (sem subagent) |

**Convenções entre comandos.**

- Todos exigem working tree git limpo para mudanças destrutivas (oferecem `git stash` se sujo).
- Todos imprimem um plano (resumo do que vai fazer) e pedem confirmação antes de qualquer escrita — exceto `/lint:audit`, `/lint:status`, `/lint:rules:list`, `/lint:rules:explain` e `/lint:report` que são read-only.
- Todos respeitam a regra "uma pergunta por vez via `AskUserQuestion`".
- Erros não-recuperáveis abortam e apontam o backup/`git stash` para o usuário restaurar.
- `/lint:audit` e `/lint:update` são acoplados por contrato: audit grava JSON estruturado, update consome. Se update rodar sem audit prévio (≤ 24h), oferece rodar audit antes.

---

## 3. Project structure

`qualy/` é o **workspace autoral** da skill. Layout:

```
qualy/
├── SPEC.md                        # este documento
├── README.md                      # instruções de uso e instalação da skill
├── CHANGELOG.md
│
├── skills/
│   └── lint/
│       └── SKILL.md               # frontmatter + corpo principal da skill /lint
│
├── commands/
│   └── lint/
│       ├── setup.md               # /lint:setup
│       ├── audit.md               # /lint:audit
│       ├── update.md              # /lint:update
│       ├── report.md              # /lint:report
│       ├── uninstall.md           # /lint:uninstall
│       ├── rollback.md            # /lint:rollback
│       ├── status.md              # /lint:status
│       └── rules/
│           ├── list.md            # /lint:rules:list
│           ├── add.md             # /lint:rules:add
│           ├── remove.md          # /lint:rules:remove
│           └── explain.md         # /lint:rules:explain
│
├── agents/
│   ├── lint-detector.md           # detecta stack + estágio + linter existente + runner de testes
│   ├── lint-installer.md          # executa instalação por camadas (linter, hook, lint-staged, coverage, report)
│   ├── lint-auditor.md            # roda audit no repo, agrega resultados, gera recomendações acionáveis
│   └── lint-migrator.md           # backup, substituição, restore
│
├── presets/                       # presets oxlint copiados pro projeto-alvo
│   ├── greenfield.fast.json
│   ├── greenfield.deep.json
│   ├── brownfield-moderate.fast.json
│   ├── brownfield-moderate.deep.json
│   ├── legacy.fast.json
│   └── legacy.deep.json
│
├── coverage-presets/              # presets de coverage por runner + estágio
│   ├── vitest.greenfield.ts       # thresholds de coverage para vitest config
│   ├── vitest.brownfield.ts
│   ├── vitest.legacy.ts
│   ├── jest.greenfield.json
│   ├── jest.brownfield.json
│   └── jest.legacy.json
│
├── report/                        # template do report visual de qualidade
│   ├── server.ts                  # servidor local efêmero (Node http) usado por /lint:report
│   ├── index.html                 # shell renderizado pelo servidor e pelo export
│   ├── app.ts                     # bootstrap, theme switcher, charts, animations
│   ├── data-loader.ts             # lê .lint-audit/*.json + coverage + git stats
│   ├── components/                # cards de métrica, charts, tabelas
│   │   ├── MetricCard.ts
│   │   ├── ChartLine.ts
│   │   ├── ChartTreemap.ts
│   │   └── ViolationsTable.ts
│   └── export.ts                  # serializa estado completo num único HTML self-contained
│
├── themes/                        # temas do report (CSS + tokens)
│   ├── linear-design-md/          # default; light + dark; baseado em getdesign.md/linear.app/design-md
│   │   ├── light.css
│   │   ├── dark.css
│   │   └── tokens.json
│   └── README.md                  # como adicionar um tema novo
│
├── templates/                     # arquivos copiados pro projeto-alvo
│   ├── post-edit.sh               # PostToolUse hook
│   ├── lintstagedrc.example.js
│   ├── lint-decisions.md.tpl      # registro de rules adicionadas/removidas pelo usuário
│   └── package-scripts.json       # snippet pra mesclar em scripts do projeto
│
├── docs/
│   ├── stages.md                  # como heurística classifica estágio + tabela de thresholds
│   ├── thresholds.md              # tabela completa de thresholds por estágio + métrica
│   ├── coverage.md                # estratégia de coverage por runner + thresholds por estágio
│   ├── audit-format.md            # contrato JSON do audit consumido por /lint:update e /lint:report
│   ├── report-design.md           # princípios de design do report e adição de novos temas
│   ├── compatibility.md           # matriz: stacks suportadas/bloqueadas e por quê
│   └── adrs/                      # decisões arquiteturais
│       ├── 0001-oxc-only-v1.md
│       ├── 0002-named-backup-rollback.md
│       ├── 0003-stage-detection-heuristic.md
│       ├── 0004-audit-update-coupling.md
│       └── 0005-report-ephemeral-server-with-export.md
│
└── tests/
    └── fixtures/                  # projetos sintéticos para testar a skill
        ├── greenfield-ts/
        ├── brownfield-eslint-prettier/
        ├── legacy-monorepo/
        ├── jest-with-coverage/    # já tem Jest + coverage threshold configurado
        └── unsupported-python/
```

**Artefatos no projeto-alvo (criados pela skill):**

```
<projeto-alvo>/
├── oxlint.fast.json
├── oxlint.deep.json
├── .claude/settings.json          # com hook PostToolUse
├── .claude/hooks/post-edit.sh
├── .husky/pre-commit              # com lint-staged
├── .lint-backup/<timestamp>/      # criado se havia linter prévio
├── .lint-audit/<timestamp>.json   # output de cada /lint:audit; usado por update e report
├── docs/lint-decisions.md         # registro append-only de rules add/remove com motivo
├── quality-report/<timestamp>.html # snapshot exportado de /lint:report (opt-in, versionável)
└── (vitest.config.ts | jest.config.* | package.json) # com coverage thresholds aplicados
```

**Distribuição.** Por enquanto, instalação manual via cópia para `~/.claude/skills/lint/`, `~/.claude/commands/lint/`, `~/.claude/agents/`. Plugin publicável fica como evolução (ADR futura).

### Calibração de thresholds por estágio

Defaults derivados da tabela do `quality-metrics` README e da literatura citada. Stage detector aplica via preset selecionado; usuário pode ajustar via `/lint:update`.

| Métrica | Greenfield | Brownfield moderado | Legado pesado |
|---|---|---|---|
| WMC (max) | 15 (error) | 20 (error) | 40 (warn) |
| Halstead Volume (max) | 800 (warn) | 1000 (warn) | 2000 (warn) |
| Halstead Effort (max) | 300 (warn) | 400 (warn) | 1000 (warn) |
| LCOM (max) | 0 (warn) | 2 (warn) | 4 (warn) |
| CBO (max) | 8 (error) | 10 (error) | 20 (warn) |
| DIT (max) | 4 (warn) | 5 (warn) | 6 (warn) |

Justificativa em `docs/thresholds.md` e `docs/adrs/0003-stage-detection-heuristic.md`.

### Heurística de detecção de estágio (resumo)

Sinais (executados pelo subagent `lint-detector`):

- **Idade do repo:** `git log --reverse --format=%ci | head -1`.
- **LOC total:** `cloc --json` ou fallback `find … | wc -l`.
- **Churn:** `git log --since='90 days ago' --pretty=oneline | wc -l`.
- **# arquivos de código:** `git ls-files '*.ts' '*.tsx' '*.js' '*.jsx' | wc -l`.
- **Cobertura de testes:** presença de `test/` `tests/` `__tests__/` ou config Vitest/Jest/Playwright.
- **Densidade de comentários TODO/FIXME/HACK:** `grep -rE 'TODO|FIXME|HACK' | wc -l` normalizado por LOC.

Classificação (regras simples; ambíguos → pergunta):

- **Greenfield:** repo < 6 meses E LOC < 5k E sem linter prévio.
- **Legado pesado:** repo > 3 anos E (LOC > 50k OU densidade TODO/HACK > 1/100 LOC OU sem testes).
- **Brownfield moderado:** o resto.

Detector imprime os sinais brutos junto com a classificação para o usuário poder discordar com base em evidência.

### Estratégia de coverage

Detecta o runner de testes e adapta:

- **Vitest detectado** → instala `@vitest/coverage-v8`, edita `vitest.config.ts` aplicando `coverage.thresholds`.
- **Jest detectado** → habilita `--coverage` com provider `v8`, edita config Jest aplicando `coverageThreshold.global`.
- **Nenhum runner** → pergunta ao usuário se quer adotar Vitest (recomendado) ou pular coverage.

Meta de coverage por estágio (ponto de partida; sempre confirmada com o usuário):

| Estágio | lines | functions | branches | statements |
|---|---|---|---|---|
| Greenfield | 90 | 90 | 80 | 90 |
| Brownfield moderado | 70 | 70 | 60 | 70 |
| Legado pesado | 40 (warn-only) | 40 | 30 | 40 |

Se o projeto **já tem** thresholds configurados, a skill mostra os valores atuais e pergunta se o usuário quer manter, adotar o default do estágio, ou definir custom. Detalhes em `docs/coverage.md`.

### Contrato de audit (`.lint-audit/<timestamp>.json`)

Estrutura mínima — consumida por `/lint:update` (recomendações) e `/lint:report` (visualização):

```jsonc
{
  "version": "1",
  "generated_at": "2026-05-03T14:22:11Z",
  "stage": "brownfield-moderate",        // greenfield | brownfield-moderate | legacy
  "stage_signals": { /* git age, LOC, churn, autores, testes, todos/hacks */ },
  "tooling": {
    "oxlint": "1.x", "oxfmt": "0.x-alpha", "quality_metrics": "x.y.z",
    "test_runner": "vitest|jest|none",
    "coverage": { "configured": true, "lines": 67.4, "functions": 71.2, "branches": 58.8, "statements": 67.0,
                  "thresholds": { "lines": 70, "functions": 70, "branches": 60, "statements": 70 } }
  },
  "violations": {
    "summary": { "errors": 12, "warnings": 47, "files_affected": 18 },
    "by_metric": {
      "wmc":      { "violations": 4, "max_seen": 38, "top": [ { "file": "...", "class": "...", "value": 38, "max": 20 } ] },
      "halstead": { "violations": 6, "max_seen_volume": 1840, "top": [ /* ... */ ] },
      "lcom":     { "violations": 5, "top": [ /* ... */ ] },
      "cbo":      { "violations": 9, "top": [ /* ... */ ] },
      "dit":      { "violations": 1, "top": [ /* ... */ ] }
    }
  },
  "rules_active": [
    { "rule": "quality-metrics/wmc", "severity": "error", "options": { "max": 20 }, "origin": "preset:brownfield-moderate" },
    { "rule": "quality-metrics/cbo", "severity": "error", "options": { "max": 10 }, "origin": "preset:brownfield-moderate" },
    { "rule": "quality-metrics/dit", "severity": "warn",  "options": { "max": 5 },  "origin": "user-override:2026-04-12" }
  ],
  "recommendations": [
    {
      "id": "rec-001",
      "type": "raise-threshold|lower-threshold|add-rule|remove-rule|enable-tier|tighten-coverage|loosen-coverage|fix-tooling",
      "title": "WMC max está em 20 mas 90% das classes estão abaixo de 12 — apertar para 14",
      "rationale": "Distribuição empírica permite threshold mais rígido sem inflar warnings.",
      "blast_radius": { "files_newly_violating": 3, "files_currently_violating": 4 },
      "patch": { /* mudança proposta no preset/config */ },
      "severity": "suggest|recommend|critical",
      "applies_to": "oxlint.fast.json"
    }
  ]
}
```

`/lint:update` itera `recommendations[]` e usa `AskUserQuestion` (apply / skip / explain) para cada uma. Recomendações com `severity: critical` (ex: hook `PostToolUse` quebrado, peer-dep faltando) sobem ao topo da fila.

---

## 4. Code style (skill, commands, agents)

### SKILL.md / commands `.md`

- YAML frontmatter sempre em primeiro lugar; campos: `name`, `description`, `allowed-tools` (quando aplicável).
- `description` deve começar pela ativação ("Use when…", "Triggered by…") — é o que decide invocação.
- Corpo em GitHub-flavored markdown com seções estáveis: Visão Geral, Quando usar, Quando NÃO usar, Fluxo, Trade-offs, Verificação.
- Comprimento alvo: SKILL.md ≤ 200 linhas; commands ≤ 100 linhas; agents ≤ 150 linhas.
- Português orgulhoso (com acentos), termos técnicos em inglês.

### Subagents

- Cada subagent tem responsabilidade única e clara nos primeiros 3 parágrafos.
- Tools restritos ao mínimo necessário (read-only para auditor; com Write/Edit para installer/migrator).
- Sempre retornam um sumário estruturado (não dump de logs) — parent agent precisa decidir com pouco contexto.

### Presets oxlint

- JSON com `$schema` apontando pro schema do oxlint do projeto-alvo.
- Comentário no topo (campo `_comment`) com o estágio que esse preset assume e a data de geração.
- Severidades alinhadas à tabela: erros bloqueiam, warns sinalizam.

### Templates copiados pro projeto-alvo

- `post-edit.sh`: `#!/usr/bin/env bash` + `set -euo pipefail`. Filtra `$CLAUDE_FILE_PATHS` para `.ts`/`.tsx`/`.js`/`.jsx` antes de chamar oxlint.
- `lintstagedrc.example.js`: ES modules, fast antes de deep.
- `lint-decisions.md`: append-only; cada add/remove de rule registra data, rule, motivo (capturado via `AskUserQuestion`), autor (`git config user.email`).
- Tudo copiado é versionável; nada gerado on-the-fly que não seja determinístico.

### Report visual (`report/` + `themes/`)

- Stack: TypeScript puro + Vite-like dev server **embutido** (`server.ts` usa Node `http` + esbuild via `import('esbuild')`). Sem framework UI — vanilla DOM + Web Components onde fizer sentido. Charts: `chart.js` + `chartjs-plugin-treemap`.
- Animações: CSS-only por padrão (transitions, `@keyframes`, `view-transitions` API onde disponível). Sem GSAP/framer.
- Theming: CSS custom properties + atributo `[data-theme="light|dark"]` no `<html>`. Tokens vêm de `themes/<name>/tokens.json`. Theme switcher persistente via `localStorage`.
- Default theme: `linear-design-md/`, derivado de `https://getdesign.md/linear.app/design-md` (cores, tipografia, espaçamento, raios de borda). Suporta `light` e `dark` via media query + override manual.
- Acessibilidade: respeita `prefers-reduced-motion` (anima nada se reduzido); contraste AA mínimo em ambos os temas; navegação por teclado nos charts (descrição textual via `aria-label`).
- Export: `export.ts` produz **HTML self-contained** (CSS inline, JS inline, dados JSON inline) — funciona offline, abrível direto no browser, versionável em `quality-report/<timestamp>.html`.
- Estado fonte: report lê `.lint-audit/<timestamp>.json` mais recente + git log + coverage report do runner (`coverage/coverage-summary.json` p/ Vitest/Jest).

### Interação com o usuário

- **Regra de ouro:** uma pergunta por vez via `AskUserQuestion` com 2–4 opções e a recomendada como primeira marcada `(Recommended)`. Aplicação sistemática em todo o fluxo.
- Confirmações destrutivas (substituir linter, sobrescrever arquivo) sempre exibem o diff/lista de arquivos afetados antes da pergunta.

---

## 5. Testing strategy

A skill é mais comportamento conversacional do que código, então o teste é majoritariamente baseado em **fixtures + execução end-to-end manual ou semi-automatizada**.

### Tiers

**T1 — Fixtures sintéticos (`tests/fixtures/`).**

Pequenos projetos representativos, cada um com `.git/` versionado, dependências mínimas, e um `EXPECTED.md` descrevendo o comportamento esperado da skill:

- `greenfield-ts/`: projeto novo, sem linter, ~500 LOC, classes simples.
- `brownfield-eslint-prettier/`: ESLint+Prettier configurados, ~5k LOC, deve disparar fluxo de substituição com backup.
- `legacy-monorepo/`: workspace pnpm com 3 pacotes, churn alto, deve classificar como legado pesado.
- `unsupported-python/`: projeto Python — skill deve recusar com mensagem clara.

**T2 — Roteiros de execução (`tests/scenarios/*.md`).**

Cada cenário é um roteiro humano-legível que descreve: comandos do usuário, perguntas esperadas (com opções esperadas), efeitos colaterais esperados em arquivos. Executados manualmente quando há mudança não-trivial. Padrão para PRs.

**T3 — Validação dos artefatos gerados.**

Após `/lint:setup` em um fixture, scripts de validação verificam:

- `oxlint --config oxlint.fast.json src/` retorna exit code esperado.
- `package.json` tem os scripts `lint`, `lint:deep`, `format` corretos.
- `.claude/settings.json` tem o hook `PostToolUse` com matcher `Write|Edit|MultiEdit`.
- `.lint-backup/<timestamp>/` existe quando havia linter prévio.
- `/lint:rollback` restaura byte-a-byte os arquivos pré-existentes.

**T4 — Verificação contra docs reais.**

Antes de release, rodar a skill contra (a) repositório novo TS criado na hora, (b) um repo TS já existente com ESLint+Prettier real (escolhido pelo autor), e validar manualmente.

### O que NÃO é testado automaticamente

- Comportamento conversacional do agente principal — depende do modelo.
- Mensagens exatas das perguntas — são revisadas em PR mas não asseridas.
- Resultados das métricas em si — isso é responsabilidade do `quality-metrics`, não da skill.

---

## 6. Boundaries

### Always

- Sempre detectar a stack antes de qualquer escrita; se incompatível com oxc, recusar com mensagem explícita listando o que oxc suporta.
- Sempre exigir working tree git limpo antes de modificações; oferecer `git stash` se sujo.
- Sempre criar `.lint-backup/<ISO-timestamp>/` antes de remover/sobrescrever qualquer arquivo de configuração de linter pré-existente.
- Sempre usar `AskUserQuestion` com 2–4 opções para qualquer escolha não-trivial; uma pergunta por turno.
- Sempre imprimir um plano (lista de mudanças) antes de aplicar e pedir confirmação.
- Sempre justificar a classificação de estágio com os sinais brutos coletados.
- Sempre delegar atividades extensivas (audit em repo grande, instalação multi-camada, geração do report) para subagents para preservar contexto principal.
- Sempre versionar com `git add` os arquivos que a skill cria no projeto-alvo (não usar `--no-verify`).
- Sempre detectar runner de testes (Vitest/Jest/none) antes de configurar coverage e mostrar valores atuais antes de propor novos.
- Sempre registrar add/remove de rules em `docs/lint-decisions.md` com motivo capturado do usuário.
- Sempre mostrar `blast_radius` (quantos arquivos passam a violar / deixam de violar) antes de aceitar uma recomendação de `/lint:update` que muda thresholds.
- Sempre respeitar `prefers-reduced-motion` no report visual.

### Ask first

- Substituir linter existente (ESLint, Prettier, Biome, dprint, etc.) — explicitar lista do que será removido.
- Sobrescrever `.claude/settings.json` se já existir — preferir merge de hooks.
- Mudar versões major de dependências adjacentes (ex: subir TypeScript pra atender peer-dep do oxc).
- Tocar em CI (`.github/workflows/`, `.gitlab-ci.yml`) — não modificar sem confirmação explícita.
- Aplicar `oxfmt` em arquivos existentes (pode reescrever milhares de linhas).
- Promover thresholds de `warn` para `error` em projeto legado pesado.
- Aceitar uma classificação de estágio quando o sinal é fraco (ambíguo).
- Alterar thresholds de coverage existentes — sempre mostrar valor atual + valor proposto antes de pedir confirmação.
- Adicionar/remover rules — capturar motivo via `AskUserQuestion` antes de aplicar.
- Aplicar uma recomendação de `/lint:update` cujo `blast_radius.files_newly_violating > 0` — exibir lista dos arquivos afetados.
- Exportar snapshot do report para `quality-report/` — perguntar no fim de `/lint:report`, não automático.
- Trocar tema do report — preview antes de persistir como default.

### Never

- Nunca rodar `/lint:setup` sem confirmação do usuário, mesmo em greenfield.
- Nunca remover arquivos de configuração de linter sem backup nomeado em `.lint-backup/`.
- Nunca usar `--no-verify`, `--force`, `git reset --hard`, `git clean -f`, `rm -rf` sem instrução explícita do usuário.
- Nunca instalar para stacks fora do oxc (Python, Go, Rust, etc.) — recusar.
- Nunca suprimir warnings de peer-dep ou de versão alpha (`oxfmt`) — sempre exibir o aviso integralmente.
- Nunca aplicar auto-fix em violações estruturais (WMC/CBO/etc.) — são refactors humanos.
- Nunca commitar automaticamente as mudanças do setup — sempre deixar staged ou não-staged conforme o usuário pediu, com mensagem sugerida.
- Nunca rodar oxlint/oxfmt em paths fora do que `git ls-files` retorna (não tocar em `node_modules/`, `dist/`, `build/`, `.next/`).
- Nunca empurrar mudanças pro remoto.
- Nunca fazer múltiplas perguntas em uma mensagem — uma por vez via `AskUserQuestion`.
- Nunca aplicar uma recomendação de `/lint:update` em batch — uma por vez com confirmação.
- Nunca expor o servidor do report fora de `localhost` (sem `0.0.0.0`, sem túnel).
- Nunca embutir dados sensíveis no export do report (filtrar `process.env`, paths absolutos do filesystem do autor, tokens em config).
- Nunca alterar thresholds de coverage para baixo (afrouxar) sem registrar o motivo em `docs/lint-decisions.md`.
- Nunca remover `.lint-audit/<timestamp>.json` automaticamente — usuário decide quando limpar (sugere git ignore opcional).

---

## 7. Acceptance criteria (v1)

A v1 é considerada pronta quando, em um Mac/Linux com Claude Code instalado:

1. **`/lint:setup` em `tests/fixtures/greenfield-ts/`:**
   - Faz 2–4 perguntas via `AskUserQuestion` (uma por vez), incluindo meta de coverage.
   - Instala oxlint, oxfmt, quality-metrics, ts-morph + provider de coverage adequado ao runner detectado.
   - Gera `oxlint.fast.json` e `oxlint.deep.json` com thresholds de greenfield.
   - Cria `.claude/settings.json` com hook `PostToolUse`.
   - Cria `.husky/pre-commit` com `lint-staged`.
   - Adiciona scripts `lint`, `lint:deep`, `format`, `coverage` ao `package.json`.
   - Configura coverage thresholds no config do runner.
   - Imprime plano antes de cada escrita.
2. **`/lint:setup` em `tests/fixtures/brownfield-eslint-prettier/`:**
   - Detecta ESLint+Prettier, mostra lista de arquivos a remover, pede confirmação.
   - Cria `.lint-backup/<timestamp>/` com `.eslintrc*`, `.prettierrc*`, e o `package.json` original.
   - Após confirmação, remove configs antigas e instala oxc + presets de brownfield moderado.
   - `/lint:rollback` em seguida restaura tudo idêntico ao estado pré-setup.
3. **`/lint:setup` em `tests/fixtures/jest-with-coverage/`:**
   - Detecta Jest + coverage threshold existente (ex: lines 60).
   - Mostra valor atual e o default do estágio detectado, pergunta qual usar.
   - Após confirmação, edita config Jest mantendo a escolha do usuário.
4. **`/lint:setup` em `tests/fixtures/unsupported-python/`:**
   - Recusa imediatamente com mensagem listando stacks suportadas.
   - Não escreve nada no projeto.
5. **`/lint:audit` em qualquer fixture configurado:**
   - Roda fast+deep tier sem modificar arquivos.
   - Persiste `.lint-audit/<timestamp>.json` com formato do contrato (seção 3).
   - Imprime resumo: estágio, top violações por métrica, # recomendações por categoria.
   - Termina com exit code não-zero se houver `error`-level.
6. **`/lint:update` após um audit:**
   - Lê o JSON mais recente em `.lint-audit/`.
   - Itera `recommendations[]` uma por vez via `AskUserQuestion` (apply/skip/explain).
   - Para `raise/lower-threshold`, mostra `blast_radius` antes de aplicar.
   - Cada aplicação é registrada em `docs/lint-decisions.md`.
7. **`/lint:report` em fixture com audit prévio:**
   - Sobe servidor em `127.0.0.1:<porta-livre>` e abre browser.
   - Renderiza cards de métrica, charts (treemap por arquivo, line de tendência por timestamp), violações top-N, coverage.
   - Theme switcher light/dark funcional; respeita `prefers-reduced-motion`.
   - No fim, oferece exportar snapshot self-contained para `quality-report/<timestamp>.html`.
   - O HTML exportado abre offline e renderiza idêntico ao servidor.
8. **`/lint:rules:list` em fixture configurado:**
   - Lista rules ativas, severidade, threshold, origem (preset / user-override + data).
9. **`/lint:rules:add` e `/lint:rules:remove`:**
   - Add: dry-run mostra arquivos novos violando; pergunta severidade e threshold; aplica.
   - Remove: pergunta motivo via `AskUserQuestion`; registra em `docs/lint-decisions.md`; aplica.
10. **`/lint:status` em fixture configurado:**
    - Imprime versões, presets ativos, estágio detectado, hooks ativos, meta de coverage atual, tema do report.
11. **Subagents:**
    - Todos recebem prompts auto-contidos e retornam sumários estruturados (≤ 30 linhas).
    - `lint-auditor` em repo de 10k+ LOC roda em < 30s no fixture `legacy-monorepo`.

---

## 8. Open questions (para iterações futuras)

- Como evoluir para plugin publicável? (ADR pendente)
- Suporte a Vue/Svelte SFC quando oxc cobrir.
- Suporte a monorepo com estágios diferentes por pacote (cada pacote tem seu preset?).
- Telemetria opt-in para refinar heurística de estágio com base em uso real.
- Integração com `/ultrareview` para usar dados das métricas em PR review.
- ADR sobre regras `quality-metrics` adicionais quando o plugin evoluir.
- Catálogo de temas para o report (comunidade contribui via PR em `themes/`).
- Modo "read-only mirror" do report: hospedar snapshot em GitHub Pages do projeto sem expor servidor local.
- Diff de audit: comparar `.lint-audit/<a>.json` vs `<b>.json` no report (regressões / melhorias por commit/sprint).
- Bloco `/lint:audit --since <ref>` para auditar apenas arquivos alterados desde uma ref git.
