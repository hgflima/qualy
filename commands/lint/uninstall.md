---
name: lint:uninstall
description: Use when the user asks to uninstall the qualy lint stack (oxlint+oxfmt+quality-metrics) from a TS/TSX/JS/JSX project, says "/lint:uninstall", "uninstall lint", "remove oxlint", "tear down qualy", or wants every artifact tracked in `.lint-manifest.json` removed (presets, PostToolUse hook, husky+lint-staged, coverage merges, package.json scripts). Confirms one question at a time via AskUserQuestion, optionally preserves snapshots under `.lint-backup/` (`--keep-backup`), and offers `/lint:rollback` afterwards when a previous linter snapshot is available.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: [--keep-backup]
---

# /lint:uninstall

Remove tudo que `/lint:setup` instalou (SPEC §2 + §6 Always — backup nomeado). A skill nunca apaga arquivos sozinha: ela lê `.lint-manifest.json`, mostra o plano, confirma com `AskUserQuestion` e delega ao subcomando `lint-uninstall` do CLI determinístico.

## Visão Geral

1. **Inventário (read-only):** `Read` no `.lint-manifest.json` + `qualy backup-list` para listar snapshots disponíveis.
2. **Confirmação:** uma pergunta por vez (manter snapshots? aplicar plano?).
3. **Remoção:** `qualy lint-uninstall [--keep-backup]` apaga arquivos qualy-owned e (opcionalmente) os snapshots.
4. **Follow-up:** entries `merged_kept` (settings/scripts/coverage/deps) ficam para limpeza manual; se sobraram backups, ofereça `/lint:rollback` via `AskUserQuestion`.

O preâmbulo `QUALY_BIN=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Usuário pediu `/lint:uninstall` ou "remove oxlint" e o projeto tem `.lint-manifest.json`.
- Brownfield TS/TSX/JS/JSX onde o usuário quer voltar ao linter anterior — combine com `/lint:rollback` no follow-up para restaurar byte-a-byte (SPEC §7.2).
- Limpeza antes de um re-setup com estágio diferente (ex: `greenfield` → `brownfield-moderate`); aqui `--keep-backup` faz sentido como rede de segurança.
- Re-execução idempotente após falha parcial: o manifest reflete o estado parcial, então `lint-uninstall` reverte só o que foi escrito.

## Quando NÃO usar

- Ausência de `.lint-manifest.json` no projeto: o CLI retorna `manifest_missing` (exit `1`); nada para desinstalar — informe e pare.
- Usuário só quer desabilitar temporariamente: `git stash` + edição manual. Não rode `uninstall`.
- Remover uma rule específica ou ajustar threshold: roteie para `/lint:rules:remove` ou `/lint:update`, não para uninstall.
- Restaurar configs de linter prévio sem remover oxc: roteie para `/lint:rollback` (escape hatch SPEC §2).

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

1. **`Read` `.lint-manifest.json`** — se ausente, pare com mensagem amigável apontando para `/lint:status`.
2. **`backup-list`** — capture o array `backups[]` (timestamp + arquivos) para a oferta de restore na etapa 7.
3. **`git-clean-check`** — exit `3` (dirty tree): `AskUserQuestion` ofertando `git stash` (Recommended) / continuar / cancelar. Defesa em profundidade sobre `--strict` (não exposto por `lint-uninstall` no v1, mas a pergunta evita clobbar trabalho não-commitado adjacente).
4. **Imprimir plano** com 3 buckets do manifest, classificados por `kind`: (a) **arquivos qualy-owned a deletar** (`preset`, `hook`, `husky`, `lintstaged`, `decisions`, `template`, `other` com `merged !== true`); (b) **snapshots de backup** (`kind:"backup"`) — preservados ou deletados conforme a Pergunta 1; (c) **entries merged/virtual** que NÃO serão deletadas (`merged === true` ou `kind === "dep"`) — surfacing para limpeza manual.
5. **Pergunta 1 — Preservar snapshots:** `AskUserQuestion` com 2 opções: `Manter .lint-backup/ (Recommended)` (vira `--keep-backup`) / `Apagar snapshots junto`. Default conservador: preservar (reversibilidade > limpeza). SPEC §6 Ask first: substituições destrutivas exigem confirmação explícita.
6. **Pergunta 2 — Aplicar plano:** `AskUserQuestion` com 2 opções: `Aplicar` / `Cancelar`. SPEC §6 Always: imprimir plano antes de aplicar.
7. **`lint-uninstall [--keep-backup]`** — uma única chamada Bash. Em sucesso (exit `0`), o output traz `removed[]`, `kept_backup`, `merged_kept[]`.
8. **Follow-up por `merged_kept`:** para cada entry, instrua o usuário sobre a limpeza manual: `kind:"dep"` → `npm/pnpm/yarn/bun remove <pkg>` (path virtual `package.json#devDependencies/<name>`); `merged === true` → edição cirúrgica do arquivo (remover keys de `package.json#scripts`, `.claude/settings.json#hooks.PostToolUse`, ou `vitest.config.ts#test.coverage`).
9. **Oferta de restore:** se `backup-list` retornou snapshots e o usuário pediu uninstall por causa de linter prévio, `AskUserQuestion` com 2 opções: `Restaurar via /lint:rollback (Recommended)` / `Pular`. Em "Restaurar", invoque `/lint:rollback` via `SlashCommand`.
10. **Pós-condição:** rode `qualy status` (read-only) e mostre o sumário. NÃO commite — instrua `git add -p` + commit sugerido (SPEC §6 Never line 416).

## Mapeamento de exit codes

- `0` — sucesso. `removed[]` lista o que foi apagado; `merged_kept[]` lista o que requer follow-up manual.
- `1` — `manifest_missing` (nada a desinstalar) ou `remove_failed` (erro de FS — mostre `reason` e aborte).
- `3` — dirty tree. Volte à pergunta de `git stash` (defesa em profundidade — não emitido pelo CLI atual, reservado para evolução futura quando `lint-uninstall` ganhar `--strict`).
- `4` — `path_invalid` ou flag desconhecida: bug no harness; reporte e aborte.

## Trade-offs

- **`merged_kept` não é deletado automaticamente**: settings/scripts/coverage compartilham arquivos com o usuário; remoção cirúrgica fica fora deste comando para evitar destruir edições legítimas. Segurança > completude.
- **Default = preservar `.lint-backup/`**: a 1ª pergunta vem com `Manter (Recommended)` porque reversibilidade > limpeza imediata; o usuário pode rodar `lint-uninstall` de novo sem `--keep-backup` quando estiver confiante.
- **Sem auto-commit**: SPEC §6 Never line 416 proíbe commit automático. O usuário decide quando empacotar a desinstalação.
- **Single-call ao CLI**: o passo 7 chama `lint-uninstall` uma vez (não por arquivo) — mais barato e atômico em relação ao manifest, que é reescrito no fim com as entries restantes.

## Verificação

- Smoke: `node "$QUALY_BIN" lint-uninstall --help` lista flags (`--cwd`, `--keep-backup`).
- E2E (PLAN §Fase 3): após `/lint:setup` num fixture `brownfield-eslint-prettier/`, `/lint:uninstall` + `/lint:rollback` deixam o repo idêntico ao estado pré-setup (SPEC §7.2 acceptance — `git diff` vazio).
- Manifest: ao final, `.lint-manifest.json` está ausente (clean uninstall) ou contém só entries merged/virtual + (se `--keep-backup`) entries `kind:"backup"`.

## Referências

- `.harn/docs/mvp/SPEC.md` §2, §6, §7.2.
- `.harn/docs/mvp/PLAN.md` §Fase 3 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_BIN` e mapeamento de exit codes.
- `commands/lint/rollback.md` — escape hatch para restore byte-a-byte sem desinstalar.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
