---
name: lint:rules:explain
description: Use when the user asks "what does rule X do", says "/lint:rules:explain <rule>", "explain quality-metrics/wmc", "qual o racional dessa rule", or wants the description, empirical rationale, current state in the project's preset, default for the detected stage, and links to docs for a single oxlint rule (`quality-metrics/*` or `category:*`). Read-only — never mutates. Recoverable error (exit `1`) when the rule is unknown to the static catalog.
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: <rule>
---

# /lint:rules:explain

Explicação read-only de uma rule oxlint específica (SPEC §2 + §7.9). Mostra descrição, racional empírico (literatura citada), estado atual no preset do projeto, default para o estágio detectado, e links para docs. **Read-only** — nunca escreve preset, manifest ou decisions.

## Visão Geral

1. **Pré-checks (read-only):** `detect-stack` → catálogo estático carregado pelo CLI (não depende de preset instalado).
2. **Execução:** `rules-explain <rule>` resolve a entry do catálogo, lê os presets do projeto (se presentes) para o bloco `current`, e devolve `{ rule, category, title, description, rationale, current, default_for_stage, links }`.
3. **Resumo ao usuário:** título, categoria, descrição, racional citado, estado atual + default por estágio (quando aplicável), links.
4. **Próximo passo:** se `current=null` e a rule está em `available[]` da baseline → ofereça `/lint:rules:add`. Se `current` carrega `severity` que difere do `default_for_stage` → ofereça `/lint:rules:add` com novo `--severity`/`--max` para realinhar.

O preâmbulo `QUALY_BIN=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Usuário pediu `/lint:rules:explain <rule>` ou perguntou o que uma rule faz / por que ela está no preset.
- Após `/lint:rules:list` para entender uma entry específica antes de decidir add/remove.
- Antes de `/lint:rules:add` ou `/lint:rules:remove` para confirmar racional empírico (SPEC §6 Always: "registrar motivo com base na literatura").
- Onboarding: usuário quer entender Halstead/WMC/LCOM/CBO/DIT antes de aceitar os defaults da baseline.

## Quando NÃO usar

- Stack bloqueada (`detect-stack` exit `2`): recuse e mostre stacks suportadas.
- Rule fora do catálogo (`unknown_rule` exit `1`): mostre lista de rules conhecidas (`quality-metrics/wmc|halstead-volume|halstead-effort|lcom|cbo|dit`, `category:correctness|suspicious`) e peça ao usuário re-confirmar o nome.
- Listar todas as rules ativas: use `/lint:rules:list` (este comando aceita uma rule por chamada).
- Aplicar mudanças: este comando é read-only. Use `/lint:rules:add` ou `/lint:rules:remove`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_BIN=""
# Dev override (uso interno do repo qualy): aponta para bin/qualy.mjs local.
[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"
# Lookup padrão: cópia materializada por `qualy install`.
if [ -z "$QUALY_BIN" ]; then
  for cand in "$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs" \
              "$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"; do
    [ -f "$cand" ] && QUALY_BIN="$cand" && break
  done
fi
[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \`npx @hgflima/qualy install\` first." >&2; exit 5; }
node "$QUALY_BIN" <subcommand> --cwd "$PWD" "$@"
```

1. **`detect-stack`** — exit `2` aborta com mensagem listando stacks suportadas; nada é escrito.
2. **Captura do nome da rule:**
   - Se o usuário passou um argumento (`/lint:rules:explain quality-metrics/wmc`): use diretamente.
   - Se ambíguo ou ausente: `AskUserQuestion` ofertando rules do catálogo conhecidas (até 4 opções; se mais de 4 fizerem sentido, mostre as 4 mais relevantes pelo contexto e marque a primeira como `(Recommended)`).
3. **`rules-explain <rule> --cwd "$PWD"`** — exit `0` retorna `{ ok, rule, category, title, description, rationale, current, current_source, default_for_stage, links[] }`. Exit `1` com `error: "unknown_rule"` significa que a rule não está no catálogo — mostre as rules conhecidas e peça correção.
4. **Sumário ao usuário** (formato fixo, Markdown):
   - **Título + categoria**: `payload.title` (`payload.category`).
   - **Descrição**: `payload.description` (1 parágrafo).
   - **Racional**: `payload.rationale` (cita literatura — Basili/Briand/Melo, Chidamber & Kemerer, Halstead, etc.).
   - **Estado atual**: se `payload.current` populated, mostre `severity`, `options.max` (quando presente), `tier`, `origin` (`preset:<stage>:<tier>`); se `null`, leia `current_source` para diagnosticar (`preset_missing` → roteie `/lint:setup`; `preset_malformed` → roteie `/lint:setup` ou edição manual; `rule_absent_from_presets` → mostre como ausente, link para `/lint:rules:add`).
   - **Default por estágio**: se `payload.default_for_stage` populated, mostre `stage`, `severity`, `max` (apenas para QM rules em deep com stage detectado).
   - **Links**: imprima `payload.links[]` como bullet list.
5. **Pós-condição (opcional):** baseado no estado:
   - `current=null` + `default_for_stage` populated → `AskUserQuestion`: `Adicionar com defaults da baseline (Recommended)` / `Adicionar com severity custom` / `Não, obrigado`. Apply → `/lint:rules:add <rule>` ou `/lint:rules:add <rule> --severity <s> --max <n>`.
   - `current` populated + difere de `default_for_stage` → ofereça realinhamento via `/lint:rules:add <rule>` (idempotente quando já igual, atualiza quando difere).
   - `current` populated + igual ao default → fechamento informativo, sem oferta.

## Mapeamento de exit codes

- `0` — sucesso; mostre sumário.
- `1` — `unknown_rule`. Mostre catálogo conhecido + peça correção. NUNCA é causado por preset ausente — `current=null` com `current_source: "preset_missing"|"preset_malformed"|"rule_absent_from_presets"` continua exit `0`.
- `2` — não esperado (stack já checada); reporte como bug.
- `3` — não aplicável (read-only).
- `4` — usage error: rule não passada via `--rule` nem positional, segundo positional, flag desconhecida.
- `5` — não aplicável (sem subprocess oxlint).
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **Catálogo estático no CLI**: as 6 rules `quality-metrics/*` + 2 categorias oxlint (`correctness`, `suspicious`) são fixas no source. SPEC §3 lockou esse conjunto; rules fora dele retornam `unknown_rule` mesmo se forem rules oxlint válidas. Trade-off: cobertura completa esperaria por evolução do catálogo (issue futura no roadmap), mas o set canônico é o que carrega rationale empírico citável.
- **`current=null` ≠ erro**: o CLI nunca falha por preset ausente em `rules-explain`. Permite o usuário aprender sobre uma rule antes de rodar `/lint:setup` (caminho de descoberta).
- **`default_for_stage` só populado para QM rules em deep com stage detectado**: categorias caem fora porque a baseline não as parametriza por estágio. Drift desse contrato quebraria a oferta de "realinhamento" pós-explain.
- **Pergunta opcional, não obrigatória**: SPEC §6 lista `/lint:rules:explain` como read-only. O caminho default é só imprimir; a `AskUserQuestion` de pós-condição só dispara quando faz sentido (gap entre current e default).

## Verificação

- Smoke: `node "$QUALY_BIN" rules-explain quality-metrics/wmc --cwd "$PWD"` retorna exit `0` com `title`, `description`, `rationale` (cita Chidamber & Kemerer / Basili-Briand-Melo), `links[]` populated. Em repo sem preset, `current=null` + `current_source="preset_missing"`.
- Smoke negativo: `rules-explain made-up/no-rule` retorna exit `1` com `error: "unknown_rule"`.
- E2E (SPEC §7.9): após `/lint:setup` greenfield, `/lint:rules:explain quality-metrics/wmc` mostra `current.severity="error"`, `current.options.max=15` (baseline greenfield deep) e `default_for_stage={stage:"greenfield",severity:"error",max:15}` (current alinhado ao default).
- E2E (SPEC §7.9): após `/lint:setup` brownfield-moderate, `/lint:rules:explain quality-metrics/cbo` mostra `current.severity="warn"`, `current.options.max=14`.

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:rules:explain`), §3 (baseline + racional empírico), §7.9 (acceptance).
- `.harn/docs/mvp/PLAN.md` §Fase 5 + §Resolução do CLI.
- `skills/lint/SKILL.md` — preâmbulo `QUALY_BIN` e mapeamento de exit codes.
- `commands/lint/rules/{list,add,remove}.md` — comandos pares.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
