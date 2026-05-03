# Implementation Plan

> Gerado por Ralph (planning mode) com base em `.harn/docs/mvp/SPEC.md` e `.harn/docs/mvp/PLAN.md`.
> Estado atual confirmado por `find src/` (vazio): nada implementado. Todas as fases do PLAN.md ainda são gaps.
> Convenção arquitetural (PLAN.md): CLI determinístico em `cli/src/` invocado por harness fino (`skills/`, `commands/`, `agents/`). Runtime: Node ≥ 22.6 com `--experimental-strip-types` (sem build step).

---

## Priority 1: Fase 0 — Bootstrap do workspace

- [x] Criar `package.json` raiz com campos `name="qualy"`, `private:true`, `type:"module"`, `engines.node:">=22.6.0"`, scripts placeholder (`test`, `test:e2e`) (why: PLAN §Fase 0; pré-condição para qualquer outro comando npm/pnpm)
- [x] Criar `tsconfig.json` raiz com `target:"ES2023"`, `module:"NodeNext"`, `moduleResolution:"NodeNext"`, `strict:true`, `noEmit:true` (why: PLAN §Fase 0; viabiliza `tsc --noEmit` da validação por iteração em AGENTS.md)
- [x] Criar `cli/package.json` com deps runtime mínimas (`ts-morph`, `vitest`, `chart.js`, `chartjs-plugin-treemap`, `esbuild`) (why: PLAN §Critical files; declara dependências em isolado do harness)
- [x] Criar `cli/tsconfig.json` estendendo o raiz, `rootDir:"./src"` (why: PLAN §File layout; isolamento de paths)
- [x] Criar `cli/src/lib/exit-codes.ts` exportando constantes (`OK=0`, `RECOVERABLE_ERROR=1`, `UNSUPPORTED_STACK=2`, `DIRTY_TREE=3`, etc.) (why: PLAN §Contratos CLI – exit codes semânticos documentados)
- [x] Criar `cli/src/lib/logger.ts` que escreve mensagens estruturadas em stderr e JSON puro em stdout (why: PLAN §Princípios – CLI emite JSON em stdout, erros em stderr)
- [x] Criar `cli/src/lib/json.ts` com `parseDefensive` e `stringifyPretty` para evitar throws não-tratados (why: PLAN §File layout – utilitário compartilhado)
- [x] Criar `cli/src/index.ts` como dispatcher por `process.argv[2]` listando subcomandos vazios e implementando `--help`, `--version` (why: PLAN §Fase 0 verificação; hub que viabiliza chamar qualquer subcomando posteriormente)
- [x] Criar `vitest.config.ts` raiz apontando para `cli/tests/unit/**` (why: AGENTS.md – tests via vitest; PLAN §Verification)
- [x] Hoistar `vitest` (e `typescript`) para um lugar onde `vitest.config.ts` na raiz consiga resolver o pacote — escolhida opção (b): npm workspaces (`"workspaces": ["cli"]` no `package.json` raiz). `npm install` na raiz hoista `vitest`/`typescript` para `node_modules/` da raiz; `cli/node_modules` e `cli/package-lock.json` removidos (lockfile agora vive só na raiz). Scripts raiz: `test → vitest run`, `typecheck → npm run typecheck --workspace @qualy/cli`. `npm test` executa 25/25 unit tests; `npm run typecheck` passa limpo (why: AGENTS.md constraint; desbloqueia execução real dos unit tests da Fase 1+)
- [x] Corrigir nome do pacote em `cli/package.json` de `chartjs-plugin-treemap` (404) para `chartjs-chart-treemap@^3.1.0` (why: pacote real publicado; desbloqueia `npm install --prefix cli`)
- [x] Adicionar `typescript` em `cli/devDependencies` para que `npm run typecheck --prefix cli` (`tsc -p tsconfig.json --noEmit`) tenha o binário disponível (why: script existia em `cli/package.json` mas faltava a dep)
- [x] Criar `.gitignore` raiz cobrindo `node_modules/`, artefatos de build/coverage, `.lint-audit/`, `.lint-backup/`, `.lint-manifest.json`, `ralph.log`, `.ralph_stuck_tracker` (why: agora que `npm install --prefix cli` funciona, evita commitar `cli/node_modules/`)
- [x] Criar `install.sh` no raiz que valida `node --version` ≥ 22.6 e copia/symlinka `skills/`, `commands/`, `agents/`, `cli/` para `~/.claude/` (idempotente). Modos: `copy` (default) e `--dev` (symlink). Layout: `skills/<name>/` e `commands/<name>/` por sub-diretório, `agents/*.md` por arquivo, `cli/` aninhado em `<target>/skills/lint/cli` (consistente com pattern `${CLAUDE_PLUGIN_ROOT}/skills/lint/cli/src/index.ts` do PLAN §Resolução do CLI). Verificações manuais: Node 22.5 → exit 1 com mensagem clara; Node 22.6/24.x → ok; segunda execução → idempotente; `--dry-run` não toca FS. Guarda defensiva `assert_safe_target` recusa qualquer remoção fora de `$TARGET_ROOT/<...>` (why: PLAN §Fase 0 + ADR 0009 – distribuição manual via script)
- [x] Criar `docs/adrs/0006-deterministic-cli-thin-harness.md` registrando a decisão central — duas camadas (CLI determinístico em `cli/src/` + harness fino em `.md`), princípios (stdout JSON, exit codes semânticos, idempotência via `.lint-manifest.json`, sem perguntas no CLI), exceção autorizada do `lint-auditor` para `rationale` (cross-ref ADR 0008), tradeoffs e verificação por fixtures vitest. Referencia ADR 0007/0008/0009. (why: PLAN §Fase 0 lista ADRs obrigatórios)
- [x] Criar `docs/adrs/0007-runtime-ts-strip-types.md` registrando: Node ≥ 22.6 + `--experimental-strip-types` como runtime único (sem `tsx`/`ts-node`/`dist/`), pattern de invocação fixo no `SKILL.md`, restrições de sintaxe TS impostas pelo strip-types e reforçadas por `verbatimModuleSyntax`/`isolatedModules`/`allowImportingTsExtensions` no `tsconfig.json` raiz, `esbuild` autorizado só dentro de `report-export` (não para o CLI próprio), tradeoffs (floor de Node alto, subset de TS) e verificação via `package.json#engines`, guarda no `install.sh`, `npm run typecheck` e `npm test`. Cross-refs ADR 0006/0009. (why: PLAN §Fase 0 lista ADRs obrigatórios; justifica Node 22.6+)
- [x] Criar `docs/adrs/0009-install-script-distribution.md` registrando: distribuição manual via `install.sh` (Bash) com modos `copy` (default) e `--dev` (symlink), validação de Node ≥ 22.6 antes de qualquer escrita, layout específico (`cli/` em `<target>/skills/lint/cli/`), idempotência, guarda `assert_safe_target`, `--dry-run`, `--target`, exclusão de desinstalação self (delegada ao usuário). Cross-refs ADR 0006/0007. Alternativas: plugin nativo (postergado v2), `npm i -g`, instruções manuais, instalador Node, Make/Just, `install.ps1` (why: PLAN §Fase 0 lista ADRs obrigatórios; explica `install.sh` em vez de plugin nativo em v1)

## Priority 2: Fase 1 — Detecção (read-only)

- [x] Criar `cli/src/lib/git.ts` com wrappers (`isClean`, `firstCommitDate`, `churn90d`, `lsFilesByExt`) chamando `git` via `child_process` (why: PLAN §File layout; base usada por múltiplos detectores). Implementado com `execFileSync` (sem shell), seam testável `setGitRunner`, e retorno `GitResult<T>` discriminado para que detectores tratem repos vazios e falhas sem throw. 19 testes unit cobrindo paths felizes, repo vazio, datas inválidas, dedup de pathspecs e validação de extensões. Convém: `firstCommitDate` retorna `null` para repos sem commits; `churn90d` 0; `lsFilesByExt` recusa extensões com `/`, `\` ou whitespace.
- [x] Criar `cli/src/lib/pkg-manager.ts` que detecta gerenciador a partir do lockfile (`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, default npm) (why: AGENTS.md – detecção por lockfile). Implementado com prioridade `bun.lock` > `bun.lockb` > `pnpm-lock.yaml` > `yarn.lock` > `package-lock.json` > default; retorna `{ manager, source }` para que `status` distinga "lock encontrado" de "fallback npm". Test seam `setExistsFn`. 11 testes unit cobrindo cada lockfile, prioridade, curto-circuito e default.
- [x] Implementar `cli/src/commands/detect-stack.ts` (lê `package.json`, classifica `.ts/.tsx/.js/.jsx` como suportado; resto bloqueia) (why: SPEC §1 stack suportada – única lista que oxc cobre). Implementado como detector puro `detectStack({ cwd }, { existsFn? })` + `runDetectStack(argv)` handler. Combina dois sinais: (i) extensões via `lsFilesByExt` (ts/tsx/js/jsx supported, vue/svelte → blocker) e (ii) marcadores de linguagem via `existsSync` no root (`pyproject.toml`/`setup.py`/`Pipfile`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`(.kts), `mix.exs`). Decisão: `supported = blockers.length===0 && (ts+tsx+js+jsx) > 0`. Exit codes: 0 supported, 2 UNSUPPORTED_STACK (qualquer blocker ou zero arquivos TS/JS), 1 RECOVERABLE_ERROR (ex: não é repo git). Wired no dispatcher via `HANDLER_OVERRIDES` Map (substitui notImplemented por subcomando, padrão para próximas fases). 18 unit tests cobrindo: classification TS-only/JS-only, blockers Python/Go/Rust/Vue/Svelte, multi-blocker, sem arquivos+sem blocker, falha git, contagem `.tsx` distinta de `.ts`, parser de flags `--cwd`/`--help`/erros. Smoke test contra este repo: `supported:true`, `tsFiles:12`, exit 0; contra fixture sintético com pyproject.toml: `supported:false`, blocker `python`, exit 2.
- [x] Implementar `cli/src/commands/git-clean-check.ts` (why: SPEC §6 Always – exigir tree limpa antes de mudanças). Adicionado `dirtyFiles(cwd)` em `cli/src/lib/git.ts` que executa `git status --porcelain=v1 -z` e parseia tokens NUL-terminados (cobre paths com espaços; pula token de origem em rename/copy `R`/`C`). Comando `gitCleanCheck()` puro retorna `{ clean, dirtyFiles[] }`; handler emite `{ clean, dirty_files }` em stdout. Exit codes: `OK` (0) limpo, `DIRTY_TREE` (3) sujo, `RECOVERABLE_ERROR` (1) falha de git. Wired no dispatcher via `HANDLER_OVERRIDES`. 14 unit tests novos (4 para `dirtyFiles`, 10 para command): clean tree, paths com espaço, rename/copy skip, falha git, parse de flags `--cwd`/`--help`/erros, contrato JSON do stdout, todos os exit codes. Smoke: contra este repo (sujo) → exit 3 + `dirty_files` listando os arquivos modificados.
- [x] Implementar `cli/src/commands/detect-existing-linter.ts` (procura `.eslintrc*`, `.prettierrc*`, `biome.json`, `dprint.json`, devDeps em package.json) (why: SPEC §1.2 substituição com consentimento). Implementado como detector puro `detectExistingLinter({ cwd }, { existsFn?, readFileFn? })` + handler `runDetectExistingLinter(argv)`. Catálogo `TOOLS` enumera 4 ferramentas: `eslint` (linter), `prettier` (formatter), `biome` (both), `dprint` (formatter); cada tool combina três sinais — config files no root (probe explícito por nome, sem glob), `package.json` keys inline (`eslintConfig`, `prettier`) emitidas como path virtual `package.json#<key>`, e `pkgNames` checados contra `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`. Biome aparece em ambas as arrays. Tools com zero evidência são omitidos. `package.json` malformado / não-objeto / ausente é tratado como "sem evidência" sem throw (parseDefensive + try/catch em `defaultReadFile`). Stdout JSON: `{ linters, formatters }` (contrato PLAN §Contratos CLI). Exit code: sempre `OK` em sucesso (read-only); `USAGE_ERROR` em flag desconhecida. Wired no dispatcher via `HANDLER_OVERRIDES`. 24 unit tests cobrindo: empty repo, ESLint legacy/flat config/inline/devDep, Prettier configs+inline, Biome em ambas as arrays, dprint, multi-tool brownfield, dedup de múltiplos eslint configs, malformed package.json, peer/optional deps, parser de flags. Smoke test: contra fixture sintético com ESLint+Prettier+Biome+inline-prettier → output canônico esperado; contra este repo → arrays vazias.
- [x] Implementar `cli/src/commands/detect-test-runner.ts` (procura `vitest.config.*`, `jest.config.*`, devDeps; lê thresholds atuais se houver) (why: SPEC §3 estratégia coverage – detectar antes de propor). Detector puro `detectTestRunner({ cwd }, { existsFn?, readFileFn? })` + handler `runDetectTestRunner(argv)`. Catálogo `RUNNERS` cobre vitest (configs `vitest.config.{ts,mts,cts,js,mjs,cjs}` + workspace variants + `package.json#vitest` + dep `vitest`) e jest (configs `jest.config.{ts,mts,cts,js,mjs,cjs,json}` + `package.json#jest` + dep `jest`). `vite.config.*` deliberadamente NÃO probed (false positives em projetos pure-Vite sem testes). Threshold reading com duas estratégias: (i) JSON exato (parseDefensive) para `*.json` configs e `package.json#jest` — extrai `coverageThreshold.global.{lines,functions,branches,statements}` para jest e `test.coverage.thresholds.*` ou `coverage.thresholds.*` para vitest; (ii) regex best-effort para JS/TS configs, escopado a containers conhecidos (`thresholds`/`coverageThreshold`/`global`) com janela de ~600 chars para evitar grab de `lines: 80` orfãos. Tie-break runner: score = `configs.length*2 + (pkg_dep?1:0)`; vitest vence em empate (SPEC §3 default recomendado). Output: `{ runner, candidates: { vitest, jest }, coverage: { configured, current_thresholds, current_values:null, source } }`. Exit codes: sempre `OK` em sucesso (read-only); `USAGE_ERROR` em flag desconhecida. Wired no dispatcher via `HANDLER_OVERRIDES`. 25 unit tests cobrindo: empty repo, vitest/jest via config-only/dep-only, jest thresholds via JSON + JS regex + `package.json#jest` inline, vitest thresholds via TS regex + workspace.json, threshold=null quando container ausente, isolamento de `lines:` órfão fora de container, tie-break vitest vs jest (config strength + default preference), malformed package.json, peerDependencies, valores não-numéricos viram null, parser de flags. Smoke test: contra este repo → `runner:"vitest"`, `configs:["vitest.config.ts"]`, `current_thresholds:null` (vitest config não tem coverage.thresholds), `configured:true`.
- [ ] Implementar `cli/src/commands/detect-stage.ts` aplicando heurística greenfield/brownfield/legacy do SPEC §3 + emitir sinais brutos (why: SPEC §3 heurística estágio)
- [ ] Implementar `cli/src/commands/status.ts` agregando versões instaladas, presets ativos, estágio detectado, hooks, coverage threshold, tema do report (why: SPEC §2 `/lint:status`)
- [ ] Criar fixture `cli/tests/fixtures/greenfield-ts/` com `.git/`, `package.json` minimalista, ~5 arquivos `.ts`, sem linter (why: SPEC §5 T1 + §7.1 acceptance)
- [ ] Criar fixture `cli/tests/fixtures/brownfield-eslint-prettier/` com ESLint + Prettier configurados, ~5k LOC sintéticos (why: SPEC §5 T1 + §7.2 acceptance)
- [ ] Criar fixture `cli/tests/fixtures/legacy-monorepo/` (pnpm workspace, 3 packages, churn alto via commits sintéticos) (why: SPEC §5 T1 + §7.11 perf <30s)
- [ ] Criar fixture `cli/tests/fixtures/jest-with-coverage/` com `jest.config.js` contendo `coverageThreshold.global.lines=60` (why: SPEC §7.3 acceptance – preserva escolha do usuário)
- [ ] Criar fixture `cli/tests/fixtures/unsupported-python/` (`pyproject.toml`, sem TS) (why: SPEC §7.4 acceptance – recusa explícita)
- [ ] Escrever testes unitários vitest para cada detector contra cada fixture relevante (why: PLAN §Fase 1 verificação – tests/unit por detector)

## Priority 3: Fase 2 — Setup greenfield (escrita)

- [ ] Criar `cli/src/lib/fs-safe.ts` (escritas vão a `.lint-manifest.json` para uninstall completo; checa working tree limpo se `--strict`) (why: PLAN §Contratos CLI – manifest + safe-write)
- [ ] Copiar in-source `cli/src/presets/oxlint/{greenfield,brownfield-moderate,legacy}.{fast,deep}.json` com thresholds da tabela do SPEC §3 (why: SPEC §3 calibração; presets versionados)
- [ ] Copiar in-source `cli/src/presets/coverage/{vitest.greenfield.ts,vitest.brownfield.ts,vitest.legacy.ts,jest.greenfield.json,jest.brownfield.json,jest.legacy.json}` (why: SPEC §3 estratégia coverage)
- [ ] Criar template `cli/src/templates/post-edit.sh` com `set -euo pipefail` filtrando `$CLAUDE_FILE_PATHS` (why: SPEC §4 templates copiados)
- [ ] Criar template `cli/src/templates/lintstagedrc.example.js` (ES modules, fast antes de deep) (why: SPEC §4 templates)
- [ ] Criar template `cli/src/templates/lint-decisions.md.tpl` (registro append-only com data, rule, motivo, autor) (why: SPEC §4 + §6 Always)
- [ ] Criar template `cli/src/templates/package-scripts.json` com `lint`, `lint:deep`, `format`, `coverage` (why: SPEC §7.1 acceptance scripts)
- [ ] Implementar `cli/src/commands/install/oxlint.ts` (escreve `oxlint.fast.json` e `oxlint.deep.json` a partir do preset do estágio) (why: PLAN §Contratos CLI)
- [ ] Implementar `cli/src/commands/install/hook.ts` (merge em `.claude/settings.json` + escreve `.claude/hooks/post-edit.sh`) (why: SPEC §1.4 hook PostToolUse; SPEC §6 Ask first – merge se já existe)
- [ ] Implementar `cli/src/commands/install/scripts.ts` (merge idempotente em `package.json#scripts`) (why: PLAN §Contratos CLI – idempotência)
- [ ] Implementar `cli/src/commands/install/deps.ts` (chama `npm/pnpm/yarn/bun add` conforme `pkg-manager.ts`; instala oxlint, oxfmt, quality-metrics, ts-morph quando deep) (why: PLAN §Contratos CLI – install-deps)
- [ ] Implementar `cli/src/commands/install/husky.ts` (cria `.husky/pre-commit` + `.lintstagedrc.js`) (why: SPEC §1.4 lint-staged + husky)
- [ ] Criar `cli/src/lib/ts-config-edit.ts` editando `vitest.config.ts` via ts-morph preservando comentários (why: PLAN §Critical files – único caminho confiável p/ TS configs)
- [ ] Implementar `cli/src/commands/install/coverage.ts` (edita `vitest.config.ts` via ts-morph ou `jest.config.*` via JSON; respeita thresholds passados via `--thresholds`) (why: SPEC §3 + §7.3 acceptance)
- [ ] Criar `skills/lint/SKILL.md` (router conversacional ≤200 linhas, define `QUALY_CLI` env var pattern do PLAN §Resolução do CLI) (why: SPEC §4 SKILL.md frontmatter + tamanho)
- [ ] Criar `commands/lint/setup.md` (chama detect-* → AskUserQuestion (estágio, coverage) → install-* em ordem) (why: SPEC §2 `/lint:setup`)
- [ ] Criar `agents/lint-detector.md` (wrapper sobre `detect-*` retornando sumário ≤30 linhas) (why: SPEC §2 + §4 Subagents)
- [ ] Criar `agents/lint-installer.md` (wrapper sobre `install-*` por camadas com opt-out) (why: SPEC §2 + §4 Subagents)
- [ ] Escrever teste e2e em `cli/tests/e2e/setup-greenfield.test.ts` rodando `setup` no fixture e validando todos os artefatos do SPEC §7.1 (why: PLAN §Fase 2 verificação)

## Priority 4: Fase 3 — Migration / backup

- [ ] Implementar `cli/src/commands/backup/create.ts` (cria `.lint-backup/<ISO-timestamp>/` com cópias de arquivos passados via `--files`) (why: SPEC §6 Always – backup nomeado)
- [ ] Implementar `cli/src/commands/backup/list.ts` (lista timestamps + arquivos) (why: PLAN §Contratos CLI)
- [ ] Implementar `cli/src/commands/backup/restore.ts` (restore byte-a-byte do timestamp escolhido) (why: SPEC §7.2 acceptance – restaura byte-a-byte)
- [ ] Implementar `cli/src/commands/uninstall.ts` (lê `.lint-manifest.json` e remove tudo; flag `--keep-backup`) (why: SPEC §2 `/lint:uninstall`)
- [ ] Criar `commands/lint/uninstall.md` orquestrando uninstall + oferta de restore (why: SPEC §2)
- [ ] Criar `commands/lint/rollback.md` orquestrando `backup-restore` mais recente (why: SPEC §2 `/lint:rollback`)
- [ ] Criar `agents/lint-migrator.md` (wrapper backup + uninstall) (why: SPEC §2 + §4 Subagents)
- [ ] Escrever teste e2e em `cli/tests/e2e/setup-rollback-brownfield.test.ts` validando SPEC §7.2 (why: PLAN §Fase 3 verificação)

## Priority 5: Fase 4 — Audit + recommendations

- [ ] Criar `cli/src/lib/audit-schema.ts` (zod) refletindo o contrato JSON do SPEC §3 (why: PLAN §Verification – schema validação)
- [ ] Implementar `cli/src/commands/audit.ts` (executa oxlint+oxfmt+quality-metrics como subprocessos, agrega em `.lint-audit/<ts>.json` conforme schema) (why: SPEC §2 `/lint:audit` + §3 contrato)
- [ ] Implementar `cli/src/commands/audit-latest.ts` (lê o `.lint-audit/*.json` mais recente) (why: PLAN §Contratos CLI)
- [ ] Criar `docs/recs-heuristics.md` documentando regras determinísticas de geração de recomendação (why: PLAN §Fase 4 + ADR 0008)
- [ ] Implementar `cli/src/commands/recs/generate.ts` (heurísticas de `docs/recs-heuristics.md` → `candidates[]` com `id` estável + `rationale_stub`) (why: PLAN §Contratos CLI – determinismo)
- [ ] Implementar `cli/src/commands/recs/blast-radius.ts` (oxlint dry-run com config proposta vs atual; conta arquivos newly/no-longer violating) (why: SPEC §6 Always – mostrar blast_radius)
- [ ] Implementar `cli/src/commands/recs/apply.ts` (aplica patch de uma rec; faz append em `docs/lint-decisions.md`) (why: SPEC §7.6 acceptance + §6 Always)
- [ ] Criar `commands/lint/audit.md` orquestrando audit (why: SPEC §2)
- [ ] Criar `commands/lint/update.md` orquestrando iteração `recommendations[]` com AskUserQuestion (why: SPEC §2 + acoplamento audit↔update)
- [ ] Criar `agents/lint-auditor.md` (executa `recs-generate`, enriquece `rationale` com contexto do código, persiste `recommendations[]` no `.lint-audit/<ts>.json`; ≤30 linhas no sumário) (why: PLAN §Fase 4 + ADR 0008 – exceção autorizada)
- [ ] Criar `docs/adrs/0008-hybrid-recs-rationale.md` (why: PLAN §Fase 4 lista ADR obrigatório)
- [ ] Escrever teste e2e validando SPEC §7.5 (audit produz JSON válido, exit ≠0 em error-level) e §7.6 (rationale ≠ rationale_stub) (why: PLAN §Fase 4 verificação)

## Priority 6: Fase 5 — Rules management

- [ ] Implementar `cli/src/commands/rules/list.ts` (active, available, disabled com origem e severidade) (why: SPEC §2 `/lint:rules:list`)
- [ ] Implementar `cli/src/commands/rules/explain.ts` (descrição, racional, threshold, links) (why: SPEC §2 `/lint:rules:explain`)
- [ ] Implementar `cli/src/commands/rules/add.ts` (edita preset, append em `docs/lint-decisions.md`; suporta dry-run para blast radius) (why: SPEC §7.9 acceptance)
- [ ] Implementar `cli/src/commands/rules/remove.ts` (edita preset, exige `--reason`, append em `docs/lint-decisions.md`) (why: SPEC §6 Always – registrar motivo)
- [ ] Criar `commands/lint/rules/{list,add,remove,explain}.md` (why: SPEC §2)
- [ ] Escrever testes unit cobrindo idempotência de add/remove e formato de `lint-decisions.md` (why: PLAN §Fase 5 verificação)

## Priority 7: Fase 6 — Report visual

- [ ] Criar `cli/src/report/themes/linear-design-md/{light.css,dark.css,tokens.json}` (why: SPEC §4 default theme)
- [ ] Criar `cli/src/report/index.html` shell (why: SPEC §3 layout report)
- [ ] Criar `cli/src/report/data-loader.ts` (lê `.lint-audit/<latest>.json` + git stats + coverage do runner) (why: SPEC §4 estado fonte)
- [ ] Criar `cli/src/report/components/MetricCard.ts` (vanilla DOM ou Web Component) (why: SPEC §4 vanilla DOM)
- [ ] Criar `cli/src/report/components/ChartLine.ts` (chart.js, tendência por timestamp) (why: SPEC §7.7 acceptance – line de tendência)
- [ ] Criar `cli/src/report/components/ChartTreemap.ts` (chartjs-plugin-treemap por arquivo) (why: SPEC §7.7 acceptance – treemap)
- [ ] Criar `cli/src/report/components/ViolationsTable.ts` (top-N violações com sort) (why: SPEC §7.7 acceptance)
- [ ] Criar `cli/src/report/app.ts` (bootstrap, theme switcher persistente em localStorage, `prefers-reduced-motion`) (why: SPEC §4 a11y + tema)
- [ ] Criar `cli/src/report/server.ts` (`node:http` em `127.0.0.1` em porta livre; serve via esbuild on-the-fly) (why: SPEC §6 Never – não expor além de localhost)
- [ ] Criar `cli/src/report/export.ts` (HTML self-contained; CSS+JS+JSON inline; filtra `process.env`, paths absolutos do autor) (why: SPEC §6 Never – não embutir dados sensíveis)
- [ ] Implementar `cli/src/commands/report/serve.ts` (wraps `report/server.ts`; printa URL + porta) (why: PLAN §Contratos CLI)
- [ ] Implementar `cli/src/commands/report/export.ts` (wraps `report/export.ts` para `quality-report/<ts>.html`) (why: SPEC §7.7 acceptance)
- [ ] Criar `commands/lint/report.md` orquestrando serve → AskUserQuestion (export?) → export opcional (why: SPEC §2 + §6 Ask first)
- [ ] Escrever teste e2e validando export self-contained renderiza idêntico offline (why: PLAN §Fase 6 verificação)

## Priority 8: Fase 7 — Hardening + docs + ADRs restantes

- [ ] Criar `docs/stages.md` (why: SPEC §3 referência da heurística)
- [ ] Criar `docs/thresholds.md` (tabela completa por estágio + métrica) (why: SPEC §3)
- [ ] Criar `docs/coverage.md` (why: SPEC §3 estratégia)
- [ ] Criar `docs/audit-format.md` (contrato JSON) (why: SPEC §3 + §6 Always)
- [ ] Criar `docs/report-design.md` (princípios e como adicionar tema) (why: SPEC §3)
- [ ] Criar `docs/compatibility.md` (matriz de stacks) (why: SPEC §3 + §1 stacks suportadas)
- [ ] Criar `docs/adrs/0001-oxc-only-v1.md` (why: SPEC §3 ADR)
- [ ] Criar `docs/adrs/0002-named-backup-rollback.md` (why: SPEC §3 ADR)
- [ ] Criar `docs/adrs/0003-stage-detection-heuristic.md` (why: SPEC §3 ADR + justificativa thresholds)
- [ ] Criar `docs/adrs/0004-audit-update-coupling.md` (why: SPEC §3 ADR)
- [ ] Criar `docs/adrs/0005-report-ephemeral-server-with-export.md` (why: SPEC §3 ADR)
- [ ] Criar `README.md` raiz (instalação via `./install.sh`, pré-req Node ≥ 22.6, lista de comandos) (why: PLAN §Fase 7)
- [ ] Criar `CHANGELOG.md` inicial (why: SPEC §3 estrutura)
- [ ] Criar roteiros `tests/scenarios/setup-greenfield.md`, `setup-brownfield.md`, `audit-update.md`, `report-export.md`, `unsupported-stack.md` (why: SPEC §5 Tier T2)
- [ ] Adicionar script `pnpm test:e2e` no `cli/package.json` que executa cada fixture e compara contra `EXPECTED.json` versionado (why: PLAN §Verification)
- [ ] Validação final manual contra repo TS real fora dos fixtures (why: PLAN §Fase 7 verificação)
