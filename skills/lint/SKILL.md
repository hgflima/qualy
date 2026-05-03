---
name: lint
description: Use when the user wants to install, audit, update, or remove oxlint+oxfmt+quality-metrics in a TypeScript/JavaScript project, or asks for a Claude Code lint setup, coverage thresholds, a quality report, or rule changes. Triggered by `/lint`, mentions of "lint setup", "code quality", "PostToolUse hook", "oxlint", or related quality-metrics work. Routes to focused slash commands (`/lint:setup`, `/lint:audit`, `/lint:update`, `/lint:status`, `/lint:report`, `/lint:rules:*`, `/lint:uninstall`, `/lint:rollback`) — never edits configs directly.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
---

# /lint

Router conversacional para a família `/lint:*`. Não modifica nada por conta própria — escolhe o subcomando certo, confirma com o usuário (uma pergunta por vez via `AskUserQuestion`) e delega.

## Visão Geral

A skill instala e gerencia oxlint + oxfmt + `quality-metrics` em projetos TS/TSX/JS/JSX, calibra thresholds por estágio (greenfield / brownfield-moderate / legacy), expõe um report visual de qualidade e suporta rollback. A lógica determinística vive em `cli/src/` (CLI TypeScript invocado via `--experimental-strip-types`); este `.md` é o orquestrador fino.

## Quando usar

- Usuário pede para instalar lint/format/coverage do zero → `/lint:setup`.
- Usuário quer saber em que estado o lint está → `/lint:status` (read-only).
- Usuário pede análise crítica do código → `/lint:audit` → `/lint:update`.
- Usuário quer ver, adicionar, remover ou explicar rules → `/lint:rules:list`, `/lint:rules:add`, `/lint:rules:remove`, `/lint:rules:explain`.
- Usuário quer abrir o report visual → `/lint:report`.
- Usuário quer remover tudo ou voltar atrás → `/lint:uninstall` ou `/lint:rollback`.

## Quando NÃO usar

- Stack não-TS/JS (Python, Go, Rust, Vue/Svelte SFC). Recuse explicitamente — `qualy detect-stack` retorna exit `2` com `blockers[]`.
- Linters de outras linguagens (ruff, golangci-lint, clippy). Fora do escopo do oxc.
- Auto-fix de violações estruturais (são extrações/refatorações, não rewrites).
- Cenários sem Claude Code (a skill assume hooks `PostToolUse` e `AskUserQuestion`).

## Resolução do CLI

Todo subcomando do harness usa o mesmo preâmbulo (definido aqui uma vez, reutilizado em `commands/lint/*.md` e `agents/lint-*.md`):

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

`CLAUDE_PLUGIN_ROOT` é exportado pelo Claude Code quando a skill é carregada como plugin; quando não está, cai para `$HOME/.claude/` (layout do `install.sh`). Em workspace de dev (presença de `SPEC.md` em `$PWD` ou ancestor), pode-se apontar para `$REPO/cli/src/index.ts`.

Saída padrão do CLI:

- **stdout**: 1 documento JSON canônico por invocação.
- **stderr**: NDJSON estruturado + mensagens humanas (não parsear).
- **exit codes** (de `cli/src/lib/exit-codes.ts`): `0` ok, `1` recoverable, `2` unsupported-stack, `3` dirty-tree, `4` usage, `5` missing-dep, `70` internal.

Mapeamento sugerido para mensagens user-friendly:

- `2` → "Stack não suportada nesta versão (apenas TS/TSX/JS/JSX). Veja `blockers` em stdout."
- `3` → "Working tree sujo. Quer rodar `git stash` antes? (Recommended)" via `AskUserQuestion`.
- `5` → "Falta `oxlint`/`oxfmt`/`quality-metrics`. Rodar `/lint:setup` instala tudo."

## Fluxo

1. Identifica intenção. Se ambígua, **uma** pergunta via `AskUserQuestion` (2–4 opções) — ex.: `setup`, `audit`, `status`, `outro`.
2. Roda o slash command correspondente via `SlashCommand`. O `.md` daquele comando cuida da orquestração específica (detect → confirm → install/audit/etc.).
3. Esta SKILL.md **não** chama o CLI diretamente para mutações — apenas roteia.
4. Exceção barata: ao receber `/lint` sem argumento, pode invocar `qualy status` para imprimir um sumário 1-shot antes de oferecer ações.

## Convenções globais (todos os subcomandos respeitam)

- **Uma pergunta por vez** via `AskUserQuestion`, com 2–4 opções; a recomendada vem primeira marcada `(Recommended)`.
- **Working tree limpo** antes de qualquer escrita destrutiva (rodar `qualy git-clean-check` ou passar `--strict`); oferecer `git stash` se sujo.
- **Backup nomeado** antes de substituir linter prévio (`.lint-backup/<ISO-timestamp>/`).
- **Decisões** registradas em `docs/lint-decisions.md` no projeto-alvo (append-only com timestamp ISO-8601 UTC, autor via `git config user.email`, motivo via `AskUserQuestion`).
- **Erros não-recuperáveis** abortam, mostram path do backup ou comando `git stash pop` para o usuário restaurar.
- **CLI nunca faz pergunta** — toda interação é responsabilidade do harness; CLI consome respostas via flags/env.

## Trade-offs

- **Determinismo > flexibilidade**: regras vivem no CLI, não no modelo. Mudar comportamento exige patch + teste, não prompt-engineering.
- **oxc-only em v1**: stacks fora de TS/TSX/JS/JSX bloqueadas (SPEC §1). Tradeoff aceito porque oxc é o único path com performance + Halstead/LCOM/CBO/DIT.
- **Sem build step**: Node ≥ 22.6 + `--experimental-strip-types` (ADR 0007). Versões antigas falham cedo no `install.sh`.
- **Subagents finos**: `lint-detector`, `lint-installer`, `lint-migrator`, `lint-auditor` retornam sumários ≤30 linhas. `lint-auditor` é a única exceção autorizada (escreve `rationale` enriquecida — ADR 0008); o resto é puro wrapper de CLI.

## Verificação

- Smoke por iteração: `node --experimental-strip-types "$QUALY_CLI" --help` lista os subcomandos.
- Smoke `/lint:status`: roda em qualquer cwd, imprime versões, presets, estágio, hooks, coverage, theme — exit `0`.
- E2E (PLAN §Fase 2 verificação): `/lint:setup` num fixture `greenfield-ts` produz todos os artefatos do SPEC §7.1 (`oxlint.fast.json`, `oxlint.deep.json`, `.claude/hooks/post-edit.sh`, `.husky/pre-commit`, `package.json#scripts`, `.lint-manifest.json`).

## Referências

- `.harn/docs/mvp/SPEC.md` — contrato completo da skill.
- `.harn/docs/mvp/PLAN.md` — divisão harness/CLI e §Resolução do CLI.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — princípio central.
- `docs/adrs/0007-runtime-ts-strip-types.md` — Node ≥ 22.6 + `--experimental-strip-types`.
- `docs/adrs/0008-hybrid-recs-rationale.md` — exceção do `lint-auditor`.
- `docs/adrs/0009-install-script-distribution.md` — `install.sh`.
