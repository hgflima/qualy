# Plan: CLI Bin Resolution Hotfix (v0.3.4)

> Status: **Draft** — pendente revisão humana antes de iniciar implementação.
> Spec: `.harn/docs/cli-bin-resolution/SPEC.md` (aprovada).
> Tasks: `.harn/docs/cli-bin-resolution/TASKS.md` (lista executável).

## 1. Visão Geral

Hotfix cirúrgico que fecha os dois bugs descobertos em v0.3.3 ao rodar qualquer
slash command de `/lint:*` após `npx @hgflima/qualy install`:

- **Bug 1** — `ERR_MODULE_NOT_FOUND` para `zod`, `ts-morph`, `fast-glob`,
  `esbuild`, `chart.js`, `chartjs-chart-treemap` (deps do CLI nunca instaladas
  no target).
- **Bug 2** — `Cannot find module '../../package.json'` em `cli/src/index.ts:63`
  (caminho relativo errado pós-cópia).

A estratégia (SPEC §2) é **parar de copiar `cli/`** para o target e em vez disso
rodar `npm install --omit=dev --no-save @hgflima/qualy@<v>` dentro de
`.claude/skills/lint/`. Isso materializa um `node_modules/` self-sufficient com
todas as deps resolvidas e — como side-effect — corrige Bug 2 (o entrypoint
agora vive em `node_modules/@hgflima/qualy/cli/src/index.ts`, onde
`../../package.json` resolve corretamente para a raiz `@hgflima/qualy/package.json`).

Os 6 slash commands de `/lint:*` (mais o preâmbulo canônico em
`skills/lint/SKILL.md`) trocam o lookup de `skills/lint/cli/src/index.ts` para
`skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs`, com fallback de dev
via `QUALY_DEV_BIN`.

## 2. Decisões de Arquitetura

- **Materialização via npm, não bundle**. Esbuild + chart.js precisariam
  permanecer external de qualquer forma (uso runtime); bundle foi descartado
  na fase Spec (§9 Out of Scope).
- **Sempre `npm` como pm de materialização**, mesmo em projetos pnpm/yarn
  (SPEC §8 Q2). Evita surpresas com symlinks do pnpm e mantém layout flat de
  `node_modules` que o entrypoint `bin/qualy.mjs` espera.
- **Stub `package.json` no target** para satisfazer `npm install`. SPEC §8 Q1
  fica resolvido: pré-criar `{"name":"qualy-runtime","private":true}` em
  `.claude/skills/lint/package.json` antes do `npm install`. Sem esse stub o
  npm cria um automaticamente — ao pré-criar controlamos o conteúdo (privado,
  sem deps registradas, fora do controle do usuário).
- **Manifest schema fica retrocompatível**: estende o enum `ManifestEntryKind`
  com `"runtime-node-modules"` e adiciona uma única entry nova. Não precisa
  bumpar `MANIFEST_VERSION` (SPEC §8 Q5 → resolvido como compatível).
- **Stop-shipping `cli/`**: remove `"cli"` de `TOP_LEVEL_DIRS` em `copy.ts` e
  apaga o `SKIP_RELATIVE` set (que filtrava `cli/tests`/`cli/node_modules`)
  agora ocioso. Garante o invariante anti-orphan do uninstall sem nenhuma
  exceção residual sobre `cli/`.
- **Preâmbulo canônico congelado em SKILL.md** continua a ser a fonte de
  verdade — os 6 commands referenciam (não duplicam). A v0.3.4 reescreve o
  bloco para usar `QUALY_BIN` (apontando ao `bin/qualy.mjs` materializado) em
  vez de `QUALY_CLI` (que apontava ao `cli/src/index.ts` shippado).
  `preamble-resolution.test.ts` (e o `preamble-parity.test.ts` mencionado nele)
  passa a validar o novo bloco.

## 3. Dependency Graph

```
                    ┌────────────────────────────────────┐
                    │ T1  manifest.ts: novo kind + test  │
                    │ T2  copy.ts: drop "cli/"           │
                    │ T3  materialize-runtime.ts (novo)  │  ← independentes
                    └────────────────────────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────────┐
                    │ T4  install.ts: integra materialize│
                    │     + 2 manifest entries (stub +   │
                    │     runtime-node-modules)          │
                    └────────────────────────────────────┘
                                    │
       ┌────────────┬───────────────┼───────────────┬──────────────┐
       ▼            ▼               ▼               ▼              ▼
   ┌────────┐ ┌──────────┐  ┌──────────────┐ ┌──────────────┐ ┌────────┐
   │ T5 un- │ │ T6 update│  │ T7a SKILL.md │ │ T7b agents/  │ │   ...  │
   │ install│ │ re-mater.│  │ + 14 commands│ │ + tests      │ │        │
   └────────┘ └──────────┘  └──────────────┘ └──────────────┘ └────────┘
       │            │               │               │
       └────────────┴───────────────┴───────────────┘
                                    ▼
                    ┌────────────────────────────────────┐
                    │ T8  E2E cli-invocation (tarball    │
                    │     local + --prefer-offline)      │
                    └────────────────────────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────────┐
                    │ T9  Smoke manual + release v0.3.4  │
                    └────────────────────────────────────┘
```

Ordem de implementação segue o grafo bottom-up: foundation (T1–T3), depois
install (T4) que destrava todos os consumers (T5–T7) — esses três são
paralelos —, depois E2E (T8) que valida o conjunto, depois release (T9).

## 4. Slicing Vertical

Cada task entrega **um caminho completo** que termina em um sistema funcional
e testável (não horizontal por camada). T4 é o gargalo natural: até T4 landar,
nenhum smoke real funciona, mas T1–T3 podem ser revisadas em paralelo. T5–T7
após T4 podem rodar em paralelo (pessoas/sessões diferentes) porque tocam
arquivos disjuntos.

## 5. Fases e Checkpoints

### Fase 1: Foundation (T1, T2, T3)

Mudanças preparatórias, isoladas, com testes unitários próprios. Nada exposto
ao usuário ainda — `qualy install` continua quebrado até T4.

**Checkpoint A** — após T1, T2, T3:
- [ ] `npm run typecheck` passa.
- [ ] `npm test` passa (unit tests de manifest, copy, e o novo
      materialize-runtime).
- [ ] Nenhum smoke E2E quebrado (eles ficam em `expected.failure` se
      necessário; a integração ainda não landed).

### Fase 2: Install Integration (T4)

Liga a foundation no pipeline de instalação. **Primeiro momento em que
`qualy install` produz um runtime funcional pós-mudança.**

**Checkpoint B** — após T4:
- [ ] Smoke manual: `npx <local-tarball> install --scope local` em tmpdir
      cria `.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs`.
- [ ] `node <bin> detect-stack --cwd "$PWD"` retorna JSON sem erro
      (validação direta de Bug 1 + Bug 2).
- [ ] Manifest contém entry com kind `runtime-node-modules` apontando para
      `skills/lint/node_modules/`.

### Fase 3: Consumers (T5, T6, T7 — paralelos)

Atualiza uninstall, update, e os slash commands para conhecerem a nova
estrutura. Cada um pode ser revisado em uma sessão separada.

**Checkpoint C** — após T5, T6, T7:
- [ ] `qualy uninstall` remove `node_modules/` materializado e deixa o tree
      limpo (sem orphans).
- [ ] `qualy update` re-materializa em version bump.
- [ ] Os 6 slash commands resolvem o novo bin sem regressão; o probe E2E
      (`preamble-resolution.test.ts`) cobre os 4 cenários (PWD-only,
      HOME-only, ambos, nenhum).

### Fase 4: Validation & Release (T8, T9)

E2E completo + smoke manual + release v0.3.4.

**Checkpoint D — Pronto para merge**:
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:e2e`
      todos verdes.
- [ ] CHANGELOG.md documenta os dois bugs corrigidos e o workaround manual a
      ser revertido (`rm .claude/skills/lint/package.json`).
- [ ] Smoke manual em macOS Node 22.6+ executou os 5 critérios da SPEC §1.
- [ ] PR aberto + revisão humana antes do bump.

## 6. Riscos e Mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| `npm install --no-save` em dir sem `package.json` cria stub indesejado ou falha por permissão | Médio | Pré-criar stub controlado (decisão de arquitetura §2). Cobrir em unit test de `materialize-runtime`. |
| Instalação leva >60s (SLA da SPEC §1) em rede lenta | Médio | Aceitar >60s no smoke, mas log de progresso (stdio inherited). Documentar em CHANGELOG que primeira invocação demora. Não bloqueador para hotfix. |
| Usuário em ambiente offline pós-install funciona, mas reinstall quebra | Baixo | Erro `EQUALY_INSTALL_NETWORK` com mensagem clara (SPEC §4). Cache do npm já cobre o caso "instalou uma vez online". |
| `pnpm-lock.yaml`/`yarn.lock` no projeto raiz interfere | Baixo | Forçamos `npm` (decisão §2). `npm install` em subdir não tenta enxergar lockfiles do parent. |
| Manifest v0.3.3 instalado falha ao ser lido por v0.3.4 | Baixo | Schema é additive; `ManifestEntryKind` é union TS, leitura ignora kinds desconhecidos? **AUDITAR em T1.** Se não ignorar, adicionar fallback no leitor. |
| Slash commands em `agents/lint-*.md` também usam o probe | Médio | Auditar em T7: o spec menciona "6 lint commands", mas SKILL.md diz que `agents/lint-*.md` reusa o mesmo preâmbulo. Atualizar todos os arquivos que ainda referenciam `cli/src/index.ts`. |
| Workaround manual do usuário (`rm .claude/skills/lint/package.json`) conflita com nosso stub | Médio | Documentar em CHANGELOG: usuários afetados devem rodar `qualy uninstall && qualy install`. Reinstall via T4 cria o stub novo. |
| Release publish via `gh release create` em workflow novo | Baixo | Workflow existente já lida (per memory: `release_workflow`). Sem mudanças no fluxo. |

## 7. Open Questions — RESOLVIDAS

Todas as 5 do SPEC §8 fechadas antes do início da implementação.

| # | Question | Decisão |
|---|---|---|
| Q1 | `npm install --no-save` em dir sem `package.json` | **Pré-criar stub controlado** (`{"name":"qualy-runtime","private":true}`) E registrar no manifest com kind `"other"` para uninstall remover. Garante invariante "manifest é fonte de verdade". |
| Q2 | Detecção de pm | **Sempre `npm`**, mesmo em projetos pnpm/yarn (decisão §2). |
| Q3 | Cache de install | **npm cache já cobre**. Sem ação. |
| Q4 | CI roda `qualy install --scope user`? | **Não**. Auditoria do `.github/workflows/publish.yml` confirma que o workflow só faz `npm ci`/typecheck/test/test:e2e/`npm publish`. Sem impacto. |
| Q5 | Schema do manifest | **Retrocompatível** (additive). `readManifest` atual já é tolerante a kinds desconhecidos por construção (`return parsed as Manifest`). T1 adiciona test que prova isso. |

### Decisões adicionais fechadas pós-Fase 0

- **T8 rede no CI**: usar **tarball local via `npm pack` + `npm install --prefer-offline`**. Funciona offline após primeira execução; valida pipeline real sem flaky.
- **Upgrade path para adopters da v0.3.3 quebrada**: **CHANGELOG instrui `qualy uninstall && qualy install`** (ou `qualy update --yes`). Sem código novo. Reinstall via fluxo normal limpa o estado intermediário do workaround manual.
- **T7 escopo**: 19 arquivos funcionais referenciam `cli/src/index.ts`/`QUALY_CLI` (`grep -rl` em `commands/ agents/ skills/`). Acima do limite de 15 → **dividir T7 em T7a (SKILL.md + 14 commands) e T7b (4 agents + testes)**.

## 8. Parallelization Opportunities

- **Fase 1 (T1, T2, T3)**: 3 PRs independentes. Podem ir em paralelo.
- **Fase 3 (T5, T6, T7)**: 3 PRs independentes pós-T4. Podem ir em paralelo.
- **Sequenciais obrigatórios**: T4 (depende de T1+T2+T3), T8 (depende de T4–T7),
  T9 (depende de T8).

## 9. Critérios de Sucesso (espelham SPEC §1)

1. `npx @hgflima/qualy@0.3.4 install` em projeto limpo deixa `/lint:rules:list`
   funcional em ≤ 60s (smoke alvo: ≤ 30s em rede média).
2. Pós-install, `node .claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs detect-stack --cwd "$PWD"` retorna sucesso.
3. `qualy uninstall` remove `node_modules/` materializado.
4. `qualy update` re-materializa nova versão no mesmo caminho.
5. Os 6 slash commands funcionam sem regressão.
