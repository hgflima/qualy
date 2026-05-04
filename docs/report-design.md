# Report visual — princípios de design e como adicionar tema

Reference contract para `cli/src/report/` e `cli/src/report/themes/` (SPEC §4 — "Report visual" + §6 Always/Never sobre o servidor e o export). É o documento canônico para responder "por que o report é vanilla DOM em vez de framework, como o tema funciona, e o que um contribuidor precisa fazer para versionar um tema novo".

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §4 (linhas 318–326 Report visual; 421–422 Never; 391/406 prefers-reduced-motion + preview), `cli/src/report/server.ts` (servidor efêmero), `cli/src/report/export.ts` (HTML self-contained), `cli/src/report/app.ts` (bootstrap browser), `cli/src/report/components/` (MetricCard, ChartLine, ChartTreemap, ViolationsTable), `cli/src/report/themes/linear-design-md/` (tema default), `cli/tests/unit/themes-linear-design-md.test.ts` (lock dos tokens), `docs/coverage.md` §7 (degradação graciosa quando `coverage-summary.json` ausente), `docs/audit-format.md` (shape consumido pelo report), ADR 0005 (servidor efêmero + export — pendente)

## 1. Propósito

O report responde uma pergunta única: **"a qualidade do código está melhorando ou piorando, e onde?"**. Tudo o mais é instrumental.

O design carrega quatro invariantes:

1. **Vanilla DOM, sem framework.** Stack: TypeScript puro + `chart.js` + `chartjs-chart-treemap`. Sem React/Vue/Svelte. Render é fábrica de elementos DOM (`createMetricCard(doc, data)`); re-render = descarta + cria de novo. Tradeoff aceito: payload menor, sem hidratação parcial, testes sem jsdom (estruturalmente compatíveis com `Document`/`HTMLElement`).
2. **Offline-safe por contrato.** O export é byte-equivalente ao servidor live: mesma fonte de dados (`<script id="report-data" type="application/json">`), mesmo bundle (`bundleApp` é compartilhado entre `server.ts` e `export.ts`), mesmas folhas de estilo (light primeiro, dark depois — precedência idêntica). Quem abre `quality-report/<timestamp>.html` em `file://` vê o mesmo report.
3. **Theming via CSS custom properties + `[data-theme]`.** Toggle é flip de atributo no `<html>`, persistido em `localStorage`. Sem CSS-in-JS, sem injeção de stylesheet em runtime. Adicionar tema = adicionar pasta + 3 arquivos (§9).
4. **Acessibilidade obrigatória.** `prefers-reduced-motion` é respeitado (motion durations colapsam para `0ms`); contraste AA mínimo nos dois modos; charts têm `aria-label`; navegação por teclado funciona (skip-link, foco visível, `aria-pressed` no toggle, `aria-live` para status).

**Anti-invariante.** O report **não** é configurável em runtime via flag CLI. Layout, ordem de seções, ordem de cards, eixos dos charts são fixos — drift quebra a comparabilidade entre snapshots versionados em `quality-report/`. Customização vive em **tema** (CSS), não em **estrutura** (DOM).

## 2. Mapa estrutural

```
cli/src/report/
├── server.ts        # createServer + listen; bundle lazy de app.ts; whitelist de rotas
├── export.ts        # HTML self-contained; redação de paths absolutos / env / tokens
├── app.ts           # bootstrap browser: tema + mount loop + theme toggle
├── data-loader.ts   # única fonte do payload ReportData (v=1)
├── index.html       # shell estático com data-mount slots e anti-flash inline
├── components/
│   ├── MetricCard.ts        # cartão atômico (errors, warnings, coverage, stage)
│   ├── ChartLine.ts         # tendência por timestamp (chart.js line)
│   ├── ChartTreemap.ts      # violações por arquivo/métrica (chartjs-chart-treemap)
│   └── ViolationsTable.ts   # top-N violações com link para arquivo
└── themes/
    └── linear-design-md/
        ├── tokens.json   # fonte semântica do tema (paleta + tipografia + espaço)
        ├── light.css     # foundation (font/space/radius/motion) + paleta light
        └── dark.css      # paleta dark (somente cores; foundation herda de light.css)
```

`server.ts` é importado por `commands/report/serve.ts`; `export.ts` por `commands/report/export.ts` (escrita em `quality-report/<timestamp>.html`). Ambos consomem `data-loader.ts:loadReportData()` e produzem o mesmo `ReportData` blob — consistência por construção.

Os componentes seguem **factory pattern puro**: `createMetricCard(doc, data) → MetricCardEl`. Sem classe, sem state interno, sem ciclo de vida. `app.ts:mountAll()` itera os slots `[data-mount="<key>"]` declarados em `index.html` e chama `replaceChildren()` antes de inserir — mount é destrutivo e idempotente.

## 3. Payload `ReportData` (v1)

Shape canônico (definido em `data-loader.ts`):

```ts
interface ReportData {
  version: "1";                             // literal — guard de leitor
  generated_at: string;                     // ISO-8601 UTC
  cwd: string;                              // <redacted> no export
  audit_path: string;                       // .lint-audit/<ts>.json
  audit: AuditPayload;                      // schema completo (v1) de docs/audit-format.md
  history: readonly ReportHistoryEntry[];   // ascendente por timestamp; powers ChartLine
  coverage: ReportCoverage | null;          // null quando ausente — sem phantom card
  git: { first_commit_date: string | null; churn_90d: number };
}
```

**Decisões de design**:

- `history` é **resumo**, não payload completo. Cada entry carrega `{timestamp, stage, errors, warnings, files_affected, by_metric: {...}}` — sem `top[]`, sem `rules_active`. Em `legacy-monorepo` com 200 audits, o blob inline ficaria megabytes; o resumo mantém kilobytes. O latest audit carrega o payload completo separadamente.
- `coverage: null` é aceito. Quando o runner não rodou ou `coverage/coverage-summary.json` está ausente/malformado, o card "Coverage (lines)" é omitido (`app.ts:buildMetricCards` checa `data.coverage !== null && data.coverage.lines !== null`). Mostrar `—%` faz o report parecer quebrado; omitir é honesto.
- `version: "1"` é literal, não derivado. Leitores devem verificar `data.version === "1"` antes de hidratar — se v2 quebra shape, a página antiga falha rápido em vez de renderizar lixo.

Cross-ref: `docs/audit-format.md` documenta `audit` em detalhe; `docs/coverage.md` §7 documenta o caminho de `coverage/coverage-summary.json` até `coverage`.

## 4. Hidratação e bootstrap

Ambos servidor e export injetam o mesmo `<script id="report-data" type="application/json">…</script>` antes de `</head>` no shell:

```
index.html (estático)
   │
   ├── <script> anti-flash inline (lê localStorage + matchMedia, set <html data-theme>)
   ├── <link rel="stylesheet" href="./themes/linear-design-md/light.css">
   ├── <link rel="stylesheet" href="./themes/linear-design-md/dark.css">
   │
   ├── (injetado por inlineReportData)
   │   <script id="report-data" type="application/json">{"version":"1",…}</script>
   │
   ├── (injetado por injectVendorScripts no servidor; inline no export)
   │   <script src="./vendor/chart.umd.js">                # ou <script>…</script>
   │   <script src="./vendor/chartjs-chart-treemap.umd.js">
   │
   └── <script type="module" src="./app.js">              # ou <script>…</script>
```

Ordem garantida:

1. **Anti-flash bootstrap inline** (síncrono, `<head>`). Lê `localStorage.qualy.theme` + `matchMedia("(prefers-color-scheme: dark)")` e define `<html data-theme>` antes do CSS aplicar. Sem isso, light → dark pisca por uma frame.
2. **Stylesheets** (light antes de dark). `light.css` declara foundation tokens em `:root`; `dark.css` só sobrescreve a paleta. A ordem importa para a regra de cascata: `:root[data-theme="dark"]` em `dark.css` precisa entrar **depois** de `:root[data-theme="light"]` em `light.css` para vencer especificidade igual.
3. **Vendor scripts UMD** (`chart.js` + `chartjs-chart-treemap`). Anexam `globalThis.Chart` e registram o controller treemap (`Chart.register(...)`). Têm que rodar antes de `app.js` consumir.
4. **`app.js`** (bundle esbuild de `app.ts`). Auto-boota via IIFE quando `globalThis.document` existe. Lê `<script id="report-data">`, aplica tema, monta componentes, conecta toggle.

**Por que o data script vai antes de `</head>` e não no `<body>`.** O bootstrap antiflash já precisa estar em `<head>`; manter o data script perto evita reordenação acidental quando alguém edita o shell. Ler do `<script>` ao invés de `fetch()` mantém o export offline-safe (uma única origem de verdade no DOM).

## 5. Theming

### 5.1 Modelo

Tokens vivem em `themes/<name>/tokens.json` (semântica) e são materializados em `themes/<name>/light.css` + `dark.css` (CSS custom properties). Componentes consomem **apenas** `var(--*)` — nunca cor literal, nunca pixel literal fora da foundation.

Exemplo (em `MetricCard`):

```css
.metric-card { background: var(--color-bg-surface-elevated); border: 1px solid var(--color-border-default); }
.metric-card[data-status="error"] { color: var(--color-status-error); }
```

Isso garante que adicionar um tema novo é **só** trocar o conjunto de variáveis — nenhuma linha de TS muda.

### 5.2 Convenção de naming

Categoria | Prefixo | Exemplos
---|---|---
Backgrounds | `--color-bg-*` | `bg-canvas`, `bg-surface`, `bg-surface-elevated`
Foreground | `--color-fg-*` | `fg-primary`, `fg-secondary`, `fg-muted`
Bordas | `--color-border-*` | `border-default`, `border-muted`
Acento (links, foco) | `--color-accent` / `--color-accent-fg` / `--color-accent-muted` | —
Status | `--color-status-*` | `status-error`, `status-warn`, `status-ok`, `status-info`
Foco visível | `--color-focus-ring` | —
Charts | `--color-chart-N` | 1..8 mínimo (lock em `themes-linear-design-md.test.ts`)
Tipografia | `--font-family-*`, `--font-size-*`, `--font-weight-*`, `--line-height-*` | foundation em `:root`
Espaço | `--space-N` | `0,1,2,3,4,5,6,8,10,12,16` (escala discreta)
Raio | `--radius-*` | `sm,md,lg,xl,full`
Motion | `--motion-duration-*`, `--motion-easing-*` | colapsam em `prefers-reduced-motion`
Sombra | `--shadow-*` | `sm,md,lg` por modo

**Por que essa lista é estável.** Mudar nomes força refactor cross-file (CSS + componentes). A lista é o contrato; tokens novos podem ser adicionados, mas remoções/renames só em ADR (cross-ref ADR 0005 — pendente).

### 5.3 Toggle e persistência

`app.ts` expõe três funções puras: `resolveInitialTheme(stored, prefersDark)`, `nextTheme(current)`, `applyTheme(doc, theme)`. O toggle (`<button id="theme-toggle">`):

- Flipa `<html data-theme>` (`light` ↔ `dark`).
- Atualiza `aria-pressed` (`true` quando `dark`).
- Persiste em `localStorage["qualy.theme"]` (silencia quotas/sandbox via try/catch).

Anti-flash inline é um espelho exato dessa lógica — drift entre os dois caminhos causa flash visível na primeira frame, então `app.ts:resolveInitialTheme` e o IIFE no `index.html` são alterados juntos ou nenhum.

### 5.4 Reduced motion

Tokens de duration colapsam em `@media (prefers-reduced-motion: reduce)`:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-duration-fast: 0ms;
    --motion-duration-base: 0ms;
    --motion-duration-slow: 0ms;
  }
}
```

Componentes não checam a media query em runtime — usam `var(--motion-duration-base)` e ganham `0ms` automático. Charts já são configurados sem animação (`ChartLine`/`ChartTreemap` passam `animation: false`); o toggle não tem transition. SPEC §6 Always linha 391 está cumprida sem código adicional.

## 6. Componentes

| Componente | Slot `data-mount` | Entrada | Saída | Empty state |
|---|---|---|---|---|
| `MetricCard` | `metric-cards` | array de `MetricCardData` | `<article>` por card | omite card de Coverage quando `data.coverage === null` |
| `ChartLine` | `chart-line` | `data.history` | `<div><canvas></div>` + `ChartLineConfig` | placeholder estático "no history yet" quando `history.length < 2` |
| `ChartTreemap` | `chart-treemap` | `data.audit.violations.by_metric` | `<div><canvas></div>` + `ChartTreemapConfig` | placeholder quando todas as métricas têm `top: []` |
| `ViolationsTable` | `violations-table` | `data.audit.violations.by_metric` | `<table>` com top-5 por métrica | `<tbody>` com mensagem "no violations" |

**Ordem dos cards** (lock em `app.ts:buildMetricCards`):

1. `Errors` — sempre.
2. `Warnings` — sempre.
3. `Files affected` — sempre.
4. `Stage` — sempre (rótulo humano via `STAGE_LABELS`).
5. `Coverage (lines)` — opcional. Status calculado por threshold (`coverageStatus`): `≥threshold → ok`, `≥threshold*0.9 → warn`, senão `error`. Sem threshold → `neutral`.

**Por que ordem fixa.** Snapshots em `quality-report/` viram diff visual ao longo do tempo; reordenar cards quebra comparabilidade. Adicionar card novo = nova posição (sempre no fim) + atualizar lock no test.

**Charts vazios não montam `chart.js`.** `mountAll()` checa `r.isEmpty` antes de chamar `mountChart`. Renderizar canvas vazio mostra eixos sem dados — mais ruidoso que o placeholder.

## 7. Acessibilidade

| Requisito | Implementação |
|---|---|
| Skip link | `<a class="skip-link" href="#main">` em `index.html` |
| Landmark roles | `<header role="banner">`, `<main role="main">`, `<footer role="contentinfo">` |
| Live region | `<div id="status" role="status" aria-live="polite">` |
| Toggle state | `<button aria-pressed="true|false">` sincronizado em `applyTheme` |
| Charts | `<div role="img" aria-label="…">` envolvendo o canvas |
| Headings | `<h2>` por seção com `aria-labelledby` |
| Contraste | AA mínimo nas duas paletas (lock visual + revisão manual) |
| Reduced motion | tokens colapsam em `0ms` (§5.4) |
| Foco visível | `--color-focus-ring` aplicado via `:focus-visible` em todos os interativos |
| Keyboard | toggle, links, table cells navegáveis sem mouse |

A11y **não é negociável** — adicionar componente sem `aria-*` falha review. Sem teste automatizado de a11y no MVP (axe-core fora de escopo), mas o lock está nas refs do shell `index.html` e no test `themes-linear-design-md.test.ts` (paletas têm tokens canônicos para status/focus).

## 8. Servidor vs export — diferenças cirúrgicas

| Aspecto | `server.ts` (live) | `export.ts` (snapshot) |
|---|---|---|
| Bind | `127.0.0.1` (constant, nunca configurável — SPEC §6 Never linha 421) | n/a (FS write) |
| Saída | servidor HTTP efêmero | `quality-report/<timestamp>.html` |
| Bundle `app.js` | servido via `/app.js` (lazy, cached) | inline `<script>…</script>` |
| Vendor `chart.js` | `<script src="./vendor/chart.umd.js">` (servido) | inline `<script>…</script>` |
| CSS | `<link rel="stylesheet" href="./themes/.../light.css">` (servido) | `<style>` inline com conteúdo do CSS |
| Dados | `<script id="report-data">` injetado em runtime no shell | mesmo, escrito ao disco |
| `cwd` | mantido (rodando localmente) | redacted como `<redacted>` |
| Paths absolutos em strings | mantidos | substituídos por `<redacted-path>` |
| `process.env.NAME` em strings | mantido | substituído por `<redacted-env>` |
| Tokens (`sk-…`, `ghp_…`, `xoxb-…`) | mantidos | substituídos por `<redacted-token>` |
| Headers | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` | n/a |
| Métodos aceitos | `GET`, `HEAD`; outros → 405 | n/a |
| Path traversal | rota whitelisted; `..` rejeitado em `routeFor` | n/a |

**Decisões críticas**:

- **`SERVER_HOST = "127.0.0.1"` é constante**, não opção. SPEC §6 Never linha 421 é absoluto — sem `--host`, sem `0.0.0.0`. Lockfile em `report-server.test.ts`.
- **`bundleApp()` é compartilhado** entre os dois (`export.ts` importa de `server.ts`). Drift entre live e export é estruturalmente impossível.
- **Redação só no export.** Live page roda no localhost do dev — vê paths reais sem custo. Export é versionável em git → pode vazar. A redação default (`redact: true`) é a postura segura; testes desligam (`redact: false`) para verificar shape sem ruído.

Cross-ref: ADR 0005 (pendente) racionaliza a separação ephemeral server + export; este doc descreve **o quê** os dois fazem, o ADR documenta **por quê** essa é a forma.

## 9. Como adicionar um tema novo

Workflow padrão para contribuidor (PR a `themes/<new-theme>/`):

1. **Cria a pasta** `cli/src/report/themes/<new-theme>/`.
2. **Cria `tokens.json`** seguindo o schema do `linear-design-md/tokens.json`:
   - `name`: igual ao nome da pasta.
   - `description`: 1 linha em prosa.
   - `source`: URL ou referência da inspiração (audit trail).
   - `modes: ["light", "dark"]` — ambos obrigatórios; tema mono-modo não é suportado em v1.
   - `color.light` e `color.dark`: **mesmas chaves** dos dois lados (lock em `themes-linear-design-md.test.ts:74-78`).
   - `chart.light` e `chart.dark`: arrays do **mesmo comprimento**, mínimo 8 (lock em `:80-83`).
   - `font.size`, `space`, `radius`, `motion`: foundation; pode reusar valores do default.
   - `shadow.light` e `shadow.dark`: mesmas chaves.
3. **Cria `light.css`**:
   - Declara foundation completa em `:root` (font/space/radius/motion/line-height).
   - Declara paleta light em `:root, :root[data-theme="light"]` com **todas** as variáveis listadas em §5.2.
   - Inclui `@media (prefers-reduced-motion: reduce)` colapsando duration tokens.
4. **Cria `dark.css`**:
   - Declara paleta dark em `:root[data-theme="dark"]` (mesmas variáveis, valores adaptados).
   - **Não** redeclara foundation (font/space/radius/motion) — herda de `light.css`.
   - Inclui `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` para auto-aplicar quando o usuário não escolheu nada.
5. **Estende o teste** (`themes-<new-theme>.test.ts`) — copy-paste de `themes-linear-design-md.test.ts` com `THEME_DIR` apontando para a nova pasta.
6. **Whitelist no servidor**. `server.ts:ROUTES` carrega rotas `cssLight: "/themes/linear-design-md/light.css"` literais. Adicionar tema = adicionar rotas + atualizar `MIME_TYPES` + estender `mimeFor`. Switching de tema **default** ainda exige editar `INDEX_HTML_PATH` (o `<link rel="stylesheet">` aponta para o tema default literalmente).
7. **Documenta no `tokens.json#description`** o que diferencia esse tema. PR descreve o uso (claro/escuro, alto contraste, monocromático, etc.).

**O que esse processo intencionalmente NÃO faz**:

- Não permite trocar tema via flag CLI em runtime. SPEC §4 linha 322: "Default theme: `linear-design-md/`". Mudar default = editar `index.html`. Catálogo dinâmico de temas (cf. SPEC §10 future, linha 490) é v2.
- Não permite tokens "extra" fora do conjunto canônico. Componentes só consomem o que está documentado em §5.2; tokens novos exigem PR ao componente também (e atualização desta tabela).
- Não permite tema mono-modo. Locks de teste comparam keys light vs dark — falha rápido se um modo falta.

## 10. Como o usuário discorda

Spectrum de override (do mais leve ao mais pesado):

1. **Toggle theme no botão** — flip `light ↔ dark` (persistido em `localStorage`).
2. **Editar tokens locais** — para preview rápido (devtools em `:root` no servidor live). Não persiste.
3. **PR a `themes/<new-theme>/`** — segue §9. Tema entra no catálogo (SPEC §10).
4. **Editar `index.html#<link rel="stylesheet">`** — mudar tema default permanentemente (afeta exports daquele clone). PR ao repositório do qualy se quiser mudar default global.

Atalhos via flag (`--theme=<name>`, `--no-charts`, `--port=<n>`) **não existem** no MVP. SPEC §4 trava: stack fixa, default fixo, comportamento determinístico run-a-run.

## 11. Drift e versionamento

Locks em três níveis:

| Lock | Onde | O que trava |
|---|---|---|
| `themes-linear-design-md.test.ts` | `cli/tests/unit/` | tokens.json schema; light.css declara foundation; dark.css NÃO redeclara foundation; chave parity light↔dark; `prefers-reduced-motion` presente; `prefers-color-scheme: dark` presente |
| `report-server.test.ts` | `cli/tests/unit/` | `SERVER_HOST === "127.0.0.1"`; routes whitelist; método != GET/HEAD → 405; `..` → 404; headers de segurança |
| `report-export.test.ts` | `cli/tests/unit/` | export é byte-identical ao live (modulo redação); CSS inline; vendor inline; `cwd` redacted; paths absolutos redacted |

**Mudanças válidas sem ADR**:

- Adicionar token novo (com mesmas chaves nos dois modos).
- Adicionar componente novo num slot `data-mount` novo + caso correspondente em `MOUNT_KEYS`.
- Adicionar tema novo seguindo §9.
- Refinar redactor (§8) para cobrir mais shapes de token sensível.

**Mudanças que exigem ADR (cross-ref ADR 0005)**:

- Trocar stack base (vanilla DOM → framework).
- Permitir tema dinâmico via flag CLI ou mudar `SERVER_HOST`.
- Trocar `localStorage` por outro mecanismo de persistência.
- Quebrar `version: "1"` do `ReportData` (introduzir v2).
- Mudar política de redação no export (default off, novos shapes).

Versão atual: v1 (qualy MVP, 2026-05-04). Próximas revisões adicionam temas e componentes mas não removem campos do `ReportData` — consumidores (export versionado em `quality-report/`) podem confiar na estabilidade do shape.
