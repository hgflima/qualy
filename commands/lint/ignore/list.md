---
name: lint:ignore:list
description: Use when the user asks to inspect the lint-ignore manifest in a TS/TSX/JS/JSX project, says "/lint:ignore:list", "list ignores", "ver exclusões ativas", "show expired ignores", or wants the inventory of `.harn/qualy/ignore.json` (active vs expired entries, with status, expires, days_overdue, and category size when applicable). Read-only — reads `.harn/qualy/ignore.json`, never mutates. Refuses (recoverable) when the manifest is corrupt (`exit 70`) and routes to manual repair.
allowed-tools: Bash, AskUserQuestion, SlashCommand
argument-hint: [--expired] [--path <glob>]
---

# /lint:ignore:list

Inventário read-only do manifesto qualy de exclusões (lint-ignore SPEC §3.3 + §4.1). Lê `.harn/qualy/ignore.json` e exibe cada entrada com `status` (`active`/`expired`), `expires`, `days_overdue` (quando vencida) e `category_size` (quando `rule` é `category:<name>` conhecido). **Read-only** — nunca escreve manifesto, presets ou decisions.

## Visão Geral

1. **Pré-checks (read-only):** `detect-stack` → `ignore-list` (manifesto ausente vira `(no entries)` em exit `0`).
2. **Execução:** `ignore-list [--expired] [--path <glob>] --cwd "$PWD"` retorna `{ entries[], expired_count }`.
3. **Resumo ao usuário:** total de entries, expired_count, top entries com `id`, `glob`, `rule`, `reason` (truncado), `expires`, `status`, e `⚠ category (N rules)` quando `category_size` presente.
4. **Próximo passo:** se `expired_count > 0`, ofereça `/lint:ignore:remove` ou renovação manual; se `entries.length === 0`, sugira `/lint:ignore:add`.

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Auditoria periódica para detectar entries vencidas antes que dívida técnica acumule.
- Antes de `/lint:ignore:add` para evitar duplicar uma entry existente.
- Após `/lint:audit` para correlacionar exclusões com regiões cinza do report.
- Em pipelines CI: `qualy ignore-list --expired` exit `1` falha o build quando há vencidas (SPEC §10 #4).

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse.
- Manifesto corrompido (`exit 70` `manifest_corrupt`): aborte e instrua reparo manual em `.harn/qualy/ignore.json`.
- Para mutar entries: este comando é read-only. Use `/lint:ignore:add`, `/lint:ignore:remove`.
- Para inspecionar um entry específico com history: use `/lint:ignore:explain <glob>`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta.
2. **`ignore-list --cwd "$PWD"` (default):** exit `0` retorna `{ ok, entries[], expired_count }`. Manifesto ausente / vazio → `entries: []`, exit `0`. Manifesto corrompido → exit `70` com `error: "manifest_corrupt"`.
3. **Filtros opcionais (passados pelo argumento do slash):**
   - `--expired`: filtra apenas vencidas. Exit `1` se houver, `0` caso contrário (útil em CI — SPEC §10 #4). Sem o flag, retorna tudo com exit `0` mesmo se houver vencidas (status mostra `expired`).
   - `--path <glob>`: filtra por igualdade literal. Não há glob-match (T4.3 traz `fast-glob`).
4. **Sumário ao usuário** (formato Markdown curto):
   - Linha resumo: `N entries (M active, K expired)`.
   - Tabela ou lista das primeiras 8 entradas com colunas `id`, `glob`, `rule` (`(path-only)` quando null, ou `category:<name>` ⚠ N rules quando `category_size` presente), `reason` (truncado a ~40 chars), `expires` (ou `(never)`), `status` (e `(N days overdue)` quando expired).
   - Mostre `createdBy: "imported"` em destaque para entries de brownfield migration (T3.4).
5. **Pós-condição (opcional, only if action makes sense):**
   - `expired_count > 0`: `AskUserQuestion` 3 opções (`Remover entradas vencidas` / `Renovar (re-add com novo --expires)` / `Não, obrigado`). Remove → roteie cada uma via `/lint:ignore:remove`. Renew → roteie via `/lint:ignore:add` (idempotência cuida do upsert).
   - `entries.length === 0`: ofereça `/lint:ignore:add <glob>` se o usuário descreveu intenção de excluir algo.

## Mapeamento de exit codes

- `0` — sucesso; mostre sumário (mesmo com `entries: []`).
- `1` — `--expired` flag passado E há vencidas (SPEC §10 #4). Mostre as vencidas e pergunte sobre próximo passo.
- `2` — não esperado (`detect-stack` já checada); reporte como bug.
- `3` — não aplicável (read-only não passa `--strict`).
- `4` — usage error: bug no harness; reporte e aborte.
- `5` — não aplicável.
- `70` — `manifest_corrupt` ou `manifest_unsupported_version`. Aborte mostrando `reason` e sugira `cat .harn/qualy/ignore.json | jq .` para inspeção manual.

## Trade-offs

- **Read-only > orquestração:** SPEC §4.1 lista `/lint:ignore:list` como sem prompts no caminho default. As únicas perguntas só disparam após o usuário aceitar explicitamente um próximo passo (remove/renew).
- **`--path` literal, não glob-match:** P2 não traz `fast-glob`; T4.3 troca para match real. Trade-off: o usuário não pode listar `src/**` sem passar o glob exato. Documentado no help do CLI.
- **`category_size` só populado para categorias conhecidas:** entries com `rule: category:bogus` (unknown) ou rules nominais não recebem o annotation. Drift desse contrato quebraria o highlighting `⚠ category (N rules)` esperado pelo usuário.
- **Manifesto vazio = sucesso:** entries.length === 0 retorna exit `0` com `(no entries)`. Trade-off: o usuário precisa ler o sumário para distinguir "manifesto fresh" de "todas removidas". Aceitável — `ignore-list` é discovery, não gate.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" ignore-list --cwd "$PWD"` em projeto sem manifesto retorna exit `0` com `entries: []`.
- E2E (SPEC §10 #3): após `qualy ignore-add 'src/legacy/**' --reason "x"`, `ignore-list` mostra 1 entry com `status: "active"`.
- E2E (SPEC §10 #4): com fixture `ignore-expired/`, `ignore-list --expired` retorna exit `1`; sem `--expired` retorna exit `0` listando a entry com `status: "expired"`, `days_overdue: 34`.
- E2E: entry com `rule: "category:perf"` mostra `category_size: 13` e o slash renderiza `⚠ category (13 rules)`.

## Referências

- `.harn/docs/lint-ignore/SPEC.md` §3.3 (`qualy ignore list`), §4.1 (slash conventions), §10 #3/#4 (acceptance).
- `.harn/docs/lint-ignore/PLAN.md` Phase 3 + Task 3.5.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/ignore/{add,remove,explain}.md` — comandos pares.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
