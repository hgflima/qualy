# Spec: tsx-runtime-fix

> Fix do bug `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` que torna `@hgflima/qualy@0.1.0` não-funcional quando instalado via npm/npx. Substitui `--experimental-strip-types` por `tsx` como runtime do shim.

## 1. Contexto e motivação

`@hgflima/qualy@0.1.0` foi publicado em 2026-05-04 com sucesso (workflow `publish.yml` verde, provenance OK). Smoke test pós-publish revelou bug crítico:

```
$ D=$(mktemp -d) && cd "$D"
$ npx -y -p '@hgflima/qualy@0.1.0' -- qualy --version
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
unsupported for files under node_modules, for "file:///.../node_modules/
@hgflima/qualy/cli/src/index.ts"
```

**Causa raiz.** ADR 0010 D3 escolheu `bin/qualy.mjs` que faz `spawn(node, ['--experimental-strip-types', 'cli/src/index.ts', ...])`. Quando o pacote é instalado via npm, `cli/src/index.ts` termina dentro de `node_modules/`. Node 22.6+ recusa-se **por design** a stripar tipos de arquivos dentro de `node_modules/` — sem flag para contornar, e sem plano dos maintainers para mudar. Bumpar Node não resolve.

**Por que escapou dos testes.** A suite e2e existente (`pack-contents.test.ts`, `install-scopes.test.ts`, etc.) executa o CLI a partir do checkout do repo (fora de `node_modules`) ou valida apenas a *lista* de arquivos no tarball. Nenhum teste executa o binário pós-`npm install`. Esse teste estava faltando.

## 2. Objective

Tornar `@hgflima/qualy@X.Y.Z` executável quando instalado via `npm install` ou `npx`, sem reintroduzir build step e preservando o ciclo dev iterativo (`install.sh --dev`).

**User stories:**
- Como adopter, executo `npx @hgflima/qualy@X.Y.Z install --scope local --dry-run` em um repo limpo e o comando completa com exit 0 e stdout não-vazio (sem erro de Node sobre node_modules).
- Como mantenedor, edito um `.ts` no checkout local e o próximo `qualy <comando>` reflete a mudança imediatamente — sem build step intermediário.
- Como autor de e2e, posso provar via teste que o binário publicado funciona pós-install, sem depender de smoke manual.

## 3. Tech Stack

- **Node**: `>=20.0.0` (drop de `>=22.6.0`; tsx suporta Node 18+, mas alinhamos com versão LTS atual e `actions/setup-node@v4` no CI).
- **tsx**: `^4.19.0` (runtime; loader explícito que interpreta `.ts` inclusive dentro de `node_modules`).
- **TypeScript**: 5.6+ (mantido; sem mudança no tsconfig).
- **Vitest**: 2.x (mantido).
- **Delta vs hoje**: tsx é a única nova dependência runtime; resto do stack inalterado.

## 4. Commands

```
Install local deps:    npm install
Typecheck:             npm run typecheck
Lint:                  npm run lint
Test (unit):           npm test
Test (e2e):            npm run test:e2e
Test (single e2e):     npx vitest run cli/tests/e2e/install/installed-tarball.test.ts
Pack (dry-run):        npm pack --dry-run
Pack (real tarball):   npm pack
Smoke local pré-pub:   D=$(mktemp -d) && cd "$D" && npm init -y && \
                       npm install /abs/path/hgflima-qualy-X.Y.Z.tgz && \
                       ./node_modules/.bin/qualy --version
```

`npm run build` continua sendo `echo ... && exit 0` — ADR 0011 atualiza a justificativa (era "Node strip-types"; passa a ser "tsx runtime"), mas a propriedade externa (sem build step, sem `dist/` no repo, sem prepack) é preservada.

## 5. Project Structure

Mudanças isoladas — sem novos diretórios. Arquivos tocados:

```
bin/qualy.mjs                                    # Shim: troca strip-types por tsx
package.json                                     # +deps.tsx, engines.node downgrade
docs/adrs/0011-tsx-runtime.md                    # Novo: supersede ADR 0007 D3
docs/adrs/0007-runtime-ts-strip-types.md         # Status: superseded by 0011
docs/adrs/0010-npm-distribution.md               # Status: D3 amended (cross-link)
.harn/docs/npx-installer/SPEC.md                 # §8: qualy → @hgflima/qualy + critério novo
CHANGELOG.md                                     # Seção [unreleased] ou [0.1.1]
cli/tests/e2e/install/installed-tarball.test.ts  # Novo e2e
```

Estruturas que **não** são tocadas: `cli/src/`, `cli/tests/unit/`, `skills/`, `commands/`, `agents/`, `.github/workflows/`, `tsconfig.json`, `cli/tsconfig.json`, layout de `files` em `package.json`.

## 6. Code Style

### Shim (referência)

```js
#!/usr/bin/env node
/**
 * `qualy` shim — published as the npm package's `bin` entry.
 *
 * Runtime payload is plain TypeScript executed via the `tsx` loader, which
 * interprets `.ts` inclusive dentro de `node_modules/` (where Node's native
 * --experimental-strip-types refuses by design). Spawn-based invocation keeps
 * tsx scoped to the child instead of leaking into the user's shell.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "src", "index.ts");
const tsxBin = createRequire(import.meta.url).resolve("tsx/cli");

const child = spawn(
  process.execPath,
  [tsxBin, entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
```

### Convenções

- ESM apenas (root `"type": "module"` mantido).
- Imports absolutos via `node:` prefix para builtins.
- `createRequire(import.meta.url)` ao invés de path traversal manual para resolver deps publicadas — sobrevive a hoisting do npm.
- Comentário do shim explica **why** (node_modules barrier), não **what** (que o código já mostra).
- Sem novos parâmetros, sem fallback duplo "se tsx falhar, tenta strip-types": um único caminho runtime.

## 7. Testing Strategy

### Novo e2e: `cli/tests/e2e/install/installed-tarball.test.ts`

**O que prova.** Que `npm pack` → `npm install <tarball>` → `qualy <cmd>` executa sem `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` e produz output esperado.

**Estrutura:**

```ts
describe("e2e: installed tarball is executable", () => {
  // beforeAll: npm pack no REPO_ROOT, gera <tmpRoot>/qualy.tgz
  // beforeAll: cria <tmpProject> com `npm init -y`, npm install <tarball>

  it("`qualy --version` exits 0 and prints a version", () => {
    const out = execFileSync(`./node_modules/.bin/qualy`, ["--version"], { cwd: tmpProject, encoding: "utf8" });
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`qualy install --scope local --dry-run` exits 0 in a git repo", () => {
    // git init em tmpRepo
    // npm install do mesmo tarball em tmpRepo
    // ./node_modules/.bin/qualy install --scope local --dry-run
    // assert: exit 0, stdout contém "[qualy] plan", stderr não contém "ERR_UNSUPPORTED"
  });

  // afterAll: rm -rf temp dirs
});
```

**Custo runtime.** ~10–20s por execução (npm pack ~3s + npm install ~5–10s × 2). Aceitável para e2e, mas:
- Roda só em `npm run test:e2e` (já é o padrão — unit suite não toca).
- Se vitest paralelo causar disputa por `~/.npm` cache, marcar `describe.sequential` ou usar `process.env.npm_config_cache` apontando para tmp dir.

**O que **não** muda.** `pack-contents.test.ts` continua validando lista de arquivos. `install-scopes`, `install-sh-parity`, `uninstall-roundtrip` continuam executando o CLI do checkout — não-redundante com o novo e2e (diferente surface).

### Coverage

Coverage no fix em si é trivial (3 linhas no shim). O novo e2e é o smoke real; sem unit dedicado para o shim (executá-lo já é o teste). Total da suite continua ≥ 90% nos módulos `cli/src/install/` (SPEC §8).

## 8. Boundaries

### Always do

- Adicionar `tsx` em `package.json` (raiz) → `dependencies`, **não** em `devDependencies`. É runtime de qualquer install.
- Manter `cli/package.json` em `0.0.0` (ADR 0010 D5 inalterado).
- Rodar `npm pack --dry-run` antes de qualquer commit que toque `files`/`bin`/`dependencies` para verificar que tarball continua sano.
- Validar localmente via smoke `npm pack` + `npm install` em tmp dir antes de marcar o fix como pronto.

### Ask first

- Mudar `engines.node` para algo abaixo de 20 (impacto em CI matrix; tsx até suporta 18, mas perdemos paridade com setup-node@v4 default).
- Tocar arquivos em `cli/src/` (fora do escopo deste fix; runtime resolution dos assets já funciona com `import.meta.url`).
- Modificar workflow `publish.yml` (CI passou no 0.1.0; não há motivo para tocar agora).
- Decidir publish strategy (unpublish 0.1.0 vs bump 0.1.1) — explicitamente fora deste spec; usuário já marcou como follow-up.

### Never do

- Adicionar build step (`prepack`, `tsc -p ...`, `cli/dist/`, `outDir`). ADR 0010 + 0011 confirmam "no build step" como decisão arquitetural.
- Hardcodar path do tsx (`node_modules/tsx/dist/cli.js`); sempre usar `createRequire(import.meta.url).resolve("tsx/cli")` para sobreviver hoisting/pnpm/yarn.
- Manter caminho duplo ("tenta strip-types, se falhar usa tsx"). Um único runtime, sem fallback condicional.
- Skipar o novo e2e ou marcá-lo `.skip` para fazer suite passar mais rápido. O ponto inteiro é que esse teste teria pegado o bug.
- Bumpar `cli/package.json` para outra coisa que não `0.0.0`.
- Republicar `0.1.0` com `--force` (npm rejeita; e mesmo se permitisse, contaminaria semver).

## 9. Success Criteria

Critérios objetivos e verificáveis. **Cada item deve estar verde antes do spec ser considerado entregue.**

- [ ] `bin/qualy.mjs` resolve `tsx/cli` via `createRequire(import.meta.url).resolve("tsx/cli")` e usa-o como primeiro argumento do spawn.
- [ ] `package.json` raiz lista `"tsx": "^4.19.0"` em `dependencies`.
- [ ] `package.json` raiz tem `engines.node` em `>=20.0.0`.
- [ ] `npm install` em repo limpo + `./node_modules/.bin/qualy --version` imprime `0.1.x` (ou versão atual da raiz) com exit 0 e **sem** `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` em stderr.
- [ ] `cli/tests/e2e/install/installed-tarball.test.ts` existe e passa, cobrindo `--version` + `install --scope local --dry-run` em git repo.
- [ ] `npm test` (unit, 2022 testes) e `npm run test:e2e` (e2e, 32 → 33+ testes com o novo) continuam verdes.
- [ ] `npm pack --dry-run` produz tarball ainda **sem** `cli/dist/`, `node_modules/tsx/`, ou qualquer artifact de build (snapshot de `pack-contents.test.ts` atualizado se necessário).
- [ ] `docs/adrs/0011-tsx-runtime.md` existe, com Status `aceito`, Decisão clara, e Consequências enumerando o que muda vs ADR 0007 e 0010 D3.
- [ ] `docs/adrs/0007-runtime-ts-strip-types.md` ganha linha `- Status: superseded by ADR 0011 (2026-05-05)` no header.
- [ ] `docs/adrs/0010-npm-distribution.md` ganha nota cruzada na seção D3 apontando para ADR 0011.
- [ ] `.harn/docs/npx-installer/SPEC.md` §8 atualiza 4 ocorrências literais `qualy` → `@hgflima/qualy` e adiciona critério "binário publicado executa pós-`npm install`".
- [ ] `CHANGELOG.md` documenta a mudança runtime na próxima seção (a definir: `[Unreleased]` ou `[0.1.1]`, dependendo da decisão de publish que está fora deste spec).
- [ ] Smoke manual: `npm pack` → `cd $(mktemp -d) && npm init -y && npm install /abs/path/hgflima-qualy-X.Y.Z.tgz && ./node_modules/.bin/qualy install --scope local --dry-run` em git repo retorna exit 0.

## 10. Out of scope

Itens deliberadamente **não** cobertos por este spec:

- **Decisão sobre publish do fix.** Unpublish 0.1.0 + republish vs bump 0.1.1 fica como follow-up. Janela de unpublish: ~2026-05-07 22:46 UTC. Usuário sinalizou "esquece publicacao".
- **Migração de assets ou layout do projeto.** Nenhum arquivo em `cli/src/` é movido.
- **Refactor do CLI core, novos subcomandos, ou mudanças de API.** Fix é cirúrgico no shim + e2e + docs.
- **Atualizar `actions/checkout@v4`/`setup-node@v4`** no `publish.yml` (Node 20 deprecation 2026-09-16). Não-bloqueante; tracking separado.
- **Rename de pacote de volta para `qualy` unscoped.** Já decidido em commit `44cf9c4` (anterior). SPEC §8 é apenas atualizado para refletir.

## 11. Open questions

Nenhuma — todas as ambiguidades foram resolvidas no preâmbulo desta sessão (assumptions surfaced + AskUserQuestion sobre estratégia de ADR). Caso surjam durante Plan/Tasks/Implementation, voltam aqui antes de avançar.
