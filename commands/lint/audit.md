---
name: lint:audit
description: Use when the user asks for a quality audit of their TS/TSX/JS/JSX project, says "/lint:audit", "audit code quality", "rodar audit", "lint-auditor", or wants the deep analysis output written to `.lint-audit/<timestamp>.json` for `/lint:update` and `/lint:report` to consume. Read-only — runs the deep tier oxlint preset (falls back to fast), aggregates violations by metric (wmc, halstead, lcom, cbo, dit), and persists the SPEC §3 audit contract. Refuses non-TS/JS stacks via `detect-stack` exit `2` and refuses if no preset is installed (exit `5` → suggest `/lint:setup`).
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: (none)
---

# /lint:audit

Análise estratégica do estado de lint+qualidade no repo (SPEC §2 + §7.5). Roda o tier `deep` do oxlint, agrega violações por métrica e persiste `.lint-audit/<timestamp>.json` para `/lint:update` aplicar e `/lint:report` visualizar. **Read-only** — não modifica configs nem scripts.

## Visão Geral

1. **Pré-checks (read-only):** `detect-stack` → `git-clean-check` (informativo, não bloqueia) → presença de `oxlint.fast.json`/`oxlint.deep.json`.
2. **Execução:** `audit --tier deep` (fallback `fast` se deep ausente). O CLI compõe `detect-stage` + `detect-test-runner` + leitura dos presets + `oxlint --format json`, valida contra `auditPayloadSchema` e escreve `.lint-audit/<safe-ts>.json`.
3. **Resumo ao usuário:** estágio detectado, top violações por métrica, contagem por severidade, caminho do arquivo persistido. Sem perguntas, sem escrita adicional.
4. **Próximo passo:** se `summary.errors > 0`, sugere `/lint:update` para iterar `recommendations[]` (acoplamento audit↔update — SPEC §6).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Projeto já configurado pelo qualy (`oxlint.fast.json` ou `oxlint.deep.json` presentes), usuário pediu `/lint:audit`.
- Antes de `/lint:update`: SPEC §6 acopla audit↔update; update sem audit ≤ 24h oferece rodar audit antes.
- Antes de `/lint:report`: report visualiza o JSON mais recente (`.lint-audit/<latest>.json`).
- Rotina periódica de qualidade: rodar audit por sprint para acompanhar tendência (treemap + line chart no report).

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`, `blockers[]` populado): recuse imediatamente. Nada para auditar fora de TS/TSX/JS/JSX.
- Sem preset instalado (`oxlint.fast.json` e `oxlint.deep.json` ambos ausentes): exit `5` (`preset_missing`); roteie para `/lint:setup`.
- `oxlint` não instalado em `node_modules/`: exit `5` (`oxlint_missing`); roteie para `/lint:setup` ou `install-deps`.
- Aplicar mudanças nas rules: este comando é read-only. Use `/lint:update` ou `/lint:rules:add|remove`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI=""
for cand in "$PWD/.claude" "$HOME/.claude"; do
  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break
done
[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found in \$PWD/.claude or \$HOME/.claude. Run \`qualy install\` first." >&2; exit 5; }
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta com mensagem listando stacks suportadas (`TS/TSX/JS/JSX`); nada é escrito.
2. **`git-clean-check`** — informativo. Audit é read-only e o JSON novo em `.lint-audit/<ts>.json` é o único side effect; não bloqueie em tree sujo. Mostre o estado ao usuário.
3. **`audit --tier deep`** — chama `oxlint --config oxlint.deep.json --format json .` por baixo. Caminhos felizes: exit `0` (sem error-level) ou exit `1` (audit ok mas `summary.errors > 0`). Caminhos de falha: `2` (stack), `5` (`oxlint_missing` ou `preset_missing`), `1` (`stage_detection_failed`, `schema_validation_failed`, `write_failed`), `3` (com `--strict`), `4` (usage).
4. **Pergunta opcional 1 — Tier:** se o usuário quer um audit rápido (smoke), `AskUserQuestion` ofertando `deep` (Recommended) / `fast` / cancelar; default = `deep`. Pergunta só dispara se o usuário pediu explicitamente "audit rápido"; o caminho default executa `deep`.
5. **Sumário ao usuário:** leia o stdout (`{ ok, path, timestamp, payload }`) e mostre 4 linhas:
   - `stage`: `payload.stage` + `stage_signals.{loc, source_files, age_days}`.
   - `summary`: `payload.violations.summary.{errors, warnings, files_affected}`.
   - `top metrics`: para cada `by_metric.<key>` com `violations > 0`, liste 1 entry de `top[]` (`file` + `value`/`max`).
   - `path`: `path` (relativo) + `bytes`.
6. **Pós-condição (opcional):** se `summary.errors > 0`, ofereça `/lint:update` via `AskUserQuestion` (Recommended se houver `recommendations[]` no payload) / mais tarde / abrir `/lint:report`.

## Mapeamento de exit codes

- `0` — sucesso, zero error-level. Mostre sumário e ofereça `/lint:report` ou `/lint:update`.
- `1` — sucesso parcial: audit completou e gravou o JSON, mas `summary.errors > 0`. Mostre sumário e roteie para `/lint:update`. Também é o código de `recoverable_error` (schema_validation_failed, stage_detection_failed, write_failed) — distinguir lendo `error` em stdout.
- `2` — stack bloqueada. Aborte sem rodar audit.
- `3` — dirty tree (somente com `--strict`; default não passa). Volte à pergunta de `git stash`.
- `4` — usage error: bug no harness; reporte e aborte.
- `5` — `oxlint_missing` ou `preset_missing`. Roteie para `/lint:setup` (instala deps + presets) ou `install-deps` isolado.
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **Read-only > orquestração total**: SPEC §6 lista `/lint:audit` como read-only. O comando NÃO escreve presets, scripts, hooks ou husky — apenas o JSON em `.lint-audit/<ts>.json`. Mutações ficam para `/lint:update`.
- **`deep` por default**: tier `deep` carrega `quality-metrics` (Halstead/LCOM/CBO/DIT/WMC); fallback `fast` quando `oxlint.deep.json` ausente. Permite audit funcional mesmo em projeto recém-setupado sem `quality-metrics` instalado, mas o sumário avisa que métricas estruturais ficam zeradas.
- **Sem `AskUserQuestion` no caminho feliz**: SPEC §6 lista audit como read-only — nenhuma pergunta de escrita. Pergunta opcional só dispara se o usuário pediu tier customizado ou cancelar; o default é executar e mostrar.
- **Não commitar**: SPEC §6 Never line 416 — a skill nunca commita. O usuário decide se versiona `.lint-audit/<ts>.json` (sugerido em `.gitignore` por default).

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" audit --cwd "$PWD" --tier fast` num fixture com `oxlint.fast.json` retorna exit `0` e grava `.lint-audit/<ts>.json` válido contra `auditPayloadSchema`.
- E2E (PLAN §Fase 4 + SPEC §7.5): `/lint:audit` num fixture com violações deliberadas retorna exit `1`, persiste o JSON com `summary.errors > 0`, e o sumário mostra top violações por métrica.
- E2E (SPEC §7.6): `recommendations[]` populadas pelo `lint-auditor` carregam `rationale` ≠ `rationale_stub` (ADR 0008).

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:audit`), §3 (audit contract), §6 (audit↔update), §7.5/§7.6 (acceptance).
- `.harn/docs/mvp/PLAN.md` §Fase 4 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
- `docs/adrs/0008-hybrid-recs-rationale.md` — exceção do `lint-auditor` para `rationale`.
