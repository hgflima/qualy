---
name: lint:setup
description: Use when the user asks to install lint/format/coverage from scratch in a TS/TSX/JS/JSX project, says "/lint:setup", "set up lint", "install oxlint", "configure oxc", or wants the Claude Code lint stack wired (presets, PostToolUse hook, husky + lint-staged, coverage thresholds, package.json scripts). Detects stack, working tree, existing linter, test runner, and stage; confirms one question at a time via AskUserQuestion; then runs `install-*` in deterministic order. Refuses non-TS/JS stacks via `detect-stack` exit `2`.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: (none)
---

# /lint:setup

Fluxo guiado de instalação do oxlint + oxfmt + `quality-metrics` no projeto-alvo (SPEC §2 + §7.1). Não modifica nada por conta própria — toda mutação passa pelo CLI; cada flag vem de uma resposta de `AskUserQuestion`.

## Visão Geral

1. **Detecção (read-only):** `detect-stack` → `git-clean-check` → `detect-existing-linter` → `detect-test-runner` → `detect-stage`.
2. **Confirmação:** uma pergunta por vez (estágio, meta de coverage, substituição de linter prévio).
3. **Instalação por camadas:** `install-deps` → `install-oxlint` → `install-hook` → `install-husky` → `install-coverage` → `install-scripts`.
4. **Verificação:** mostra `qualy status` no final; instrui o usuário a revisar e commitar (a skill nunca commita).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Projeto TS/TSX/JS/JSX sem oxc instalado, usuário pediu `/lint:setup`.
- Projeto greenfield novo (sem linter): caminho mais curto, confirmações mínimas.
- Projeto brownfield com ESLint+Prettier/Biome/dprint: dispara `/lint:rollback` ou `lint-migrator` antes de prosseguir (SPEC §7.2).
- Projeto com coverage existente (vitest/jest threshold já configurado): mostra valor atual antes de propor o do estágio (SPEC §7.3).

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`, `blockers[]` populado): recuse imediatamente listando o que oxc cobre. Não escreva nada.
- Working tree sujo: NÃO rode `install-*` antes de pedir `git stash` via `AskUserQuestion`.
- Repo já configurado pelo qualy (presença de `.lint-manifest.json`): roteie para `/lint:status` + `/lint:update`, não re-setup.
- Mudança de versões majors/CI: fora do escopo deste comando — peça `Ask first` (SPEC §6).

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta com mensagem listando stacks suportadas (`TS/TSX/JS/JSX`); não escreve nada.
2. **`git-clean-check`** — exit `3` (dirty tree): `AskUserQuestion` ofertando `git stash` (Recommended) / continuar mesmo assim / cancelar.
3. **`detect-existing-linter`** — se `linters[]` ou `formatters[]` não-vazios, mostre a lista e `AskUserQuestion`: substituir com backup (Recommended) / cancelar / executar `/lint:rollback`. Substituição rota via `lint-migrator` (Fase 3) — não toque arquivos diretamente aqui.
4. **`detect-test-runner`** — capture `runner` (`vitest|jest|none`) e `coverage.current_thresholds` para a próxima pergunta.
5. **`detect-stage`** — capture `stage` + `reasoning`; mostre os sinais brutos (SPEC §6 Always: "justificar com sinais brutos").
6. **Pergunta 1 — Estágio:** `AskUserQuestion` com 4 opções (estágio detectado marcado `(Recommended)` + as outras três alternativas: `greenfield`, `brownfield-moderate`, `legacy`); resposta vira `--stage` em `install-oxlint`/`install-coverage`.
7. **Pergunta 2 — Coverage:** se `runner !== "none"`, `AskUserQuestion` com 3 opções (preset do estágio (Recommended) / preservar atual / customizar). SPEC §6 Ask first: "alterar thresholds de coverage existentes — sempre mostrar valor atual + valor proposto antes de pedir confirmação."
8. **Pergunta 3 — Plano:** imprima a lista de mudanças (arquivos novos, arquivos mesclados, deps a instalar) e peça confirmação via `AskUserQuestion` (aplicar / cancelar). SPEC §6 Always: "imprimir plano antes de aplicar".
9. **Instalação por camadas (em ordem; cada falha aborta o resto):**
   1. `install-deps --strict` — pacotes da peer (oxlint/oxfmt/quality-metrics/ts-morph).
   2. `install-oxlint --stage <s> --strict` — escreve `oxlint.fast.json` + `oxlint.deep.json`.
   3. `install-hook --strict` — copia `.claude/hooks/post-edit.sh`, mescla `.claude/settings.json#hooks.PostToolUse`.
   4. `install-husky --strict` — escreve `.husky/pre-commit` + `.lintstagedrc.{js,mjs}` (se ausentes).
   5. `install-coverage --runner <r> --stage <s> --strict` — edita `vitest.config.ts` via ts-morph ou `jest.config.{json,*}` via JSON; runner=none → noop.
   6. `install-scripts --runner <r> --strict` — mescla `package.json#scripts` (`lint`, `lint:deep`, `format`, `coverage`).
10. **Pós-condição:** rode `status` (read-only) e mostre o sumário ao usuário. NÃO commite — instrua `git add -p` + commit sugerido.

## Mapeamento de exit codes

- `0` — sucesso. Continue para a próxima camada.
- `2` — stack bloqueada (apenas em `detect-stack`). Aborte.
- `3` — dirty tree (com `--strict`). Volte à pergunta de `git stash`.
- `4` — usage error: bug no harness; reporte e aborte.
- `5` — missing-dep: rode `install-deps` antes; se falhar, mostre stderr e abortar.
- `1` / `70` — recoverable / internal: aborte mostrando o erro do CLI; restaure via `/lint:rollback` se houver backup.

## Trade-offs

- **Determinismo > flexibilidade**: a ordem de `install-*` é fixa (deps antes de oxlint, oxlint antes de hook, hook antes de husky). Mudar a ordem exige patch + teste, não prompt-engineering.
- **Sem auto-commit**: SPEC §6 Never proíbe commit automático. O usuário decide quando empacotar.
- **`--strict` em todas as escritas**: defesa em profundidade sobre `git-clean-check`. Falha em strict aborta antes de tocar o FS.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" detect-stack --cwd "$PWD"` retorna `{supported:true,…}` em projeto TS.
- E2E (PLAN §Fase 2): `/lint:setup` num fixture `greenfield-ts` produz todos os artefatos do SPEC §7.1 (`oxlint.fast.json`, `oxlint.deep.json`, `.claude/hooks/post-edit.sh`, `.husky/pre-commit`, `.lintstagedrc.*`, `package.json#scripts`, `.lint-manifest.json`).
- Manifest: ao final, `.lint-manifest.json` lista todos os arquivos escritos com `kind` correto, viabilizando `/lint:uninstall` e `/lint:rollback`.

## Referências

- `.harn/docs/mvp/SPEC.md` §2, §6, §7.1.
- `.harn/docs/mvp/PLAN.md` §Fase 2 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
