---
name: lint:rules:add
description: Use when the user asks to enable or tighten an oxlint rule, says "/lint:rules:add <rule>", "add quality-metrics/wmc", "ativar rule", "tighten correctness to error", or wants to add a `quality-metrics/*` or `category:*` entry to the project's `oxlint.{fast,deep}.json` preset. Mutating — edits preset, appends `rule-add` entry to `.harn/qualy/docs/lint-decisions.md`. Confirms via `AskUserQuestion` (one question at a time), shows blast radius via dry-run for QM rules, and refuses dirty trees with `--strict` (offers `git stash`). SPEC §6 — uses `lint-installer` subagent for the write.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: <rule> [--severity error|warn|off] [--max <n>] [--tier fast|deep]
---

# /lint:rules:add

Habilita (ou tighten) uma rule oxlint no preset do projeto-alvo (SPEC §2 + §7.9). Mutating — edita `oxlint.fast.json` ou `oxlint.deep.json` (uma tier por chamada) e append um entry `rule-add` em `.harn/qualy/docs/lint-decisions.md` com motivo capturado pelo harness. Toda escrita passa pelo CLI; este `.md` orquestra detecção → confirmação → dry-run (blast radius) → motivo → aplicação.

## Visão Geral

1. **Pré-checks:** `detect-stack` → `git-clean-check` (oferece `git stash` se sujo) → presença de preset alvo.
2. **Resolução de defaults:** tier (`quality-metrics/*` → deep, demais → fast; `--tier` override) + severity/max (baseline do estágio para QM rules; warn default para outras; usuário confirma via `AskUserQuestion`).
3. **Dry-run com blast radius (SPEC §7.9):** `rules-add --dry-run --measure-blast-radius` mostra `files_newly_violating` antes de qualquer escrita; usuário decide aplicar ou cancelar.
4. **Captura de motivo:** `AskUserQuestion` pedindo o motivo livre; persistido em `.harn/qualy/docs/lint-decisions.md` via CLI.
5. **Aplicação:** `rules-add --strict` por baixo, idempotente (já igual → `already-present`, sem write).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Após `/lint:rules:list` mostrar `available[]` não vazio e o usuário escolher uma rule para ativar.
- Após `/lint:rules:explain <rule>` revelar `current=null` e o usuário aceitar adicionar com defaults da baseline.
- Para tighten severity (`warn` → `error`) ou apertar `max` em uma rule já ativa (idempotente quando igual; `update` quando difere).
- Quando o usuário descobre uma category (`category:correctness`, `category:suspicious`) que quer enforçar como `error` ao invés do default `warn`.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse imediatamente.
- Sem preset instalado (`oxlint.fast.json` e `oxlint.deep.json` ambos ausentes): exit `1` (`preset_missing`); roteie para `/lint:setup` antes.
- Rule fora do catálogo conhecido (`unknown_rule` exit `1`): mostre catálogo + peça correção (espelho de `rules-explain`).
- `oxlint` não instalado em `node_modules/` (com `--measure-blast-radius`): exit `5` (`oxlint_missing`); roteie para `/lint:setup` ou `install-deps`.
- Tree sujo e usuário recusou `git stash`: aborte sem aplicar nada (`--strict` defesa em profundidade).
- Remover rule: este comando é só add/tighten. Use `/lint:rules:remove`.

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

1. **`detect-stack`** — exit `2` aborta.
2. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`. `rules-add --strict` aborta em sujo, então prefira `git stash`.
3. **Captura do nome da rule:**
   - Se o usuário passou positional/`--rule`: use diretamente.
   - Senão: `AskUserQuestion` ofertando rules de `available[]` do `rules-list` (até 4 opções; primeiro = a mais alinhada à baseline do estágio).
4. **Resolução de defaults (preview, sem escrita):** `rules-explain <rule>` para obter `default_for_stage` (apenas QM rules em deep com stage detectado) e `current` se aplicável. Mostre o usuário o tier resolvido + severity/max propostos.
5. **Pergunta 1 — Severidade/max (condicional):** se `--severity`/`--max` já passados, pule. Se a rule é QM e `default_for_stage` populated, ofereça `AskUserQuestion`: `Aceitar baseline (Recommended)` / `Custom severity` / `Custom max` / `Cancelar`. SPEC §6 Always: "alterar threshold — sempre mostrar valor proposto antes de pedir confirmação".
6. **Dry-run com blast radius (SPEC §7.9 acceptance):** `rules-add <rule> [--severity ...] [--max ...] [--tier ...] --dry-run --measure-blast-radius` retorna `{ action: "would-add"|"would-update"|"already-present", blast_radius: { files_currently_violating, files_newly_violating, files_no_longer_violating } | null }`. Mostre `files_newly_violating` ao usuário. Se `already-present`, pule para fechamento informativo (sem escrita).
7. **Pergunta 2 — Confirmação:** `AskUserQuestion` com 3 opções fixas: `Aplicar (Recommended)` / `Cancelar` / `Mostrar arquivos newly violating`. Show → lista os primeiros 10 arquivos do dry-run e volta à pergunta.
8. **Pergunta 3 — Motivo:** `AskUserQuestion` pedindo o motivo livre (texto). SPEC §6 Always: "registrar motivo em `.harn/qualy/docs/lint-decisions.md`". Default vazio é aceito (CLI usa `(none)`), mas peça texto significativo. Uma pergunta por vez — não combine com a Pergunta 2.
9. **Aplicação:** `rules-add <rule> [--severity ...] [--max ...] [--tier ...] [--reason "<motivo>"] --strict` — exit `0` aplicado, `1` recoverable (`preset_missing`/`malformed`, `unknown_rule`, `severity_required`, `max_required`, `decisions_failed`), `3` dirty tree, `4` usage, `5` `oxlint_missing` (só se `--measure-blast-radius` ainda for usado aqui — não é, `--strict` no apply path não mede).
10. **Pós-condição:** mostre `action` final, `files_changed` (preset + decisions), `decision.path`. Continue para fechamento; sem auto-commit (SPEC §6 Never line 416). Sugira `/lint:audit` para re-medir e `/lint:report` para visualizar.

## Mapeamento de exit codes

- `0` — `rules-add` aplicou (ou `already-present` no-op).
- `1` — recoverable: `preset_missing` (roteie `/lint:setup`), `preset_malformed` (mostre erro + edição manual), `unknown_rule` (mostre catálogo), `severity_required`/`max_required` (volte à Pergunta 1), `decisions_failed` (mostre erro do append no decisions log).
- `2` — não esperado (stack já checada); reporte.
- `3` — `--strict` + tree sujo. Volte ao passo 2 e ofereça `git stash`.
- `4` — usage error: bug no harness; reporte.
- `5` — `oxlint_missing` (apenas com `--measure-blast-radius`). Roteie `/lint:setup` ou `install-deps`.
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **Uma tier por chamada**: SPEC §3 separa `oxlint.fast.json` (categories + curated correctness) de `oxlint.deep.json` (categories + `quality-metrics`). `rules-add` edita uma só. Se o usuário quer a mesma rule em ambas as tiers, rode duas vezes — explícito > mágico.
- **Blast radius opcional via `--measure-blast-radius`**: o flag dispara dual-run de oxlint (current vs proposed em tmp dir). SPEC §7.9 acceptance exige mostrar `files_newly_violating` antes de aplicar. Sem o flag, o dry-run ainda mostra a `action` + severidade/max propostos, mas `blast_radius=null`. Use o flag por default no caminho greenfield/brownfield onde o usuário ainda não viu o impacto.
- **Reason gate no harness**: o CLI aceita `--reason` opcional (default `(none)` em `.harn/qualy/docs/lint-decisions.md`). O harness sempre pergunta; mesmo que o usuário responda vazio, registra como `(none)`. Trade-off: SPEC §6 line 423 exige motivo para afrouxamentos (`rules-remove`, `lower-threshold`, `loosen-coverage`); para tighten/add, motivo é desejável mas não bloqueante.
- **Idempotência byte-a-byte**: `already-present` (severity+max iguais) NÃO escreve preset E NÃO append em decisions. Trade-off: usuário pode rodar `/lint:rules:add` várias vezes sem poluir o log. Mudança de severity/max força `update` com novo entry no decisions.
- **Sem auto-commit (SPEC §6 Never line 416)**: cada `rules-add` deixa staged (preset + `lint-decisions.md`). Usuário decide quando commitar.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" rules-add --help` retorna a usage com `--rule`/positional REQUIRED + `--severity`/`--max`/`--tier`/`--reason`/`--dry-run`/`--measure-blast-radius`/`--strict`/`--cwd`.
- E2E (SPEC §7.9): num fixture greenfield com `oxlint.deep.json` instalado, `/lint:rules:add quality-metrics/cbo` (resposta da Pergunta 1: aceitar baseline) → preset gains `["error",{"max":8}]` em `rules`, `quality-metrics` em `plugins[]` (idempotente), `.harn/qualy/docs/lint-decisions.md` ganha entry `rule-add: quality-metrics/cbo: severity=error, max=8`. Segundo run → `already-present` no-op.
- E2E (SPEC §7.9): dry-run com `--measure-blast-radius` retorna `blast_radius` populado em fixture com violações reais.

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:rules:add`), §3 (baseline + plugins[] em deep), §6 (registrar motivo), §7.9 (acceptance — dry-run + blast radius).
- `.harn/docs/mvp/PLAN.md` §Fase 5 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/rules/{list,remove,explain}.md` — comandos pares.
- `agents/lint-installer.md` — subagent para escrita de presets (SPEC §2 column 3).
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
