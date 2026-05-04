# Plano — `qualy/lint` skill (implementação determinística)

## Context

`qualy/SPEC.md` define a skill `/lint` que instala/gerencia oxlint+oxfmt+`quality-metrics` em projetos TS/TSX/JS/JSX, calibra thresholds por estágio, audita o repo, gera report visual e suporta rollback. O SPEC está completo (acceptance criteria, contratos JSON, presets, fluxos).

A diretiva-chave do usuário: **maximizar determinismo movendo a lógica real para um CLI TypeScript bundled (`qualy/cli/`)**, deixando os artefatos do harness (`SKILL.md`, slash commands, subagents) como **orquestradores finos** que apenas (i) chamam subcomandos do CLI e (ii) usam `AskUserQuestion` para confirmações. Subagents permanecem (decisão do usuário) — viram wrappers que invocam o CLI e devolvem sumários estruturados.

Resultado intencional: o que o modelo "decide em runtime" se restringe a fluxo conversacional e aplicação de respostas do usuário — toda detecção, instalação, parsing, cálculo e geração de artefatos é código testável.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Camada harness (.md, model-interpreted)                        │
│  ─────────────────────────────────────────                      │
│  skills/lint/SKILL.md           (router conversacional)         │
│  commands/lint/<x>.md           (orchestradores: chamam CLI +   │
│                                  AskUserQuestion)               │
│  agents/lint-{detector,installer,auditor,migrator}.md           │
│                                  (wrappers finos sobre o CLI;   │
│                                   lint-auditor enriquece        │
│                                   rationale das recs)           │
│  install.sh                     (distribuição: copia/symlinka   │
│                                  para ~/.claude/, valida Node)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ Bash: node --experimental-strip-types $CLI <sub> --json …
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Camada determinística (TS, executado direto)                   │
│  ─────────────────────────────────────                          │
│  qualy/cli/src/index.ts               dispatcher                │
│  qualy/cli/src/commands/*.ts          subcomandos               │
│  qualy/cli/src/lib/{git,fs,json,…}    utilitários               │
│  (sem build step; Node 22.6+ executa .ts via --experimental-    │
│   strip-types)                                                  │
└─────────────────────────────────────────────────────────────────┘
                             │ executa
                             ▼
                    projeto-alvo (cwd)
```

**Princípios da divisão:**

1. CLI sempre emite **JSON em stdout** (uma linha ou pretty), erros estruturados em stderr, exit codes semânticos (0=ok, 1=erro recuperável, 2=stack não suportada, 3=working tree sujo, …).
2. CLI **nunca** faz pergunta ao usuário — recebe respostas via flags/env. Toda interação é responsabilidade do harness.
3. CLI é **idempotente**: rodar duas vezes não deve duplicar hooks, scripts, etc.
4. Harness `.md` **nunca** parseia package.json, roda git/grep/cloc, ou edita configs — apenas chama o CLI e mostra resultado.
5. Subagents recebem prompt curto: "rode `qualy <sub>`, devolva o JSON e um sumário ≤ 30 linhas". **Exceção autorizada:** `lint-auditor` consome `candidates` de `recs-generate` e escreve `rationale` enriquecida com contexto do código (ver ADR 0008) — toda a parte determinística (cálculo, deltas, blast radius, IDs estáveis) continua no CLI.

---

## Contratos CLI (subcomandos)

Todos aceitam `--cwd <path>` (default `.`) e `--json` (default true). Exit codes documentados em `cli/src/lib/exit-codes.ts`.

| Subcomando | Input flags | Output (stdout JSON) | Side effects |
|---|---|---|---|
| `detect-stack` | — | `{ supported: bool, langs: string[], blockers: string[], evidence: {…} }` | nenhum |
| `detect-stage` | — | `{ stage: "greenfield"\|"brownfield-moderate"\|"legacy", confidence: "low"\|"high", signals: {age,loc,churn,files,tests,todos} }` | nenhum |
| `detect-existing-linter` | — | `{ linters: [{name, configs:[paths], pkg_dep:bool}], formatters: [...] }` | nenhum |
| `detect-test-runner` | — | `{ runner: "vitest"\|"jest"\|"none", coverage: { configured, current_thresholds, current_values } }` | nenhum |
| `git-clean-check` | — | `{ clean: bool, dirty_files: string[] }` | nenhum |
| `backup-create` | `--files <json-list>` | `{ backup_dir: ".lint-backup/<ts>" }` | cria `.lint-backup/<ts>/` com cópias |
| `backup-list` | — | `{ backups: [{ts, files, ...}] }` | nenhum |
| `backup-restore` | `--ts <iso>` | `{ restored: string[] }` | restaura arquivos |
| `install-oxlint` | `--stage <s> --tier <fast\|deep>` | `{ written: string[] }` | escreve `oxlint.<tier>.json` |
| `install-hook` | — | `{ written: string[], merged: bool }` | merge em `.claude/settings.json` + `.claude/hooks/post-edit.sh` |
| `install-husky` | — | `{ written: string[] }` | `.husky/pre-commit` + `.lintstagedrc.js` |
| `install-scripts` | `--scripts <json>` | `{ added: string[], skipped: string[] }` | merge em `package.json#scripts` |
| `install-coverage` | `--runner <r> --thresholds <json>` | `{ written: string[] }` | edita `vitest.config.ts` ou `jest.config.*` |
| `install-deps` | `--deps <json>` | `{ installed: string[] }` | roda npm/pnpm/yarn/bun add (detecta lockfile) |
| `audit` | `--tier <fast\|deep>` | grava `.lint-audit/<ts>.json` (contrato §3 do SPEC); stdout: `{ audit_path, summary }` | escreve `.lint-audit/<ts>.json` |
| `audit-latest` | — | `{ path, audit }` | nenhum |
| `recs-generate` | `--audit <path>` | `{ candidates: [{ id, type, evidence, suggested_change, rationale_stub }] }` (heurísticas determinísticas) | nenhum (idempotente sobre audit) |
| `recs-blast-radius` | `--rec-id <id> --audit <path>` | `{ files_newly_violating, files_no_longer_violating, examples }` | roda oxlint dry-run com config proposta |
| `recs-apply` | `--rec-id <id> --audit <path>` | `{ files_changed: string[] }` | aplica patch da rec, commita decisão em `docs/lint-decisions.md` |
| `rules-list` | — | `{ active:[…], available:[…], disabled:[…] }` | nenhum |
| `rules-add` | `--rule <r> --severity <s> --max <n>` | `{ written: string[] }` | edita preset, append `docs/lint-decisions.md` |
| `rules-remove` | `--rule <r> --reason <text>` | `{ written: string[] }` | edita preset, append `docs/lint-decisions.md` |
| `rules-explain` | `--rule <r>` | `{ description, rationale, threshold, links:[] }` | nenhum |
| `status` | — | `{ versions, presets, stage, hooks, coverage, theme }` | nenhum |
| `report-serve` | `--port <n>` | `{ url, port }` | sobe servidor http (long-running; harness mata via PID) |
| `report-export` | `--audit <path> --out <path>` | `{ html_path, bytes }` | escreve HTML self-contained |
| `uninstall` | `--keep-backup` | `{ removed: string[], kept_backup: bool }` | remove tudo que foi instalado |

**Observações:**

- `recs-generate` é determinístico e emite **candidatos** (id estável, tipo, evidência numérica, mudança proposta, `rationale_stub` por template). Heurísticas como "se p90 da métrica < 0.7 × threshold, propor tighten para round(p90 × 1.2)" — tabela completa em `qualy/docs/recs-heuristics.md`. O subagent `lint-auditor` consome esses candidatos, escreve `rationale` final com contexto do código e persiste o array `recommendations` enriquecido em `.lint-audit/<ts>.json` (mesmo arquivo do audit). Contrato `audit → update` preservado: `recs-apply` lê `recommendations` (não `candidates`). Ver ADR 0008.
- `audit` chama oxlint+oxfmt+`quality-metrics` como subprocessos, parseia JSON deles, agrega. `quality-metrics` é dependência peer do projeto-alvo (instalada por `install-deps`).
- Todas as escritas em arquivos do projeto-alvo passam por `qualy/cli/src/lib/safe-write.ts` que: (i) verifica working tree limpo se `--strict`, (ii) registra arquivos tocados num manifest `.lint-manifest.json` p/ uninstall completo.

---

## File layout

```
qualy/
├── SPEC.md                          (já existe)
├── README.md                        (instalação via ./install.sh)
├── CHANGELOG.md
├── install.sh                       (valida Node ≥ 22.6, copia/symlinka
│                                     skills/, commands/, agents/, cli/
│                                     para ~/.claude/; idempotente)
├── package.json                     (root: scripts test/lint do próprio CLI)
├── tsconfig.json
│
├── cli/
│   ├── src/
│   │   ├── index.ts                 (dispatcher por argv[2])
│   │   ├── commands/
│   │   │   ├── detect-stack.ts
│   │   │   ├── detect-stage.ts
│   │   │   ├── detect-existing-linter.ts
│   │   │   ├── detect-test-runner.ts
│   │   │   ├── git-clean-check.ts
│   │   │   ├── backup/{create,list,restore}.ts
│   │   │   ├── install/{oxlint,hook,husky,scripts,coverage,deps}.ts
│   │   │   ├── audit.ts
│   │   │   ├── recs/{generate,blast-radius,apply}.ts
│   │   │   ├── rules/{list,add,remove,explain}.ts
│   │   │   ├── status.ts
│   │   │   ├── report/{serve,export}.ts
│   │   │   └── uninstall.ts
│   │   ├── lib/
│   │   │   ├── git.ts               (exec wrapper)
│   │   │   ├── fs-safe.ts           (manifest-aware writes)
│   │   │   ├── json.ts              (parse/stringify defensivo)
│   │   │   ├── pkg-manager.ts       (detecta npm/pnpm/yarn/bun)
│   │   │   ├── ts-config-edit.ts    (AST edit de vitest.config.ts via ts-morph)
│   │   │   ├── exit-codes.ts
│   │   │   └── logger.ts            (stderr structured)
│   │   ├── presets/                 (in-source — copiados pro projeto-alvo)
│   │   │   ├── oxlint/{greenfield,brownfield-moderate,legacy}.{fast,deep}.json
│   │   │   └── coverage/{vitest,jest}.{greenfield,brownfield,legacy}.{ts,json}
│   │   ├── templates/
│   │   │   ├── post-edit.sh
│   │   │   ├── lintstagedrc.example.js
│   │   │   ├── lint-decisions.md.tpl
│   │   │   └── package-scripts.json
│   │   └── report/                  (TS puro do report visual)
│   │       ├── server.ts
│   │       ├── index.html
│   │       ├── app.ts
│   │       ├── data-loader.ts
│   │       ├── components/{MetricCard,ChartLine,ChartTreemap,ViolationsTable}.ts
│   │       ├── export.ts
│   │       └── themes/linear-design-md/{light.css,dark.css,tokens.json}
│   ├── tests/
│   │   ├── unit/                    (vitest)
│   │   └── fixtures/                (greenfield-ts, brownfield-eslint-prettier, legacy-monorepo, jest-with-coverage, unsupported-python)
│   ├── package.json                 (deps: ts-morph, vitest, chart.js, chartjs-plugin-treemap, esbuild — runtime apenas para report-export)
│   └── tsconfig.json
│
├── skills/lint/SKILL.md             (router; ≤ 200 linhas)
├── commands/lint/
│   ├── setup.md         audit.md         update.md     report.md
│   ├── uninstall.md     rollback.md      status.md
│   └── rules/{list,add,remove,explain}.md
├── agents/
│   ├── lint-detector.md             (chama detect-* subcomandos, devolve sumário)
│   ├── lint-installer.md            (chama install-* subcomandos)
│   ├── lint-auditor.md              (chama audit + recs-generate)
│   └── lint-migrator.md             (chama backup-* + uninstall)
│
└── docs/
    ├── stages.md                    (heurística stage detection)
    ├── thresholds.md                (tabela completa)
    ├── coverage.md                  (estratégia)
    ├── audit-format.md              (contrato JSON)
    ├── recs-heuristics.md           (NEW: regras de geração de rec)
    ├── report-design.md
    ├── compatibility.md
    └── adrs/
        ├── 0001-oxc-only-v1.md
        ├── 0002-named-backup-rollback.md
        ├── 0003-stage-detection-heuristic.md
        ├── 0004-audit-update-coupling.md
        ├── 0005-report-ephemeral-server-with-export.md
        ├── 0006-deterministic-cli-thin-harness.md   (NEW; rationale de recs é exceção autorizada)
        ├── 0007-runtime-ts-strip-types.md           (NEW; Node 22.6+ + --experimental-strip-types)
        ├── 0008-hybrid-recs-rationale.md            (NEW; CLI gera candidatos, subagent escreve rationale)
        └── 0009-install-script-distribution.md      (NEW; install.sh em vez de cópia manual ou plugin nativo em v1)
```

---

## Resolução do CLI nas `.md` do harness

Pattern para todos os commands/agents (definido uma vez em `SKILL.md` e reusado):

```bash
# preâmbulo padrão de todo command/agent
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
# ou, se rodando do workspace de dev: $REPO/cli/src/index.ts (detectado por presença de SPEC.md)
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

Cada `.md` do harness só especifica:
1. Quais subcomandos chamar e em qual ordem.
2. Quais respostas do usuário (via `AskUserQuestion`) viram quais flags do CLI.
3. Como interpretar exit codes (mensagens user-friendly).

---

## Phase order (build incremental)

A entrega é grande; faseando para sempre ter um caminho funcional end-to-end.

**Fase 0 — Bootstrap do workspace** *(0.5 dia)*
- `package.json`, `tsconfig.json`, vitest config, script `test`.
- Esqueleto `cli/src/index.ts` (dispatcher) + `cli/src/lib/{exit-codes,logger,json}.ts`.
- `install.sh` skeleton: valida `node --version >= 22.6`, copia/symlinka `skills/`, `commands/`, `agents/`, `cli/` para `~/.claude/` (idempotente).
- ADRs `0006-deterministic-cli-thin-harness.md`, `0007-runtime-ts-strip-types.md`, `0009-install-script-distribution.md`.
- ✅ Verificação: `node --experimental-strip-types cli/src/index.ts --help` lista subcomandos vazios; `./install.sh` em VM com Node 20 aborta com mensagem clara.

**Fase 1 — Detecção (read-only)** *(1 dia)*
- `detect-stack`, `detect-stage`, `detect-existing-linter`, `detect-test-runner`, `git-clean-check`, `status`.
- Fixtures `tests/fixtures/{greenfield-ts,brownfield-eslint-prettier,legacy-monorepo,jest-with-coverage,unsupported-python}`.
- Vitest cobrindo cada detector contra cada fixture.
- ✅ Verificação: `node --experimental-strip-types cli/src/index.ts detect-stage --cwd tests/fixtures/legacy-monorepo` retorna `{stage:"legacy",…}` com sinais corretos.

**Fase 2 — Setup greenfield (escrita)** *(1.5 dia)*
- `install-oxlint`, `install-hook`, `install-scripts`, `install-deps`, `install-husky`, `install-coverage`.
- Manifest `.lint-manifest.json` para tracking de tudo escrito.
- Presets oxlint copiados de `cli/src/presets/`.
- Templates copiados de `cli/src/templates/`.
- Skill `SKILL.md` + `commands/lint/setup.md` + `agents/lint-{detector,installer}.md` (todos thin sobre CLI).
- ✅ Verificação: `/lint:setup` em `greenfield-ts/` produz todos os artefatos do acceptance §7.1.

**Fase 3 — Migration / backup** *(1 dia)*
- `backup-create`, `backup-list`, `backup-restore`, `uninstall`.
- `commands/lint/{uninstall,rollback}.md` + `agents/lint-migrator.md`.
- ✅ Verificação: acceptance §7.2 (brownfield-eslint-prettier → setup → rollback restaura byte-a-byte).

**Fase 4 — Audit + recommendations** *(2 dias)*
- `audit` (chama oxlint+oxfmt+quality-metrics como subprocessos, agrega JSON conforme contrato §3 do SPEC).
- `recs-generate` (heurísticas determinísticas; tabela em `docs/recs-heuristics.md`) — emite `candidates` com `rationale_stub` por template.
- `recs-blast-radius` (oxlint dry-run com config proposta).
- `recs-apply` (lê `recommendations` enriquecido, não `candidates`).
- `commands/lint/{audit,update}.md` + `agents/lint-auditor.md` (subagent: chama `recs-generate`, recebe candidatos, escreve `rationale` final com contexto do código, persiste array `recommendations` em `.lint-audit/<ts>.json`).
- ADR `0008-hybrid-recs-rationale.md`.
- ✅ Verificação: acceptance §7.5–7.6, com requisito explícito de rationale legível (não stub) — teste compara que `recommendations[i].rationale` ≠ `candidates[i].rationale_stub`.

**Fase 5 — Rules management** *(0.5 dia)*
- `rules-list`, `rules-add`, `rules-remove`, `rules-explain`.
- `commands/lint/rules/*.md`.
- ✅ Verificação: acceptance §7.8–7.9.

**Fase 6 — Report visual** *(2 dias)*
- `cli/src/report/*` — server, app, components, theme `linear-design-md`.
- `report-serve`, `report-export`.
- `commands/lint/report.md`.
- ✅ Verificação: acceptance §7.7 (server local + export self-contained renderiza idêntico offline).

**Fase 7 — Hardening + docs** *(1 dia)*
- ADRs restantes (0001–0005), `docs/{stages,thresholds,coverage,audit-format,recs-heuristics,report-design,compatibility}.md`.
- README.md raiz com fluxo `./install.sh` (não cópia manual). Documenta pré-req Node ≥ 22.6.
- CHANGELOG inicial.
- Tier T2 (roteiros `tests/scenarios/*.md`) para os fluxos não automatizados.
- ✅ Verificação: rodar `./install.sh` + `/lint:setup` num repo TS real (escolhido pelo autor, fora dos fixtures) sem retoques.

**Total estimado:** ~8.5 dias-pessoa (sem build/bundle pipeline).

---

## Critical files / utilitários a reusar

- `quality-metrics` (plugin externo, GitHub: hgflima/quality-metrics) — não reimplementar; chamar via subprocesso. **Peer dep do projeto-alvo** (instalada em seu `node_modules/` por `install-deps`); CLI resolve via subprocesso lá. Desacopla release cycles.
- `ts-morph` — único caminho confiável para editar `vitest.config.ts` preservando comentários/formatação. Usado em `cli/src/lib/ts-config-edit.ts`.
- `esbuild` — runtime do report apenas (bundle do HTML self-contained em `report-export`, via `import('esbuild')`). CLI próprio **não** é bundlado.
- `--experimental-strip-types` (Node 22.6+) — runtime que executa `.ts` direto, sem build step. Ver ADR 0007.
- Node built-ins (`node:fs`, `node:child_process`, `node:http`, `node:path`) — preferir sempre que possível, evitar deps que possam quebrar em diferentes versões do Node.

---

## Verification

**Por fase:** scripts em `cli/package.json`:
- `pnpm test` — vitest unit + fixtures (executa via Node strip-types; sem build).
- `pnpm test:e2e` — script que roda cada fixture através do CLI (`node --experimental-strip-types cli/src/index.ts <sub>`) e compara output contra `EXPECTED.json` versionado.

**End-to-end final:**
1. `pnpm test && pnpm test:e2e` — verde.
2. `./install.sh` (copia/symlinka para `~/.claude/`); abrir Claude Code num projeto TS real:
   - `/lint:setup` em projeto greenfield → 11 itens da seção 7 do SPEC verdes.
   - `/lint:audit` → `.lint-audit/<ts>.json` válido contra schema (zod em `cli/src/lib/audit-schema.ts`); `recommendations[*].rationale` legível (não stub).
   - `/lint:report` → `127.0.0.1:<porta>` renderiza; export HTML abre offline idêntico.
   - `/lint:rollback` → restore byte-a-byte.
3. Rodar contra `tests/fixtures/unsupported-python/` → CLI retorna exit code 2 com mensagem listando stacks suportadas; nada escrito.
4. Rodar `./install.sh` em ambiente com Node < 22.6 → aborta com mensagem clara apontando o requisito.

---

## Decisões registradas

Resoluções das open questions originais (todas decididas; ADRs correspondentes na Fase 7):

1. **Distribuição via `qualy/install.sh`** — script bash que valida pré-reqs (Node ≥ 22.6) e copia/symlinka para `~/.claude/`. Idempotente. Plugin Claude Code publicável fica como evolução futura (SPEC §8). Ver ADR 0009.
2. **Sem bundle: TS executado direto via `node --experimental-strip-types`** — sem `dist/`, sem esbuild como dep do CLI próprio (esbuild fica só como runtime do `report-export`). Edits em `src/` têm efeito imediato. Ver ADR 0007.
3. **Recommendations híbridas** — CLI emite `candidates` determinísticos (ID estável, evidência numérica, `rationale_stub`); subagent `lint-auditor` reescreve `rationale` final com contexto do código antes de persistir `recommendations` no `.lint-audit/<ts>.json`. Contrato `audit → update` preservado. Ver ADR 0008.
4. **`quality-metrics` é peer dep** instalada no projeto-alvo (não embutida no CLI) — `install-deps` adiciona ao `package.json` do projeto, CLI invoca via subprocesso. Desacopla release cycles.
5. **Node ≥ 22.6** — necessário para `--experimental-strip-types`. CLI valida em startup e falha cedo com mensagem clara. README documenta.

## Open questions remanescentes

- Comportamento se `quality-metrics` major bump quebrar contrato JSON (versão pinned em `install-deps` + warning em `audit` se versão divergir do testado?).
- `install.sh` deve oferecer symlink ou cópia? (symlink facilita dev no próprio `qualy/`, cópia é mais segura para usuário final — talvez flag `--dev` decide).
