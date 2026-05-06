---
name: lint:update
description: Use when the user asks to apply audit recommendations, says "/lint:update", "aplicar audit", "atualizar lint", "iterate recommendations", or wants to walk `audit.recommendations[]` one by one with `apply/skip/explain` after a previous `/lint:audit`. Reads `.lint-audit/<latest>.json` via `audit-latest`, shows `blast_radius` before threshold/rule changes, captures `--reason` via `AskUserQuestion` for loosening changes (`lower-threshold`, `remove-rule`, `loosen-coverage` — SPEC §6), and delegates each application to `recs-apply --rec-id <id>`. Refuses if no audit exists or audit is older than 24h (SPEC §6 acoplamento) — offers `/lint:audit` first.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: [--rec-id <id>]
---

# /lint:update

Aplica `recommendations[]` do audit mais recente **uma por vez**, com `AskUserQuestion` (apply / skip / explain) e captura de motivo para qualquer afrouxamento (SPEC §2 + §6 acoplamento audit↔update). Mutações reais ficam em `recs-apply`; este arquivo é só o orquestrador.

## Visão Geral

1. **Pré-checks:** `audit-latest` (lê `.lint-audit/<ts>.json`) → idade do audit ≤ 24h → `git-clean-check` (gating: oferece `git stash` se sujo).
2. **Iteração:** para cada `recommendations[i]` (em ordem do audit, `severity: critical` primeiro), opcional `recs-blast-radius --candidate-id <id>` antes da pergunta; `AskUserQuestion` com 3 opções fixas (Apply / Skip / Explain).
3. **Captura de motivo:** se `type ∈ {lower-threshold, remove-rule, loosen-coverage}`, dispara segunda `AskUserQuestion` pedindo o motivo livre (1 pergunta por vez — SPEC §6).
4. **Aplicação:** `recs-apply --rec-id <id> [--reason <text>] --strict` por rec; manifest e `.harn/qualy/docs/lint-decisions.md` são append-only via CLI.

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Logo após `/lint:audit` quando `summary.errors > 0` ou `recommendations[].length > 0` (acoplamento SPEC §6 line 66).
- Manutenção periódica: estágio mudou (greenfield → brownfield), thresholds folgaram, ou novas rules foram propostas.
- Re-rodar para aplicar somente uma rec específica via `--rec-id <id>`; restantes ficam para o próximo turno.

## Quando NÃO usar

- Sem `.lint-audit/<ts>.json` (`audit-latest` retorna `audit_missing`, exit `1`): roteie para `/lint:audit` antes (SPEC §6 line 66 — update sem audit prévio ≤ 24h oferece rodar audit).
- `recommendations[]` vazio: nada para aplicar; mostre o sumário e ofereça `/lint:report` ou rodar `/lint:audit` novamente.
- Tree sujo e usuário recusou `git stash`: aborte sem aplicar nada (`--strict` defesa em profundidade).
- Mudança de versão de oxlint/oxfmt/quality-metrics: delegado a `install-deps` (rec `fix-tooling` retorna `applicable: false` com `delegate: "install-deps"`).
- Re-instalar tier deep: rec `enable-tier` retorna `applicable: false` com `delegate: "/lint:setup"`.

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

1. **`audit-latest`** — lê `.lint-audit/<latest>.json`. Exit `1` (`audit_missing`/`read_failed`/`parse_failed`/`schema_validation_failed`): roteie para `/lint:audit` via `SlashCommand`.
2. **Idade do audit (SPEC §6 line 66):** compute `now - audit.generated_at`. Se > 24h, `AskUserQuestion` ofertando `Rodar /lint:audit antes (Recommended)` / `Continuar com o audit existente`. Default = re-rodar.
3. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`. `recs-apply --strict` aborta em sujo, então prefira `git stash`.
4. **Itere `audit.recommendations[]`** (SPEC §3 contract): ordene `severity: critical` primeiro, depois `recommend`, `suggest`. Se `--rec-id <id>` foi passado, restrinja ao subset de 1 entry.
5. **Por rec, mostre o cartão:** `id`, `title`, `rationale` (não `rationale_stub` — vem enriquecido pelo `lint-auditor` por ADR 0008), `severity`, `type`, `applies_to`, `evidence` resumida.
6. **Blast radius (opcional, recomendado para `raise-threshold`/`lower-threshold`/`add-rule`):** `recs-blast-radius --candidate-id <id>` retorna `{ files_newly_violating, files_no_longer_violating }`. SPEC §6 Always exige mostrar `blast_radius` antes de aceitar rec que muda threshold com `files_newly_violating > 0`. Tipos `fix-tooling`/`tighten-coverage`/`loosen-coverage`/`enable-tier` retornam `applicable: false` (skip silencioso).
7. **Pergunta 1 — Decisão:** `AskUserQuestion` com 3 opções: `Apply (Recommended)` / `Skip` / `Explain`. `Explain` mostra `rationale` + `evidence.top[]` e volta à pergunta.
8. **Pergunta 2 — Motivo (condicional):** se `type ∈ {lower-threshold, remove-rule, loosen-coverage}`, dispara segunda `AskUserQuestion` pedindo o motivo (texto livre). SPEC §6 Always + Never line 423 exigem motivo registrado para qualquer afrouxamento. SEM motivo, `recs-apply` rejeita com `reason_required`.
9. **`recs-apply --rec-id <id> [--reason <text>] --strict`** — exit `0` aplicado, `1` skipped (`applicable: false` para `enable-tier`/`fix-tooling` — roteie via `SlashCommand` ao `delegate`), `1` recoverable (`reason_required`/`preset_missing`/`config_missing`), `3` dirty tree.
10. **Pós-condição por rec:** mostre `files_changed` e `decision.path` (`.harn/qualy/docs/lint-decisions.md`). Continue para a próxima rec até esgotar `recommendations[]`. Sem auto-commit (SPEC §6 Never line 416).
11. **Fechamento:** sumário final com `applied: <n>`, `skipped: <n>`, `delegated: [<list>]`. Sugira `/lint:audit` para re-medir e `/lint:report` para visualizar.

## Mapeamento de exit codes

- `0` — `recs-apply` aplicou ou pulou (`applicable: false`). Continue para a próxima rec.
- `1` — `audit_missing` (roteie para `/lint:audit`); ou `recoverable_error` (`reason_required`, `preset_missing`/`malformed`, `coverage_config_missing`, `recommendation_not_found`). Mostre `error` e `reason` ao usuário; `reason_required` reabre Pergunta 2.
- `2` — não esperado (audit já filtrou stack); reporte e aborte.
- `3` — `--strict` + tree sujo. Volte ao passo 3 e ofereça `git stash`.
- `4` — usage error: bug no harness; reporte.
- `5` — não esperado em update (sem subprocess oxlint além do blast-radius opcional, que retorna `5` só se `oxlint_missing`). Roteie para `/lint:setup`.

## Trade-offs

- **Uma pergunta por vez (SPEC §6 Always)**: Pergunta 1 (Apply/Skip/Explain) e Pergunta 2 (motivo) são duas chamadas separadas a `AskUserQuestion`, nunca combinadas. SPEC §6 line 419 + line 462 lockam a regra.
- **Reason gate no CLI, não no .md**: `recs-apply` rejeita `reason_required` para tipos de afrouxamento; o orquestrador NÃO adivinha motivo nem usa default vazio. Falha explícita força a Pergunta 2.
- **Blast radius opcional por tipo**: tipos não-mensuráveis via oxlint dry-run (`fix-tooling`/`tighten-coverage`/`loosen-coverage`/`enable-tier`) retornam `applicable: false` — pule a chamada para evitar ruído no usuário.
- **`enable-tier` e `fix-tooling` delegam**: SPEC §3 contract enumera 8 `REC_TYPES` mas `recs-apply` só aplica 6; os 2 restantes orquestram `/lint:setup` ou `install-deps`. Não tente reimplementar aqui.
- **Sem auto-commit (SPEC §6 Never line 416)**: cada `recs-apply` deixa staged (manifest + `lint-decisions.md`). Usuário decide quando commitar — sugira a mensagem mas NÃO rode `git commit`.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" recs-apply --help` retorna a usage com `--rec-id` REQUIRED + `--reason`/`--audit`/`--strict`/`--cwd` opcionais.
- E2E (PLAN §Fase 4 + SPEC §7.6): `/lint:update` num fixture com audit prévio aplica 1 rec `lower-threshold` com motivo capturado, escreve preset modificado + entry em `.harn/qualy/docs/lint-decisions.md`, e o segundo run com mesmo audit retorna `recommendation_not_found` (idempotência ao nível de manifest).
- E2E (SPEC §6 acoplamento): `/lint:update` sem `.lint-audit/` retorna exit `1` e oferece `/lint:audit` via `SlashCommand`.

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:update`), §3 (`recommendations[]` contract), §6 (acoplamento audit↔update + reason gate), §7.6 (acceptance).
- `.harn/docs/mvp/PLAN.md` §Fase 4 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/audit.md` — par simétrico (audit produz, update consome).
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
- `docs/adrs/0008-hybrid-recs-rationale.md` — `rationale` enriquecido vem do `lint-auditor`, NÃO do `rationale_stub`.
