# Cenário T2 — `/lint:setup` em projeto brownfield com ESLint+Prettier

> Roteiro humano-legível para execução manual / semi-automatizada (SPEC §5 Tier T2). Cobre SPEC §7.2 acceptance (substituição com backup + `/lint:rollback` simétrico).
> Fixture base: `cli/tests/fixtures/brownfield-eslint-prettier/` materializada via `materializeFixture("brownfield-eslint-prettier")`.

## Pré-condições

- `node --version` ≥ 22.6.
- Fixture materializada (cp + `git init` + commit determinístico): 8 fontes TS, ~5071 LOC, `.eslintrc.json` + `.prettierrc.json` no root, devDeps `eslint`/`@typescript-eslint/*`/`prettier` em `package.json`.
- Working tree limpo logo após materialização.
- `cli/tests/fixtures/brownfield-eslint-prettier/EXPECTED.md` documenta o estado canônico esperado dos detectores.

## Comando do usuário

```
/lint:setup
```

## Sequência esperada

### 1. Detecção

- `detect-stack` → `supported:true`, `extensions.ts:8`, exit `0`.
- `git-clean-check` → clean.
- `detect-existing-linter` → `linters:[{ name:"eslint", configs:[".eslintrc.json"], pkg_dep:true }]`, `formatters:[{ name:"prettier", configs:[".prettierrc.json"], pkg_dep:true }]`.
- `detect-test-runner` → `runner:null`.
- `detect-stage` → `stage:"brownfield-moderate"` (LOC ≥ 5000 AND `linter_present:true` ⇒ falha gate greenfield; idade < 1095 ⇒ falha gate legacy; resultado: brownfield-moderate por default).

O harness imprime os sinais brutos + a lista de configs ESLint/Prettier detectadas.

### 2. Pergunta 1 — Estratégia de substituição (`AskUserQuestion`, 3 opções)

SPEC §6 Always line 384–385 + §7.2: "criar `.lint-backup/<ISO-timestamp>/` antes de remover/sobrescrever qualquer arquivo de configuração de linter pré-existente" e "diff/lista de arquivos antes da pergunta".

```
Detected: ESLint (.eslintrc.json) + Prettier (.prettierrc.json) + 5 devDeps relacionadas.

Files to back up before replacing:
  - .eslintrc.json
  - .prettierrc.json
  - package.json (devDeps a desinstalar)

Substituir com backup (Recommended)
Cancelar setup
Executar /lint:rollback (se já houver backup)
```

**Resposta esperada:** `Substituir com backup (Recommended)`. O harness rota para o subagent `lint-migrator` (Fase 3 — `agents/lint-migrator.md`); este orquestra `backup-create` + remoção das configs ESLint/Prettier antes de prosseguir com `install-*`.

### 3. Pergunta 2 — Estágio (`AskUserQuestion`, 4 opções)

```
brownfield-moderate (Recommended)   ← detectado por LOC≥5k AND linter_present
greenfield
legacy
cancelar
```

**Resposta esperada:** `brownfield-moderate (Recommended)`.

### 4. Pergunta 3 — Coverage (skipada)

`runner === null` → harness **NÃO** dispara Pergunta 3. `install-coverage --runner none` será no-op.

### 5. Pergunta 4 — Plano

```
Plano de mudanças:
  1. backup-create: copia .eslintrc.json, .prettierrc.json, package.json → .lint-backup/<ISO-ts>/
  2. remove ESLint/Prettier configs + devDeps relacionadas
  3. install-deps (oxlint/oxfmt/quality-metrics/ts-morph)
  4. install-oxlint --stage brownfield-moderate (presets brownfield)
  5. install-hook + install-husky + install-scripts
  6. install-coverage --runner none (no-op)

Aplicar? [Aplicar (Recommended) / Cancelar]
```

**Resposta esperada:** `Aplicar (Recommended)`.

### 6. Instalação por camadas (com backup)

| # | Operação                                                | Side effects                                                                                                      |
| - | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 0 | `backup-create --files .eslintrc.json,.prettierrc.json,package.json --strict` | Cria `.lint-backup/<safe-ts>/` byte-a-byte; manifest entries `kind:"backup"` (ADR 0002).                          |
| 1 | Remoção das configs prévias                             | `unlink .eslintrc.json`, `unlink .prettierrc.json`, edit `package.json#devDependencies` removendo eslint/prettier |
| 2 | `install-deps --strict`                                 | Instala oxlint/oxfmt/quality-metrics/ts-morph                                                                     |
| 3 | `install-oxlint --stage brownfield-moderate --strict`   | `oxlint.fast.json` + `oxlint.deep.json` (presets brownfield, max=20/1000/400/2/10/5)                              |
| 4 | `install-hook --strict`                                 | `.claude/hooks/post-edit.sh` + merge `.claude/settings.json`                                                       |
| 5 | `install-husky --strict`                                | `.husky/pre-commit` + `.lintstagedrc.js`                                                                          |
| 6 | `install-coverage --runner none`                        | no-op                                                                                                             |
| 7 | `install-scripts --runner none --strict`                | merge `package.json#scripts` (lint, lint:deep, format, coverage)                                                  |

### 7. Pós-condição

- `qualy status` reporta `stage.detected:"brownfield-moderate"`, presets fast+deep ativos, hooks ativos.
- `.lint-backup/<ISO-ts>/.eslintrc.json` + `.prettierrc.json` + `package.json` existem byte-a-byte iguais ao pré-setup.
- `.lint-manifest.json` lista todos os artefatos novos (`kind:"preset"`/`"hook"`/`"husky"`/`"scripts"`) **e** as entries `kind:"backup"` para `/lint:rollback` reverter.
- Sem auto-commit. Harness sugere `git add -p` ao usuário.

## Cenário simétrico — `/lint:rollback`

Após o setup acima, o usuário executa:

```
/lint:rollback
```

### Sequência esperada

1. `backup-list` retorna 1 entry com o `<safe-ts>` mais recente.
2. **Pergunta — Confirmação:** `AskUserQuestion`:
   ```
   Restaurar .eslintrc.json, .prettierrc.json, package.json a partir de .lint-backup/<ts>/? (Recommended)
   Cancelar
   ```
3. `backup-restore --ts <ts> --strict` reescreve os 3 arquivos byte-a-byte.
4. **Pergunta opcional — Desinstalar oxc?** `AskUserQuestion`:
   ```
   Manter oxlint+oxfmt instalados (escape hatch — Recommended SPEC §2 line 53)
   Executar /lint:uninstall agora
   ```

   `/lint:rollback` **não** desinstala oxc por design (ADR 0002 — escape hatch SPEC §2 line 53). Usuário escolhe.

### Pós-condição rollback

- `.eslintrc.json` + `.prettierrc.json` + `package.json` byte-a-byte idênticos ao estado pré-setup (asseridos via `diff` ou hash em `cli/tests/e2e/setup-rollback-brownfield.test.ts`).
- `.lint-backup/<ts>/` permanece (entries `kind:"backup"` preservados em manifest para idempotência); `--keep-backup` é o default em `backup-restore`.
- Idempotência: rodar `/lint:rollback` de novo sobre os mesmos 3 arquivos é noop byte-a-byte.

## Verificação manual

- [ ] Backup criado **antes** da remoção das configs (ordem audit-grade — ADR 0002).
- [ ] `.lint-backup/<ts>/` é sortable lexicalmente (formato ISO timestamp filesystem-safe).
- [ ] Restore não toca arquivos que não estavam no backup (não recria devDeps removidas, por exemplo — usuário decide se reinstala via package manager).
- [ ] `/lint:rollback` simétrico restaura byte-a-byte; `diff -r` antes/depois é vazio.
- [ ] `--keep-backup` default em `backup-restore` permite re-rollback.
- [ ] Subagent `lint-migrator` retorna sumário ≤ 30 linhas (SPEC §6 Always line 386).

## E2E automatizado (referência)

`cli/tests/e2e/setup-rollback-brownfield.test.ts` cobre o ciclo completo (backup → remove → install → rollback → verify byte-a-byte). Este roteiro T2 valida o caminho conversacional (perguntas em ordem, listas exibidas antes da confirmação, sumário de subagent).

## Referências

- SPEC §2 (`/lint:setup`, `/lint:rollback`), §6 (backup nomeado, AskUserQuestion, diff antes da confirmação), §7.2 (acceptance).
- PLAN §Fase 3 (migration / backup).
- `commands/lint/setup.md`, `commands/lint/rollback.md`, `agents/lint-migrator.md`.
- `cli/tests/fixtures/brownfield-eslint-prettier/EXPECTED.md`.
- ADR 0002 (named backup rollback), ADR 0006 (CLI determinístico).
