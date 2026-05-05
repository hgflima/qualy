---
name: lint:ignore:remove
description: Use when the user asks to remove a lint exclusion in a TS/TSX/JS/JSX project, says "/lint:ignore:remove <glob>", "remover exclusão", "expor src/legacy ao lint de novo", "drop ignore entry", or wants to drop an entry from `.harn/qualy/ignore.json` and recompile the oxlint presets. Mutating — edits manifest, recompiles `oxlint.{fast,deep}.json` markers, appends `ignore-remove` to `.harn/qualy/docs/lint-decisions.md`. **`--reason` is mandatory** (SPEC §6 — toda remoção precisa de motivo registrado). Confirms via `AskUserQuestion` (one question at a time) and refuses dirty trees with `--strict` (offers `git stash`).
allowed-tools: Bash, AskUserQuestion, SlashCommand
argument-hint: <glob> [--rule <rule-id>|path] [--reason <txt>]
---

# /lint:ignore:remove

Remove uma entrada do manifesto qualy de exclusões (lint-ignore SPEC §3.2 + §4.1). Mutating — edita `.harn/qualy/ignore.json`, recompila `oxlint.fast.json` e `oxlint.deep.json` entre os markers `_qualy:start_/end_`, e append entry `ignore-remove` em `.harn/qualy/docs/lint-decisions.md` com motivo **obrigatório** capturado pelo harness. SPEC §6 Always: toda remoção exige motivo registrado — sem motivo, `ignore-remove` rejeita com `reason_required`.

## Visão Geral

1. **Pré-checks:** `detect-stack` → `git-clean-check` (oferece `git stash` se sujo) → `ignore-list` (existe entry?).
2. **Resolução de ambiguity:** se o glob casa múltiplas entries (path-only + per-rule), o CLI retorna `entry_ambiguous` com `candidates`; `AskUserQuestion` deixa o usuário escolher e re-roda com `--rule <id>` (ou `--rule path` para a path-only).
3. **Captura de motivo (SPEC §6 Always):** `AskUserQuestion` pedindo o motivo livre antes de qualquer escrita. SEM motivo, abortar.
4. **Confirmação com blast radius:** `AskUserQuestion` mostrando entry alvo (id, glob, rule, reason original) e confirmando que removê-la expõe novos arquivos ao lint.
5. **Aplicação:** `ignore-remove <glob> [--rule <id>|path] --reason "<motivo>" --strict` por baixo.

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Pasta legada foi reescrita e a exclusão `src/legacy/**` não é mais necessária.
- Entry vencida (status `expired`) que o time decidiu não renovar — quer expor o path ao lint de novo.
- Per-rule entry obsoleto (`category:correctness` em `src/x/**` que foi refatorado e agora atende a baseline).
- Migração de `createdBy: "imported"` para entries explícitas: depois de revisar uma entry importada, o usuário pode removê-la se for desnecessária.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse imediatamente.
- Manifesto corrompido (`exit 70` `manifest_corrupt`): aborte e instrua reparo manual.
- Entry não existe (`exit 1` `entry_not_found`): mostre "no entry matches" e ofereça `/lint:ignore:list` para descobrir.
- Glob ambíguo sem `--rule`: `entry_ambiguous` — capture o `candidates[]` no JSON e roteie via `AskUserQuestion`.
- Tree sujo + usuário recusou `git stash`: aborte sem aplicar (`--strict`).
- Para listar/inspecionar: este comando muta. Use `/lint:ignore:list` ou `/lint:ignore:explain`.
- Para apenas atualizar `reason`/`expires`: use `/lint:ignore:add` (idempotente — mesma `(glob, rule)` vira `ignore-update`, não duplica).

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta.
2. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`. `ignore-remove --strict` aborta em sujo.
3. **Captura do glob:**
   - Se positional/`--glob` ausente: `AskUserQuestion` "Qual entry remover?" — popule até 4 opções via `ignore-list` rodado antes (entries reais do projeto).
   - Se passado: use direto.
4. **Preview do estado atual:** `ignore-explain <glob> --cwd "$PWD"` (read-only).
   - Exit `1` `entry_not_found` → "no entry matches"; ofereça `/lint:ignore:list` e termine.
   - Exit `1` `entry_ambiguous` → `candidates[]`. `AskUserQuestion` ofertando até 4 candidatos (cada um com `id` + `rule || (path-only)`); na escolha re-rode `ignore-explain --rule <id>` para mostrar o estado atual da entry escolhida.
5. **Pergunta 1 — Motivo (SPEC §6 Always):** `AskUserQuestion` pedindo motivo livre. SEM motivo (vazio ou whitespace-only), repita — `ignore-remove` rejeita `reason_required` no caminho final. Uma pergunta por vez — não combine com Pergunta 2.
6. **Pergunta 2 — Confirmação (blast radius):** `AskUserQuestion` com 3 opções fixas: `Remover (Recommended)` / `Cancelar` / `Mostrar history primeiro`. Show → `ignore-explain` mostra `history[]` e volta à pergunta. Útil antes de apagar dívida técnica antiga: lembra quando/por quê foi adicionada. Mensagem deve mencionar que a remoção expõe novos arquivos ao lint (blast-radius detalhado em arquivos chega em T4.3 com `ignore-blast-radius`).
7. **Aplicação:** `ignore-remove <glob> [--rule <id>|path] --reason "<motivo>" --strict --cwd "$PWD"`. Exit `0` aplicado, `1` recoverable (`reason_required`/`entry_not_found`/`entry_ambiguous`/`manifest_write_failed`/`decisions_failed`), `3` dirty tree (volte ao passo 2), `4` usage, `70` `manifest_corrupt`.
8. **Pós-condição:** mostre `id` removido, `glob`, `rule`, `files_changed` (manifesto + presets + decisions). NÃO commite — SPEC §6 Never. Sugira `/lint:audit` para re-medir agora que o path está exposto.

## Mapeamento de exit codes

- `0` — `ignore-remove` aplicou; entry dropped, presets recompiled, decision logged.
- `1` — recoverable: `reason_required` (volte à Pergunta 1 — whitespace-only conta como vazio, SPEC §6 enforça non-trivial reason), `entry_not_found` (mostre `/lint:ignore:list`), `entry_ambiguous` (mostre candidates e ofereça `--rule` via AskUserQuestion), `invalid_glob` (glob vazio), `manifest_write_failed`, `preset_malformed`, `decisions_failed`.
- `2` — não esperado (stack já checada); reporte como bug.
- `3` — `--strict` + tree sujo. Volte ao passo 2 e ofereça `git stash`.
- `4` — usage error: glob/positional ausente, `--reason` ausente, flag desconhecida.
- `5` — não aplicável.
- `70` — `manifest_corrupt` / `manifest_unsupported_version`. Aborte.

## Trade-offs

- **`--reason` mandatório (SPEC §6 Always)**: igual `/lint:rules:remove`. Whitespace-only é rejeitado pelo CLI. Trade-off: SPEC §6 enquadra remoção como mudança auditável; o motivo cria audit-trail útil em retros (`.harn/qualy/docs/lint-decisions.md` é append-only).
- **Ambiguity em vez de remove-all:** se o glob casa múltiplas entries, o CLI recusa em vez de remover todas — protege o usuário de afrouxamento acidental quando a intenção era só dropar a entry path-only mantendo as per-rule. SPEC §3.2 line 318: "ambíguo → exit 1".
- **Blast radius "verbal" em P3, real em P4:** Pergunta 2 menciona que remover expõe arquivos ao lint mas sem contar quantos. T4.3 vai trazer `ignore-blast-radius <glob>` com count + sample de até 10 arquivos; até lá, a confirmação é informativa.
- **`--rule path` como sinônimo de `null`:** o CLI aceita ambos. Slash command sempre passa explícito (mais robusto que tentar omitir o flag para "path-only").
- **Idempotência via not-found:** se a entry já foi removida, exit `1` `entry_not_found` (não exit `0` "no-op"). Trade-off vs. `rules-remove` que retorna `already-absent`. Aceitável — `ignore-list` é barato e o usuário rodar duas vezes seguidas é raro.
- **Sem auto-commit (SPEC §6 Never):** cada `ignore-remove` deixa staged (manifesto + presets + decisions). Usuário decide quando commitar.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" ignore-remove --help` retorna usage com `<glob>` REQUIRED + `--reason` REQUIRED + `--rule`/`--strict`/`--cwd` opcionais.
- E2E (SPEC §10 #8 — dirty tree): tree sujo + `--strict` → exit `3` com mensagem `git stash`.
- E2E (SPEC §6 reason gate): `ignore-remove 'src/legacy/**' --reason "" --cwd "$PWD"` retorna exit `1` com `error: "reason_required"` mesmo com a entry presente.
- E2E ambiguity: após adicionar 1 path-only + 1 per-rule no mesmo glob, `ignore-remove 'src/x/**' --reason "y"` retorna exit `1` `entry_ambiguous` com `candidates`. Slash mostra opções e re-roda com `--rule path` ou `--rule quality-metrics/wmc`.
- E2E sucesso: após `ignore-add 'src/legacy/**' --reason "x"` → `/lint:ignore:remove 'src/legacy/**'` (Pergunta 1: `"reescrita concluída"`; Pergunta 2: Remover) → `.harn/qualy/ignore.json` perde a entry, presets recompilados (markers vazios ou removidos), `.harn/qualy/docs/lint-decisions.md` ganha entry `ignore-remove` com `reason: "reescrita concluída"`.

## Referências

- `.harn/docs/lint-ignore/SPEC.md` §3.2 (`qualy ignore remove`), §4.1 (slash conventions), §6 (Always: registrar motivo + Never: sem afrouxamento sem motivo), §10 #8.
- `.harn/docs/lint-ignore/PLAN.md` Phase 3 + Task 3.5.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/ignore/{add,list,explain}.md` — comandos pares.
- `commands/lint/rules/remove.md` — modelo de "remoção com reason mandatory".
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
