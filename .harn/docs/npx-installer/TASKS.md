# Tasks — Instalador via npx

> Documento de execução. Cada task é um checklist marcável.
> Visão estratégica em `PLAN.md`; SPEC em `SPEC.md`.
> **Regra:** cada passo ≤ 30 min de trabalho focado. Se um passo virar maior, quebrar em sub-passos antes de começar.

---

## Phase 1 — Primitivos compartilhados

### Task 1.1 — `version.ts` (XS)

**Goal:** Ler versão do `package.json` raiz + pré-flight Node ≥ 22.6.
**PLAN:** §5 Phase 1 / Task 1.1.

**Steps:**
- [ ] Criar `cli/src/install/` (mkdir).
- [ ] Criar `cli/src/install/version.ts` exportando `readPackageVersion(): string` e `checkNodeVersion(): { ok: true } | { ok: false, found: string, required: "22.6.0" }`.
- [ ] `readPackageVersion`: a partir de `import.meta.url`, subir diretórios até achar `package.json` com `"name": "qualy"`. Lança erro claro se não encontrar.
- [ ] `checkNodeVersion`: parsear `process.versions.node` em `[major, minor, patch]`; comparar contra `22.6.0` por componente.
- [ ] Criar `cli/tests/unit/install/` (mkdir).
- [ ] Criar `cli/tests/unit/install/version.test.ts`. Casos: (a) versão lida = a do `package.json` raiz; (b) `checkNodeVersion` mockado p/ `22.5.9` retorna `ok:false`; (c) `22.6.0` e `24.0.0` retornam `ok:true`; (d) raiz ausente lança erro com mensagem explícita.

**Done when:**
- [ ] `npm test -- cli/tests/unit/install/version.test.ts` verde.
- [ ] `npm run typecheck` verde.

---

### Task 1.2 — `scope.ts` (S)

**Goal:** Resolver `user|project|local` para path absoluto, com anti-traversal.
**PLAN:** §5 Phase 1 / Task 1.2.

**Steps:**
- [ ] Criar `cli/src/install/scope.ts`.
- [ ] Exportar `type Scope = "user" | "project" | "local"`.
- [ ] Exportar `resolveScope(scope: Scope, cwd: string): { root: string; scope: Scope }`.
- [ ] `user`: ler `process.env.HOME`; se indefinido → lançar `RecoverableError("HOME undefined; cannot resolve --scope user")`. Retornar `${HOME}/.claude`.
- [ ] `project|local`: usar `path.resolve(cwd)`; rejeitar se `cwd` contém `..` (após normalização ainda) ou se resolve para `/`. Retornar `${cwd}/.claude`.
- [ ] `project`: testar `existsSync(${cwd}/.git)`; se ausente → `RecoverableError("project scope requires a git repo; use --scope local instead")`.
- [ ] Criar `cli/tests/unit/install/scope.test.ts`. Casos: (a) 3 escopos felizes em tmpdirs sintéticos; (b) HOME ausente → erro recuperável; (c) cwd `/` → rejeitado; (d) cwd com `..` → rejeitado; (e) project sem `.git/` → erro com sugestão `--scope local` no message.

**Done when:**
- [ ] `npm test -- cli/tests/unit/install/scope.test.ts` verde.
- [ ] `npm run typecheck` verde.

---

### Task 1.3 — `manifest.ts` (S)

**Goal:** Read/write atômico do manifest do harness (não do lint-stack).
**PLAN:** §5 Phase 1 / Task 1.3 + D2.

**Steps:**
- [ ] Criar `cli/src/install/manifest.ts`.
- [ ] Definir e exportar:
  ```ts
  export type Manifest = {
    version: "1";
    scope: Scope;                // discrimina vs lint-stack manifest
    harness_version: string;
    installer: "npx" | "install.sh";
    installed_at: string;        // ISO 8601
    entries: Array<{ path: string; sha256: string; kind: "skill"|"command"|"agent"|"cli"|"other" }>;
  };
  ```
- [ ] `readManifest(scopeRoot): Manifest | null`: lê `${scopeRoot}/.lint-manifest.json`; retorna `null` se ENOENT; **lança** se JSON existe mas falta `scope` (é lint-stack manifest, não tocar).
- [ ] `writeManifest(scopeRoot, m): void`: escreve em `<file>.tmp.<rand>`, depois `rename` atômico.
- [ ] `deleteManifest(scopeRoot): void`: `unlinkSync` com try/catch p/ ENOENT (idempotente).
- [ ] Criar `cli/tests/unit/install/manifest.test.ts`. Casos: (a) round-trip read/write em tmpdir; (b) deleteManifest 2x seguidas não falha; (c) read de manifest sem `scope` lança erro claro; (d) write em FS read-only falha graceful (mockar via `fs.writeFile` rejection).

**Done when:**
- [ ] `npm test -- cli/tests/unit/install/manifest.test.ts` verde.
- [ ] `npm run typecheck` verde.

---

### Task 1.4 — `copy.ts` (M)

**Goal:** Cópia byte-a-byte do payload + sha256 + dry-run + idempotência.
**PLAN:** §5 Phase 1 / Task 1.4.

**Steps:**
- [ ] Criar `cli/src/install/copy.ts`.
- [ ] Definir `type PathEntry = { rel: string; abs: string; sha256: string; kind: Manifest["entries"][number]["kind"] }`.
- [ ] Definir `type CopyArgs = { source: string; target: string; dryRun: boolean }`.
- [ ] Definir `type CopyResult = { copied: PathEntry[]; skipped: PathEntry[] }`.
- [ ] Implementar `walkPayload(source)`: iterador que retorna paths relativos para `skills/`, `commands/`, `agents/`, `cli/` (skipa `cli/tests/`, `cli/node_modules/`, `.harn/`).
- [ ] Implementar `sha256File(abs)`: stream `createHash('sha256')` (não buffer-all — alguns assets podem ser grandes).
- [ ] Implementar `mapTarget(rel, target)`: `cli/...` → `${target}/skills/lint/cli/...`; `skills|commands|agents/...` → `${target}/...`.
- [ ] Implementar `copyPayload(args)`:
  - [ ] Para cada path do walk: calcular sha256 source.
  - [ ] Se target existe e sha256 bate → push em `skipped`, continuar.
  - [ ] Se `dryRun` → push em `copied` sem escrever.
  - [ ] Senão: `mkdirSync(dirname(target), { recursive: true })`, `copyFileSync(source, target)`, push em `copied`.
- [ ] Criar `cli/tests/unit/install/copy.test.ts`. Casos: (a) cópia limpa em tmpdir (assertar conteúdo + sha256); (b) idempotência (rodar 2x, segunda é all-skipped); (c) dry-run em tmpdir vazio: 0 bytes escritos (assertar via `readdirSync(tmp)` antes/depois); (d) sha256 estável entre 2 runs do mesmo source; (e) anti-órfão: criar arquivo extra no target antes de copiar; após copy ele permanece intacto.

**Done when:**
- [ ] `npm test -- cli/tests/unit/install/copy.test.ts` verde.
- [ ] `npm run typecheck` verde.

---

### ✅ Checkpoint B (PLAN §5 Phase 1)

- [ ] `npm run typecheck && npm test -- cli/tests/unit/install/` tudo verde.
- [ ] Cobertura ≥ 90% nos 4 módulos novos (verificar via `npm run test -- --coverage` se config existir; senão, contar linhas testadas vs totais manualmente).
- [ ] Push branch + revisão humana antes de Phase 2.

---

## Phase 2 — Subcomandos (vertical slices)

### Task 2.1 — `qualy install` (M)

**Goal:** Subcomando funcional que cria escopo + copia payload + escreve manifest.
**PLAN:** §5 Phase 2 / Task 2.1.

**Steps:**
- [ ] **Decisão pré-implementação:** confirmar se handler do harness install fica em `cli/src/install/install.ts` (PLAN) ou em `cli/src/commands/install/harness.ts` (convenção do repo). PLAN está vencendo — seguir PLAN. Documentar decisão em commit message do primeiro commit da task.
- [ ] Criar `cli/src/install/gitignore.ts` exportando `appendIgnoreLine(repoRoot, line): "added"|"already-present"|"created"`. Comportamento: se `.gitignore` ausente, criar com a linha. Se presente e linha já existe (literal match após trim), no-op. Se presente sem a linha, append (com `\n` antes se não terminar em `\n`).
- [ ] Criar `cli/src/install/install.ts` exportando `runHarnessInstall(args): Promise<ExitCode>`.
- [ ] Parsear flags: `--scope` (default `project`), `--dry-run`, `--yes`. Reusar parser existente do CLI se houver helper; senão parser inline simples.
- [ ] Pipeline:
  - [ ] `checkNodeVersion()` → exit `5` (MISSING_DEPENDENCY) se falhar.
  - [ ] `resolveScope(scope, cwd)` → exit `1` se falhar.
  - [ ] `readManifest(scopeRoot)`: se existe, log "overwriting existing harness install" (SPEC §6 — sobrescreve sem perguntar).
  - [ ] Resolver `source` = root do pacote npm via `version.ts`.
  - [ ] `copyPayload({ source, target: scopeRoot, dryRun })`.
  - [ ] Se `scope === "local"`: `appendIgnoreLine(cwd, ".claude/")`.
  - [ ] Construir manifest novo: `harness_version = readPackageVersion()`, `installer: "npx"`, `installed_at = new Date().toISOString()`, `entries = result.copied`.
  - [ ] `writeManifest(scopeRoot, manifest)` (skip se dryRun).
- [ ] Output JSON canônico (via `lib/logger.ts` `output()`): `{ ok, scope, version, target, copied: number, skipped: number, dry_run }`.
- [ ] Registrar handler em `cli/src/index.ts`: import `runHarnessInstall`, adicionar entrada `install` em `SUBCOMMANDS` (cuidado — não conflitar com handlers existentes de `cli/src/commands/install/`).
- [ ] Criar `cli/tests/unit/install/install.test.ts`. Matriz: scope × dry-run × already-installed (3×2×2 = 12 casos, mas vários colapsam — mirar 6-8 testes representativos).
- [ ] Criar `cli/tests/e2e/install/install-scopes.test.ts`. Spawn do CLI compilado em tmpdir; assertar arquivos no FS pós-install.
- [ ] Manual smoke: `npm pack && npx ./qualy-*.tgz install --scope local --dry-run` em repo sintético (criar `/tmp/test-repo-$(date +%s)` com `git init`).

**Performance budget (informational):** install em VM limpa ~30s. Sem gate de CI.

**Done when:**
- [ ] `npm run typecheck && npm test && npm run test:e2e` verde.
- [ ] Smoke manual: 3 escopos rodam end-to-end em tmpdirs.
- [ ] `qualy install --help` mostra texto coerente.

---

### Task 2.2a — Rename `uninstall` → `lint-uninstall` (S)

**Goal:** Liberar o nome `uninstall` para o harness sem mudar semântica do legado.
**PLAN:** §5 Phase 2 / Task 2.2a + D1.

**Steps:**
- [ ] `git mv cli/src/commands/uninstall.ts cli/src/commands/lint-uninstall.ts`.
- [ ] Editar `cli/src/commands/lint-uninstall.ts`: renomear export `runUninstall` → `runLintUninstall` (tudo que for nome de função/classe que mencione "uninstall" sem prefixo).
- [ ] Editar `cli/src/index.ts`: trocar `import { runUninstall } from "./commands/uninstall.ts"` por `import { runLintUninstall } from "./commands/lint-uninstall.ts"`. Trocar entrada `uninstall` em `SUBCOMMANDS` para `lint-uninstall` apontando para `runLintUninstall`.
- [ ] `git mv cli/tests/unit/uninstall.test.ts cli/tests/unit/lint-uninstall.test.ts`.
- [ ] Editar imports/strings em `cli/tests/unit/lint-uninstall.test.ts` para refletir novo nome.
- [ ] Atualizar `commands/lint:uninstall.md`: trocar todas as ocorrências de `qualy uninstall` por `qualy lint-uninstall`.
- [ ] Atualizar `agents/lint-migrator.md`: idem.
- [ ] `grep -rn "qualy uninstall" cli/ commands/ agents/ docs/` — deve retornar zero resultados (exceto possivelmente CHANGELOG.md anterior, OK).
- [ ] `grep -rn "runUninstall\b" cli/` — deve retornar zero resultados.

**Done when:**
- [ ] `npm run typecheck` verde.
- [ ] `npm test` verde (suite unit completa).
- [ ] `npm run test:e2e` verde (e2e existentes que invocavam `qualy uninstall` foram atualizados pelo rename).
- [ ] Greps acima limpos.

---

### ✅ Checkpoint C.1

- [ ] Rename limpo. Registry estável. Sem string `qualy uninstall` em lugar nenhum (exceto CHANGELOG histórico se aplicável). Sem isso, 2.2b não começa.

---

### Task 2.2b — `qualy uninstall` (harness) (S)

**Goal:** Subcomando que remove o harness lendo o manifest do escopo.
**PLAN:** §5 Phase 2 / Task 2.2b.

**Steps:**
- [ ] Criar `cli/src/install/uninstall.ts` exportando `runHarnessUninstall(args): Promise<ExitCode>`.
- [ ] Parsear flags: `--scope`, `--dry-run`, `--yes`, `--keep-backup` (no-op para harness; documentar no `--help`).
- [ ] Pipeline:
  - [ ] `resolveScope(scope, cwd)`.
  - [ ] `readManifest(scopeRoot)` → se `null`, exit `1` com mensagem `no harness installed at scope <X>`.
  - [ ] Para cada `entry` no manifest: `unlinkSync(${scopeRoot}/${entry.path})` (skip se dryRun); coletar em `removed[]`. Capturar ENOENT como `kept[]` com motivo `"already-absent"`.
  - [ ] `deleteManifest(scopeRoot)` (skip se dryRun).
  - [ ] Best-effort: tentar `rmdir` em diretórios que ficaram vazios (sem recursão profunda — só os diretórios diretos das entries).
- [ ] Output JSON: `{ ok, scope, removed: string[], kept: Array<{path, reason}>, dry_run }`.
- [ ] Registrar `uninstall` em `cli/src/index.ts` apontando para `runHarnessUninstall`. Coexiste com `lint-uninstall`.
- [ ] Criar `cli/tests/unit/install/uninstall.test.ts`. Casos: (a) install→uninstall round-trip em tmpdir, FS limpo; (b) uninstall sem manifest → exit 1 com mensagem clara; (c) órfão criado pelo usuário no scope persiste após uninstall; (d) dry-run não toca FS.
- [ ] Criar `cli/tests/e2e/install/uninstall-roundtrip.test.ts`.
- [ ] Sanity manual: `qualy --help` lista ambos `uninstall` e `lint-uninstall` com summaries distintos.

**Done when:**
- [ ] `npm run typecheck && npm test && npm run test:e2e` verde.
- [ ] `qualy uninstall --help` e `qualy lint-uninstall --help` distinguíveis.

---

### Task 2.3 — `qualy update` (M)

**Goal:** Detectar nova versão no npm e re-instalar.
**PLAN:** §5 Phase 2 / Task 2.3 + D4.

**Steps:**
- [ ] Criar `cli/src/install/registry.ts` exportando `fetchLatestVersion(opts: { timeoutMs: number }): Promise<{ ok: true, version: string } | { ok: false, kind: "network"|"auth"|"mirror"|"unknown", message: string }>`.
- [ ] Implementar via `child_process.spawn('npm', ['view', 'qualy', 'version'])` com timeout (`AbortController`).
- [ ] Mapeamento de erro:
  - [ ] stdout vazio / `null` / não-semver → `kind: "mirror"`.
  - [ ] stderr contém `E401|E403|ENEEDAUTH` → `kind: "auth"`.
  - [ ] stderr contém `ENOTFOUND|ETIMEDOUT|ECONNREFUSED` ou timeout estourou → `kind: "network"`.
  - [ ] qualquer outro código de saída ≠ 0 → `kind: "unknown"`.
- [ ] Criar `cli/src/install/update.ts` exportando `runHarnessUpdate(args): Promise<ExitCode>`.
- [ ] Parsear flags: `--scope`, `--dry-run`, `--yes`.
- [ ] Pipeline:
  - [ ] `resolveScope(scope, cwd)`.
  - [ ] `readManifest(scopeRoot)` → se `null`, exit `1` ("no harness installed; run `qualy install` first").
  - [ ] `fetchLatestVersion({ timeoutMs: 5000 })`. Se `!ok`, mapear `kind` para mensagem:
    - [ ] `network` → `cannot reach npm registry (network or DNS issue)`.
    - [ ] `auth` → `registry rejected request (check ~/.npmrc auth or use a public registry)`.
    - [ ] `mirror` → `registry returned no version for "qualy" — your registry may be a private mirror without this package`.
    - [ ] `unknown` → mensagem genérica + sugerir `qualy update --dry-run`. Todos exit `1`.
  - [ ] Comparar `manifest.harness_version` vs `latest`:
    - [ ] iguais → output `{ status: "up-to-date" }`, exit `0`.
    - [ ] `latest > installed`: imprimir `installed: A.B.C → latest: X.Y.Z`. Se major bump E `!--yes` → ler stdin via `readline` para confirmação (y/N). `--yes` skipa.
    - [ ] Aplicar via spawn `npx qualy@<latest> install --scope <X> --yes` (skip se dryRun).
- [ ] Output JSON: `{ ok, status: "up-to-date"|"updated"|"would-update", installed_before, installed_after }`.
- [ ] Registrar `update` em `cli/src/index.ts`.
- [ ] Criar `cli/tests/unit/install/update.test.ts`. Mock de `registry.ts`. Casos: (a) iguais; (b) minor bump auto-aplica; (c) major bump sem `--yes` aborta; (d) major com `--yes` aplica; (e-h) cada um dos 4 kinds de erro com mensagem específica assertada.
- [ ] E2E **skipado** (depende do registry real). Cobertura via mock.

**Done when:**
- [ ] `npm run typecheck && npm test` verde.
- [ ] Cobertura unit cobre as 4 classes de erro.

---

### ✅ Checkpoint C (PLAN §5 Phase 2)

- [ ] `npm run typecheck && npm test && npm run test:e2e` tudo verde.
- [ ] Cobertura ≥ 90% em `cli/src/install/`.
- [ ] Push + revisão antes de Phase 3.

---

## Phase 3 — Packaging & distribuição

### Task 3.1 — `package.json` raiz: `bin` + `files` + shim (S)

**Goal:** Pacote npm publishable + shim que invoca node com `--experimental-strip-types`.
**PLAN:** §5 Phase 3 / Task 3.1 + D3.

**Steps:**
- [ ] Criar `bin/qualy.mjs`:
  ```js
  #!/usr/bin/env node
  import { spawn } from "node:child_process";
  import { fileURLToPath } from "node:url";
  import { resolve, dirname } from "node:path";
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, "../cli/src/index.ts");
  const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  ```
- [ ] `chmod +x bin/qualy.mjs`.
- [ ] Editar `package.json` raiz:
  - [ ] `"private": true` → `"private": false`.
  - [ ] Adicionar `"bin": { "qualy": "bin/qualy.mjs" }`.
  - [ ] Adicionar `"files": ["cli/src/", "skills/", "commands/", "agents/", "bin/", "package.json", "README.md", "CHANGELOG.md"]`.
  - [ ] Confirmar/adicionar `"engines": { "node": ">=22.6.0" }`.
- [ ] Criar `cli/tests/e2e/install/pack-contents.test.ts`: roda `npm pack --dry-run --json`, parseia, asserta lista exata de paths (snapshot). Garante que `cli/tests/`, `cli/node_modules/`, `.harn/` ficam fora.
- [ ] Smoke manual: `npm pack && cd /tmp && npx /caminho/qualy-0.1.0.tgz --version` deve imprimir `0.1.0` (após Task 3.2 bumpar).

**Done when:**
- [ ] `npm pack --dry-run` lista apenas os paths esperados.
- [ ] Pack-contents snapshot test verde.
- [ ] Shim invoca CLI corretamente em tmpdir.

---

### Task 3.2 — Bump `0.0.0` → `0.1.0` + CHANGELOG (XS)

**Goal:** Marcar release.
**PLAN:** §5 Phase 3 / Task 3.2 + D5.

**Steps:**
- [ ] `package.json` raiz: `"version": "0.0.0"` → `"version": "0.1.0"`.
- [ ] `cli/package.json`: permanece `0.0.0` (D5 — não publicado isolado).
- [ ] Editar `CHANGELOG.md`: nova seção `## 0.1.0 — YYYY-MM-DD` com bullets:
  - [ ] `qualy install --scope <user|project|local>` (novo).
  - [ ] `qualy uninstall --scope <X>` (novo).
  - [ ] `qualy update --scope <X>` (novo).
  - [ ] **Breaking:** `qualy uninstall` antigo renomeado para `qualy lint-uninstall` (D1).

**Done when:**
- [ ] `git diff package.json CHANGELOG.md` revisado por humano.

---

### Task 3.3 — GitHub Actions: publish on tag (S)

**Goal:** Workflow que publica no npm quando tag `v*` é pushed. Inicialmente em modo `--dry-run`.
**PLAN:** §5 Phase 3 / Task 3.3.

**Steps:**
- [ ] Criar `.github/workflows/publish.yml`:
  - [ ] Trigger: `on: push: tags: ['v*']`.
  - [ ] Concurrency group: `${{ github.ref }}` para evitar duplicatas.
  - [ ] Steps: checkout, setup-node@v4 com `node-version: 22.6`, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, **`npm publish --dry-run --access public`**.
  - [ ] Auth: `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` no step de publish.
- [ ] Validar localmente com `act` se instalado; senão criar branch experimental, push tag de teste (`v0.0.0-test.1`), confirmar que workflow roda até o publish dry-run.
- [ ] Deletar tag de teste após validar: `git push --delete origin v0.0.0-test.1` e `git tag -d v0.0.0-test.1`.

**Done when:**
- [ ] Workflow YAML committado.
- [ ] Run de teste em branch experimental verde até `npm publish --dry-run` (sem publicar de verdade).
- [ ] Tag de teste limpa.

---

### Task 3.4 — Primeiro publish manual `v0.1.0` (S)

**Goal:** Evento sensível — primeira release pública. Sem pressa.
**PLAN:** §5 Phase 3 / Task 3.4.

**Pre-flight (todos verdes antes da tag):**
- [ ] `npm pack --dry-run` lista exatamente os paths esperados (cross-check com 3.1).
- [ ] `package.json` versão = `0.1.0`; `cli/package.json` = `0.0.0`.
- [ ] `CHANGELOG.md` `0.1.0` reflete os 3 subcomandos novos + breaking do rename.
- [ ] `gh secret list -R <owner>/qualy | grep NPM_TOKEN` confirma presença.
- [ ] Confirmar scope do `NPM_TOKEN` em [npmjs.com tokens](https://www.npmjs.com/settings/<user>/tokens) = `Automation` (não `Read-only`).
- [ ] `git status` limpo; `git rev-parse HEAD` == `git rev-parse origin/main`.
- [ ] CI verde no último commit de main (typecheck + lint + test + test:e2e).

**Edição do workflow:**
- [ ] Commit removendo `--dry-run` do step `npm publish` em `.github/workflows/publish.yml`. Mensagem: `[release] enable real npm publish for v0.1.0`.
- [ ] Push para main. Aguardar CI verde.

**Tag e push:**
- [ ] `git tag -s v0.1.0 -m "v0.1.0 — npx installer"` (ou `-a` se GPG não configurado — registrar a exceção no CHANGELOG).
- [ ] `git push origin v0.1.0`.
- [ ] Acompanhar workflow em `gh run watch`.

**Smoke test pós-publish (≤ 5 min após workflow verde):**
- [ ] `mkdir -p /tmp/qualy-smoke-$(date +%s) && cd /tmp/qualy-smoke-* && npx qualy@0.1.0 --version` imprime `0.1.0`.
- [ ] `git init && npx qualy@0.1.0 install --scope local --dry-run` exit 0.
- [ ] `npm view qualy version` retorna `0.1.0`.

**Rollback plan (se smoke falhar):**
- [ ] `npm unpublish qualy@0.1.0` (dentro de 24h — janela do npm; após isso, vira `deprecate`).
- [ ] Documentar incident em CHANGELOG (linha extra na seção 0.1.0).
- [ ] Bumpar para `0.1.1` com fix.

**Done when:**
- [ ] Smoke test 100% verde.
- [ ] `npm view qualy` mostra `latest: 0.1.0`.

---

### ✅ Checkpoint D

- [ ] Tarball válido + workflow verde + primeiro publish ok + smoke test ok. Pronto para Phase 4.

---

## Phase 4 — Documentação & paridade

### Task 4.1 — README: nova seção "Instalação" (S)

**Goal:** Promover `npx qualy install` como caminho oficial.
**PLAN:** §5 Phase 4 / Task 4.1.

**Steps:**
- [ ] Editar `README.md`. Adicionar seção `## Instalação` próxima ao topo.
- [ ] 3 sub-seções com exemplo + comentário "quando usar":
  - [ ] `--scope user`: ferramenta pessoal, todos os projetos. `npx qualy install --scope user`.
  - [ ] `--scope project`: time inteiro versiona `.claude/`. `npx qualy install --scope project`.
  - [ ] `--scope local`: experimentação individual sem afetar o repo. `npx qualy install --scope local` (gitignored).
- [ ] Nota curta: `install.sh --dev` é só para devs do qualy.
- [ ] Link para `.harn/docs/npx-installer/SPEC.md`.

**Done when:**
- [ ] `npm run lint` (markdown lint, se configurado) verde.
- [ ] Revisão humana aprovada.

---

### Task 4.2 — `install.sh`: deprecation soft + paridade (S)

**Goal:** Comunicar que o caminho oficial é npx; garantir paridade automatizada.
**PLAN:** §5 Phase 4 / Task 4.2.

**Steps:**
- [ ] Editar `install.sh`: na entrada (antes de qualquer mutação), se `$1 != "--dev"`, imprimir:
  ```
  [qualy/install] note: o caminho recomendado agora é `npx qualy install`.
  Use `--dev` apenas se estiver desenvolvendo o qualy localmente.
  ```
  Continuar a execução normalmente (deprecation **soft**, não bloqueante).
- [ ] Comportamento de `install.sh --dev` permanece **idêntico** (sem print extra).
- [ ] Criar `cli/tests/e2e/install/install-sh-parity.test.ts`:
  - [ ] Em tmpdir A: rodar `install.sh --dev`. Coletar `find ${HOME}/.claude -type f`.
  - [ ] Em tmpdir B: rodar `npx <tarball> install --scope user`. Coletar idem.
  - [ ] Asserta que os dois conjuntos de paths são iguais (ignorar timestamps em manifest; ignorar diferença symlink vs file se houver).
- [ ] Smoke manual: `./install.sh --dry-run` mostra a deprecation note; `./install.sh --dev --dry-run` não mostra.

**Done when:**
- [ ] Parity test verde.
- [ ] `install.sh --dev` ainda funcional via smoke manual.

---

### Task 4.3 — ADR 0010: distribuição via npm (S)

**Goal:** Registrar decisões D1–D5 num ADR.
**PLAN:** §5 Phase 4 / Task 4.3.

**Steps:**
- [ ] Criar `docs/adrs/0010-npm-distribution.md`. Estrutura:
  - [ ] `Status: Accepted` / `Date: 2026-MM-DD`.
  - [ ] `Context`: por que npm distribution + estado anterior (install.sh git clone).
  - [ ] `Decision`: cada D1–D5 com 1 parágrafo de rationale.
  - [ ] `Consequences`: o que muda (breaking rename, novo bin, novo manifest schema).
  - [ ] `Alternatives considered`: env -S, esbuild pre-compile, registry HTTP direto, `--registry` flag.
- [ ] Adicionar link no README (seção "Decisões arquiteturais" ou similar — checar convenção do repo).

**Done when:**
- [ ] ADR committado.
- [ ] Link no README funciona.
- [ ] Revisão humana aprovada.

---

### ✅ Checkpoint E (final)

- [ ] Todos os 9 critérios de SPEC §8 verdadeiros (cross-check com `PLAN.md §6`).
- [ ] `gh release view v0.1.0` mostra release publicado.
- [ ] `npm view qualy` saudável.
- [ ] Feature shipped.
