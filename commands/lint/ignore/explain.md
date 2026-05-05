---
name: lint:ignore:explain
description: Use when the user asks "what is this ignore", says "/lint:ignore:explain <glob>", "explicar essa exclusão", "por que esse path foi ignorado", or wants the entry details + history of mutations from `.harn/qualy/docs/lint-decisions.md` for a single entry in `.harn/qualy/ignore.json`. Read-only — never mutates. Recoverable error (exit `1`) when the entry is not found or the glob is ambiguous (multiple entries → ask for `--rule`).
allowed-tools: Bash, AskUserQuestion, SlashCommand
argument-hint: <glob> [--rule <rule-id>|path]
---

# /lint:ignore:explain

Explicação read-only de uma entrada do manifesto qualy de exclusões (lint-ignore SPEC §3.4 + §4.1). Resolve `(glob, rule)` em `.harn/qualy/ignore.json` e mostra a entry decorada (`status`, `days_overdue` quando vencida) + history filtrado de `.harn/qualy/docs/lint-decisions.md` (todos os blocos `ignore-add`/`ignore-update`/`ignore-remove`/`ignore-import` com o mesmo `id`). **Read-only** — nunca escreve manifesto, presets ou decisions.

## Visão Geral

1. **Pré-checks (read-only):** `detect-stack` → `ignore-explain` resolve a entry.
2. **Execução:** `ignore-explain <glob> [--rule <id>|path] --cwd "$PWD"` retorna `{ ok, entry, history[] }`.
3. **Resumo ao usuário:** detalhes da entry (id, glob, rule, reason, expires, status, createdBy) + timeline de history (timestamp, kind, subject por bloco).
4. **Próximo passo:** se `status: "expired"`, ofereça `/lint:ignore:remove` ou renovação via `/lint:ignore:add` (idempotente — atualiza `expires` in-place).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash. Stack envelope: TS/TSX/JS/JSX.

## Quando usar

- Onboarding: novo dev viu `src/legacy/**` no `ignore-list` e quer saber por quê foi excluído.
- Code review: PR mexe em `src/generated/**` e o reviewer quer confirmar reason original.
- Auditoria de dívida técnica: rastrear quando uma entry foi criada e por quem (history mostra cada `ignore-add`/`ignore-update`).
- Antes de `/lint:ignore:remove`: ler reason + history para decidir se vale realmente expor o path ao lint.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse.
- Manifesto corrompido (exit `70` `manifest_corrupt`): aborte e instrua reparo manual.
- Entry não existe (exit `1` `entry_not_found`): mostre `(not found)` e ofereça `/lint:ignore:list` para descobrir entries existentes.
- Glob ambíguo (exit `1` `entry_ambiguous`): mostre `candidates[]` e peça ao usuário re-rodar com `--rule <id>` (ou `--rule path` para a entry path-only).
- Para listar todas as entries: use `/lint:ignore:list` (este comando é por entry).
- Para mutar: este comando é read-only. Use `/lint:ignore:add` ou `/lint:ignore:remove`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta.
2. **Captura do glob:**
   - Se positional/`--glob` ausente: `AskUserQuestion` "Qual entry inspecionar?" — ofereça até 4 globs reais via `ignore-list` (rode antes para popular as opções).
   - Se o usuário passou `<glob>`: use direto.
3. **`ignore-explain <glob> [--rule <id>] --cwd "$PWD"`** — exit `0` retorna `{ ok, entry, history[] }`. Exit `1`:
   - `error: "entry_not_found"` → mostre "no entry matches `<glob>`" e ofereça `/lint:ignore:list` para descobrir.
   - `error: "entry_ambiguous"` → mostre `candidates: [{ id, rule }]`. `AskUserQuestion` ofertando até 4 candidatos (cada um com `id` + `rule || (path-only)`); na escolha, re-rode `ignore-explain <glob> --rule <id>` (ou `--rule path` para path-only).
4. **Sumário ao usuário** (formato fixo, Markdown):
   - **Entry**: `id`, `glob`, `rule` (`(path-only)` quando null), `reason`, `expires` (ou `(never)`), `status` (+ `(N days overdue)` quando expired), `createdBy` (`user` ou `imported`), `createdAt`.
   - **History** (até 10 blocos, ordem cronológica do log): cada bloco mostra `timestamp`, `kind` (`ignore-add` / `ignore-update` / `ignore-remove` / `ignore-import`), e `subject`. Se `history.length === 0`, imprima "no decision-log entries found" — pode acontecer se o decision log foi resetado ou a entry foi importada antes da migração.
5. **Pós-condição (opcional):**
   - `status: "expired"`: `AskUserQuestion` 3 opções (`Renovar (estende --expires)` / `Remover entry` / `Manter como está`). Renew → `/lint:ignore:add <glob> --reason "<original>" --expires <new>` (idempotente, vira `ignore-update`). Remove → `/lint:ignore:remove <glob> --reason "<motivo>"`.
   - `createdBy: "imported"`: lembre que essa entry veio do brownfield import (SPEC §2.4) — o `reason` é genérico (`Imported from oxlint preset on first qualy ignore mutation`). Ofereça `/lint:ignore:add` para refinar reason.

## Mapeamento de exit codes

- `0` — sucesso; mostre entry + history.
- `1` — `entry_not_found` (mostre catálogo via `/lint:ignore:list`) ou `entry_ambiguous` (peça `--rule` para disambiguar; `--rule path` é a sintaxe para path-only).
- `2` — não esperado (`detect-stack` já checada); reporte como bug.
- `3` — não aplicável (read-only).
- `4` — usage error: glob não passado, flag desconhecida.
- `5` — não aplicável.
- `70` — `manifest_corrupt` / `manifest_unsupported_version`. Aborte mostrando `reason`.

## Trade-offs

- **`--rule path` como sinônimo de `null`:** o CLI aceita ambos para que o slash command sempre passe um seletor explícito sem precisar saber se a entry é path-only. SPEC §3.4 não exigiria, mas evita bugs em `AskUserQuestion` candidates onde renderizar `null` no markdown é frágil.
- **Glob é igualdade literal, não picomatch:** `ignore-explain "src/**"` só casa entries com `glob === "src/**"` exato (não com `src/legacy/**`). Trade-off: T4.3 vai trazer `fast-glob`; até lá, o usuário precisa do glob exato (rodar `ignore-list` antes ajuda).
- **History pode estar vazia:** decision log pode ter sido apagado ou recriado, ou a entry foi importada antes de a migração T1.3 rodar. `history: []` ≠ erro — é informativo. SPEC §3.4 não promete o histórico completo, só "linhas relevantes do `lint-decisions.md`".
- **Pergunta opcional, não obrigatória:** SPEC §4.1 lista `/lint:ignore:explain` como sem prompts no caminho default. A `AskUserQuestion` de pós-condição só dispara quando faz sentido (entry expired ou imported genérico).
- **Sem auto-commit:** read-only, então não há mutação para commit. Trade-off N/A.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" ignore-explain --help` retorna usage com `<glob>` REQUIRED + `--rule`/`--cwd` opcionais.
- E2E (SPEC §10): após `qualy ignore-add 'src/legacy/**' --reason "x"`, `ignore-explain 'src/legacy/**'` retorna exit `0` com `entry.id`, `entry.reason: "x"`, `history.length === 1` com `kind: "ignore-add"`.
- E2E ambiguity: após `ignore-add 'src/x/**' --reason "a"` E `ignore-add 'src/x/**' --rule quality-metrics/wmc --reason "b" --i-know-this-disables-many` → `ignore-explain 'src/x/**'` retorna exit `1` `entry_ambiguous` com `candidates: [{id, rule: null}, {id, rule: "quality-metrics/wmc"}]`. Slash command pergunta qual escolher e re-roda com `--rule path` ou `--rule quality-metrics/wmc`.

## Referências

- `.harn/docs/lint-ignore/SPEC.md` §3.4 (`qualy ignore explain`), §4.1 (slash conventions).
- `.harn/docs/lint-ignore/PLAN.md` Phase 3 + Task 3.5.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/ignore/{add,remove,list}.md` — comandos pares.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
