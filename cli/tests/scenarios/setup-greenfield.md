# Cenário T2 — `/lint:setup` em projeto greenfield

> Roteiro humano-legível para execução manual / semi-automatizada (SPEC §5 Tier T2). Cobre SPEC §7.1 acceptance.
> Fixture base: `cli/tests/fixtures/greenfield-ts/` materializada via `materializeFixture("greenfield-ts")` (cp + `git init` + commit determinístico).

## Pré-condições

- `node --version` ≥ 22.6 (validado por `install.sh` — ADR 0007).
- `cli/tests/fixtures/greenfield-ts/EXPECTED.md` documenta o estado canônico esperado da fixture (5 `.ts`, 420 LOC, sem linter/test runner, sem `.git/` versionado dentro do parent repo).
- Working tree do fixture materializado limpo (`git-clean-check` exit `0`).
- Skill instalada via `./install.sh` (default `copy`) ou `./install.sh --dev` (symlink durante desenvolvimento).

## Comando do usuário

```
/lint:setup
```

## Sequência esperada

### 1. Detecção (read-only — sem perguntas)

- `detect-stack` → `{ supported: true, extensions: { ts: 5, tsx: 0, js: 0, jsx: 0 }, blockers: [] }`, exit `0`.
- `git-clean-check` → `{ clean: true, dirty_files: [] }`, exit `0`.
- `detect-existing-linter` → `{ linters: [], formatters: [] }` (nenhum prévio).
- `detect-test-runner` → `{ runner: null, candidates: { vitest:{}, jest:{} }, coverage: { configured: false, ... } }`.
- `detect-stage` → `{ stage: "greenfield", signals: { age_days: 0, source_files: 5, loc: 420, linter_present: false, has_tests: false, todo_count: 0, ... }, reasoning: "..." }`, exit `0`.

O harness imprime os sinais brutos antes de qualquer pergunta (SPEC §6 Always — "justificar com sinais brutos").

### 2. Pergunta 1 — Estágio (`AskUserQuestion`, 4 opções)

```
greenfield (Recommended)   ← detectado por age<183d AND loc<5000 AND linter_present=false
brownfield-moderate
legacy
cancelar
```

**Resposta esperada do usuário:** `greenfield (Recommended)`. A resposta vira `--stage greenfield` em `install-oxlint` e `install-coverage`.

### 3. Pergunta 2 — Coverage (skipada)

`runner === null` na fixture greenfield → o harness **não dispara a Pergunta 2**. `install-coverage` será chamado com `--runner none` e fará no-op (sem escrita em `vitest.config.ts`/`jest.config.json`).

### 4. Pergunta 3 — Plano (`AskUserQuestion`, 2 opções)

O harness imprime a lista de mudanças antes de aplicar (SPEC §6 Always):

```
Plano de mudanças (em ordem):
  1. install-deps (--strict): instala oxlint, oxfmt, @oxc-project/quality-metrics, ts-morph
  2. install-oxlint --stage greenfield: cria oxlint.fast.json + oxlint.deep.json
  3. install-hook: copia .claude/hooks/post-edit.sh + merge .claude/settings.json#hooks.PostToolUse
  4. install-husky: cria .husky/pre-commit + .lintstagedrc.js (greenfield-ts é type=module)
  5. install-coverage --runner none: no-op (sem test runner detectado)
  6. install-scripts: merge package.json#scripts (lint, lint:deep, format, coverage)

Aplicar? [Aplicar (Recommended) / Cancelar]
```

**Resposta esperada:** `Aplicar (Recommended)`.

### 5. Instalação por camadas (ordem fixa, falha aborta o resto)

Cada chamada é stdout JSON canônico + exit code. Ordem em `commands/lint/setup.md` §Fluxo passo 9.

| # | Comando CLI                                              | Side effects                                                                                                  |
| - | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1 | `install-deps --strict`                                  | `package.json` recebe devDeps; manifest entries `kind:"dep"` por pacote                                       |
| 2 | `install-oxlint --stage greenfield --strict`             | `oxlint.fast.json` + `oxlint.deep.json` (greenfield preset, SPEC §3); manifest `kind:"preset"`                |
| 3 | `install-hook --strict`                                  | `.claude/hooks/post-edit.sh` (mode `0o755`), merge em `.claude/settings.json#hooks.PostToolUse[*]`            |
| 4 | `install-husky --strict`                                 | `.husky/pre-commit` + `.lintstagedrc.js` (extensão escolhida por `package.json#type`)                         |
| 5 | `install-coverage --runner none --stage greenfield`      | no-op (sem `vitest.config.ts`/`jest.config.json` para tocar)                                                  |
| 6 | `install-scripts --runner none --strict`                 | `package.json#scripts.{lint, lint:deep, format, coverage}`; manifest `kind:"scripts"` com `merged: true`      |

### 6. Pós-condição

- `qualy status --cwd "$PWD"` retorna `stage.detected:"greenfield"`, `presets.fast:true`, `presets.deep:true`, `hooks.post_edit:true`, `hooks.husky:true`, `hooks.lintstaged:true`, `coverage.runner:"none"`, exit `0`.
- `.lint-manifest.json` lista todos os artefatos com `kind` correto (preset/hook/husky/lintstaged/scripts/dep) — precondição para `/lint:uninstall` reverter por inteiro.
- O harness **NÃO commita** (SPEC §6 Never line 416). Sugere `git add -p` + commit message ao usuário.

## Verificação manual

- [ ] Apenas 2 perguntas via `AskUserQuestion` (Estágio + Plano), nunca duas no mesmo turno.
- [ ] `oxlint.fast.json` carrega `categories.{correctness:"error", suspicious:"warn"}` (SPEC §3 greenfield, sem `quality-metrics`).
- [ ] `oxlint.deep.json` carrega `plugins:["quality-metrics"]` + 6 rules `quality-metrics/*` com max greenfield (`wmc:15`, `cbo:8`, `dit:4`, `lcom:0`, `halstead-volume:800`, `halstead-effort:300`).
- [ ] `.claude/settings.json#hooks.PostToolUse` referencia `post-edit.sh` com matcher `"Write|Edit|MultiEdit"`.
- [ ] `package.json#scripts.lint` chama `oxlint --config oxlint.fast.json`; `lint:deep` chama `--config oxlint.deep.json`.
- [ ] Re-rodar `/lint:setup` é idempotente: detecta `.lint-manifest.json` e roteia para `/lint:status` + `/lint:update` (SPEC §7.1 não recoloca artefatos).

## E2E automatizado (referência)

`cli/tests/e2e/setup-greenfield.test.ts` cobre os artefatos SPEC §7.1 sem rodar o package manager real (stub `runFn` em `install-deps`). Este roteiro T2 valida o caminho conversacional + visual que o e2e não cobre (perguntas, plano impresso, output do `status` ao usuário).

## Referências

- SPEC §2 (`/lint:setup`), §6 (Always: plano + sinais + uma pergunta), §7.1 (acceptance).
- PLAN §Fase 2 (verificação).
- `commands/lint/setup.md` (orquestração harness).
- `cli/tests/fixtures/greenfield-ts/EXPECTED.md` (contrato dos detectores).
- ADR 0006 (CLI determinístico), ADR 0007 (runtime sem build step).
