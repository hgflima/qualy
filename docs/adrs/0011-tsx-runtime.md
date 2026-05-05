# ADR 0011 — Runtime TS via `tsx` (substitui `--experimental-strip-types`)

- Status: aceito
- Data: 2026-05-05
- Relacionados: ADR 0007 (superseded), ADR 0010 D3 (amended), ADR 0006 (CLI determinístico)

## Contexto

`@hgflima/qualy@0.1.0` foi publicado em 2026-05-04 e o smoke pós-publish revelou bug crítico:

```
$ npx -y -p '@hgflima/qualy@0.1.0' -- qualy --version
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
unsupported for files under node_modules, for "file:///.../node_modules/
@hgflima/qualy/cli/src/index.ts"
```

ADR 0007 fixou Node ≥ 22.6 com `--experimental-strip-types` como runtime, e ADR 0010 D3 escolheu o shim `bin/qualy.mjs` que faz `spawn(node, ['--experimental-strip-types', '../cli/src/index.ts', ...])`. A combinação funciona perfeitamente quando o CLI é executado a partir do checkout do repo (cenário `install.sh --dev`), mas falha quando o pacote é instalado via npm/npx, porque o entry point termina em `node_modules/@hgflima/qualy/cli/src/index.ts`.

**Causa raiz é arquitetural, não circunstancial.** Node recusa-se **por design** a stripar tipos de arquivos dentro de `node_modules/`: a flag existe para autoria local, não como runtime de pacotes publicados. Não há flag para contornar, e não há plano dos maintainers para mudar — bumpar Node não resolve.

**Por que escapou dos testes.** A suite e2e existente (`pack-contents`, `install-scopes`, `install-sh-parity`, `uninstall-roundtrip`) executa o CLI a partir do checkout (fora de `node_modules/`) ou valida apenas a *lista* de arquivos no tarball. Nenhum teste executava o binário pós-`npm install`. Esse smoke estava faltando — a SPEC original supôs que "se o tarball está sano, o binário roda".

A questão é: **como tornar `cli/src/*.ts` executável dentro de `node_modules/` preservando o zero-build-step do ADR 0007 (sem `dist/`, sem `prepack`, edits refletem imediatamente em `--dev`)?**

## Decisão

Adotar **`tsx` como runtime do shim publicado**, substituindo `--experimental-strip-types`. Caminho único, sem fallback condicional.

Implementação:

1. **`bin/qualy.mjs`** resolve `tsx/cli` via `createRequire(import.meta.url).resolve("tsx/cli")` e faz `spawn(process.execPath, [tsxBin, entry, ...argv.slice(2)], { stdio: 'inherit' })`. `createRequire` sobrevive a hoisting de npm/pnpm/yarn — não há hardcode de `node_modules/tsx/dist/cli.js`.
2. **`tsx ^4.19.0`** entra em `dependencies` da raiz (não `devDependencies`). É runtime de qualquer install.
3. **Demais runtime deps do CLI publicado (`zod`, `ts-morph`, `esbuild`, `chart.js`, `chartjs-chart-treemap`)** também migram para `dependencies` da raiz. Antes elas só viviam em `cli/package.json` (workspace privado, não publicado) e em `devDependencies` da raiz — mascaradas pelo erro de strip-types, ficaram aparentes assim que o shim começou a executar com sucesso.
4. **`engines.node`** baixa de `>=22.6.0` para `>=20.0.0`. tsx suporta Node ≥ 18, mas alinhamos com o default do `actions/setup-node@v4` no CI e com a versão LTS atual.
5. **Sem build step novo.** ADR 0010 D3 amended (não revogada): `bin/qualy.mjs` continua o ponto de entrada; só muda o que ele faz spawn.
6. **`scripts.build`** continua noop (`echo ... && exit 0`); a string apenas troca a justificativa ("Node 22.6+ via strip-types" → "via tsx loader").

## Consequências

**Positivas**

- `@hgflima/qualy@X.Y.Z` torna-se executável quando instalado via npm/npx — objetivo primário do fix. Critério SPEC §9 #4 (`npm install` + `qualy --version` exit 0 sem `ERR_UNSUPPORTED`) verde.
- Floor de Node desce para 20 LTS, ampliando base de usuários sem perder paridade com `setup-node@v4`. Usuários em Node 20 que estavam bloqueados por ADR 0007 voltam a funcionar.
- Continua zero-build-step: nada de `dist/`, `prepack`, ou tsc emit. Edits em `cli/src/` refletem instantaneamente em `--dev` (ADR 0009) e nos workspaces locais.
- Stack traces continuam apontando para `.ts` original (tsx preserva isso, igual a strip-types).
- `createRequire` é a forma oficial recomendada para resolver deps publicadas de dentro de ESM — sobrevive hoisting de pnpm/yarn sem código condicional.

**Negativas / tradeoffs**

- Tarball ganha `tsx` (~1MB instalado) + suas transitivas (esbuild já estava na lista por outras razões; se já estiver em `node_modules/` do consumidor, npm dedupe). Custo aceitável dado o ganho.
- Adiciona uma dependência runtime que precisamos vigiar (versões, breaking changes em majors). Mitigado pelo range `^4.19.0` e por tsx ser amplamente adotado/maintido.
- Spawn overhead inalterado vs ADR 0007 (já era ~30-50ms via shim → child node); tsx adiciona alguns ms de bootstrap no child. Imperceptível para `install`/`update`.
- ADR 0007 fica como histórico; o pattern "node --experimental-strip-types `<path>`" usado em Bash blocks de `commands/lint/*.md` continua válido **só** no contexto de uso dev (`install.sh --dev` aponta para checkout fora de `node_modules`). Para invocações via pacote publicado, todo mundo passa pelo shim, então o pattern não vaza.
- `cli/package.json` continua listando suas próprias `dependencies` (não publicadas — `private: true`); fica um pouco mais ruidoso ter as mesmas deps em dois lugares. Aceitável: cli/package.json é workspace local e dá metadata aos test runners; root é a fonte de verdade do pacote publicado.

## Alternativas consideradas

- **Bundle via esbuild (`cli/dist/qualy.mjs`).** Rejeitada — viola o "no build step" do ADR 0007 (mantido). Cria artefato versionado, exige `prepack`/CI step antes de cada release, quebra o modo `--dev` (symlink só do `dist/`). O ganho em startup é negligível para um CLI deste porte; o custo arquitetural é alto.
- **Workaround para `--experimental-strip-types` em `node_modules/`.** Não existe. Node implementa essa restrição deliberadamente — a flag existe para autoria local e não há intenção de habilitá-la dentro de pacotes instalados (rastreamos as discussões upstream antes de optar pelo tsx).
- **Bumpar Node para versão futura que talvez resolva.** Rejeitada — não há sinal de que a restrição vá ser relaxada; e mesmo que fosse, exigiria que todos os usuários upgradem para a versão futura para conseguir instalar o pacote. Custoso e dependente de eventos externos.
- **Caminho duplo: `tsx` quando flag indisponível, `--experimental-strip-types` quando possível.** Rejeitada — dois caminhos = duas matrizes de bug, sem benefício real. tsx funciona em ambos cenários (checkout e `node_modules`); manter strip-types como otimização condicional adiciona complexidade sem retorno mensurável.
- **`ts-node` em vez de `tsx`.** Rejeitada — histórico de incompatibilidades com ESM + `NodeNext` + `verbatimModuleSyntax`; startup mais lento; o próprio mantenedor recomenda alternativas para projetos novos. tsx é o sucessor de fato no ecossistema.

## Verificação

- `cli/tests/e2e/install/installed-tarball.test.ts` (novo): roda `npm pack` + `npm install <tarball>` em tmpdir e executa `./node_modules/.bin/qualy --version` e `qualy install --scope local --dry-run` em git repo. Falha aqui = recidiva do bug.
- Smoke manual reproduzível: `npm pack && cd $(mktemp -d) && npm init -y && npm install /abs/path/hgflima-qualy-X.Y.Z.tgz && ./node_modules/.bin/qualy --version` retorna exit 0 com JSON de versão e **sem** `ERR_UNSUPPORTED` em stderr.
- `package.json#dependencies.tsx` = `^4.19.0` (raiz).
- `package.json#engines.node` = `>=20.0.0` (raiz).
- `bin/qualy.mjs` resolve tsx via `createRequire(import.meta.url).resolve("tsx/cli")` — sem hardcode de path; `grep -c experimental-strip-types bin/qualy.mjs` retorna `0`.
- `npm pack --dry-run` continua sem `cli/dist/` ou qualquer artefato de build (snapshot `pack-contents.test.ts.snap` inalterado).
- `npm test` (unit) e `npm run test:e2e` (e2e) verdes; e2e ganha pelo menos a suite nova (33+ testes, antes 32).
