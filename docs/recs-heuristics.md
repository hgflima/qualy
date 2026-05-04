# Heurísticas de geração de recomendações

Reference contract para `cli/src/commands/recs/generate.ts` (PLAN §Fase 4 + §Contratos CLI).

- Status: aceito v1 · Data: 2026-05-03
- Relacionados: ADR 0006 (CLI determinístico), ADR 0008 (rationale híbrida), SPEC §3 (contrato de audit), `cli/src/lib/audit-schema.ts` (zod)

## 1. Propósito

`recs-generate` lê `.lint-audit/<ts>.json` (validado por `auditPayloadSchema`) e emite uma lista determinística de **candidatos** para o subagent `lint-auditor` enriquecer com `rationale` final e persistir em `recommendations[]` no mesmo arquivo (ADR 0008). Toda decisão numérica (gatilhos, fórmulas, blast radius parcial, IDs estáveis) vive aqui — o modelo só edita prosa.

**Invariante.** Mesmo audit → mesmo conjunto de candidatos, mesma ordem, mesmos IDs. Drift quebra a suite de testes do `recs-generate` antes de chegar no `/lint:update`.

## 2. Inputs consumidos

Da `AuditPayload`, o gerador lê:

- `stage` — para escolher tabela de thresholds (cross-ref `cli/src/presets/oxlint/`).
- `tooling.{oxlint,oxfmt,quality_metrics}` — `null` dispara `fix-tooling`.
- `tooling.test_runner` + `tooling.coverage` — alimenta `tighten-coverage`/`loosen-coverage`.
- `violations.summary` — usado em sumário, não em gatilho.
- `violations.by_metric.<key>.{violations, max_seen, max_seen_volume, max_seen_effort, top}` — corpo dos gatilhos de threshold.
- `rules_active[]` — `origin` distingue `preset:*` (ajustável) de `user-override:*` (intocável).
- `recommendations[]` — ignorado (este é o output que estamos derivando; gerador é puro sobre os outros campos).

## 3. Output contract — `candidates[]`

```jsonc
{
  "candidates": [
    {
      "id": "rec-raise-threshold-wmc-fast",        // estável (§4)
      "type": "raise-threshold",                   // recTypeSchema
      "title": "WMC max está em 20 — apertar para 14",
      "rationale_stub": "max_seen=12 < 0.7 × max=20 (greenfield); apertar para round(max_seen × 1.2)=14.",
      "evidence": {                                // numérico, source-of-truth
        "metric": "wmc",
        "current_max": 20,
        "max_seen": 12,
        "violations": 0,
        "stage": "greenfield"
      },
      "suggested_change": {                        // shape do `patch` futuro
        "applies_to": "oxlint.fast.json",
        "rule": "quality-metrics/wmc",
        "max": 14
      },
      "blast_radius": {
        "files_currently_violating": 0,
        "files_newly_violating": null              // resolvido por recs-blast-radius
      },
      "severity": "suggest",                       // recSeveritySchema
      "applies_to": "oxlint.fast.json"
    }
  ]
}
```

Observações:

- `candidates[].rationale_stub` é o **template determinístico** (§5); o subagent reescreve em `recommendations[].rationale` com contexto humano (ADR 0008). Drift quebra acceptance §7.6.
- `blast_radius.files_newly_violating: null` em candidatos sinaliza "ainda não medido" — `recs-blast-radius` preenche depois rodando `oxlint --config <patch>` em dry-run.
- `evidence` carrega os números brutos para o consumidor (`/lint:update`, `/lint:report`) auditar a recomendação sem reabrir o audit.
- `suggested_change` espelha a struct futura do `patch` em `recommendations[]` mas é nomeado distinto para permitir evolução do shape sem reescrever specs.

## 4. Stable ID derivation

IDs determinísticos em duas partes: `rec-<type>-<slug>`.

| `type` | `<slug>` |
|---|---|
| `raise-threshold` | `<metric>-<tier>` (ex: `wmc-fast`) |
| `lower-threshold` | `<metric>-<tier>` |
| `add-rule` | `<rule-slug>-<tier>` (rule-slug = `quality-metrics/cbo` → `quality-metrics-cbo`) |
| `remove-rule` | `<rule-slug>-<tier>` |
| `enable-tier` | `<tier>` (`enable-tier-deep`) |
| `tighten-coverage` | `<runner>-<key>` (ex: `vitest-lines`) |
| `loosen-coverage` | `<runner>-<key>` |
| `fix-tooling` | `<package-slug>` (`oxlint` → `oxlint`; `@oxc-project/quality-metrics` → `quality-metrics`) |

Slug rules: lowercase ASCII, `[a-z0-9-]+`, `/` → `-`, `@` removido. Colisão entre dois candidatos com mesma `(type, slug)` é **bug**; gerador deve agrupar antes de emitir (ex: nunca duas raise-threshold para o mesmo metric+tier).

## 5. Rationale_stub templates

Templates fixos, parametrizados pelo `evidence`. Em PT-BR (alinha com SPEC §4 line 297). Cada template cobre os 5 placeholders permitidos: `{metric}`, `{rule}`, `{current_max}`, `{max_seen}`, `{violations}`, `{stage}`, `{tier}`, `{runner}`, `{key}`, `{current_value}`, `{proposed_value}`, `{package}`.

| Type | Template |
|---|---|
| `raise-threshold` | `{metric} max={current_max} mas max_seen={max_seen} ({stage}); apertar para round(max_seen × 1.2)={proposed_value}.` |
| `lower-threshold` | `{metric} max={current_max} com {violations} violações (max_seen={max_seen}); afrouxar para round(max_seen × 0.9)={proposed_value}.` |
| `add-rule` | `Stage {stage} habilita {rule} no preset; ausente em {tier} — adicionar com max={proposed_value}.` |
| `remove-rule` | `{rule} sem hits em 90 dias e fora do baseline {stage}; remover de {tier}.` |
| `enable-tier` | `Tier {tier} ausente — preset deep não escrito ou quality_metrics não instalado.` |
| `tighten-coverage` | `{runner}.{key}={current_value}% acima do threshold ({proposed_value}%); apertar para {proposed_value}%.` |
| `loosen-coverage` | `{runner}.{key}={current_value}% abaixo do threshold ({proposed_value}%); afrouxar para {proposed_value}% (registrar motivo em lint-decisions.md — SPEC §6 Never).` |
| `fix-tooling` | `{package} ausente em node_modules/; instalar via install-deps.` |

Stubs **nunca** são vazios e **sempre** contêm pelo menos um número de `evidence`. Testes do `recs-generate` asseguram isso.

## 6. Heurísticas por type

### 6.1 `raise-threshold` (apertar)

Disparo: para cada metric ∈ {wmc, halstead, lcom, cbo, dit} cujo `rules_active[]` carrega entry com `origin: preset:*`:
- requerer `violations.by_metric.<metric>.violations === 0` (sem hits — espaço para apertar);
- requerer `max_seen` disponível (Halstead usa `max_seen_volume`);
- gatilho: `max_seen < 0.7 × current_max` (regra do PLAN §Contratos CLI line 91).

Fórmula: `proposed = max(1, round(max_seen × 1.2))`. Se `proposed === current_max`, **dropar** (no-op).

`severity`: `suggest` por padrão; `recommend` quando `(current_max - proposed) >= 5` (ganho relevante).

`applies_to`: tier que carrega a rule. Se ambos os tiers (fast+deep) têm a mesma rule, emitir candidato apenas para o **deep** (rule de quality-metrics tipicamente vive ali).

### 6.2 `lower-threshold` (afrouxar)

Disparo: para cada metric com entry `origin: preset:*`:
- gatilho: `violations >= 5` E `max_seen > 1.5 × current_max`.

Fórmula: `proposed = round(max_seen × 0.9)`. Floor: nunca emitir `proposed > stage_legacy_max` (legacy é o teto absoluto da tabela §3 do SPEC).

`severity`: `recommend` por padrão; `critical` quando `violations >= 20` (loop bloqueado por warnings).

### 6.3 `add-rule`

Disparo: para cada `(stage, tier)` listado nos presets bundled (`cli/src/presets/oxlint/<stage>.<tier>.json`), comparar `rules_active[]` ao baseline:
- se baseline carrega `quality-metrics/<rule>` mas `rules_active[]` não, emitir candidato.

`evidence.proposed_value`: o `max` do baseline para o stage corrente (cross-ref tabela SPEC §3).

`severity`: `recommend`. Não emitir quando o stage do audit não bate o stage do preset (ex: audit de `legacy` não recebe sugestão de `cbo:8` do baseline `greenfield`).

### 6.4 `remove-rule`

Disparo conservador: emitir **apenas** quando todas as condições valem:
- `origin: user-override:*` (regras adicionadas pelo usuário, nunca preset);
- `violations === 0` há 90+ dias (sinalizado por `evidence` futuro — em v1, não emitir; reservado).

V1 **não emite** `remove-rule` automaticamente. Usuário aciona via `/lint:rules:remove`. Documentado para fechar a tabela do SPEC §3 line 273.

### 6.5 `enable-tier`

Disparo, qualquer um:
- `tooling.quality_metrics === null` (pacote não instalado) → tier deep não roda;
- `oxlint.deep.json` ausente (resolvido lendo `existsSync` — gerador recebe FS seam).

`severity`: `recommend`. `applies_to`: `oxlint.deep.json`. `proposed_value`: nada (action change, não threshold).

### 6.6 `tighten-coverage`

Disparo: `tooling.coverage.configured === true` E para cada `key ∈ {lines,functions,branches,statements}`:
- `tooling.coverage.<key>` (current_value) ≥ próximo tier de stage da tabela SPEC §3.

Próximo tier (mais estrito):
- `legacy` → `brownfield-moderate`;
- `brownfield-moderate` → `greenfield`;
- `greenfield` → não emite (já no topo).

Fórmula: `proposed = next_tier_threshold[key]`. Se `current_value < proposed`, dropar.

`severity`: `suggest`.

### 6.7 `loosen-coverage`

Disparo: `tooling.coverage.<key> < tooling.coverage.thresholds.<key>` (mede falha real).

Fórmula: `proposed = floor(current_value)` (alinhado com a realidade, sem cair abaixo do tier `legacy` da tabela). Se `proposed < legacy_table[key]`, dropar (não vale a pena recomendar abaixo do piso).

`severity`: `recommend`. **Sempre** carrega no `rationale_stub` o aviso de `lint-decisions.md` (SPEC §6 Never line 423).

### 6.8 `fix-tooling`

Disparo, qualquer um:
- `tooling.oxlint === null` (oxlint não instalado);
- `tooling.oxfmt === null` (oxfmt não instalado);
- `tooling.quality_metrics === null` E o stage tem rules `quality-metrics/*` ativas.

`severity`: `critical`. `applies_to`: `package.json`.

## 7. Determinismo & ordering

1. **Ordem de emissão** (lock contra drift):
   1. `fix-tooling` (todos),
   2. `enable-tier`,
   3. `add-rule` (alfabético por rule),
   4. `lower-threshold` (alfabético por metric),
   5. `raise-threshold` (alfabético por metric),
   6. `remove-rule` (não emite em v1),
   7. `loosen-coverage` (lines→functions→branches→statements),
   8. `tighten-coverage` (mesma ordem).

2. **`user-override:*` é intocável**: rule com `origin` começando por `user-override:` nunca recebe `raise-threshold`/`lower-threshold` automático — usuário escreveu o threshold de propósito.

3. **Floor / ceiling**: nenhum `proposed_value` deve sair da faixa `[greenfield_table[k], legacy_table[k]]` (clamping deterministicamente).

4. **Round half-up**: `round(x)` segue `Math.round(x)` do JS (half away from zero positivo). Documentar nas testes.

5. **Stage drift entre audit e preset**: se `audit.stage !== preset_comment.stage` em uma rule `origin:preset:<x>`, gerador trata o stage do audit como verdade (`max` da tabela do audit.stage), e emite **apenas** quando faz sentido (ex: audit em `legacy` com preset `greenfield` ativo provavelmente quer recalibração — emitir `lower-threshold` de cada metric).

## 8. Severities & gating

| `severity` | Quando | Comportamento em `/lint:update` |
|---|---|---|
| `suggest` | Ganho marginal (raise-threshold default, tighten-coverage). | Pulável sem registro. |
| `recommend` | Ganho relevante (add-rule, lower-threshold default, enable-tier). | Pergunta apply/skip/explain. |
| `critical` | Quebra ferramenta ou loop agêntico (fix-tooling, lower-threshold com 20+ violations). | Sobe ao topo da fila (SPEC §3 line 285). |

## 9. Acceptance per heurística

Cada heurística DEVE ter:

- **Teste positivo**: audit fixture que dispara → candidate emitido com ID, evidence e stub esperados.
- **Teste negativo**: audit fixture na fronteira do gatilho → nada emitido.
- **Idempotência**: rodar `recs-generate` 2× sobre o mesmo audit produz JSON byte-igual.
- **Fronteira `user-override`**: rule com `origin:user-override:*` ignorada por raise/lower.

## 10. Open questions

- **p90 vs max_seen**: PLAN §Contratos CLI line 91 menciona `p90`, mas `audit-schema.ts` só carrega `max_seen` em v1. Seguir `max_seen` até `quality-metrics` exportar percentis. Adicionar `p50`/`p90` ao schema é open question da Fase 4 hardening.
- **`remove-rule`**: v1 não emite. Disparo de "rule sem hits há N dias" precisa de auditoria temporal (cross-audit), reservado para v2 (PLAN §Open questions).
- **Coverage `warn-only` em legacy**: tabela SPEC §3 marca legacy `lines: 40 (warn-only)` mas `vitest`/`jest` não têm warn nativo. O candidato `loosen-coverage` deve respeitar `_warnOnly` do preset bundled (cross-ref `cli/src/presets/coverage/{vitest,jest}.legacy.*`).
- **Patch shape em `applies_to: package.json`**: `fix-tooling` aponta para o package.json mas não tem `patch` numérico — `recs/apply` deve delegar a `install-deps`. Documentar contrato em `recs/apply.ts` na próxima task.
