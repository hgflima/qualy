# Implementation Plan: tsx-runtime-fix

> Companion to [SPEC.md](./SPEC.md). Slices the work into vertical, verifiable tasks
> ordered by dependency. Each task leaves the repo in a working state.
> See [TASKS.md](./TASKS.md) for the executable checklist.

> **Status: completo (2026-05-05).** Todas as 6 tasks (Phase 1–3) e 3 checkpoints
> (A, B, C) concluídos. Entregue no commit `5f80e0e`. Suite verde: 2022 unit +
> 34 e2e (incluindo `installed-tarball.test.ts`). Smoke manual confirmado: pacote
> publicado executa pós-`npm install` sem `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
>
> **Desvio de escopo registrado:** ao remover o erro de strip-types, apareceu
> `ERR_MODULE_NOT_FOUND: zod` (mascarado antes). Para satisfazer SPEC §9 #4, todas
> as runtime deps do CLI (`zod`, `ts-morph`, `esbuild`, `chart.js`,
> `chartjs-chart-treemap`) — não só `tsx` — foram movidas para `dependencies` da
> raiz. ADR 0011 e CHANGELOG documentam essa expansão.

## Overview

Bug-fix focado: trocar `--experimental-strip-types` por `tsx` no shim `bin/qualy.mjs`
para que `@hgflima/qualy@X.Y.Z` execute pós-`npm install` (Node recusa stripar tipos
dentro de `node_modules/` por design). Adiciona um e2e que prova o fix e atualiza ADRs
+ SPEC cruzado para manter a história arquitetural coerente.

Volume real: 1 arquivo de runtime (~30 linhas), 1 e2e novo (~80 linhas), 4 docs (ADRs +
SPECs cruzados), 1 entrada no CHANGELOG. **Não** é uma feature — é cirurgia.

## Architecture Decisions

Já fixadas no SPEC §3 e §6; replicadas aqui para tornar o plano auto-contido.

- **Runtime: `tsx` via spawn**, resolvido por `createRequire(import.meta.url).resolve("tsx/cli")`.
  Sobrevive a hoisting de npm/pnpm/yarn. Sem fallback para strip-types — caminho único.
- **`tsx` em `dependencies`**, não `devDependencies`. É runtime de qualquer install.
- **`engines.node` baixa para `>=20.0.0`** (alinha com `setup-node@v4` default e tsx LTS).
- **Sem build step novo.** ADR 0010 D3 amended (não revogada): `bin/qualy.mjs` continua
  o ponto de entrada; só muda o que ele faz spawn.
- **ADR 0007 → superseded por ADR 0011**, não deletada. Histórico preservado.

## Dependency Graph

```
package.json (engines + tsx dep)        ← Task 1
        │
        ▼
bin/qualy.mjs (shim rewrite)             ← Task 2  (depends on tsx being installable)
        │
        ▼
Manual smoke (npm pack + install + qualy --version)   ← Checkpoint A
        │
        ▼
cli/tests/e2e/install/installed-tarball.test.ts        ← Task 3  (codifica o smoke)
        │
        ▼
npm test:e2e + pack-contents.test.ts.snap regression-check   ← Checkpoint B
        │
        ▼
ADR 0011 + ADR 0007 status + ADR 0010 cross-link       ← Task 4  (docs paralelos a partir daqui)
        │
        ▼
.harn/docs/npx-installer/SPEC.md §8 update              ← Task 5
        │
        ▼
CHANGELOG [Unreleased] entry                             ← Task 6
        │
        ▼
Final smoke + Success Criteria sweep                    ← Checkpoint C
```

Tasks 4, 5, 6 são docs e podem ser paralelizadas se feitas por agentes independentes,
mas para uma única sessão linear a ordem listada é mais natural (ADR é fonte de verdade,
SPEC e CHANGELOG fazem referência cruzada a ela).

## Vertical Slices

Em vez de "todo o código primeiro, todos os docs depois", cada fase entrega um estado
verificável:

- **Fase 1** (Tasks 1+2) — **Fix runtime.** Após Checkpoint A, o pacote é executável
  via `npm install`. Esse é o objetivo primário do spec.
- **Fase 2** (Task 3) — **Lock the regression.** Após Checkpoint B, qualquer recidiva
  do bug quebra a suite e2e.
- **Fase 3** (Tasks 4–6) — **Coerência documental.** Após Checkpoint C, todos os
  Success Criteria do SPEC §9 estão verdes, com a narrativa arquitetural alinhada.

## Task List

### Phase 1: Runtime Fix

#### Task 1: `package.json` — engines + tsx dep + build noop message

**Description:** Adicionar `tsx` como `dependency`, baixar `engines.node` para `>=20.0.0`,
e atualizar o texto do `npm run build` noop para refletir tsx em vez de strip-types.

**Acceptance criteria:**
- [x] `dependencies.tsx` = `"^4.19.0"` no `package.json` raiz.
- [x] `engines.node` = `">=20.0.0"` no `package.json` raiz.
- [x] String do `scripts.build` substitui `"Node 22.6+ executes .ts directly via --experimental-strip-types"` por `"executes .ts via tsx loader"` (ou texto equivalente — a propriedade externa "noop, sem build" é o que importa).
- [x] `npm install` no checkout completa sem warning de engine e instala `node_modules/tsx`.

**Verification:**
- [x] `node -e "console.log(require('./package.json').dependencies.tsx)"` imprime `^4.19.0`.
- [x] `node -e "console.log(require('./package.json').engines.node)"` imprime `>=20.0.0`.
- [x] `ls node_modules/tsx/` lista artefatos do pacote tsx.
- [x] `npm run build` ainda exit 0 com mensagem nova.

**Dependencies:** None.

**Files likely touched:**
- `package.json`

**Estimated scope:** XS (1 arquivo).

---

#### Task 2: `bin/qualy.mjs` — rewrite shim para usar tsx

**Description:** Substituir o spawn de `node --experimental-strip-types <entry>` por
`node <tsx-cli> <entry>`, resolvendo `tsx/cli` via `createRequire(import.meta.url).resolve("tsx/cli")`.
Ajustar comentário do header para explicar **por que** tsx (barreira do `node_modules/`).
Sem fallback condicional. Manter exit/signal handling existente.

**Acceptance criteria:**
- [x] Shim importa `createRequire` de `node:module`.
- [x] Resolve tsx via `createRequire(import.meta.url).resolve("tsx/cli")` — não hardcode de path.
- [x] `spawn` recebe `[tsxBin, entry, ...process.argv.slice(2)]` (sem `--experimental-strip-types`).
- [x] Comentário do header explica a barreira do `node_modules/` e por que tsx (referência ao SPEC §1, mas sem citar nome de SPEC — comentário deve sobreviver renames).
- [x] Exit/signal forwarding inalterado vs versão atual.

**Verification:**
- [x] `./bin/qualy.mjs --version` no checkout local imprime `0.1.0` (ou versão atual da raiz) com exit 0.
- [x] `node --check bin/qualy.mjs` (smoke de syntax) passa.
- [x] `grep -c experimental-strip-types bin/qualy.mjs` retorna `0`.

**Dependencies:** Task 1 (tsx precisa estar em `node_modules/` para o `createRequire.resolve` funcionar).

**Files likely touched:**
- `bin/qualy.mjs`

**Estimated scope:** XS (1 arquivo, ~30 linhas).

---

### Checkpoint A: Manual Smoke Pós-Install

> Antes de prosseguir, **provar manualmente** que o fix resolve o bug original.
> Esse smoke é o que faltou na release 0.1.0.

- [x] `npm pack` no `REPO_ROOT` gera `hgflima-qualy-0.1.0.tgz`.
- [x] Em `mktemp -d`: `npm init -y && npm install /abs/path/hgflima-qualy-0.1.0.tgz`.
- [x] `./node_modules/.bin/qualy --version` imprime `0.1.0` com exit 0 e **sem** `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` em stderr.
- [x] Em outro `mktemp -d` com `git init`: mesmo install, depois `./node_modules/.bin/qualy install --scope local --dry-run` — exit 0, stdout não-vazio.

Se algum passo falhar, voltar a Task 2 antes de avançar.

---

### Phase 2: Lock the Regression

#### Task 3: `cli/tests/e2e/install/installed-tarball.test.ts` — novo e2e

**Description:** Codificar o smoke do Checkpoint A como e2e automatizado. `beforeAll`
roda `npm pack`, cria projeto sintético, `npm install <tarball>`. Dois `it`s: `--version`
e `install --scope local --dry-run` em git repo. `afterAll` limpa tmpdirs.

**Acceptance criteria:**
- [x] Arquivo existe em `cli/tests/e2e/install/installed-tarball.test.ts`.
- [x] Suite executa `npm pack` uma vez (não por teste) e reusa o tarball.
- [x] `it("'qualy --version' exits 0 and prints a version")` — assert exit 0 + regex `/^\d+\.\d+\.\d+/` no stdout.
- [x] `it("'qualy install --scope local --dry-run' exits 0 in a git repo")` — assert exit 0, stdout contém marcador previsível do plan, stderr não contém `ERR_UNSUPPORTED`.
- [x] Tmpdirs criados com `mkdtempSync` e removidos em `afterAll` (mesmo padrão de `install-scopes.test.ts`).
- [x] Suite passa em `npm run test:e2e`.

**Verification:**
- [x] `npx vitest run cli/tests/e2e/install/installed-tarball.test.ts` exit 0.
- [x] `npm run test:e2e` exit 0 com 33+ testes (32 atual + ≥1 nova suite).
- [x] Test isola cache de npm via `process.env.npm_config_cache` apontando para tmp (evita corrida com vitest paralelo).
- [x] Sanity reverso: aplicar `git stash` no fix de Task 2, rodar a nova suite — **deve falhar** com `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Reverter o stash e reconfirmar pass.

**Dependencies:** Task 2 (o teste só passa com o fix aplicado).

**Files likely touched:**
- `cli/tests/e2e/install/installed-tarball.test.ts` (novo)

**Estimated scope:** S (1 arquivo, ~80 linhas).

---

### Checkpoint B: Suite Verde + Snapshot Sane

- [x] `npm test` (unit) passa.
- [x] `npm run test:e2e` passa, incluindo a nova suite.
- [x] `npm run typecheck` passa.
- [x] `npm run lint` passa.
- [x] `npm pack --dry-run` produz tarball sem `cli/dist/`, `node_modules/tsx/`, ou qualquer artifact de build.
- [x] `pack-contents.test.ts.snap` **não** regrediu — se regrediu, investigar antes de aceitar `--update` (qualquer arquivo novo no tarball precisa ser revisão deliberada).

Se snapshot regrediu inesperadamente, **pause e investigue** — o esperado é diff zero
porque `files: [...]` não mudou.

---

### Phase 3: Coerência Documental

#### Task 4: ADRs — 0011 (novo), 0007 (status), 0010 (cross-link)

**Description:** Registrar a decisão de runtime com ADR 0011, marcar ADR 0007 como
superseded, e adicionar nota cruzada na seção D3 do ADR 0010. Estrutura de ADR segue
template existente do projeto (Status / Data / Contexto / Decisão / Consequências /
Alternativas / Verificação) — copiar shape de ADR 0010.

**Acceptance criteria:**
- [x] `docs/adrs/0011-tsx-runtime.md` existe com:
  - Status: aceito; Data: 2026-05-05.
  - Contexto cita o bug `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` e a barreira do `node_modules/`.
  - Decisão: tsx via spawn, resolvido por `createRequire`, sem fallback.
  - Consequências: enumera o que muda vs ADR 0007 (drop strip-types, adiciona ~1MB de tsx em deps) e ADR 0010 D3 (mesmo shim, runtime diferente).
  - Alternativas consideradas: bundle via esbuild (rejeitada — viola "no build step"), `--experimental-strip-types` com lockfile workaround (não existe), Node bump (não resolve por design).
  - Verificação: aponta para `installed-tarball.test.ts` + smoke manual.
- [x] `docs/adrs/0007-runtime-ts-strip-types.md` ganha linha no header: `- Status: superseded by ADR 0011 (2026-05-05)`. Conteúdo histórico preservado.
- [x] `docs/adrs/0010-npm-distribution.md` ganha nota cruzada na seção `### D3` apontando para ADR 0011 (frase curta, ~2 linhas, sem reescrever a decisão).

**Verification:**
- [x] `grep -l "0011" docs/adrs/*.md` lista os 3 arquivos esperados.
- [x] `grep "superseded by ADR 0011" docs/adrs/0007-runtime-ts-strip-types.md` retorna 1 linha.
- [x] Render Markdown limpo (preview no editor).

**Dependencies:** Task 2 (o ADR documenta a decisão tomada no código).

**Files likely touched:**
- `docs/adrs/0011-tsx-runtime.md` (novo)
- `docs/adrs/0007-runtime-ts-strip-types.md`
- `docs/adrs/0010-npm-distribution.md`

**Estimated scope:** S (1 arquivo novo + 2 edits pequenos).

---

#### Task 5: `.harn/docs/npx-installer/SPEC.md` §8 — rename + novo critério

**Description:** Atualizar 4 ocorrências literais `qualy` → `@hgflima/qualy` na §8
(Success Criteria) e adicionar critério novo: "binário publicado executa pós-`npm install`".

**Acceptance criteria:**
- [x] 4 substituições aplicadas em §8 (verificar via `grep -n '\bqualy\b' .harn/docs/npx-installer/SPEC.md` antes/depois — só sobram as ocorrências que **não** representam o nome do pacote npm).
- [x] Novo critério adicionado em §8 com texto tipo: `- [ ] Binário publicado executa pós-`npm install` em projeto limpo (cli/tests/e2e/install/installed-tarball.test.ts).`
- [x] Nenhuma outra seção tocada (escopo cirúrgico).

**Verification:**
- [x] `grep -c '@hgflima/qualy' .harn/docs/npx-installer/SPEC.md` aumenta em ≥4.
- [x] `grep installed-tarball .harn/docs/npx-installer/SPEC.md` retorna ≥1 linha.

**Dependencies:** Task 3 (o novo critério referencia o teste por nome).

**Files likely touched:**
- `.harn/docs/npx-installer/SPEC.md`

**Estimated scope:** XS (1 arquivo, ~5 linhas tocadas).

---

#### Task 6: `CHANGELOG.md` — entrada `[Unreleased]`

**Description:** Documentar a mudança runtime na seção `[Unreleased]` do CHANGELOG.
Decisão entre `[Unreleased]` vs `[0.1.1]` é explicitamente out-of-scope (SPEC §10) —
ficamos em `[Unreleased]` até a release ser cortada.

**Acceptance criteria:**
- [x] Seção `[Unreleased]` ganha sub-seção `### Changed` (ou `### Fixed`) com bullet:
  - Mencionar troca de runtime (`--experimental-strip-types` → `tsx`).
  - Mencionar drop de `engines.node` para `>=20.0.0`.
  - Linkar ADR 0011 (path relativo).
  - Mencionar bug fix (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` em pacote instalado).
- [x] Texto segue tom do CHANGELOG existente (Keep a Changelog 1.1.0).

**Verification:**
- [x] `grep -A 5 '## \[Unreleased\]' CHANGELOG.md` mostra a entrada nova.
- [x] Markdown render limpo.

**Dependencies:** Task 4 (link para ADR 0011 só faz sentido depois que ele existe).

**Files likely touched:**
- `CHANGELOG.md`

**Estimated scope:** XS (1 arquivo, ~6 linhas).

---

### Checkpoint C: Success Criteria Sweep

Caminhar pelos 13 critérios do SPEC §9 e confirmar cada um:

- [x] `bin/qualy.mjs` resolve via `createRequire` (Task 2).
- [x] `package.json` lista `tsx ^4.19.0` em `dependencies` (Task 1).
- [x] `engines.node` = `>=20.0.0` (Task 1).
- [x] `npm install` + `qualy --version` exit 0, sem stderr de strip-types (Checkpoint A).
- [x] `installed-tarball.test.ts` existe e passa (Task 3).
- [x] `npm test` + `npm run test:e2e` verdes (Checkpoint B).
- [x] `npm pack --dry-run` sem build artifacts (Checkpoint B).
- [x] ADR 0011 com Status/Decisão/Consequências (Task 4).
- [x] ADR 0007 com linha de superseded (Task 4).
- [x] ADR 0010 D3 cross-link (Task 4).
- [x] SPEC §8 npx-installer atualizado (Task 5).
- [x] CHANGELOG entry (Task 6).
- [x] Smoke manual passa (Checkpoint A — re-rodar para confirmar nada regrediu durante Phase 3).

Se qualquer item amarelo ou vermelho, voltar à task correspondente. **Não** marcar o
spec como entregue até todos os 13 estarem verdes.

## Risks and Mitigations

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| `tsx/cli` não resolve via `createRequire` em pnpm/yarn (hoisting esquisito) | Médio — quebra adopters em pnpm | `createRequire` é a forma oficial recomendada; testar manualmente com `pnpm install` no Checkpoint A se possível, mas e2e principal é via npm que é o caso comum |
| Snapshot de `pack-contents.test.ts` regride inesperadamente | Baixo — falha visível e localizada | Checkpoint B inclui inspeção manual antes de aceitar update |
| Vitest paralelo dispara N `npm pack` simultâneos e corrompe `~/.npm` cache | Médio — flaky tests | Task 3 acceptance criteria fixa `process.env.npm_config_cache` para tmp; alternativa: `describe.sequential` |
| Engine downgrade de `>=22.6.0` para `>=20.0.0` esconde uso de syntax Node 22+ no CLI | Baixo — typecheck pega | `npm run typecheck` no Checkpoint B; tsconfig já está em NodeNext, não dependemos de feature de runtime específica de 22 |
| ADR 0011 fica inconsistente com ADR 0007 | Baixo — documental | Task 4 acceptance criteria explicitamente lista cross-link; render Markdown valida |
| Custo do e2e novo (~10–20s) torna `npm run test:e2e` lento o suficiente para virar bypass | Baixo no curto prazo | Aceitável; e2e já é o tier mais lento. Se virar problema, marcar com `describe.skipIf(process.env.CI === undefined)` futuramente — fora deste spec |

## Open Questions

Nenhuma — SPEC §11 confirma. Caso surjam durante implementação, listar aqui antes de
prosseguir, mesmo que a resposta seja óbvia (auditabilidade).

## Parallelization Notes

Em uma única sessão linear (Ralph ou agente único), executar Tasks 1→2→3→4→5→6 em ordem.

Em fan-out com múltiplos agentes:

- **Sequencial obrigatório:** Tasks 1 → 2 → 3 (dependência funcional).
- **Paralelo OK após Task 3:** Tasks 4, 5, 6 podem rodar em agentes independentes
  (apenas docs, paths disjuntos). Coordenar para que o link CHANGELOG → ADR só seja
  escrito depois que ADR 0011 existir (ou usar path relativo com placeholder e revisar
  no Checkpoint C).
