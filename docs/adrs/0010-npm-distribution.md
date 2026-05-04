# ADR 0010 — Distribuição via npm (`npx @hgflima/qualy install`)

- Status: aceito
- Data: 2026-05-04
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0007 (runtime TS via `--experimental-strip-types`), ADR 0009 (`install.sh` em v0)

## Contexto

ADR 0009 fixou `install.sh` como mecanismo único de distribuição em v0. A decisão era explicitamente provisória: SPEC §3 daquela fase declarava plugin Claude Code nativo como evolução, e o script Bash atendia o público técnico inicial (autor + early users) que já tinha o repo clonado para iterar.

Com o produto entrando em uso real em projetos onde o usuário **não** quer clonar o `qualy/` para experimentar, o atrito de "git clone + ./install.sh" tornou-se o gargalo dominante. Os sinais relevantes:

- Adopter individual quer rodar a skill em qualquer projeto sem clonar nada (`npx <pkg> install` resolve sob demanda).
- Times querem versionar o harness no próprio repositório (`<repo>/.claude/`), não no `~/.claude/` global do dev — `install.sh` só sabe instalar em `$HOME`.
- Sem registro de versão por instalação, é impossível reproduzir um setup entre máquinas/CIs ou auditar drift quando algo quebra.
- Plugin Claude Code nativo continua em formato/política em evolução — congelar agora travaria decisões (manifest, update, telemetria) sem aprendizado suficiente.
- O CLI roda direto do fonte (`cli/src/*.ts`) via `--experimental-strip-types` (ADR 0007) — não há `dist/`. Qualquer formato de distribuição precisa carregar TS puro e aceitar que a execução é via flag de Node.
- O autor precisa continuar iterando no `qualy/` enquanto usa a skill em outros projetos — o ciclo `editar → reinstalar` do modo symlink (`install.sh --dev`) precisa ser preservado.

A questão é: **como entregar uma instalação reprodutível, descobrível, multi-escopo, sem comprometer o zero-build-step do ADR 0007 nem perder o fluxo dev-mode?**

## Decisão

Adotar **`npm` como mecanismo primário de distribuição** a partir de v0.1.0, com `npx @hgflima/qualy install --scope <user|project|local>` como ponto de entrada documentado. `install.sh` permanece no repo apenas como fluxo `--dev` para mantenedores, com soft deprecation no caminho default (TASKS 4.2).

Cinco subdecisões abaixo (D1–D5) detalham os pontos não-óbvios. Todas foram resolvidas em 2026-05-04 via AskUserQuestion no PLAN §3.

### D1 — Conflito de nome: `uninstall` (lint stack) vs `qualy uninstall` (harness)

**Problema.** `cli/src/commands/uninstall.ts` já existia e removia o stack de lint (oxlint/hooks/husky) lendo o `.lint-manifest.json` do projeto-alvo. A nova SPEC introduz `qualy uninstall` para remover o **harness** de um escopo. Mesmo nome, semântica diferente.

**Decisão.** Renomear o subcomando existente para `lint-uninstall`. Sem alias de deprecation.

**Rationale.** O subcomando antigo emparelha com o slash command `/lint:uninstall` (skill `lint:uninstall`) — chamá-lo `lint-uninstall` torna a relação 1:1 explícita e libera o nome `uninstall` para o conceito de mais alto nível (remover o harness). Adicionar alias retroativo manteria duas formas equivalentes em todos os docs/agentes/help — mais ruído do que benefício em 0.x. O rename é breaking, mas a janela 0.x é exatamente onde quebras desse tipo são esperadas; está registrado no CHANGELOG 0.1.0.

### D2 — Filename do manifest do harness

**Problema.** A SPEC original sugeria "estender `.lint-manifest.json` com campos de versão". Mas o **manifest do projeto-lint** vive em `<repo-root>/.lint-manifest.json` (rastreia oxlint configs, hooks, husky, scripts), e o **manifest do harness** viveria em `<scope>/.claude/.lint-manifest.json` (rastreia skills/commands/agents/cli e versão). Mesmo filename, schemas distintos.

**Decisão.** Manter o nome `.lint-manifest.json`, discriminar por presença do campo `scope`.

**Rationale.** Os dois arquivos vivem em paths diferentes — nenhum tooling lê os dois ao mesmo tempo. Inventar um segundo nome (`.harness-manifest.json`?) duplicaria a área de cobertura de testes e adicionaria mais um path para o desinstalador conhecer. Em vez disso, `manifest.ts` (novo) trata `scope: "user"|"project"|"local"` + `harness_version: string` + `installer: "npx"|"install.sh"` como obrigatórios em manifests do harness, e **recusa** ler manifests sem `scope` (ou seja, o do lint stack), evitando que um caminho toque o do outro por acidente.

### D3 — Como o `bin` do npm executa `cli/src/index.ts` em TS puro

**Problema.** `cli/src/index.ts` exige `node --experimental-strip-types`. O campo `"bin"` do `package.json` aponta para um único arquivo executável; não há onde passar flags ao Node.

**Decisão.** Shim `bin/qualy.mjs` que faz `child_process.spawn('node', ['--experimental-strip-types', resolve(__dirname, '../cli/src/index.ts'), ...process.argv.slice(2)], { stdio: 'inherit' })`.

**Rationale.** ~15 linhas, zero deps, portável em qualquer Unix. Custa ~30-50ms de overhead por invocação (irrelevante para `install`/`update`, que medem em segundos). `env -S "node --experimental-strip-types"` na shebang do `index.ts` foi rejeitado: exige `coreutils >= 8.30`, instável em macOS pré-Sequoia e WSL básico, e mascara o requisito de Node em uma camada de Bash que a maioria dos usuários não inspeciona. Pre-compile via esbuild foi rejeitado por violar o "sem build step" da SPEC (ADR 0007).

### D4 — Como `qualy update` descobre `latest`

**Problema.** SPEC §1 diz que o CLI detecta nova versão no npm — é a primeira (e única) operação que toca a rede. Precisa decidir o mecanismo, com timeout claro e mapeamento de erros úteis.

**Decisão.** `npm view @hgflima/qualy version` via `child_process.spawn`, com timeout default 5s e classes de erro discriminadas (`network`, `auth`, `mirror`, `unknown`).

**Rationale.** Reusa o npm CLI que todo usuário npx já tem — sem nova runtime dependency. `npm view` resolve por baixo dos panos: redirects, autenticação para registries privados, fingerprint correto de User-Agent, configuração de proxy local em `~/.npmrc`. Bater no endpoint HTTP direto (`https://registry.npmjs.org/...`) exigiria reimplementar tudo isso à mão. Lib dedicada (`npm-registry-fetch`) foi rejeitada por violar "sem novas runtime dependencies" da SPEC. Flag `--registry <url>` para enterprise fica fora de v1: adicionar quando alguém pedir.

### D5 — Versão de `cli/package.json` vs `package.json` raiz

**Problema.** Ao bumpar a raiz para `0.1.0`, o que fazer com `cli/package.json` que está em `0.0.0`?

**Decisão.** Manter `cli/package.json` em `0.0.0` permanentemente.

**Rationale.** `cli/` é workspace interno, **nunca** publicado isolado. Marcar `0.0.0` sinaliza "não publishable" e protege contra `npm publish` acidental rodado de dentro de `cli/`. `readPackageVersion()` resolve sempre via `package.json` raiz (sobe de `import.meta.url` até achar o `package.json` com `"name": "@hgflima/qualy"`) — não há ambiguidade em runtime. Custo zero: nenhum bump duplo a cada release. Script de sync foi rejeitado por adicionar complexidade desnecessária para um benefício inexistente.

## Consequências

**Positivas**

- Adoção drasticamente mais simples: `npx @hgflima/qualy install --scope local` funciona em qualquer máquina com Node ≥ 22.6, sem clone, sem build, sem `npm i -g`. O atrito principal de v0 (clone + bash) sai do caminho.
- Três escopos cobrem três workflows reais (`user` para a toolbox pessoal, `project` para times com config commitada, `local` para experimentação gitignored), sem expor um único path "global" que confunda usuários compartilhando uma mesma máquina.
- Manifest versionado por escopo (D2) torna o ciclo install/uninstall determinístico e reproduzível — `qualy uninstall` remove byte-a-byte o que o manifest registrou, e nada além (anti-órfão).
- Update flow nativo (`qualy update`, D4) com mensagens de erro acionáveis em quatro classes (network/auth/mirror/unknown) reduz o suporte humano necessário quando algo falha.
- Shim de bin (D3) preserva o zero-build-step do ADR 0007 — o `.ts` em disco continua sendo o que executa, sem release artifacts a sincronizar.
- `install.sh --dev` segue funcional para o ciclo de iteração local do mantenedor — ADR 0009 não é revogada, só rebaixada a fluxo dev-only com soft deprecation no caminho default (TASKS 4.2).

**Negativas / tradeoffs**

- Adiciona uma fronteira de release: bump de versão raiz + tag git + workflow `publish.yml` por OIDC/Trusted Publisher. Mais cerimônia por release, em troca de um caminho de update reprodutível.
- Rename `uninstall` → `lint-uninstall` (D1) é breaking em todos os agentes/skills/docs que mencionavam o subcomando — atualizado num único commit, registrado no CHANGELOG 0.1.0. Um usuário que tenha automatizado `qualy uninstall` para limpar o lint stack precisa atualizar seu script.
- Manifest com filename compartilhado (D2) exige que toda lógica futura que toque `.lint-manifest.json` discrimine por `scope`. O risco de ler o "manifest errado" é mitigado em código (`manifest.ts` recusa manifests sem `scope`), mas continua sendo uma armadilha para quem editar à mão.
- Shim adiciona um spawn por invocação (~30-50ms). Imperceptível para `install`/`update`, mas mensurável em loops apertados — não esperado em uso real.
- `npm view` (D4) introduz dependência implícita do npm CLI estar no PATH. Hoje é universal entre usuários npx; se um futuro `bunx`-only ecossistema emergir sem `npm`, a função degrada para `unknown`.
- `cli/package.json` permanente em `0.0.0` (D5) cria descontinuidade visual (raiz `0.1.0`, subpkg `0.0.0`). Mitigado por uma linha em `cli/package.json` explicando "não publishable" e por `readPackageVersion()` ler sempre da raiz.

## Alternativas consideradas

- **Continuar só com `install.sh`.** Rejeitada: o atrito de clone-and-bash é exatamente o que está bloqueando adoção. ADR 0009 sempre foi explícita sobre ser provisória.
- **Plugin Claude Code nativo (marketplace).** Postergada (não rejeitada): o formato/política de plugins ainda está se mexendo. Empacotar agora congelaria decisões (estrutura de manifest, mecanismo de update, telemetria opt-in) que dependem de aprendizado com early users. Reaberto quando os contratos do CLI estiverem estáveis. Quando vier, `npx <pkg> install` continua útil para escopos `project`/`local` (que o plugin marketplace provavelmente não cobre da mesma forma).
- **`npm install -g qualy`.** Rejeitada: `-g` colide com múltiplas versões do harness por máquina (impossível ter `0.1.x` num projeto e `0.2.x` em outro), e requer permissões elevadas em alguns sistemas. `npx <pkg>@<version>` resolve sob demanda sem sujar o sistema, e o `update` flow troca a versão por escopo, não por máquina.
- **Pacote `tar.gz` em GitHub Releases + `curl | tar`.** Rejeitada: reinventa update/version-discovery. npm já resolve isso com infra estável.
- **`env -S "node --experimental-strip-types"` na shebang em vez do shim (D3).** Rejeitada por requer coreutils ≥ 8.30 (instável em macOS pré-Sequoia, WSL básico) e por mascarar o requisito de Node atrás de uma camada Bash.
- **Lib HTTP dedicada para registry (D4).** `npm-registry-fetch` ou similar. Rejeitada por violar "sem novas runtime dependencies"; reusar o npm CLI cobre todos os cenários reais (auth, redirects, mirror) sem código novo.
- **Schema separado para o manifest do harness (D2).** `.harness-manifest.json` ou similar. Rejeitada por duplicar área de testes sem benefício — paths diferentes já desambiguam, e a discriminação por `scope` é checagem trivial em runtime.
- **Bumpar `cli/package.json` em sincronia com a raiz (D5).** Rejeitada por adicionar bump duplo a cada release sem benefício; o subpkg nunca é publicado.

## Verificação

- `npx @hgflima/qualy install --scope local --dry-run` em repo sintético (`mktemp -d && git init`) reporta plano e não escreve bytes (e2e: `cli/tests/e2e/install/install-scopes.test.ts`).
- `npx @hgflima/qualy install --scope project` em repo com `.git/` cria `<cwd>/.claude/.lint-manifest.json` com `scope: "project"` e payload completo (e2e idem).
- `npx @hgflima/qualy uninstall --scope <X>` remove byte-a-byte tudo do manifest e o próprio manifest; arquivos órfãos do usuário em `.claude/` permanecem (e2e: `cli/tests/e2e/install/uninstall-roundtrip.test.ts`).
- `qualy update` mapeia 4 classes de erro (`network`, `auth`, `mirror`, `unknown`) com mensagem específica (unit: `cli/tests/unit/install/update.test.ts`).
- `npm pack --dry-run` produz tarball com paths exatos esperados, sem `cli/tests/`, `cli/node_modules/`, `.harn/`, `install.sh` (e2e + snapshot: `cli/tests/e2e/install/pack-contents.test.ts`).
- `bin/qualy.mjs` é publicado com mode `0o755` e dispara `cli/src/index.ts` com `--experimental-strip-types` (validado pelo mesmo pack-contents test).
- Paridade `install.sh --dev` ↔ `npx @hgflima/qualy install --scope user`: mesmos paths sob `.claude/` modulo manifest e dirs dev-only (e2e: `cli/tests/e2e/install/install-sh-parity.test.ts`).
- Workflow `.github/workflows/publish.yml` em tag `v*` publica via OIDC Trusted Publisher (sem `NPM_TOKEN` em segredo); rollback documentado em TASKS 3.4.
- README seção `## Installation` cobre os três escopos com exemplo executável e nota sobre `install.sh --dev`.
