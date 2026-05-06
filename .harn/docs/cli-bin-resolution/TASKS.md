# Tasks: CLI Bin Resolution Hotfix (v0.3.4)

> Acompanha `PLAN.md` e `SPEC.md`. Cada task é executável em uma sessão
> focada, com critérios de aceitação e passos de verificação explícitos.
> Tamanho-alvo: S–M. Nenhuma L; quebrar mais se aparecer.

## Fase 1 — Foundation (paralelizável)

### Task 1: Estender `ManifestEntryKind` com `runtime-node-modules`

**Descrição**: O manifest precisa registrar a árvore `node_modules/`
materializada como **uma única entry** (não uma por arquivo) com kind novo
`runtime-node-modules`, para o uninstall poder fazer `rm -rf` no diretório
inteiro. A leitura de manifests v0.3.3 não pode regredir — kinds desconhecidos
devem ser tolerados sem throw.

**Critérios de aceitação**:
- [ ] `ManifestEntryKind` em `cli/src/install/manifest.ts:25` inclui
      `"runtime-node-modules"`.
- [ ] Unit test prova que `readManifest` atual já tolera kind desconhecido
      sem throw (auditoria já confirmou que `return parsed as Manifest` não
      valida kinds — test apenas trava o invariante para o futuro).
- [ ] `MANIFEST_VERSION` permanece `"1"` (mudança é aditiva).
- [ ] Unit test cobre: gravar + ler entry com kind novo; ler manifest legado
      v0.3.3 sem entry runtime; ler manifest com kind desconhecido sem throw.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/manifest.test.ts` verde.
- [ ] `npm run typecheck` verde.

**Dependencies**: Nenhuma.

**Files likely touched**:
- `cli/src/install/manifest.ts`
- `cli/tests/unit/install/manifest.test.ts`

**Estimated scope**: XS (1–2 arquivos).

---

### Task 2: Remover `cli/` do payload copiado

**Descrição**: Tirar `"cli"` de `TOP_LEVEL_DIRS` em `cli/src/install/copy.ts:58`,
remover o branch `cli/...` em `mapTarget()`, apagar o set `SKIP_RELATIVE`
(agora ocioso). Atualizar a docstring do módulo: o payload passa a ser
`skills/`, `commands/`, `agents/` apenas. Bug 2 desaparece como side-effect
porque ninguém mais copia `cli/src/index.ts` para o target.

**Critérios de aceitação**:
- [ ] `walkPayload(source)` não emite nenhum path começando com `cli/`.
- [ ] `mapTarget(rel, target)` mantém comportamento identidade-prepend para
      `skills|commands|agents`.
- [ ] `SKIP_RELATIVE` removido (ou esvaziado e documentado como intencional
      vazio para manter shape do código — preferir remover).
- [ ] Docstring do módulo atualizada (`TOP_LEVEL_DIRS = ["skills", "commands", "agents"]`).
- [ ] Unit tests existentes em `copy.test.ts` ajustados: expectativas de
      `cli/...` removidas/invertidas.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/copy.test.ts` verde.
- [ ] `npm test -- cli/tests/unit/install/install.test.ts` continua verde
      (em manchete; pode falhar parcialmente até T4 — usar `it.skip`/`it.todo`
      pontual com TODO referenciando T4 caso necessário).

**Dependencies**: Nenhuma.

**Files likely touched**:
- `cli/src/install/copy.ts`
- `cli/tests/unit/install/copy.test.ts`

**Estimated scope**: XS (1–2 arquivos).

---

### Task 3: Novo módulo `materialize-runtime.ts`

**Descrição**: Criar `cli/src/install/materialize-runtime.ts` exportando
`materializeRuntime({ target, packageSpec, dryRun })` que: (a) cria/valida o
diretório `${target}/skills/lint/`, (b) escreve um stub mínimo
`package.json` (`{"name":"qualy-runtime","private":true}`) se ausente, (c)
spawna `npm install --omit=dev --no-save --no-audit --no-fund <packageSpec>`
com `stdio: "inherit"`, (d) mapeia falhas para erros nominais
(`EQUALY_INSTALL_NETWORK`, `EQUALY_INSTALL_FS`). **Retorna no resultado o
caminho relativo do stub criado** (`stubCreated: string | null`) para o
chamador (T4) registrar no manifest com kind `"other"`.

**Critérios de aceitação**:
- [ ] Função exportada com assinatura tipada (resultado discriminado
      `{ ok: true, stubCreated: string | null, runtimePath: string } | { ok: false, error, reason }`).
- [ ] Sempre usa `npm` (não detecta pm — decisão da PLAN §2).
- [ ] `--dry-run` retorna `{ ok: true, stubCreated: null }` sem spawnar nada
      nem criar stub.
- [ ] Stub `package.json` só é escrito se ausente; nunca sobrescreve.
      Quando criado, seu path relativo (ex. `skills/lint/package.json`) volta
      em `stubCreated`; quando já existia, `stubCreated: null`.
- [ ] `child_process.spawn` recebe args via array (não string concatenada —
      sem injeção).
- [ ] `packageSpec` validado no chamador (apenas `@hgflima/qualy@<semver>` é
      aceito; rejeitar valores que contenham `;`, `&`, `|`, espaço).
- [ ] Unit test: mocka `spawn`, valida args/cwd, valida criação do stub +
      retorno em `stubCreated`, valida idempotência (stub já existe →
      `stubCreated: null`), valida mapeamento de exit code → kind de erro.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/materialize-runtime.test.ts` verde.
- [ ] `npm run typecheck` verde.
- [ ] `npm run lint` verde.

**Dependencies**: Nenhuma.

**Files likely touched**:
- `cli/src/install/materialize-runtime.ts` (novo)
- `cli/tests/unit/install/materialize-runtime.test.ts` (novo)

**Estimated scope**: M (3 arquivos).

---

## Checkpoint A — Foundation pronta

- [ ] `npm run typecheck && npm run lint && npm test` todos verdes.
- [ ] Nenhum E2E verde foi quebrado (alguns podem ainda exigir T4; nesse caso
      flag temporário com `it.todo` referenciando T4).
- [ ] Revisão humana antes da Fase 2.

---

## Fase 2 — Install Integration

### Task 4: Integrar `materializeRuntime()` em `installHarness`

**Descrição**: No pipeline de `cli/src/install/install.ts`, após `copyPayload()`
e antes de gravar o manifest, chamar `materializeRuntime({ target: <scopeRoot>, packageSpec: '@hgflima/qualy@${version}', dryRun: opts.dryRun })`. A
versão é a mesma já lida via `readPackageVersion(source)`. **Adicionar duas
entries ao manifest**: (i) kind `runtime-node-modules` com path
`skills/lint/node_modules` (sem hash — diretório); (ii) kind `"other"` com
path `skills/lint/package.json` (com sha256 do stub) — **somente se
`stubCreated` voltar não-nulo do materializeRuntime**.

**Critérios de aceitação**:
- [ ] `installHarness` retorna `error: "runtime_install_network"` |
      `"runtime_install_fs"` | `"runtime_install_unknown"` quando
      `materializeRuntime` falha (exit `1` recoverable).
- [ ] Manifest gravado contém **exatamente uma** entry com kind
      `runtime-node-modules` apontando para `skills/lint/node_modules`.
- [ ] Manifest contém entry kind `"other"` para `skills/lint/package.json`
      apenas quando o stub foi recém-criado por T3 (idempotência: reinstall
      não duplica entry).
- [ ] `--dry-run` continua não escrevendo bytes nem chamando npm.
- [ ] `--scope user|project|local` continuam todos funcionando.
- [ ] Saída JSON canônica inclui `runtime: { action: "materialized" | "skipped" | "dry-run" }` (campo novo no `InstallOk`).
- [ ] Unit test `install.test.ts` mocka `materializeRuntime`; valida ordem
      (copy → materialize → manifest write), propagação de erro, e que stub
      entra no manifest exatamente quando `stubCreated` é não-nulo.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/install.test.ts` verde.
- [ ] **Smoke manual**: dentro do repo qualy, `npm pack` → `mkdir /tmp/q-smoke
      && cd /tmp/q-smoke && git init && npx <abs-path>/hgflima-qualy-*.tgz install
      --scope local` produz `.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs`.
- [ ] **Smoke manual**: `node .claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs detect-stack --cwd "$PWD"` retorna JSON com exit `0`.

**Dependencies**: T1, T2, T3.

**Files likely touched**:
- `cli/src/install/install.ts`
- `cli/tests/unit/install/install.test.ts`

**Estimated scope**: M (2 arquivos, mudanças não-triviais).

---

## Checkpoint B — Install funcional

- [ ] Smoke manual da T4 acima passa em macOS Node 22.6+.
- [ ] Manifest contém entry runtime correta.
- [ ] **Bug 1 e Bug 2 ambos invisíveis** (validar com `detect-stack` e
      `rules-list`, ambos importam zod / fast-glob).
- [ ] Revisão humana antes da Fase 3.

---

## Fase 3 — Consumers (paralelizáveis pós-T4)

### Task 5: Uninstall — remover `runtime-node-modules` recursivamente

**Descrição**: Em `cli/src/install/uninstall.ts`, no loop sobre
`manifest.entries`, detectar `entry.kind === "runtime-node-modules"` e usar
`rmSync(abs, { recursive: true, force: true })` em vez de `unlinkSync`.
Manter o resto do contrato intacto (kept[] com `already-absent`, manifest
delete final, rmdir best-effort dos parents).

**Critérios de aceitação**:
- [ ] Entry kind `runtime-node-modules` resulta em remoção recursiva.
- [ ] `--dry-run` continua não tocando o FS.
- [ ] `ENOENT` na entry runtime mapeia para `kept[]` com `already-absent`
      (consistente com o resto do uninstall).
- [ ] Outras kinds (`skill`, `command`, `agent`, `cli`, `other`) continuam
      usando `unlinkSync`.
- [ ] Unit test cobre: install + uninstall em tmpdir; valida que
      `.claude/skills/lint/node_modules/` não existe pós-uninstall.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/uninstall.test.ts` verde.

**Dependencies**: T4 (precisa do manifest com a nova entry para testar).

**Files likely touched**:
- `cli/src/install/uninstall.ts`
- `cli/tests/unit/install/uninstall.test.ts`

**Estimated scope**: S (2 arquivos).

---

### Task 6: Update — re-materializar em bump

**Descrição**: Auditar `cli/src/install/update.ts`. O fluxo atual delega para
`npx @hgflima/qualy@<latest> install --scope <X> --cwd <Y> --yes`, que **já**
vai entrar no novo `installHarness` modificado em T4 — então a
re-materialização vem de graça. Tarefa: validar com teste E2E, garantir que
`up-to-date` (versão local == latest) **não** dispara reinstall desnecessário,
e documentar o comportamento na docstring.

**Critérios de aceitação**:
- [ ] Quando `installed_version === latest`, retorna `status: "up-to-date"`
      sem chamar `applyInstall` (já é o caso hoje; só validar).
- [ ] Quando há bump (minor ou patch), `applyInstall` reusa o caminho `npx
      install` que cobre re-materialização.
- [ ] Docstring de `update.ts` atualizada explicando que o `npm install`
      embutido vem do install pipeline (não duplicado aqui).
- [ ] Unit/E2E test cobre re-materialização: monta um install em v=X, força
      manifest para v=X-1, roda `update`, verifica que
      `node_modules/@hgflima/qualy/package.json` tem `version: X`.

**Verificação**:
- [ ] `npm test -- cli/tests/unit/install/update.test.ts` verde.
- [ ] `npm run test:e2e -- update` (se houver E2E) verde.

**Dependencies**: T4.

**Files likely touched**:
- `cli/src/install/update.ts` (docstring + possivelmente nada mais)
- `cli/tests/unit/install/update.test.ts`

**Estimated scope**: S (1–2 arquivos, mudança mínima além de testes).

---

### Task 7a: SKILL.md preamble + 14 commands

**Descrição**: Substituir o preâmbulo canônico em `skills/lint/SKILL.md`
(seção "Resolução do CLI") pelo novo bloco que resolve `QUALY_BIN` apontando
para `bin/qualy.mjs` materializado, com fallback `QUALY_DEV_BIN` para uso
no repo qualy. Atualizar todos os 14 `.md` em `commands/lint/` (mesma busca:
`grep -rl 'cli/src/index.ts\|QUALY_CLI' commands/lint/`):
`setup.md`, `audit.md`, `report.md`, `rollback.md`, `uninstall.md`,
`update.md`, `ignore/{add,explain,list,remove}.md`,
`rules/{add,explain,list,remove}.md`.

**Critérios de aceitação**:
- [ ] `skills/lint/SKILL.md` contém o novo bloco bash do SPEC §4
      ("commands/lint/*.md → DEPOIS"), com fallback `QUALY_DEV_BIN`.
- [ ] Os 14 `commands/lint/**/*.md` referenciam o novo preâmbulo (cópia
      byte-a-byte do SKILL.md, mantendo a convenção atual).
- [ ] Mensagem de erro do exit 5 atualizada: "qualy not installed. Run
      `npx @hgflima/qualy install` first."
- [ ] `grep -rl 'cli/src/index.ts\|QUALY_CLI' commands/lint/ skills/lint/`
      retorna zero matches.

**Verificação**:
- [ ] `npm run test:e2e -- preamble-resolution` verde com novo bloco
      (T7a inclui a atualização do test E2E).
- [ ] Inspeção visual: cada `.md` mantém exemplos coerentes (`node
      "$QUALY_BIN"` em vez de `node --experimental-strip-types "$QUALY_CLI"`).

**Dependencies**: T4.

**Files likely touched**:
- `skills/lint/SKILL.md`
- `commands/lint/setup.md`, `audit.md`, `report.md`, `rollback.md`,
  `uninstall.md`, `update.md`
- `commands/lint/ignore/{add,explain,list,remove}.md`
- `commands/lint/rules/{add,explain,list,remove}.md`
- `cli/tests/e2e/preamble-resolution.test.ts`
- `cli/tests/unit/...` (parity test, se existir; auditar com
  `grep -rl preamble-parity cli/tests/`)

**Estimated scope**: M (~17 arquivos, mudanças mecânicas).

---

### Task 7b: Agents + auditoria final

**Descrição**: Atualizar os 4 agents em `agents/lint-*.md` (`lint-detector`,
`lint-installer`, `lint-migrator`, `lint-auditor`) com o mesmo preâmbulo
canônico de T7a. Auditar `docs/adrs/` — ADRs são imutáveis por princípio
(registram decisões passadas), portanto **não atualizar**; ADR novo (0014?)
é responsabilidade de T9 documentando a decisão de v0.3.4.

**Critérios de aceitação**:
- [ ] Os 4 `agents/lint-*.md` usam o novo preâmbulo `QUALY_BIN`.
- [ ] `grep -rl 'cli/src/index.ts\|QUALY_CLI' agents/` retorna zero.
- [ ] ADRs em `docs/adrs/` deixados intocados (decisões históricas).
- [ ] `grep -rl 'cli/src/index.ts' commands/ agents/ skills/` retorna **zero
      matches finais** (exceto possíveis ADRs históricos, que são imutáveis).

**Verificação**:
- [ ] `npm run lint && npm test && npm run test:e2e` todos verdes.
- [ ] Inspeção visual nos 4 agents: instruções coerentes pós-substituição.

**Dependencies**: T7a (mantém o bloco canônico em SKILL.md como source of
truth para os agents copiarem).

**Files likely touched**:
- `agents/lint-detector.md`
- `agents/lint-installer.md`
- `agents/lint-migrator.md`
- `agents/lint-auditor.md`

**Estimated scope**: S (4 arquivos, mudança mecânica).

---

## Checkpoint C — Consumers prontos

- [ ] T5, T6, T7a, T7b todos com critérios marcados.
- [ ] `npm test && npm run test:e2e` todos verdes.
- [ ] `grep -rl 'cli/src/index.ts\|QUALY_CLI' commands/ agents/ skills/`
      retorna zero (validação cross-task de T2 + T7a + T7b).
- [ ] Smoke manual: install + invocar `/lint:rules:list` (Bash literal:
      `node "$QUALY_BIN" rules-list --cwd "$PWD"`) retorna JSON sem stack
      trace.
- [ ] Revisão humana antes da Fase 4.

---

## Fase 4 — Validation & Release

### Task 8: E2E `cli-invocation` (smoke Bug 1 + Bug 2 via tarball local)

**Descrição**: Novo arquivo `cli/tests/e2e/cli-invocation.test.ts` que: em
`beforeAll`, roda `npm pack` no repo qualy gerando `hgflima-qualy-<v>.tgz`
em tmpdir; em cada cenário, monta tmpdir limpo, spawna `npm install
<abs-path>/hgflima-qualy-<v>.tgz --prefer-offline --no-audit --no-fund`
dentro de `.claude/skills/lint/` (replicando o que `materializeRuntime` faz),
depois spawna `node <tmp>/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs detect-stack --cwd <tmp>`
e valida exit 0 + JSON parseável + presença das chaves esperadas (`ok`,
`languages`, `runtimes`). **Não usa registry de produção** — `--prefer-offline`
+ tarball local cobrem o caminho real sem flaky de rede.

**Critérios de aceitação**:
- [ ] Test passa em CI (Linux runner, macOS local) sem dependência de
      registry npm — só usa cache + tarball local.
- [ ] Cobre Bug 1 (zod resolvível) e Bug 2 (`../../package.json` resolvível
      em `cli/src/index.ts:63`) sem mocks — execução real do entrypoint.
- [ ] `beforeAll` gera `npm pack` uma vez e reusa o tarball entre cenários
      (não regera por scenario, custo amortizado).
- [ ] Cleanup do tmpdir no `afterEach`; cleanup do tarball em `afterAll`.
- [ ] Timeout >= 60s (npm install local ainda pode demorar em CI frio).
- [ ] Cenário extra: invocar também `rules-list` (importa `fast-glob`) e
      uma chamada que toca `zod` — cobre as 6 deps mencionadas no SPEC §1
      Bug 1.

**Verificação**:
- [ ] `npm run test:e2e -- cli-invocation` verde.
- [ ] CI runner verde após push.

**Dependencies**: T4–T7.

**Files likely touched**:
- `cli/tests/e2e/cli-invocation.test.ts` (novo)
- Possivelmente fixture tarball em `cli/tests/fixtures/`.

**Estimated scope**: M (1 arquivo, lógica de orchestração não-trivial).

---

### Task 9: Smoke manual + Release v0.3.4

**Descrição**: Executar a sequência da SPEC §3 ("Verificação local antes de
publicar") em macOS Node 22.6+ e em CI Linux runner. Atualizar CHANGELOG
documentando: (a) Bug 1 + Bug 2 corrigidos, (b) **upgrade path para adopters
da v0.3.3 quebrada**: instrução explícita `qualy uninstall && qualy install`
(ou `qualy update --yes`) — reinstall via fluxo normal limpa qualquer estado
intermediário, incluindo o workaround manual (`rm .claude/skills/lint/package.json`)
que alguns adopters aplicaram, (c) nova entry kind `runtime-node-modules` no
manifest + entry `"other"` para o stub `package.json`. Bump 0.3.3 → 0.3.4 via
fluxo padrão (per memory: `release_workflow`): bump + CHANGELOG + commit + tag
+ push + `gh release create` (NÃO bare tag push — esse não dispara publish).

**Critérios de aceitação**:
- [ ] Smoke macOS: 5 critérios da SPEC §1 verdes.
- [ ] Smoke CI: workflow existente verde no PR.
- [ ] CHANGELOG.md tem seção `## v0.3.4` com bullets do hotfix + nota do
      workaround.
- [ ] Q4 da PLAN §7 (workflow CI usa `--scope user`?) auditada e validada
      antes do release.
- [ ] Tag `v0.3.4` criada e GitHub Release publicada via `gh release create`
      → CI publica no npm.
- [ ] Pós-publish: `npx @hgflima/qualy@0.3.4 install` em tmpdir limpa funciona
      end-to-end.

**Verificação**:
- [ ] `npm view @hgflima/qualy version` retorna `0.3.4`.
- [ ] Smoke pós-publish verde.

**Dependencies**: T8.

**Files likely touched**:
- `package.json` (version bump)
- `CHANGELOG.md`
- Tag/release no GitHub (não é arquivo).

**Estimated scope**: S (2 arquivos + workflow externo).

---

## Checkpoint D — Pronto para merge & release

- [ ] Todos os 9 tasks com critérios marcados.
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:e2e`
      verdes.
- [ ] Smoke manual + CI verdes.
- [ ] CHANGELOG documentado.
- [ ] PR aprovado por revisão humana.
- [ ] v0.3.4 publicada no npm.
- [ ] Validar com pelo menos um adopter externo que `/lint:rules:list`
      funciona em projeto limpo pós-install.

---

## Pontos de atenção (decisões já fechadas)

- **T1 manifest tolerância**: ✅ resolvido — auditoria confirmou que
  `readManifest` retorna `parsed as Manifest` sem validar kinds. T1 só
  adiciona test que trava o invariante.
- **T7 escopo**: ✅ resolvido — 19 arquivos funcionais (14 commands + 4
  agents + 1 SKILL.md). Dividido em T7a (15 arquivos) e T7b (4 arquivos).
- **T8 dependência de rede**: ✅ resolvido — usar tarball local via `npm
  pack` em `beforeAll` + `npm install --prefer-offline`. CI offline-friendly.
- **T9 timing**: release workflow listen em `release:published`. Bare tag
  push NÃO publica (memory: `release_workflow`). Passo correto:
  `gh release create v0.3.4 --notes-from-tag`.
