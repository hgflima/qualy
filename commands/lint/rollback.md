---
name: lint:rollback
description: Use when the user asks to restore a backup taken by `/lint:setup` or `/lint:audit` over a brownfield TS/TSX/JS/JSX project, says "/lint:rollback", "rollback lint", "restore eslint", "undo setup", or wants to bring previously-existing linter/formatter configs back byte-for-byte from `.lint-backup/<timestamp>/` without uninstalling oxc first (escape hatch — SPEC §2). Defaults to the most-recent snapshot listed by `qualy backup-list`; supports `--ts <timestamp>` to pick another, and `--files` to restore a subset.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: [<timestamp>]
---

# /lint:rollback

Restaura byte-a-byte os arquivos preservados em `.lint-backup/<timestamp>/` (SPEC §2 + §7.2 acceptance — `/lint:rollback` deixa o repo idêntico ao estado pré-setup). Diferente de `/lint:uninstall`, NÃO toca os artefatos qualy-owned: oxlint/oxfmt/hooks/scripts permanecem instalados — é um escape hatch para reverter só os arquivos do usuário (configs de linter prévio) sem perder o setup oxc.

O preâmbulo `QUALY_BIN=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Visão Geral

1. **Inventário (read-only):** `qualy backup-list` lista os snapshots disponíveis (descending por timestamp).
2. **Confirmação:** `AskUserQuestion` sobre qual snapshot restaurar (mais recente como `Recommended`) e se aplicar.
3. **Restauração:** `qualy backup-restore --ts <timestamp>` reescreve cada arquivo no path original com os bytes do snapshot.
4. **Pós-condição:** `qualy status` confirma que oxc continua wired e os arquivos do usuário voltaram.

## Quando usar

- Brownfield TS/TSX/JS/JSX onde `/lint:setup` removeu/sobrescreveu `.eslintrc*`, `.prettierrc*`, `biome.json`, `dprint.json` ou similares e o usuário quer voltar atrás.
- Após `/lint:audit` ou `/lint:update` que tenha gravado um snapshot antes de aplicar mudanças destrutivas.
- Resgate parcial: usuário sobrescreveu manualmente um arquivo previamente versionado e quer só esse arquivo de volta — use `--files` para escopar (SPEC §6 Always — backup nomeado).

## Quando NÃO usar

- Não há `.lint-manifest.json` ou nenhum snapshot `kind:"backup"`: nada a restaurar — informe e pare (`backup-list` retorna `backups: []`).
- Usuário quer remover oxc também: roteie para `/lint:uninstall` (que oferece `/lint:rollback` no follow-up — SPEC §2).
- Reverter apenas uma rule ou threshold: roteie para `/lint:rules:remove` ou `/lint:update` (não há snapshot para isso — é diff de preset).
- Promover um snapshot antigo a "estado canônico" via `git`: rollback grava no working tree; o commit fica por conta do usuário (SPEC §6 Never line 416).

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_BIN=""
# Dev override (uso interno do repo qualy): aponta para bin/qualy.mjs local.
[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"
# Lookup padrão: cópia materializada por `qualy install`.
if [ -z "$QUALY_BIN" ]; then
  for cand in "$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs" \
              "$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"; do
    [ -f "$cand" ] && QUALY_BIN="$cand" && break
  done
fi
[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \`npx @hgflima/qualy install\` first." >&2; exit 5; }
node "$QUALY_BIN" <subcommand> --cwd "$PWD" "$@"
```

1. **`backup-list`** — capture `backups[]`. Vazio → mensagem amigável apontando para `/lint:status` e pare.
2. **`git-clean-check`** — exit `3` (dirty tree): `AskUserQuestion` ofertando `git stash` (Recommended) / continuar / cancelar. Defesa em profundidade contra clobbar trabalho não-commitado adjacente; `backup-restore --strict` reforça via CLI no passo 5.
3. **Selecionar snapshot:** se o usuário passou `<timestamp>` como argumento (`argument-hint`), use-o direto. Caso contrário, `AskUserQuestion` com 2–4 opções: `Mais recente: <ts0> (Recommended)` / cada timestamp adicional até 3 / `Outro (digitar)`. Default conservador: `backups[0]` (descending — `backup-list` ordena para isso).
4. **Imprimir plano** (SPEC §6 Always): liste cada `files[].src` do snapshot escolhido (ex: `.eslintrc.json`, `.prettierrc.json`, `package.json`) e quais bytes serão reescritos; flag arquivos com `present: false` — eles ainda restauram (o destino é recriado), mas o usuário sabe que foram apagados desde o backup. **Pergunta:** `AskUserQuestion` com 2 opções: `Aplicar` / `Cancelar`.
5. **`backup-restore --ts <timestamp> --strict`** — uma única chamada Bash. Em sucesso (exit `0`), o output traz `restored[]` (`{src, from, bytes}` por arquivo). Para subset, passe `--files '[".eslintrc.json"]'`.
6. **Pós-condição:** rode `qualy status` (read-only) e mostre o sumário (estágio, presets ativos, arquivos restaurados). NÃO commite — instrua `git add -p` + commit sugerido (SPEC §6 Never line 416). Se o usuário quiser também desinstalar oxc, ofereça `/lint:uninstall` via `SlashCommand`.

## Mapeamento de exit codes

- `0` — sucesso. `restored[]` lista os bytes reescritos.
- `1` — `timestamp_not_found` (manifest ausente, ts inexistente ou só decoy entries), `backup_file_missing` (arquivo do snapshot apagado manualmente — informe e aborte; o snapshot precisa ser reconstruído), ou `read_failed`.
- `3` — dirty tree (`--strict`). Volte à pergunta de `git stash`.
- `4` — `timestamp_empty`, `subset_not_in_backup` (path passado em `--files` não está naquele backup), `path_invalid` ou flag desconhecida.

## Trade-offs

- **Não desinstala oxc**: este é o escape hatch SPEC §2 — restaurar só os arquivos do usuário; setup oxc permanece. Para remover oxc também, encadeie `/lint:uninstall` no follow-up. Escopo > completude.
- **Default = snapshot mais recente**: `backups[0]` (descending) cobre 95% dos casos; o `argument-hint` permite pular a pergunta com `<timestamp>` literal quando o usuário sabe qual quer.
- **Manifest preservado**: `backup-restore` usa `skipManifest:true` — entries `kind:"backup"` permanecem listadas, então rodar `/lint:rollback` de novo (idempotente) ou `/lint:uninstall --keep-backup` continua funcionando. Reversibilidade > limpeza.
- **`--strict` no passo 5**: defesa em profundidade sobre o `git-clean-check` da etapa 2 (race entre pergunta e write); reforça SPEC §6 Always (working tree limpo).
- **Sem auto-commit**: SPEC §6 Never line 416 proíbe; usuário decide quando empacotar a restauração.

## Verificação

- Smoke: `node "$QUALY_BIN" backup-restore --help` lista flags (`--cwd`, `--ts`, `--files`, `--strict`).
- E2E (PLAN §Fase 3): após `/lint:setup` num fixture `brownfield-eslint-prettier/`, `/lint:rollback` deixa `.eslintrc*`, `.prettierrc*` idênticos ao estado pré-setup (SPEC §7.2 acceptance — `git diff` vazio nos arquivos do usuário).
- Manifest: ao final, entries `kind:"backup"` permanecem (skipManifest); destinos do restore NÃO ganharam entries qualy-owned.

## Referências

- `.harn/docs/mvp/SPEC.md` §2, §6, §7.2.
- `.harn/docs/mvp/PLAN.md` §Fase 3 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_BIN` e mapeamento de exit codes.
- `commands/lint/uninstall.md` — uninstall completo; oferece `/lint:rollback` no follow-up.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
