# Tasks — Fixes do `/lint:audit` (cadeia `quality-metrics`)

> Origem: investigação em 2026-05-04. `/lint:audit --tier deep` reporta `errors=0, warnings=0` e `tooling.quality_metrics=null` num repo de 161 arquivos / 62k LOC. Causa: oxlint nunca lê código — o preset deep é rejeitado pelo schema do oxlint 1.62.0, e mesmo se fosse aceito, o plugin não carregaria nem as rules existiriam.
>
> **Regra:** cada Task ≤ 30 min de trabalho focado. Se um passo virar maior, quebrar antes de começar.
>
> **Verificação universal (use depois de QUALQUER task abaixo):**
> ```bash
> PATH="./node_modules/.bin:$PATH" oxlint --config oxlint.deep.json --format json . | head -20
> ```
> Espera-se que o parse passe (sem `Failed to parse oxlint configuration file`) e oxlint retorne JSON estruturado (mesmo que vazio). Esse é o critério de "ainda funciona" entre tasks.

---

## Phase 1 — Fix do preset `oxlint.deep.json` (gerado pelo qualy)

Os 4 bugs do preset estão **encadeados**: cada um esconde o próximo. As tasks devem ser aplicadas em ordem.

### Task F1.1 — Remover `_comment` do gerador de presets (XS)

**Goal:** O `_comment` no topo do JSON é rejeitado pelo schema do oxlint 1.62.0 (`unknown field _comment, expected one of $schema, plugins, jsPlugins, ...`). Eliminar do código que gera os presets.

**Onde:** `skills/lint/cli/src/commands/install/oxlint.ts` (ou onde quer que o preset seja escrito; grep por `"_comment"` e por `stage=` no source).

**Steps:**
- [ ] Grep `rg '_comment' skills/lint/cli/src/` para localizar o gerador.
- [ ] Remover a propriedade `_comment` do objeto que vira `oxlint.fast.json` e `oxlint.deep.json`.
- [ ] Mover o conteúdo do comment (`stage=<name>`, `tier=<deep|fast>`, `generated=<date>`) para um arquivo lateral, ex.: `.qualy/preset-meta.json`, OU embutir como comentário em `.lint-manifest.json` (que já é qualy-only). NÃO usar comment em `oxlint.*.json`.
- [ ] Atualizar `rules-list.ts` que lê `_comment` para extrair `stage` — ler de `.qualy/preset-meta.json` ou de `.lint-manifest.json`. Caso ausente: `stage=null`.
- [ ] Atualizar todos os fixtures de teste em `cli/tests/**/oxlint.{fast,deep}.json` que carregam `_comment`.

**Done when:**
- [ ] `rg '"_comment"' skills/lint/` volta vazio fora de docs/CHANGELOG.
- [ ] `oxlint --config oxlint.deep.json --format json .` num projeto recém-setupado **não** falha com `unknown field _comment`.
- [ ] `qualy rules-list` continua reportando `stage` correto (lendo do novo local).
- [ ] `npm test` verde.

---

### Task F1.2 — Mover plugin para `jsPlugins` no gerador (XS)

**Goal:** `quality-metrics` é plugin JS externo. Hoje o qualy escreve `"plugins": ["quality-metrics"]`, e oxlint responde `Unknown plugin: 'quality-metrics'` — o array `plugins` é só para built-ins (react, typescript, import, ...).

**Onde:** mesmo arquivo da Task F1.1.

**Steps:**
- [ ] No gerador de `oxlint.deep.json`, substituir `plugins: ["quality-metrics"]` por `jsPlugins: ["quality-metrics"]` (ou pela forma resolvida — ver Task F1.3).
- [ ] Manter `plugins` array vazio/omitido (built-ins ficam no default do oxlint).
- [ ] Atualizar fixtures e snapshots.
- [ ] Conferir que `rules-list.ts` ainda detecta as rules `quality-metrics/*` corretamente (a deteção pode estar lendo `plugins[]`).

**Done when:**
- [ ] Após F1.1+F1.2, `oxlint --config oxlint.deep.json --format json .` avança do parse e tenta carregar o plugin (próxima falha esperada: F1.3).
- [ ] `npm test` verde.

---

### Task F1.3 — Resolver caminho do plugin `quality-metrics` (S)

**Goal:** Mesmo com `jsPlugins: ["quality-metrics"]`, oxlint 1.62.0 falha com `Cannot find module 'quality-metrics'`. O loader não acha o módulo a partir do cwd usando bare specifier. **Funciona** com path absoluto: `jsPlugins: ["/abs/path/node_modules/quality-metrics/dist/index.js"]`.

**Decisão a tomar:** path absoluto é frágil (quebra ao mover/clonar repo). Três opções, escolher uma na revisão da task:

- **(A) Path relativo ao cwd no preset:** `"./node_modules/quality-metrics/dist/index.js"`. Funciona se o usuário rodar `oxlint` a partir da raiz do repo. Quebra se rodar de subpasta.
- **(B) Forma `{ name, specifier }` apontando para path resolvido em runtime:** o gerador faz `require.resolve("quality-metrics")` no momento do `install` e escreve o path resolvido. Quebra ao mudar de máquina.
- **(C) Wrapper script:** o qualy escreve um shim `oxlint.deep.config.js` que importa o plugin via Node resolution e devolve a config — em vez de JSON estático. Mais robusto mas vira config TS/JS (oxlint marca como experimental).

**Steps:**
- [ ] Validar empiricamente cada opção num fixture (criar `cli/tests/e2e/install/oxlint-jsplugin-resolution.test.ts`).
- [ ] Escolher e documentar em `docs/adrs/0011-oxlint-jsplugin-resolution.md`.
- [ ] Atualizar gerador para emitir a forma escolhida.
- [ ] Atualizar README/SPEC se a forma de invocação mudar.

**Done when:**
- [ ] Após F1.1+F1.2+F1.3, `oxlint --config oxlint.deep.json --format json .` carrega o plugin (próxima falha esperada: F1.4 — rule names).
- [ ] ADR 0011 mergeado.
- [ ] `npm test` verde, incluindo o e2e novo.

---

### Task F1.4 — Corrigir rule names: `halstead` é **uma** rule (S)

**Goal:** O qualy escreve `quality-metrics/halstead-volume` e `quality-metrics/halstead-effort`, mas o plugin `quality-metrics@0.1.1` exporta apenas 5 rules: `wmc, halstead, lcom, cbo, dit`. `halstead` é **uma** rule com options `{ maxVolume, maxEffort }`.

**Steps:**
- [ ] No gerador de presets, substituir as duas linhas:
  ```json
  "quality-metrics/halstead-volume": ["warn", { "max": 1000 }],
  "quality-metrics/halstead-effort": ["warn", { "max": 400 }],
  ```
  por uma única:
  ```json
  "quality-metrics/halstead": ["warn", { "maxVolume": 1000, "maxEffort": 400 }]
  ```
- [ ] Atualizar a baseline `quality-metrics` nos 4 estágios (`greenfield`, `brownfield-strict`, `brownfield-moderate`, `brownfield-loose`) — a estrutura `by_metric` do audit deve mapear `halstead` (key única) em vez de `halstead-volume`/`halstead-effort`.
- [ ] Atualizar `audit.ts` (`METRIC_RULE_TO_KEY`):
  ```ts
  // antes:
  "halstead-volume": "halstead",
  "halstead-effort": "halstead",
  // depois:
  "halstead": "halstead",
  ```
- [ ] Atualizar `rules-list.ts`, `rules-explain.ts`, `recs/generate.ts`, `recs/blast-radius.ts` que listam o conjunto canônico de rules (`wmc, halstead-volume, halstead-effort, lcom, cbo, dit` → `wmc, halstead, lcom, cbo, dit`).
- [ ] Atualizar `audit-schema.ts` se `by_metric.halstead` mantiver a mesma chave (não precisa mudar) — verificar.
- [ ] Atualizar fixtures e snapshots.

**Done when:**
- [ ] `oxlint --config oxlint.deep.json --format json .` roda end-to-end e reporta diagnostics reais (esperado: violações em arquivos com WMC>20, etc).
- [ ] `qualy audit --tier deep` retorna `summary.errors > 0` ou explicitamente "0 violações reais" — não silêncio.
- [ ] `qualy rules-list` mostra 5 rules `quality-metrics/*`, não 6.
- [ ] `npm test` verde.

---

### Checkpoint F1 — `/lint:audit --tier deep` funciona end-to-end

- [ ] Audit num fixture com violação proposital (ex.: classe com 25 métodos) reporta a violação no `by_metric.wmc.top[]`.
- [ ] Audit no qualy real (`/Users/henriquelima/dev/personal/qualy`) deixa de reportar `errors=0` artificialmente — qualquer número que apareça é real.
- [ ] Coverage ≥ 90% nos 4 módulos do gerador de presets.

---

## Phase 2 — Fix do detector de tooling (nome scoped fantasma)

### Task F2.1 — Trocar `@oxc-project/quality-metrics` por `quality-metrics` no detector (XS)

**Goal:** `audit.ts:85` e `status.ts:76` definem `TRACKED_PACKAGES.quality_metrics = "@oxc-project/quality-metrics"`. Esse pacote scoped não existe no npm. O pacote real instalado por `install-deps` é `quality-metrics` (unscoped). Por isso `tooling.quality_metrics` sempre vem `null`.

**Onde:**
- `skills/lint/cli/src/commands/audit.ts:85`
- `skills/lint/cli/src/commands/status.ts:76`
- `skills/lint/cli/src/commands/recs/generate.ts:251` (mensagem de rec menciona o nome scoped errado)
- Qualquer outro grep por `@oxc-project/quality-metrics` no source.

**Steps:**
- [ ] `rg '@oxc-project/quality-metrics' skills/lint/cli/src/` — listar todas as ocorrências.
- [ ] Substituir todas por `quality-metrics` (unscoped).
- [ ] Verificar se há fixtures/testes que mockam o nome errado e corrigir.
- [ ] Atualizar mensagens de erro que citam o nome do pacote ao usuário.

**Done when:**
- [ ] `rg '@oxc-project/quality-metrics' skills/lint/` volta vazio fora de CHANGELOG/ADR histórico.
- [ ] `qualy status` num projeto com `quality-metrics` instalado mostra `versions.quality_metrics: "0.1.1"`, não `null`.
- [ ] `qualy audit` populates `tooling.quality_metrics` corretamente.
- [ ] `npm test` verde.

---

### Checkpoint F2 — Detector consistente com o instalador

- [ ] `qualy install-deps` instala `quality-metrics` (já correto).
- [ ] `qualy status`, `qualy audit`, `qualy recs-generate` todos usam o mesmo nome.
- [ ] Sem inconsistência interna.

---

## Phase 3 — Hardening (defesa contra retorno do problema)

### Task F3.1 — Audit deve falhar (não silenciar) quando oxlint não produz output (S)

**Goal:** Hoje `audit.ts` aceita `oxlint exit 0 + stdout vazio` como "0 violações". Isso mascarou os 4 bugs do preset por dias. O CLI precisa distinguir "lint completou com 0 violações" de "lint falhou no parse mas retornou 0".

**Steps:**
- [ ] Em `audit.ts`, depois de chamar oxlint, verificar `stderr` por strings tipo `Failed to parse oxlint configuration file`, `Unknown plugin`, `Cannot find module`, `Rule '...' not found`. Se presentes, retornar `recoverable_error` com `error: "preset_invalid"` e `reason: <stderr trimmed>`.
- [ ] Se `stdout` vazio E `summary` zerado E o repo tem ≥ N source files (heurística simples), warn no log: `"audit reported 0 violations on N files — verify preset"`.
- [ ] Acrescentar test: rodar audit com preset deliberadamente quebrado; deve retornar exit `1` com `error: "preset_invalid"`, não `ok:true`.

**Done when:**
- [ ] Audit num preset com `_comment` (ou qualquer outro problema do tipo do bug atual) **falha explicitamente** em vez de retornar zero violações.
- [ ] Mensagem do erro orienta o usuário a reinstalar (`/lint:setup`).
- [ ] `npm test` verde.

---

### Task F3.2 — E2E que valida o ciclo completo de install→audit (M)

**Goal:** Garantir via teste que `/lint:setup` + `/lint:audit` num fixture limpo de fato detecta uma violação plantada (ex.: classe com 25 métodos para gatilhar `wmc`).

**Steps:**
- [ ] Criar `cli/tests/e2e/install/audit-detects-real-violation.test.ts`.
- [ ] Setup: tmp dir, `package.json` mínimo, arquivo `src/big-class.ts` com classe de 25 métodos triviais (`m1() {} m2() {}` ...).
- [ ] Rodar `qualy install-deps` + `qualy install-oxlint` (ou as primitivas que `/lint:setup` chama).
- [ ] Rodar `qualy audit --tier deep`.
- [ ] Asserção: `payload.violations.summary.errors >= 1` E `payload.violations.by_metric.wmc.top[0].file` aponta para `src/big-class.ts`.
- [ ] Asserção: `payload.tooling.quality_metrics === "0.1.1"` (não null).

**Done when:**
- [ ] O teste passa após F1.1–F1.4 + F2.1.
- [ ] O teste **falha** se algum dos 5 bugs voltar (smoke test contra regressão).

---

### Checkpoint F3 — Sistema com defesa em profundidade

- [ ] Audit não pode mais retornar `errors=0` silenciosamente quando oxlint falhou no parse.
- [ ] E2E real provando que install + audit detecta violações reais.
- [ ] `quality_metrics: null` no audit só aparece se o pacote de fato não está em `node_modules/`.

---

## Resumo executivo

| Phase | Foco | Tasks | Tamanho total |
|-------|------|-------|---------------|
| F1 | Preset `oxlint.deep.json` | F1.1–F1.4 | ~2h |
| F2 | Detector tooling | F2.1 | ~30min |
| F3 | Hardening + e2e | F3.1, F3.2 | ~1.5h |

**Caminho mínimo para destravar `/lint:audit` agora (sem fix de produto):** rodar Phase 1 inteira. F2 é cosmético mas barato. F3 é seguro contra regressão futura.

**Referências:**
- Investigação original: conversa de 2026-05-04 com Henrique.
- Plugin docs: `node_modules/quality-metrics/README.md`.
- Schema oxlint: `node_modules/oxlint/configuration_schema.json`.
- Código afetado: `skills/lint/cli/src/commands/{audit,status,install/oxlint,install/deps,rules-list,recs/generate,recs/blast-radius}.ts`.
