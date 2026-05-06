---
name: lint:rules:remove
description: Use when the user asks to disable a lint rule, says "/lint:rules:remove <rule>", "remove quality-metrics/dit", "desativar rule", or wants to drop a `quality-metrics/*` or `category:*` entry from the project's `oxlint.{fast,deep}.json` preset. Mutating — edits preset, appends `rule-remove` entry to `.harn/qualy/docs/lint-decisions.md`. **`--reason` is mandatory** (SPEC §6 — toda remoção precisa de motivo registrado). Confirms via `AskUserQuestion` (one question at a time) and refuses dirty trees with `--strict` (offers `git stash`). Uses `lint-installer` subagent for the write.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: <rule> [--tier fast|deep]
---

# /lint:rules:remove

Desabilita uma rule oxlint no preset do projeto-alvo (SPEC §2 + §7.9). Mutating — edita `oxlint.fast.json` ou `oxlint.deep.json` (uma tier por chamada) e append um entry `rule-remove` em `.harn/qualy/docs/lint-decisions.md` com motivo **obrigatório** capturado pelo harness. SPEC §6 Always (line 389): toda remoção exige motivo registrado — sem motivo, `rules-remove` rejeita com `reason_required`.

## Visão Geral

1. **Pré-checks:** `detect-stack` → `git-clean-check` (oferece `git stash` se sujo) → presença de preset alvo → presença da rule no preset.
2. **Captura de motivo (SPEC §6 Always):** `AskUserQuestion` pedindo o motivo livre antes de qualquer escrita. SEM motivo, abortar — não passe `--reason ""`.
3. **Confirmação:** `AskUserQuestion` mostrando severity+max prévios e confirmando a remoção.
4. **Aplicação:** `rules-remove --reason "<motivo>" --strict` por baixo, idempotente (já ausente → `already-absent`, sem write).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Usuário pediu `/lint:rules:remove <rule>` ou disse que uma rule específica está bloqueando o time sem benefício mensurável.
- Após `/lint:audit` mostrar uma rec `remove-rule` (encaminhada via `/lint:update` em casos típicos, mas o usuário pode preferir o caminho explícito).
- Após `/lint:rules:list` revelar uma entry obsoleta (e.g., rule herdada de fixture antigo).
- Para remover entries explícitas `severity: off` (que aparecem em `disabled[]` do `rules-list`) — sem isso, o oxlint default da rule volta a valer.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse imediatamente.
- Sem preset instalado (`oxlint.fast.json` e `oxlint.deep.json` ambos ausentes): exit `1` (`preset_missing`); roteie para `/lint:setup`.
- Rule fora do catálogo conhecido (`unknown_rule` exit `1`): mostre catálogo + peça correção.
- Rule já ausente: idempotente — `rules-remove` retorna `action: "already-absent"` sem write. Mostre informativo e fechamento sem registrar decision.
- Tree sujo e usuário recusou `git stash`: aborte sem aplicar nada (`--strict` defesa em profundidade).
- Adicionar / tighten rule: este comando é só remove. Use `/lint:rules:add`.
- Loosen threshold (deixa rule, baixa max): NÃO é remoção; passe por `/lint:update` com rec `lower-threshold` ou `/lint:rules:add <rule> --max <maior>` para realinhar.

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
2. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`. `rules-remove --strict` aborta em sujo, então prefira `git stash`.
3. **Captura do nome da rule:**
   - Se o usuário passou positional/`--rule`: use diretamente.
   - Senão: `AskUserQuestion` ofertando rules ativas do `rules-list` (até 4 opções; primeiro = a mais frequentemente removida em projetos similares OU a sugerida pelo audit, marcada `(Recommended)`).
4. **Preview do estado atual:** `rules-explain <rule> --cwd "$PWD"` (read-only) para mostrar `current.severity`/`current.options.max` ao usuário antes da confirmação. Se `current=null` com `current_source: "rule_absent_from_presets"`: rule já ausente — informe e finalize sem `rules-remove` (idempotente sem efeito colateral).
5. **Pergunta 1 — Motivo (SPEC §6 Always):** `AskUserQuestion` com texto livre pedindo o motivo. SEM motivo (resposta vazia ou whitespace-only), repita a pergunta — `rules-remove` rejeita `reason_required` no caminho final, então é melhor falhar cedo no harness. Uma pergunta por vez — não combine com a Pergunta 2.
6. **Pergunta 2 — Confirmação:** `AskUserQuestion` com 3 opções fixas: `Remover (Recommended)` / `Cancelar` / `Mostrar racional da rule`. Show → `rules-explain <rule>` mostra `description` + `rationale` (literatura) e volta à pergunta. Útil quando o usuário hesita: lembra por que a rule foi adicionada antes de remover.
7. **Aplicação:** `rules-remove <rule> --reason "<motivo>" [--tier ...] --strict` — exit `0` aplicado (`removed` ou `already-absent`), `1` recoverable (`preset_missing`/`malformed`, `unknown_rule`, `reason_required` se motivo vazio escapou ao guard, `decisions_failed`), `3` dirty tree, `4` usage.
8. **Pós-condição:** mostre `action` final, `previous: { severity, max? }`, `files_changed` (preset + decisions), `decision.path`. Continue para fechamento; sem auto-commit (SPEC §6 Never line 416). Sugira `/lint:audit` para re-medir.

## Mapeamento de exit codes

- `0` — `rules-remove` aplicou (`removed`) ou já ausente (`already-absent` no-op, sem decision).
- `1` — recoverable: `preset_missing` (roteie `/lint:setup`), `preset_malformed` (mostre erro), `unknown_rule` (mostre catálogo), `reason_required` (volte à Pergunta 1 — `--reason` whitespace-only conta como vazio, SPEC §6 enforça non-trivial reason), `decisions_failed` (erro do append no decisions log).
- `2` — não esperado (stack já checada); reporte.
- `3` — `--strict` + tree sujo. Volte ao passo 2 e ofereça `git stash`.
- `4` — usage error: bug no harness; reporte.
- `5` — não aplicável (sem subprocess oxlint).
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **`--reason` mandatório (SPEC §6 Always line 389)**: ao contrário de `rules-add`, `rules-remove` exige motivo non-trivial. Whitespace-only ou string vazia é rejeitado pelo CLI. Trade-off: SPEC §6 line 423 enquadra remoção como afrouxamento (igual `lower-threshold`/`loosen-coverage`); o motivo cria audit-trail útil em retros e PR review (`.harn/qualy/docs/lint-decisions.md` é append-only).
- **Uma tier por chamada**: igual `rules-add`. Se a rule existe em `fast` E `deep`, rode duas vezes (com motivos potencialmente diferentes — útil quando deep enforça threshold mais apertado).
- **Idempotência por já-ausente**: `already-absent` NÃO escreve preset E NÃO append em decisions (verificado em testes). Trade-off: o usuário pode rodar `rules-remove` sem checar `rules-list` antes; o no-op é seguro e silencioso.
- **Sem dry-run com blast radius**: remoção AFROUXA enforcement, então não há novos arquivos violando. O CLI suporta `--dry-run` (preview do `previous`) mas não `--measure-blast-radius` (sem sentido). Pergunta 2 (confirmação) substitui o blast-radius preview.
- **Sem auto-commit (SPEC §6 Never line 416)**: cada `rules-remove` deixa staged (preset + `lint-decisions.md`). Usuário decide quando commitar.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" rules-remove --help` retorna a usage com `--rule`/positional REQUIRED + `--reason` REQUIRED + `--tier`/`--dry-run`/`--strict`/`--cwd` opcionais.
- E2E (SPEC §7.9): num fixture com `quality-metrics/cbo` ativa em deep, `/lint:rules:remove quality-metrics/cbo` (Pergunta 1: motivo `"team agreement after retro"`; Pergunta 2: Remover) → preset perde a entry, `.harn/qualy/docs/lint-decisions.md` ganha entry `rule-remove: quality-metrics/cbo: severity=error, max=8 — reason: team agreement after retro`. Segundo run → `already-absent` no-op.
- E2E (SPEC §6 reason gate): `rules-remove --rule quality-metrics/cbo --reason "" --cwd "$PWD"` retorna exit `1` com `error: "reason_required"` mesmo com a rule presente.

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:rules:remove`), §6 (Always: registrar motivo + Never: sem afrouxamento sem motivo), §7.9 (acceptance — pergunta motivo + registra).
- `.harn/docs/mvp/PLAN.md` §Fase 5 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/rules/{list,add,explain}.md` — comandos pares.
- `agents/lint-installer.md` — subagent para escrita de presets (SPEC §2 column 3).
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
