---
name: lint:rules:list
description: Use when the user asks to inspect which oxlint rules are active in the project, says "/lint:rules:list", "list lint rules", "ver rules ativas", "show enabled lint rules", or wants the inventory (active / available / disabled) with origin (preset:<stage>:<tier>), severity, and threshold. Read-only — reads `oxlint.fast.json` and `oxlint.deep.json`, never mutates. Refuses (recoverable) when no preset is installed (`preset_missing` exit `1`) and routes to `/lint:setup`.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: (none)
---

# /lint:rules:list

Inventário read-only das rules oxlint do projeto-alvo (SPEC §2 + §7.9). Mostra três buckets — `active`, `disabled`, `available` — derivados de `oxlint.fast.json` e `oxlint.deep.json` mais a baseline do estágio detectado. **Read-only** — não escreve presets, manifest, nem decisions.

## Visão Geral

1. **Pré-checks (read-only):** `detect-stack` → presença de `oxlint.fast.json`/`oxlint.deep.json`.
2. **Execução:** `rules-list` lê os presets, identifica o estágio via `_comment` (`stage=<name>`), e devolve `{ active, disabled, available }`. `available[]` cruza a baseline `quality-metrics` do estágio com as rules ausentes em ambos os tiers.
3. **Resumo ao usuário:** estágio, contagens por bucket, top entries com origem + severidade + `max`/options.
4. **Próximo passo:** se `available[]` não vazio, ofereça `/lint:rules:add <rule>`; se algo em `active[]` precisa de detalhe, `/lint:rules:explain <rule>`.

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Usuário pediu `/lint:rules:list` ou quer inspecionar a configuração de rules atual.
- Antes de `/lint:rules:add` ou `/lint:rules:remove` para ver o que já está configurado e evitar duplicação.
- Após `/lint:setup` para confirmar que o preset do estágio detectado foi escrito corretamente.
- Onboarding: usuário entra em projeto novo e precisa entender o que está sendo enforced.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse e roteie para a mensagem de stacks suportadas.
- Sem preset instalado (`oxlint.fast.json` e `oxlint.deep.json` ambos ausentes): exit `1` (`preset_missing`); roteie para `/lint:setup`.
- Aplicar mudanças nas rules: este comando é read-only. Use `/lint:rules:add` ou `/lint:rules:remove`.
- Ver descrição/rationale de uma rule específica: use `/lint:rules:explain <rule>` (este comando só lista).

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta com mensagem listando stacks suportadas (`TS/TSX/JS/JSX`); nada é escrito.
2. **`rules-list --cwd "$PWD"`** — exit `0` retorna `{ ok, cwd, stage, active[], disabled[], available[] }`. Exit `1` com `error: "preset_missing"` (nem fast nem deep presentes) ou `error: "preset_malformed"` (todos os presents inválidos) → roteie para `/lint:setup` via `SlashCommand`.
3. **Sumário ao usuário** (4 linhas + tabela curta):
   - `stage`: `payload.stage` (ou `null` se o `_comment` do preset não carrega `stage=`).
   - `active`: `payload.active.length` rules; mostre top 5 ordenadas por origem (`preset:<stage>:deep` antes, `preset:<stage>:fast` depois) com `rule`, `severity`, `options.max` (quando presente).
   - `disabled`: `payload.disabled.length` rules; liste-as inline (curtas).
   - `available`: `payload.available.length` rules; mostre nomes + `suggested_severity`/`suggested_max` para o usuário decidir um futuro `rules-add`.
4. **Pós-condição (opcional):**
   - Se `available[]` não vazio: ofereça via `AskUserQuestion` (3 opções fixas: `Adicionar uma rule disponível` / `Explicar uma rule ativa` / `Não, obrigado`). Apply → roteia para `/lint:rules:add <rule>`; Explain → `/lint:rules:explain <rule>`.
   - Se `disabled[]` não vazio: mencione que as rules `off` estão presentes mas não enforced; ofereça `/lint:rules:remove <rule>` se o usuário quiser remover a entry explicitamente do preset.

## Mapeamento de exit codes

- `0` — sucesso; mostre sumário.
- `1` — `preset_missing` (nenhum preset; roteie para `/lint:setup`) ou `preset_malformed` (todos inválidos; mostre `error`/`reason`).
- `2` — não esperado (stack já checada via `detect-stack`); reporte como bug do CLI.
- `3` — não aplicável (read-only não passa `--strict`).
- `4` — usage error: bug no harness; reporte e aborte.
- `5` — não aplicável (sem subprocess oxlint).
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **Read-only > orquestração**: SPEC §6 lista `/lint:rules:list` como read-only. Nenhuma escrita; nenhuma `AskUserQuestion` no caminho default. As únicas perguntas só disparam quando o usuário aceita explicitamente um próximo passo (`add`/`explain`/`remove`).
- **`available[]` derivado da baseline do estágio, não do catálogo oxlint inteiro**: SPEC §3 lockou os 6 quality-metrics como conjunto canônico. Listar todas as 200+ rules oxlint disponíveis seria ruído. O harness pode oferecer `rules-explain` para descobrir rules fora da baseline.
- **`stage=null` quando `_comment` ausente**: o CLI mantém-se puro/read-only e não chama `detect-stage` por baixo. Se `available[]` ficar vazio só porque o `_comment` perdeu a tag, sugira ao usuário rodar `/lint:setup` para reescrever os presets canônicos ou edita-los manualmente.
- **Categorias listadas como `category:<name>`**: mirrors `audit.ts`/`rules-explain` para que decisões de severidade em bulk apareçam ao lado de named rules. Drift quebraria contratos com `/lint:rules:add`/`remove` que aceitam `category:correctness` etc.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" rules-list --cwd "$PWD"` num fixture com `oxlint.fast.json` retorna exit `0` e o JSON com `active[]` populado.
- E2E (SPEC §7.9): num fixture configurado por `/lint:setup` greenfield, `rules-list` mostra `stage=greenfield`, todas as 6 rules `quality-metrics/*` com severity `error` e `max` da baseline, `category:correctness=error` em `active[]`, e `available[]` vazio (baseline já totalmente representada).
- E2E (SPEC §7.9): num fixture brownfield-moderate, `rules-list` mostra severidades `warn` para WMC/CBO/DIT e `error` para Halstead/LCOM (espelho da baseline).

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:rules:list`), §3 (baseline por estágio), §7.9 (acceptance).
- `.harn/docs/mvp/PLAN.md` §Fase 5 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/rules/{add,remove,explain}.md` — comandos pares.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
