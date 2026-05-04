# Cenário T2 — `/lint:audit` seguido de `/lint:update`

> Roteiro humano-legível para execução manual / semi-automatizada (SPEC §5 Tier T2). Cobre SPEC §7.5 (audit) + §7.6 (update + acoplamento).
> Pré-requisito: projeto já configurado pelo qualy (presets `oxlint.fast.json`/`oxlint.deep.json` presentes — i.e., `/lint:setup` já rodou).

## Pré-condições

- `node --version` ≥ 22.6.
- `oxlint.fast.json` **e** `oxlint.deep.json` no root, gerados por `/lint:setup`.
- `oxlint`, `@oxc-project/quality-metrics` instalados em `node_modules/`.
- Working tree limpo (informativo no audit; obrigatório no update via `--strict`).
- Working dir inclui violações deliberadas (ex: classe com WMC > preset max para forçar `summary.errors > 0`).

## Comando do usuário (Parte A — audit)

```
/lint:audit
```

### Sequência esperada do audit

1. `detect-stack` → `supported:true`, exit `0`.
2. `git-clean-check` → informativo (NÃO bloqueia audit; SPEC §6 line 63 — audit é read-only).
3. `audit --tier deep` → executa `oxlint --config oxlint.deep.json --format json .` por baixo, agrega violações por métrica, valida contra `auditPayloadSchema`, escreve `.lint-audit/<safe-ts>.json`.
4. **Sumário ao usuário** (4 linhas, sem perguntas no caminho feliz):
   ```
   stage: brownfield-moderate (loc=5071, source_files=8, age_days=0)
   summary: errors=3, warnings=12, files_affected=4
   top metrics: wmc → src/router.ts:42 (value=23, max=20)
                halstead-effort → src/parser.ts:88 (value=540, max=400)
                lcom → src/storage.ts:14 (value=4, max=2)
   path: .lint-audit/2026-05-04T17-22-08-000Z.json (12.4 KB)
   ```
5. **Pergunta opcional (só se `summary.errors > 0`):** `AskUserQuestion`:
   ```
   Ir para /lint:update agora (Recommended se há recommendations[])
   Mais tarde
   Abrir /lint:report
   ```

### Pós-condição audit

- `.lint-audit/<safe-ts>.json` validado contra `auditPayloadSchema` (SPEC §3): chaves obrigatórias `version:"1"`, `generated_at`, `cwd`, `stage`, `stage_signals`, `tooling`, `violations`, `rules_active`, `recommendations[]`.
- Exit code `0` se zero error-level, ou `1` se `summary.errors > 0` (audit ok mas com erros — distinguir de `recoverable_error` lendo `error` em stdout).
- `recommendations[]` populadas pelo subagent `lint-auditor` (ADR 0008 — exceção autorizada para escrever `rationale` enriquecida; jamais permanece como `rationale_stub`).

## Comando do usuário (Parte B — update)

```
/lint:update
```

(Idealmente dentro da janela de 24h após o audit — SPEC §6 line 66.)

### Sequência esperada do update

1. **`audit-latest`** lê `.lint-audit/<latest>.json`. Exit `1` (`audit_missing`) ⇒ harness oferece `/lint:audit` via `SlashCommand` (SPEC §6 line 66).
2. **Idade do audit:** se `now - generated_at > 24h`, `AskUserQuestion`:
   ```
   Rodar /lint:audit antes (Recommended)
   Continuar com o audit existente
   ```
3. **`git-clean-check`** → exit `3` (sujo) ⇒ `AskUserQuestion`:
   ```
   git stash (Recommended)
   Continuar mesmo assim
   Cancelar
   ```
   `recs-apply --strict` aborta em sujo, então `git stash` é o caminho seguro.
4. **Iteração por rec** (em ordem `severity: critical` → `recommend` → `suggest`):
   1. **Cartão da rec:** `id`, `title`, `rationale` (do `lint-auditor`, NÃO `rationale_stub`), `severity`, `type`, `applies_to`, `evidence` resumida.
   2. **Blast radius (opcional, recomendado para `raise-threshold`/`lower-threshold`/`add-rule`):**
      `recs-blast-radius --candidate-id <id>` retorna `{ files_newly_violating, files_no_longer_violating }`. SPEC §6 Always exige mostrar antes de aceitar rec que muda threshold com `files_newly_violating > 0`.
   3. **Pergunta 1 — Decisão (`AskUserQuestion`, 3 opções):**
      ```
      Apply (Recommended)
      Skip
      Explain
      ```
      `Explain` mostra `rationale` + `evidence.top[]` e volta à pergunta.
   4. **Pergunta 2 — Motivo (condicional):** se `type ∈ {lower-threshold, remove-rule, loosen-coverage}`, segunda `AskUserQuestion` com texto livre (motivo). SPEC §6 Always + Never line 423: motivo registrado para qualquer afrouxamento. Sem motivo ⇒ `recs-apply` rejeita com `reason_required` (1 pergunta por turno — SPEC §6).
   5. **`recs-apply --rec-id <id> [--reason <text>] --strict`:**
      - Exit `0` aplicado: edita preset/config, append em `docs/lint-decisions.md`, manifest atualizado.
      - Exit `1` skipped (`applicable:false` para `enable-tier`/`fix-tooling`): roteia via `SlashCommand` ao `delegate` (`/lint:setup` ou `install-deps`).
      - Exit `1` recoverable (`reason_required`/`preset_missing`/`config_missing`): mostra erro; `reason_required` reabre Pergunta 2.
      - Exit `3` dirty tree: volta ao passo 3.
5. **Fechamento:** sumário com `applied:<n>`, `skipped:<n>`, `delegated:[<list>]`. Sugere `/lint:audit` (re-medir) e `/lint:report` (visualizar).

### Pós-condição update

- Para cada rec aplicada: `oxlint.fast.json` ou `oxlint.deep.json` editado; entry append-only em `docs/lint-decisions.md` com timestamp ISO-8601 UTC + autor (`git config user.email`) + motivo.
- Idempotência: re-rodar `/lint:update` com mesmo audit retorna `recommendation_not_found` para cada rec já aplicada (manifest é fonte da verdade).
- Sem auto-commit (SPEC §6 Never line 416). Mudanças ficam staged via CLI; usuário decide quando empacotar.

## Caminhos negativos comuns

| Cenário                                              | Comportamento esperado                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.lint-audit/` ausente                              | Update retorna exit `1` (`audit_missing`); harness oferece `/lint:audit` via `SlashCommand` |
| Audit corrompido (schema validation fail)           | `audit-latest` exit `1` (`schema_validation_failed`); harness sugere re-rodar audit  |
| `recommendations[]` vazia                           | Sumário "nada a aplicar"; harness oferece `/lint:report` ou `/lint:audit` novamente  |
| `--rec-id` referenciando rec já aplicada            | Exit `1` (`recommendation_not_found`)                                                 |
| Tipo `enable-tier` ou `fix-tooling`                 | `recs-apply` retorna `applicable:false`; harness roteia via `SlashCommand` ao `delegate` |

## Verificação manual

- [ ] `lint-auditor` enriquece `rationale` (subagent retorna ≤ 30 linhas — SPEC §6 line 386).
- [ ] Cada rec tem `id` estável (regra `type + slug` — `docs/recs-heuristics.md`); resume via `--rec-id` funciona em sessão futura.
- [ ] Pergunta 1 e Pergunta 2 são chamadas separadas a `AskUserQuestion` (uma pergunta por turno — SPEC §6 line 419).
- [ ] Para tipo `lower-threshold`/`remove-rule`/`loosen-coverage`, motivo é mandatório; CLI rejeita sem.
- [ ] `docs/lint-decisions.md` cresce append-only (sem rewrites).
- [ ] Re-rodar update no mesmo audit é noop por rec já aplicada.
- [ ] Audit > 24h dispara confirmação extra (não é hard-fail).

## E2E automatizado (referência)

`cli/tests/e2e/audit-recommendations.test.ts` cobre:
- audit produz JSON válido contra schema;
- update aplica 1 rec `lower-threshold` com motivo;
- segundo run retorna `recommendation_not_found`;
- update sem audit retorna exit `1` (`audit_missing`).

Este roteiro T2 valida o caminho conversacional (cartão da rec, blast radius UI, pergunta de motivo, sumário final) que o e2e não cobre.

## Referências

- SPEC §2 (`/lint:audit`, `/lint:update`), §3 (audit + recommendations contract), §6 (acoplamento audit↔update + reason gate + uma pergunta por vez), §7.5 + §7.6 (acceptance).
- PLAN §Fase 4.
- `commands/lint/audit.md`, `commands/lint/update.md`, `agents/lint-auditor.md`.
- `docs/audit-format.md` (contrato JSON canônico), `docs/recs-heuristics.md` (IDs estáveis).
- ADR 0004 (audit-update coupling), ADR 0006 (CLI determinístico), ADR 0008 (rationale híbrida via `lint-auditor`).
