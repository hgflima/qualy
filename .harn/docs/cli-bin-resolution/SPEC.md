# Spec: CLI Bin Resolution Hotfix (v0.3.4)

> Status: **Draft** — pendente aprovação do usuário antes da fase Plan.
> Escopo: hotfix de dois bugs descobertos em v0.3.3 ao rodar `/lint:rules:list`. Não é refactor de layout; é mudança cirúrgica no installer + slash command preamble.

## 1. Objective

Após `npx @hgflima/qualy install`, qualquer slash command de `/lint:*` deve executar com sucesso sem `ERR_MODULE_NOT_FOUND` ou `Cannot find module '../../package.json'`. O CLI runtime materializado em `.claude/skills/lint/` deve ser self-sufficient (deps resolvidas localmente) e funcionar offline a partir da segunda invocação.

### Bugs cobertos

**Bug 1 — Deps do CLI não resolvíveis após install**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from
  /…/.claude/skills/lint/cli/src/lib/audit-schema.ts
```

Causa: pipeline copia `cli/src/` para `.claude/skills/lint/cli/` mas não materializa nenhum `node_modules/`. Node ESM caminha para cima e não encontra `zod`, `ts-morph`, `fast-glob`, `esbuild`, `chart.js`, `chartjs-chart-treemap`. Como o install é via `npx`, o `qualy` não fica no PATH pós-install — não há `node_modules` global do qualy para herdar.

**Bug 2 — Caminho relativo errado para package.json no entrypoint**

```
Error: Cannot find module '../../package.json'
  at file:///…/.claude/skills/lint/cli/src/index.ts:63:43
```

Causa: `createRequire(import.meta.url)("../../package.json")` em `cli/src/index.ts:63` resolve para `.claude/skills/lint/package.json` (não existe). `cli/package.json` é shippado para `.claude/skills/lint/cli/package.json` mas o caminho relativo aponta um nível acima.

### Por quê resolver de uma vez

Os dois bugs juntos quebram **toda** invocação do CLI pós-install. Hotfix prioritário; sem isso a v0.3.3 está inutilizável.

### Usuário-alvo

Qualquer adopter que rodou `npx @hgflima/qualy install` em v0.3.3+. Inclui adopter individual, time de engenharia, power user. Sem mudança no fluxo do dev de qualy (este repo).

### Sucesso

1. `npx @hgflima/qualy@0.3.4 install` em projeto limpo (Node ≥ 22.6, sem cache de qualy) deixa `/lint:rules:list` funcional em ≤ 60s.
2. Após install, `node .claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs detect-stack --cwd "$PWD"` retorna sucesso sem `ERR_MODULE_NOT_FOUND`.
3. `qualy uninstall` remove `node_modules/` materializado junto com os demais artefatos (manifest é fonte de verdade).
4. `qualy update` materializa a nova versão no mesmo caminho (substitui).
5. Os 6 slash commands (`/lint:setup`, `/lint:audit`, `/lint:report`, `/lint:rollback`, `/lint:uninstall`, `/lint:update`) funcionam sem regressão.

---

## 2. Estratégia

**Decisão**: o `qualy install` materializa uma cópia local com deps via `npm install` dentro de `.claude/skills/lint/`, e os slash commands invocam o bin desse caminho.

### Antes (v0.3.3, quebrado)

```
.claude/skills/lint/
  SKILL.md
  cli/                              ← copiado de cli/src + cli/package.json
    package.json                    ← orphan; deps não instaladas
    src/
      index.ts                      ← createRequire('../../package.json') falha
      lib/audit-schema.ts           ← import 'zod' falha (ERR_MODULE_NOT_FOUND)
```

### Depois (v0.3.4)

```
.claude/skills/lint/
  SKILL.md
  node_modules/                     ← novo: materializado por npm install
    @hgflima/qualy/
      package.json                  ← layout válido: ../../package.json funciona
      bin/qualy.mjs                 ← entrypoint canônico
      cli/src/                      ← runtime
      ...
    zod/, ts-morph/, fast-glob/,
    esbuild/, chart.js/, ...        ← todas as deps resolvidas pelo npm
```

`cli/` deixa de ser copiado para `.claude/skills/lint/`. Bug 2 desaparece como side-effect: `cli/src/index.ts` agora **só** roda no contexto `node_modules/@hgflima/qualy/cli/src/index.ts` onde `../../package.json` resolve corretamente para a raiz `@hgflima/qualy/package.json`.

---

## 3. Commands

```bash
# Workflow de release v0.3.4 (mantém o fluxo atual; sem build step novo)
npm run typecheck
npm run lint
npm run test
npm run test:e2e

# Bump + tag (workflow existente, ver memory: release_workflow)
npm version patch                                    # 0.3.3 → 0.3.4
git push origin main --follow-tags
gh release create v0.3.4 --notes-from-tag            # dispara publish

# Verificação local antes de publicar (smoke test)
npm pack                                             # gera hgflima-qualy-0.3.4.tgz
mkdir /tmp/qualy-smoke && cd /tmp/qualy-smoke
npx /path/to/hgflima-qualy-0.3.4.tgz install --scope local
ls .claude/skills/lint/node_modules/@hgflima/qualy   # deve existir
node .claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs detect-stack --cwd "$PWD"
                                                     # deve retornar JSON sem error
```

---

## 4. Project Structure (mudanças)

### `cli/src/install/copy.ts`

Remove `"cli"` de `TOP_LEVEL_DIRS`:

```ts
- const TOP_LEVEL_DIRS = ["skills", "commands", "agents", "cli"] as const;
+ const TOP_LEVEL_DIRS = ["skills", "commands", "agents"] as const;
```

Remove o branch `cli/...` em `mapTarget()` (e o set `SKIP_RELATIVE` que filtrava `cli/tests` e `cli/node_modules` — fica obsoleto). Atualiza docstring.

### `cli/src/install/install.ts` (e/ou novo módulo `install-runtime.ts`)

Adiciona novo passo após `copyPayload()`, antes de gravar o manifest:

```ts
// Materializa cópia self-sufficient com deps em .claude/skills/lint/
await materializeRuntime({
  target: join(target, "skills", "lint"),
  packageSpec: `@hgflima/qualy@${SELF_VERSION}`,
  dryRun,
  packageManager: detectPackageManager(),  // npm | pnpm | yarn
});
```

`materializeRuntime()` executa, em ordem:

```bash
cd .claude/skills/lint
<pm> install --omit=dev --no-save --no-audit --no-fund @hgflima/qualy@<version>
```

- `--no-save`: não cria `.claude/skills/lint/package.json`. Apenas `node_modules/` é materializado. Se necessário, gera um `package.json` mínimo apenas para satisfazer o pm (ver Open Questions).
- `--omit=dev`: ignora devDependencies (`oxlint`, `oxfmt`, `quality-metrics`, `@vitest/coverage-v8`).
- `--no-audit --no-fund`: silencia ruído.
- `<version>`: lido do `package.json` da própria instância de qualy em execução (read via `createRequire(import.meta.url)("../../../package.json").version` no install command).

**Falhas tratadas**:
- Sem rede / registry indisponível: erro `EQUALY_INSTALL_NETWORK` com mensagem clara.
- pm não detectado: default para `npm`.
- Espaço em disco / permissão: erro `EQUALY_INSTALL_FS`.

### `cli/src/install/manifest.ts`

Estende `ManifestEntryKind` para incluir `"runtime-node-modules"`. Registra a entrada `.claude/skills/lint/node_modules/` (diretório, não arquivo) no manifest com kind apropriado para o uninstall remover.

### `cli/src/install/uninstall.ts`

Quando encontrar entry kind `"runtime-node-modules"`, faz `rm -rf` recursivo no diretório (em vez do `unlink` por arquivo). Mantém safety: só remove paths registrados no manifest.

### `cli/src/install/update.ts`

Quando bumping de versão: refaz `materializeRuntime()` apontando para a nova versão. Se versão local já bate, skip.

### `commands/lint/*.md` (6 arquivos)

Substitui o preamble bash existente:

```bash
# ANTES
QUALY_CLI=""
for cand in "$PWD/.claude" "$HOME/.claude"; do
  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break
done
[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found..." >&2; exit 5; }
node --experimental-strip-types "$QUALY_CLI" <subcmd> --cwd "$PWD" "$@"
```

```bash
# DEPOIS
QUALY_BIN=""
# Dev override (uso interno do repo qualy): aponta para bin/qualy.mjs local.
[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"
# Lookup padrão: cópia materializada por `qualy install`.
if [ -z "$QUALY_BIN" ]; then
  for cand in "$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs" \
              "$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"; do
    [ -f "$cand" ] && QUALY_BIN="$cand" && break
  done
fi
[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \`npx @hgflima/qualy install\` first." >&2; exit 5; }
node "$QUALY_BIN" <subcmd> --cwd "$PWD" "$@"
```

### `cli/src/index.ts:63`

**Não muda.** O fix do Bug 2 vem de fora (mudança de layout) — `../../package.json` agora resolve corretamente em todos os caminhos válidos de execução.

### `cli/package.json`

`fast-glob` **já está declarada na raiz** (`package.json` do `@hgflima/qualy`, linha 48). O missing dep do bug report era visível só inspecionando `cli/package.json` em isolamento — mas como a npm install agora materializa o pacote raiz, fast-glob vem junto. Nenhuma mudança em `cli/package.json` é necessária para o hotfix.

(Nota: o `cli/package.json` continua existindo no source tree apenas para o workspace; deixa de ser copiado.)

### Workaround a reverter

```bash
rm /tmp/whichever-project/.claude/skills/lint/package.json
```

Documentar no CHANGELOG que o duplicado manual aplicado por usuários afetados deve ser removido (uninstall + reinstall faz isso).

---

## 5. Code Style

- Sem novas dependências.
- Reusa `detectPackageManager()` se já existir; senão, módulo novo curto em `cli/src/install/pm-detect.ts` (verifica `pnpm-lock.yaml`, `yarn.lock`, default `npm`).
- `materializeRuntime()` usa `child_process.spawn` com stdio herdado para o usuário ver progresso do npm install.
- Erros novos seguem o padrão `EQUALY_<DOMAIN>_<DETAIL>` já em uso.
- Toda mudança em copy.ts/install.ts mantém o invariante "anti-orphan" do uninstall (manifest é a fonte de verdade).

---

## 6. Testing Strategy

### Unit (vitest, `cli/tests/unit/`)

- `install/copy.test.ts`: atualizar expectativas — `cli/` não deve mais aparecer em `walkPayload` nem em `mapTarget`.
- `install/materialize-runtime.test.ts` (novo): mocka `child_process.spawn`; valida comando + args + cwd.
- `install/manifest.test.ts`: valida nova entry kind `"runtime-node-modules"`.
- `install/uninstall.test.ts`: valida `rm -rf` no path da entry runtime.
- `install/update.test.ts`: valida re-materialização em bump de versão.

### E2E (vitest, `cli/tests/e2e/`)

- `install-flow.test.ts`: roda `qualy install --scope local` em tmpdir; valida que `.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs` existe e é executável.
- `cli-invocation.test.ts`: após install, executa `node <bin> detect-stack --cwd <tmpdir>`; valida exit 0 e JSON parseável (smoke do Bug 1 + Bug 2).
- `uninstall-flow.test.ts`: após install + uninstall, valida que `.claude/skills/lint/` não existe mais.

### Smoke manual pré-release

Executar a sequência da §3 ("Verificação local da publicação") em pelo menos:
- macOS, Node 22.6+
- Linux CI runner (validação no CI workflow já existente)

---

## 7. Boundaries

### Always

- Manter manifest como fonte de verdade do uninstall.
- `qualy install` continua sendo idempotente (rerodar = no-op se versão bate).
- Slash commands continuam não-interativos no caminho CLI puro (sem readline).
- `--scope user|project|local` continua funcionando — todos materializam node_modules no `.claude/skills/lint/` do scope correspondente.

### Ask first

- Mudar formato do manifest (`.lint-manifest.json`) — usuários com v0.3.3 instalado precisam de migration path se o schema mudar de forma breaking.
- Alterar contrato dos subcomandos (`detect-stack`, `recs-generate`, etc.) — fora do escopo do hotfix.
- Mudar a versão mínima de Node.

### Never

- Reintroduzir `cli/` em `TOP_LEVEL_DIRS` (anti-pattern: TS sem deps em `.claude/`).
- Bundlar com esbuild como parte deste hotfix (out of scope; `esbuild` + `chart.js` precisariam permanecer externals de qualquer forma — análise feita durante design).
- Usar `--save` no `npm install`: isso criaria um `package.json` em `.claude/skills/lint/` que não pertence ao usuário gerenciar.
- Skipar pre-commit hooks no release (`--no-verify`) — release workflow existente já lida com isso.

---

## 8. Open Questions (não-bloqueadoras; resolver durante a fase Plan)

1. **`npm install --no-save` em diretório sem `package.json`**: o npm cria um `package.json` mínimo automaticamente? Ou precisamos pré-criar um stub mínimo `{ "name": "qualy-runtime", "private": true, "dependencies": {} }`? Validar com smoke test.
2. **Detecção de package manager**: usuário com `pnpm-lock.yaml` no projeto raiz quer pnpm também em `.claude/skills/lint/`? Ou sempre default npm para garantir layout flat de `node_modules`? Recomendação inicial: **sempre npm**, para evitar surpresas com pnpm symlinks.
3. **Cache de install**: se duas reinstalações em projetos diferentes acontecem em sequência, vale aproveitar `npm cache`? npm já cacheia por default; sem ação extra necessária.
4. **CI scope=user no GitHub Actions**: o workflow de release executa `qualy install --scope user` em algum step? Se sim, validar que ainda funciona pós-mudança.
5. **Schema do manifest**: precisa bumpar a `manifestVersion` ou só estender o enum de `kind` é compatível? Se compatível, no migration. Se breaking, precisamos de migrate path para v0.3.3 → v0.3.4.

---

## 9. Out of Scope

- Refactor de layout do `cli/` (mover `cli/src/` para `skills/lint/src/` etc.) — opção (b) do bug report do usuário. Bigger patch; pode virar follow-up.
- Bundle CLI com esbuild — análise mostrou que `esbuild`, `chart.js`, `chartjs-chart-treemap` precisariam permanecer external por uso runtime, não eliminando deps no target.
- Inline VERSION via build-step — solução foi obviada pela mudança de layout (Bug 2 sumiu como side-effect).
- Fast-glob como dep do `cli/package.json` — irrelevante após a mudança (cli/package.json não é mais shippado).
