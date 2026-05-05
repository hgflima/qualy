---
name: lint:ignore:add
description: Use when the user asks to add a path-based lint exclusion in a TS/TSX/JS/JSX project, says "/lint:ignore:add <glob>", "ignorar legacy", "exclude generated code", "skip vendored files", or wants to register an audited entry in `.harn/qualy/ignore.json` with mandatory `reason` and optional `expires`. Mutating — edits manifest, recompiles `oxlint.{fast,deep}.json` markers, appends `ignore-add` (or `ignore-update`) to `.harn/qualy/docs/lint-decisions.md`. Confirms via `AskUserQuestion` (one question at a time), refuses dirty trees with `--strict` (offers `git stash`). Phase 2 is path-only — per-rule (`--rule`) lands in T3.3.
allowed-tools: Bash, AskUserQuestion
argument-hint: <glob> [--reason <txt>] [--expires YYYY-MM-DD]
---

# /lint:ignore:add

Registra uma exclusão de path no manifesto qualy (lint-ignore SPEC §3.1 + §4.1) com motivo obrigatório e expiry opcional. Mutating — edita `.harn/qualy/ignore.json`, recompila os presets `oxlint.fast.json` e `oxlint.deep.json` entre os markers `_qualy:start_/end_`, e append entry `ignore-add` (ou `ignore-update` em re-add) em `.harn/qualy/docs/lint-decisions.md`. Toda escrita passa pelo CLI; este `.md` orquestra detecção → captura de glob → captura de motivo → captura de expiry → confirmação → aplicação.

## Visão Geral

1. **Pré-checks:** `detect-stack` → `git-clean-check` (oferece `git stash` se sujo).
2. **Captura do glob:** se ausente no positional, `AskUserQuestion` pedindo a path expression.
3. **Captura do reason (SPEC §4.1):** `AskUserQuestion` com 4 opções fixas — `legacy code` / `generated code` / `vendored code` / `Other`. Em `Other`, segunda pergunta pede o texto livre. SPEC §3.1 + §6 Always: reason é obrigatório.
4. **Captura do expires:** `AskUserQuestion` com 4 opções — `No expiry (Recommended)` / `90 days` / `180 days` / `Custom YYYY-MM-DD`. Datas no passado são rejeitadas pelo CLI (exit `1`).
5. **Aplicação:** `ignore-add <glob> --reason "<txt>" [--expires <date>] --strict` por baixo, idempotente (mesmo `(glob, rule=null)` → `ignore-update`, sem duplicar).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash. Stack envelope: TS/TSX/JS/JSX.

## Quando usar

- Pasta legada que ainda será reescrita (`src/legacy/**`) — defaults: `legacy code` + `No expiry`.
- Código gerado automaticamente (`src/generated/**`, `dist/**`) — defaults: `generated code` + `No expiry`.
- Dependências vendored copiadas para o repo (`vendor/**`) — defaults: `vendored code` + `No expiry`.
- Migração temporária de Q3 para Q4 — `Other` + `Custom YYYY-MM-DD` para forçar revisão futura.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse imediatamente.
- Para desligar uma rule específica em um path: este comando é só path-only em Phase 2. Per-rule (`--rule quality-metrics/wmc`) chega em T3.3.
- Manifesto corrompido (`exit 70` `manifest_corrupt`): aborte e instrua reparo manual em `.harn/qualy/ignore.json`.
- Tree sujo e usuário recusou `git stash`: aborte sem aplicar (`--strict` defesa em profundidade).
- Para remover exclusões: use `/lint:ignore:remove`. Para listar: `/lint:ignore:list`. Para inspecionar: `/lint:ignore:explain`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta com refusal claro (não TS/TSX/JS/JSX).
2. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`. `ignore-add --strict` aborta em sujo, então prefira `git stash`.
3. **Captura do glob:** se positional/`--glob` ausente: `AskUserQuestion` "Qual path/glob excluir?" (uma pergunta por vez — não combine com reason).
4. **Captura do reason (SPEC §4.1):** `AskUserQuestion` com 4 opções: `legacy code` / `generated code` / `vendored code` / `Other`. Em `Other`, segunda `AskUserQuestion` pede texto livre. Reason obrigatório (mandatory) — vazio é rejeitado pelo CLI (exit `1`).
5. **Captura do expires:** `AskUserQuestion` com 4 opções: `No expiry (Recommended)` / `90 days` / `180 days` / `Custom YYYY-MM-DD`. Em `90`/`180`, calcule a data localmente (today + N) e passe pronta. Em `Custom`, segunda `AskUserQuestion` pede `YYYY-MM-DD`.
6. **Aplicação:** `ignore-add <glob> --reason "<reason>" [--expires <date>] --strict --cwd "$PWD"`. Exit `0` aplicado, `1` recoverable (`invalid_glob`, `reason_required`, `expires_in_past`, `decisions_failed`), `3` dirty tree (volte ao passo 2), `4` usage, `70` `manifest_corrupt`.
7. **Pós-condição:** mostre `id` do entry, `action` (`added` / `updated`), `files_changed` (manifesto + presets + decisions). NÃO commite — SPEC §6 Never line 416. Sugira `/lint:audit` para re-medir e `/lint:ignore:list` para visualizar.

## Trade-offs

- **One-question-at-a-time (memória do user — ADHD):** glob → reason → expires são 3 (ou 4 com Other/Custom) `AskUserQuestion` separadas. Nunca combine. SPEC §4 line 330.
- **Idempotência byte-a-byte:** re-add do mesmo `(glob, rule=null)` registra como `ignore-update` no decisions log e atualiza `reason`/`expires` in-place. Não duplica o entry no manifesto. Trade-off: usuário pode rodar `/lint:ignore:add` múltiplas vezes para refinar reason/expires sem poluir.
- **Path-only em Phase 2:** `--rule` (per-rule + `category:*`) só pousa em T3.3. Para Phase 2, slash não promete o flag — o usuário que precisa de granularidade rule-por-path espera o próximo release.
- **Brownfield import deferido para T3.4/T3.4b:** se o projeto já tem `ignorePatterns[]` fora dos markers em `oxlint.fast.json`, esses patterns são **preservados byte-a-byte** pelo compile (T2.2) mas **não migrados** para o manifesto. A migração silenciosa <5 / com confirmação ≥5 chega em T3.4 + T3.4b.
- **Sem auto-commit (SPEC §6 Never line 416):** cada `ignore-add` deixa staged (manifesto + presets + decisions). Usuário decide quando commitar. Os 3+ arquivos editados são deterministicamente reconstruíveis via `qualy ignore-compile`.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" ignore-add --help` retorna a usage com `<glob>` REQUIRED + `--reason`/`--expires`/`--strict`/`--cwd`.
- E2E (SPEC §10 #1 — greenfield path-only): num fixture limpo, `/lint:ignore:add 'src/legacy/**'` (resposta da Pergunta 2: `legacy code`; Pergunta 3: `No expiry`) → `.harn/qualy/ignore.json` ganha entry `{ glob: "src/legacy/**", rule: null, reason: "legacy code", expires: null }`, `oxlint.fast.json` e `oxlint.deep.json` ganham `ignorePatterns: [_qualy:start_, "src/legacy/**", _qualy:end_]`, `.harn/qualy/docs/lint-decisions.md` ganha entry `ignore-add`. Segundo run idêntico → `ignore-update` (idempotente).
- E2E (SPEC §10 #8): tree sujo + `--strict` → exit `3` com mensagem `git stash`.

## Referências

- `.harn/docs/lint-ignore/SPEC.md` §3.1 (`qualy ignore add`), §4.1 (slash conventions), §6 (registrar reason).
- `.harn/docs/lint-ignore/PLAN.md` Phase 2 + Task 2.7.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/rules/add.md` — comando par (rule-add); estrutura espelhada.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
