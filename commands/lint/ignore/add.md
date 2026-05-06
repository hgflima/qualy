---
name: lint:ignore:add
description: Use when the user asks to add a lint exclusion in a TS/TSX/JS/JSX project, says "/lint:ignore:add <glob>", "ignorar legacy", "exclude generated code", "skip vendored files", "ignore quality-metrics/wmc em src/x/**", or wants to register an audited entry in `.harn/qualy/ignore.json` with mandatory `reason` and optional `expires`. Mutating — edits manifest, recompiles `oxlint.{fast,deep}.json` markers, appends `ignore-add` (or `ignore-update`) to `.harn/qualy/docs/lint-decisions.md`. Confirms via `AskUserQuestion` (one question at a time), refuses dirty trees with `--strict` (offers `git stash`). Supports path-only, per-rule (`--rule quality-metrics/wmc`), and category (`--rule category:correctness`) entries — categories require explicit acknowledgement of the blast radius.
allowed-tools: Bash, AskUserQuestion, SlashCommand
argument-hint: <glob> [--rule <rule-id>|category:<name>] [--reason <txt>] [--expires YYYY-MM-DD]
---

# /lint:ignore:add

Registra uma exclusão no manifesto qualy (lint-ignore SPEC §3.1 + §4.1) com motivo obrigatório e expiry opcional. Mutating — edita `.harn/qualy/ignore.json`, recompila `oxlint.fast.json` e `oxlint.deep.json` entre os markers `_qualy:start_/end_` (path entries em `ignorePatterns`, per-rule + category entries em `overrides[]`), e append entry `ignore-add` (ou `ignore-update` em re-add) em `.harn/qualy/docs/lint-decisions.md`. Toda escrita passa pelo CLI; este `.md` orquestra detecção → captura de glob → captura de `--rule` (opcional) → captura de motivo → captura de expiry → confirmação → aplicação.

## Visão Geral

1. **Pré-checks:** `detect-stack` → `git-clean-check` (oferece `git stash` se sujo) → `ignore-import-preview` (≥5 patterns dispara confirmação).
2. **Captura do glob:** se ausente no positional, `AskUserQuestion` pedindo a path expression.
3. **Captura do `--rule` (opcional, T3.3):** `AskUserQuestion` 4 opções fixas: `path-only (Recommended)` / `quality-metrics/<rule>` / `category:<name>` / `outra rule oxlint`. Em `category:*`, segunda pergunta consulta `category-info <name>` para listar N rules e confirmar (injeta `--i-know-this-disables-many`).
4. **Captura do reason (SPEC §4.1):** `AskUserQuestion` com 4 opções fixas — `legacy code` / `generated code` / `vendored code` / `Other`. Em `Other`, segunda pergunta pede texto livre. Reason é obrigatório.
5. **Captura do expires:** `AskUserQuestion` com 4 opções — `No expiry (Recommended)` / `90 days` / `180 days` / `Custom YYYY-MM-DD`. Datas no passado são rejeitadas pelo CLI.
6. **Aplicação:** `ignore-add <glob> [--rule <id> [--i-know-this-disables-many]] --reason "<txt>" [--expires <date>] --strict` por baixo, idempotente (mesmo `(glob, rule)` → `ignore-update`).

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash. Stack envelope: TS/TSX/JS/JSX.

## Quando usar

- Pasta legada (`src/legacy/**`) — defaults: `path-only` + `legacy code` + `No expiry`.
- Código gerado (`dist/**`) — defaults: `path-only` + `generated code` + `No expiry`.
- Vendored deps (`vendor/**`) — defaults: `path-only` + `vendored code` + `No expiry`.
- Per-rule em path específico (`src/generated/** + quality-metrics/wmc`) — silencia uma rule mantendo o resto enforced.
- Categoria inteira em path específico (`src/legacy/** + category:correctness`) — desliga 231 rules; pede confirmação explícita.
- Migração temporária Q3→Q4: `Other` reason + `Custom YYYY-MM-DD` força revisão futura via `/lint:ignore:list --expired`.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse imediatamente.
- Manifesto corrompido (`exit 70` `manifest_corrupt`): aborte e instrua reparo manual em `.harn/qualy/ignore.json`.
- Tree sujo e usuário recusou `git stash`: aborte sem aplicar (`--strict`).
- Para remover exclusões: use `/lint:ignore:remove`. Para listar: `/lint:ignore:list`. Para inspecionar: `/lint:ignore:explain`.
- Para mudar config global de rule (não path-específico): use `/lint:rules:add` / `/lint:rules:remove`.

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

1. **`detect-stack`** — exit `2` aborta com refusal claro.
2. **`git-clean-check`** — exit `3` (sujo): `AskUserQuestion` ofertando `git stash` (Recommended) / `Continuar mesmo assim` / `Cancelar`.
3. **`ignore-import-preview --cwd "$PWD"` (SPEC §8.2 + T3.4b):** lê presets e devolve `{ manifest_empty, count, would_import: [{glob, tier}] }`. Se `count >= 5` E `manifest_empty: true` → `AskUserQuestion` "encontrei N patterns no preset que serão importados como `createdBy: imported`. Confirma?" (3 opções: `Importar todos (Recommended)` / `Cancelar e revisar manualmente` / `Mostrar lista`). Se `count < 5`, segue silencioso (CLI importa em background na próxima mutação). Manifesto non-empty → skip.
4. **Captura do glob:** se positional/`--glob` ausente: `AskUserQuestion` "Qual path/glob excluir?" (uma pergunta por vez — não combine com rule/reason).
5. **Captura do `--rule` (T3.3):** `AskUserQuestion` "Escopo da exclusão?" 4 opções: `path-only (Recommended)` / `quality-metrics/<rule específica>` / `category:<name> (atenção — desliga muitas rules)` / `outra rule oxlint (opaque)`.
   - **path-only:** prossegue sem `--rule`.
   - **quality-metrics:** segunda pergunta com 5 opções (`wmc`, `halstead`, `lcom`, `cbo`, `dit`). CLI valida contra `KNOWN_QUALITY_METRICS_RULES` — typos viram exit `1` `unknown_rule`.
   - **`category:*` (SPEC §3.1.1):** segunda pergunta lista 7 categorias (`correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `style`, `nursery`); ao escolher, rode `category-info <name> --cwd "$PWD"` para puxar `count` e `rules[]`; terceira pergunta `AskUserQuestion` "isso vai desligar **N rules** em `<glob>`. Confirma?" 2 opções (`Confirmar (injeta --i-know-this-disables-many)` / `Cancelar`). CLI exit `1` `category_requires_ack` é defesa em profundidade — o slash injeta o flag automaticamente.
   - **opaque:** texto livre (terceiros como `eslint/no-debugger`); CLI aceita as-is, oxlint surfacing erro próprio se a rule não existir.
6. **Captura do reason (SPEC §4.1):** `AskUserQuestion` 4 opções: `legacy code` / `generated code` / `vendored code` / `Other`. Em `Other`, segunda pergunta pede texto livre. CLI rejeita reason vazio com exit `1` `reason_required`.
7. **Captura do expires:** `AskUserQuestion` 4 opções: `No expiry (Recommended)` / `90 days` / `180 days` / `Custom YYYY-MM-DD`. Em `90`/`180`, calcule a data localmente (today + N) e passe pronta. Em `Custom`, segunda pergunta pede `YYYY-MM-DD`.
8. **Blast radius (T4.3):** rode `ignore-blast-radius <glob> --cwd "$PWD"` antes de aplicar. Saída `{ files_in_glob, sample }` (até 10 paths; excludes `node_modules`/`.git`/`dist`/`.harn`/`.lint-audit`/`.lint-backup`). Mostre o número e o sample no preâmbulo da aplicação ("você está prestes a silenciar lint em **N arquivos**: ...") — read-only, ms-scale.
9. **Aplicação:** `ignore-add <glob> [--rule <id> [--i-know-this-disables-many]] --reason "<reason>" [--expires <date>] --strict --cwd "$PWD"`. Exit `0` aplicado, `1` recoverable (`invalid_glob`, `reason_required`, `expires_in_past`, `unknown_rule`, `unknown_category`, `category_requires_ack`, `decisions_failed`), `3` dirty tree (volte ao passo 2), `4` usage, `70` `manifest_corrupt`.
10. **Pós-condição:** mostre `id` do entry, `action` (`added` / `updated`), `imported.length` (patterns brownfield-importados nessa mutação), `files_changed` (manifesto + presets + decisions). NÃO commite — SPEC §6 Never. Sugira `/lint:audit` para re-medir e `/lint:ignore:list` para visualizar.

## Trade-offs

- **One-question-at-a-time (memória do user — ADHD):** glob → rule → reason → expires são até 4 (mais pode ter Other/Custom/category-confirm) `AskUserQuestion` separadas. Nunca combine. SPEC §4.
- **Idempotência byte-a-byte:** re-add do mesmo `(glob, rule)` registra como `ignore-update` no decisions log e atualiza `reason`/`expires` in-place. Não duplica entry. Útil para refinar metadata sem poluir.
- **`category:*` exige confirmação UX + CLI flag (SPEC §3.1.1):** o slash mostra contagem real via `category-info` e injeta `--i-know-this-disables-many` automaticamente. Trade-off: usuário sem slash que rode CLI direto precisa lembrar do flag — exit `1` `category_requires_ack` documenta tamanho da categoria no `reason` da resposta.
- **Brownfield import threshold ≥5 (decisão §8.2):** abaixo de 5 patterns, o import é silencioso (`createdBy: "imported"` aparece em `/lint:ignore:list`); acima, `AskUserQuestion` confirma. Trade-off: usuários atentos ao manifesto veem entries surpresa, mas `decision-log` registra `ignore-import` como audit-trail.
- **`category-info` usa catálogo estático (T3.1):** `KNOWN_CATEGORIES` é hardcoded contra oxlint 1.62.0 (752 rules). Drift quando oxlint adiciona rules — review trimestral via smoke test em `category-catalog.test.ts`. `category:bogus` (não em `KNOWN_CATEGORIES`) → exit `1` `unknown_category`.
- **Sem auto-commit (SPEC §6 Never):** cada `ignore-add` deixa staged. Os 3+ arquivos editados são deterministicamente reconstruíveis via `qualy ignore-compile`.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" ignore-add --help` retorna usage com `<glob>` REQUIRED + `--reason` REQUIRED + `--rule`/`--expires`/`--strict`/`--i-know-this-disables-many`/`--cwd` opcionais.
- E2E (SPEC §10 #1 — path-only): greenfield + `/lint:ignore:add 'src/legacy/**'` (Pergunta 2: `path-only`; reason: `legacy code`; expires: `No expiry`) → manifesto ganha entry, presets recebem markers, decisions ganha `ignore-add`. Re-run idêntico → `ignore-update`.
- E2E (SPEC §10 #2 — per-rule): `ignore-add 'src/x/**' --rule quality-metrics/wmc --reason "y"` → desabilita só essa rule no path; `quality-metrics/cbo` ainda dispara em `src/x/**`.
- E2E (SPEC §10 #6 — brownfield import): preset com `ignorePatterns: ["src/old/**"]` fora dos markers → primeira `ignore-add` importa (entry `createdBy: "imported"`, `reason: "Imported from oxlint preset on first qualy ignore mutation"`); decision log ganha `ignore-import` antes de `ignore-add`.
- E2E (SPEC §10 #10 + #11 — category): `ignore-add 'src/legacy/**' --rule category:correctness --reason "z"` SEM `--i-know-this-disables-many` → exit `1` `category_requires_ack` mencionando `silences 231 rules`. Slash injetando o flag → exit `0`. `ignore-list` mostra `⚠ category (231 rules)`.
- E2E (SPEC §10 #8): tree sujo + `--strict` → exit `3` com mensagem `git stash`.

## Referências

- `.harn/docs/lint-ignore/SPEC.md` §3.1 (`qualy ignore add`), §3.1.1 (category semantics), §4.1 (slash conventions), §6 (registrar reason).
- `.harn/docs/lint-ignore/PLAN.md` Phase 2 + Phase 3 + Tasks 2.7 / 3.3 / 3.4 / 3.4b / 3.5.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/rules/add.md` — comando par (rule-add); estrutura espelhada.
- `cli/src/lib/category-catalog.ts` — fonte de verdade de `KNOWN_CATEGORIES` + counts.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
