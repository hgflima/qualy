# Plano — Instalador via npx (`qualy install/uninstall/update`)

> Status: **Draft** — pronto para revisão humana antes da fase Tasks.
> Acopla-se à `SPEC.md` desta pasta. Não substitui `.harn/docs/mvp/PLAN.md`.

---

## 1. Overview

Adicionar três subcomandos novos ao bin `qualy` (`install`, `uninstall`, `update`) que distribuem o harness do `/lint` (skills, commands, agents, cli) via npm — eliminando a necessidade de clonar o repo e rodar `install.sh`. O `install.sh` continua existindo apenas como caminho `--dev` para desenvolvedores do qualy.

A feature é **aditiva**: nenhum subcomando existente muda de comportamento. O único code path tocado fora de `cli/src/install/` é o registry em `cli/src/index.ts` (e um rename, ver §3 Decisão D1).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Distribuição via npm                                           │
│  ─────────────────────────                                      │
│  npx qualy install       → copia payload do tarball             │
│  npx qualy uninstall     → remove via manifest                  │
│  npx qualy update        → checa registry, re-instala           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ Node 22.6+ --experimental-strip-types
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  cli/src/install/   (NOVO — toda lógica isolada aqui)           │
│  ───────────────────                                            │
│  scope.ts        resolve {user|project|local} → path absoluto   │
│  manifest.ts     read/write <scope>/.claude/.lint-manifest.json │
│  copy.ts         copia payload do pacote → escopo, sha256       │
│  version.ts      lê versão do package.json + checa Node ≥ 22.6  │
│  install.ts      orquestra scope+copy+manifest                  │
│  uninstall.ts    lê manifest, remove paths rastreados           │
│  update.ts       compara installed vs latest, dispara install   │
│  gitignore.ts    helper para --scope local (anexa .claude/)     │
└─────────────────────────────────────────────────────────────────┘
                                  │ delega para
                                  ▼
                          payload (skills/, commands/,
                          agents/, cli/) — copiado byte-a-byte
```

**Princípios** (alinhados ao PLAN do MVP):

1. CLI não pergunta nada — confirmações ficam no slash command (não há slash command para esta feature ainda; quando rodar via CLI direto, `--yes` força non-interactive).
2. **Toda mutação passa pelo manifest** (`<scope>/.claude/.lint-manifest.json`). Sem manifest, `uninstall` não toca nada.
3. **Idempotente**: rodar `install` duas vezes sobrescreve o payload sem duplicar entradas no manifest.
4. **`--dry-run` em todos os subcomandos mutantes** (SPEC §7). Reporta o plano sem tocar FS.
5. **Anti path-traversal**: `scope.ts` valida que `project|local` resolvem dentro de `cwd` e que `user` resolve dentro de `$HOME`.

---

## 3. Architecture Decisions

Todas resolvidas em 2026-05-04 via AskUserQuestion. Vinculantes para a fase Tasks.

### D1 — Conflito de nome: `uninstall` (atual) vs `qualy uninstall` (novo) — **Aprovada**

**Problema:** `cli/src/commands/uninstall.ts` já existe e remove o stack de lint (oxlint/hooks/husky) lendo `.lint-manifest.json` do projeto-alvo. A SPEC §3 introduz `qualy uninstall` para remover o **harness** de um escopo. Mesmo nome, semântica diferente.

**Decisão: renomear o existente para `lint-uninstall`.**
- O subcomando atual emparelha com o slash command `/lint:uninstall` (skill `lint:uninstall`). Renomear para `lint-uninstall` torna a relação 1:1 explícita e libera `uninstall` para o harness.
- Update path: `cli/src/index.ts` registry, todos os call sites em `commands/lint:uninstall.md`, `agents/lint-migrator.md`, e nos testes (`cli/tests/unit/uninstall.test.ts`).
- Sem deprecation alias (rename é breaking em 0.x, registrado em ADR 0010 + CHANGELOG).

### D2 — Filename do manifest do harness — **Aprovada**

**Problema:** SPEC §3 diz "estender `.lint-manifest.json` com campos de versão". Mas o **manifest do projeto-lint** vive em `<repo-root>/.lint-manifest.json`, e o **manifest do harness** viveria em `<scope>/.claude/.lint-manifest.json`. Mesmo nome, schemas diferentes (um rastreia oxlint configs/hooks, o outro rastreia skills/commands/agents/cli).

**Decisão: manter o nome, schema discriminado por presença de `scope`.**
- Path differente já desambigua: nenhum tooling lê os dois ao mesmo tempo.
- Estender o schema atual com campos opcionais `scope: "user"|"project"|"local"`, `harness_version: string`, `installer: "npx"|"install.sh"`. Quando esses campos estão presentes, é manifest de harness; quando ausentes, é manifest de lint stack.
- `manifest.ts` (novo) só lê/escreve manifests com `scope` definido — não toca o do projeto-lint.

### D3 — Como o `bin` do npm executa `cli/src/index.ts` em TS puro — **Aprovada**

**Problema:** `cli/src/index.ts` exige `node --experimental-strip-types`. Mas o campo `"bin"` do `package.json` aponta para um único arquivo executável; não há onde passar flags do node.

**Decisão: shim `bin/qualy.mjs`.**
- Arquivo `.mjs` minúsculo que faz `child_process.spawn('node', ['--experimental-strip-types', resolve(__dirname, '../cli/src/index.ts'), ...process.argv.slice(2)], { stdio: 'inherit' })`. Funciona em qualquer Unix; portável; testável.
- Custo: ~15 linhas de código + 1 process spawn por invocação (~30-50ms overhead, irrelevante para `install/update`).
- Benefício: zero dependência em comportamento de `env -S` (rejeitado por exigir coreutils ≥ 8.30, instável em macOS pré-Sequoia / WSL básico). Pre-compile via esbuild rejeitado por violar "sem build step" da SPEC §2.

### D4 — Como `qualy update` descobre `latest` — **Aprovada**

**Problema:** SPEC §1 diz "detecta nova versão no npm". É a primeira (e única) operação do CLI que toca a rede. Precisa decidir o mecanismo.

**Decisão: `npm view qualy version` via `child_process`.**
- Reusa o npm CLI já presente (todo usuário npx tem npm). Sem nova dependência.
- Timeout configurável (default 5s); falha → mensagem clara e exit `RECOVERABLE_ERROR`.
- **Não usar registry HTTP direto** (`https://registry.npmjs.org/qualy`): exige tratar redirects, autenticação para registries privados, e fingerprint do User-Agent — `npm view` resolve tudo isso. Lib dedicada (`npm-registry-fetch`) rejeitada por violar "sem novas runtime dependencies" da SPEC §2.

**Out of scope considerado:** flag `--registry <url>` para enterprise. Adicionar quando alguém pedir.

### D5 — Versão de `cli/package.json` vs `package.json` raiz — **Aprovada**

**Problema:** Ao bumpar a raiz para `0.1.0` (Task 3.2), o que fazer com `cli/package.json` que está em `0.0.0`?

**Decisão: manter `cli/package.json` em `0.0.0` permanentemente.**
- `cli/` é workspace interno, **nunca** publicado isolado. `0.0.0` sinaliza "não publishable" e protege contra `npm publish` acidental dentro de `cli/`.
- `readPackageVersion()` (Task 1.1) resolve sempre via `package.json` raiz (resolve via `import.meta.url` subindo até encontrar o `package.json` com `"name": "qualy"`). Não há ambiguidade em runtime.
- Custo zero: nenhum bump duplo a cada release. Script de sync rejeitado por adicionar complexidade desnecessária para um benefício inexistente.

---

## 4. Dependency graph

```
                ┌──────────────────┐
                │  package.json    │  ← D3: bin/qualy.mjs shim
                │  (bin + files)   │
                └────────┬─────────┘
                         │
                         ▼
            ┌─────────────────────────┐
            │  version.ts (Phase 1.1) │
            │  scope.ts   (Phase 1.2) │  ← independentes
            └──────────┬──────────────┘
                       │
                       ▼
            ┌─────────────────────────┐
            │  manifest.ts (1.3)      │  ← depende de scope
            │  copy.ts     (1.4)      │  ← depende de scope + version
            └──────────┬──────────────┘
                       │
                       ▼
            ┌─────────────────────────┐
            │  install.ts  (Phase 2.1)│  ← orquestra todos os primitivos
            └──────────┬──────────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
    ┌──────────────┐      ┌────────────┐
    │ uninstall.ts │      │ update.ts  │  ← chama install.ts internamente
    │ (Phase 2.2)  │      │ (Phase 2.3)│
    └──────────────┘      └────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Phase 3:       │
              │  packaging      │
              │  + publish wf   │
              └─────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Phase 4:       │
              │  README + ADR   │
              └─────────────────┘
```

Cada slice na Phase 2 entrega uma feature ponta-a-ponta (CLI + testes unit + e2e).

---

## 5. Phases & Tasks

> Convenção: cada task lista (a) acceptance criteria, (b) verification, (c) dependencies, (d) files likely touched, (e) sizing (XS/S/M/L). Tasks L são red flag — se aparecerem, revisitar este plano.

### Phase 0 — Resolução de decisões

Concluída em 2026-05-04. D1–D4 aprovadas conforme §3. Phase 1 liberada.

---

### Phase 1 — Primitivos compartilhados (`cli/src/install/`)

#### Task 1.1 — `version.ts`: ler versão do `package.json` + preflight Node
- **AC:**
  - `readPackageVersion(): string` retorna `version` do `package.json` raiz do pacote (resolve via `import.meta.url` para funcionar tanto em `node_modules/qualy/` quanto em dev local).
  - `checkNodeVersion(): { ok: true } | { ok: false, found, required }` valida ≥ 22.6.0.
- **Verification:** `npm test -- cli/tests/unit/install/version.test.ts`. Casos: versão lida corretamente; node 22.5 retorna `ok:false`; node 22.6+ retorna `ok:true`.
- **Deps:** Nenhuma.
- **Files:** `cli/src/install/version.ts`, `cli/tests/unit/install/version.test.ts`.
- **Size:** XS.

#### Task 1.2 — `scope.ts`: resolução de `user|project|local`
- **AC:**
  - `resolveScope(scope, cwd): { root: string, scope: Scope }` retorna path absoluto.
  - `user` → `${HOME}/.claude/`. Falha (exit `RECOVERABLE_ERROR`) se `HOME` indefinido.
  - `project|local` → `${cwd}/.claude/`. Anti-traversal: rejeita `cwd` que contenha `..` ou aponte para raiz.
  - `project` em `cwd` sem `.git/` → exit `RECOVERABLE_ERROR` com sugestão `--scope local` (SPEC §7 "Ask first").
- **Verification:** `npm test -- cli/tests/unit/install/scope.test.ts`. Casos: 3 escopos felizes; HOME ausente; cwd com `..`; project sem `.git/`.
- **Deps:** Nenhuma.
- **Files:** `cli/src/install/scope.ts`, `cli/tests/unit/install/scope.test.ts`.
- **Size:** S.

#### Task 1.3 — `manifest.ts`: read/write do harness manifest
- **AC:**
  - Schema (D2): `{ version: "1", scope: Scope, harness_version: string, installer: "npx", installed_at: ISO, entries: Array<{ path, sha256, kind }> }`.
  - `readManifest(scopeRoot): Manifest | null` (null quando ausente).
  - `writeManifest(scopeRoot, manifest): void` — atomic via tmp+rename.
  - `deleteManifest(scopeRoot): void` — idempotente.
  - Nunca toca o manifest do **projeto-lint** (sem campo `scope`).
- **Verification:** `npm test -- cli/tests/unit/install/manifest.test.ts`. Casos: round-trip; idempotência; recusa parsear manifest sem `scope`; tmp+rename em FS lotado falha graceful.
- **Deps:** Task 1.2.
- **Files:** `cli/src/install/manifest.ts`, `cli/tests/unit/install/manifest.test.ts`.
- **Size:** S.

#### Task 1.4 — `copy.ts`: cópia byte-a-byte do payload + sha256
- **AC:**
  - `copyPayload({ source, target, dryRun }): { copied: PathEntry[], skipped: PathEntry[] }`.
  - Source = root do pacote npm (resolvido via `version.ts`); copia `skills/`, `commands/`, `agents/`, `cli/` para `<target>/{skills,commands,agents}/` e `<target>/skills/lint/cli/`.
  - Calcula sha256 de cada arquivo escrito (entra no manifest).
  - `dryRun: true` → reporta plano, **zero bytes escritos** (assertado em teste com `tmpfs` snapshot).
  - Idempotente: arquivo com mesmo sha256 pré-existente é "skipped" sem re-escrever.
  - Anti-órfãos: nunca remove arquivos fora do payload (SPEC §7 "Never do").
- **Verification:** `npm test -- cli/tests/unit/install/copy.test.ts`. Casos: cópia limpa em tmpdir; idempotência; dry-run não muda mtime de tmpdir; sha256 estável entre runs.
- **Deps:** Task 1.2, Task 1.1.
- **Files:** `cli/src/install/copy.ts`, `cli/tests/unit/install/copy.test.ts`.
- **Size:** M.

**Checkpoint B** — `npm run typecheck && npm test -- cli/tests/unit/install/`. Cobertura ≥ 90% nos 4 módulos. Sem isso, Phase 2 não começa.

---

### Phase 2 — Subcomandos (vertical slices)

Cada slice adiciona um subcomando ao registry, escreve testes unit + e2e, e atualiza `cli/src/index.ts`.

#### Task 2.1 — `qualy install`
- **AC:**
  - Flags: `--scope <user|project|local>` (default `project`), `--dry-run`, `--yes`.
  - Cria `<scope>/.claude/{skills,commands,agents}` + `skills/lint/cli/` + manifest.
  - `--scope local`: anexa `.claude/` ao `.gitignore` (cria se ausente). Se `.gitignore` existe e a linha já está lá, no-op.
  - `--scope project` em cwd sem `.git/` → exit 1 com sugestão.
  - Sobrescreve instalação existente sem perguntar (SPEC §6).
  - Output: `{ ok, scope, version, target, copied, skipped }`.
  - Exit codes: `0` ok; `1` recoverable (HOME ausente, cwd inválido); `5` MISSING_DEPENDENCY (Node < 22.6).
- **Verification:**
  - Unit: `cli/tests/unit/install/install.test.ts` — cobre matriz scope × dry-run × already-installed.
  - E2E: `cli/tests/e2e/install/install-scopes.test.ts` — bin compilado em tmpdir, valida arquivos no FS.
  - Manual: `npm pack && npx ./qualy-*.tgz install --scope local --dry-run` em repo sintético.
- **Performance budget (informational, sem gate):** `install --scope user` em VM limpa deve completar em ~30s. Não é AC de CI — depende de hardware do runner e estado do cache npm. Se uma medida cair > 60s em hardware razoável, abrir issue de regressão.
- **Deps:** Tasks 1.1–1.4.
- **Files:** `cli/src/install/install.ts`, `cli/src/install/gitignore.ts`, `cli/src/index.ts` (registry), tests.
- **Size:** M.

#### Task 2.2a — Rename `uninstall` legado → `lint-uninstall` (D1)
- **AC:**
  - `cli/src/commands/uninstall.ts` → `cli/src/commands/lint-uninstall.ts` (apenas rename + ajuste do default export name; semântica intacta).
  - Registry em `cli/src/index.ts`: entrada `uninstall` removida, entrada `lint-uninstall` adicionada apontando para o novo módulo.
  - Call sites atualizados: `commands/lint:uninstall.md`, `agents/lint-migrator.md`, `cli/tests/unit/uninstall.test.ts` (renomear arquivo e ajustar import path).
  - Após este task, `qualy lint-uninstall` reproduz 1:1 o comportamento do antigo `qualy uninstall`. `qualy uninstall` ainda **não existe** (vai ser criado em 2.2b).
  - Sem deprecation alias — rename é breaking em 0.x (ADR 0010 + CHANGELOG cobrem).
- **Verification:**
  - `npm run typecheck && npm test -- cli/tests/unit/lint-uninstall.test.ts` passa.
  - `npm test -- cli/tests/e2e/` passa (qualquer e2e que invocava `qualy uninstall` foi atualizado para `qualy lint-uninstall`).
  - `grep -r "qualy uninstall" cli/ commands/ agents/` retorna **zero** resultados (a string só pode aparecer em 2.2b depois).
- **Deps:** Task 2.1.
- **Files:** rename `cli/src/commands/uninstall.ts` → `cli/src/commands/lint-uninstall.ts`, `cli/src/index.ts`, `commands/lint:uninstall.md`, `agents/lint-migrator.md`, rename `cli/tests/unit/uninstall.test.ts` → `cli/tests/unit/lint-uninstall.test.ts`.
- **Size:** S.

**Checkpoint C.1** — Rename limpo, registry estável, todos os testes verdes, grep não acusa referência stale a `qualy uninstall`. Sem isso, 2.2b não começa.

#### Task 2.2b — `qualy uninstall` (harness)
- **AC:**
  - Flags: `--scope <user|project|local>` (default `project`), `--dry-run`, `--yes`, `--keep-backup` (no-op para harness; mantido por simetria com SPEC §3).
  - Lê manifest do escopo. Se ausente → exit 1 com mensagem ("nenhum harness instalado em `<scope>`").
  - Remove **somente** os paths rastreados no manifest (SPEC §7 "Never do — nunca remover arquivos órfãos").
  - Após remover todos os paths, deleta o manifest. Diretórios vazios resultantes são removidos (best-effort).
  - Output: `{ ok, scope, removed: string[], kept: string[] }`.
  - `qualy uninstall` e `qualy lint-uninstall` coexistem com semânticas distintas (harness vs lint stack).
- **Verification:**
  - Unit: `cli/tests/unit/install/uninstall.test.ts` — instala, uninstala, valida FS limpo; uninstala sem manifest → erro claro; órfão criado pelo usuário no escopo permanece.
  - E2E: `cli/tests/e2e/install/uninstall-roundtrip.test.ts` — install → uninstall → FS no estado pré-install (exceto órfãos).
  - Sanity: `qualy uninstall --help` e `qualy lint-uninstall --help` mostram descrições distintas e não-conflitantes.
- **Deps:** Task 2.2a.
- **Files:** `cli/src/install/uninstall.ts` (novo), `cli/src/index.ts` (adicionar entrada `uninstall`), tests novos.
- **Size:** S.

#### Task 2.3 — `qualy update`
- **AC:**
  - Flags: `--scope`, `--dry-run`, `--yes`.
  - Lê manifest do escopo (precisa estar instalado).
  - Resolve `latest` via `npm view qualy version` (D4) com timeout de 5s.
  - Erros do `npm view` são distinguidos por classe, todos com exit `1` (RECOVERABLE_ERROR):
    - **Network unreachable** (`ENOTFOUND`, `ETIMEDOUT`, timeout estourado) → `[qualy/update] cannot reach npm registry (network or DNS issue)`.
    - **Auth/registry config** (`E401`, `E403`, `ENEEDAUTH`) → `[qualy/update] registry rejected request (check ~/.npmrc auth or use a public registry)`.
    - **Versão ausente/inválida no payload** (stdout vazio, `null`, ou string que não parseia como semver) → `[qualy/update] registry returned no version for "qualy" — your registry may be a private mirror without this package`.
    - **Default fallback** (qualquer outro erro de spawn) → mensagem genérica + sugestão `qualy update --dry-run` para debug.
  - Se `latest === installed` → output `{ ok: true, status: "up-to-date" }`, exit 0.
  - Se `latest > installed`:
    - Imprime `installed: A.B.C → latest: X.Y.Z`.
    - Se major bump E não `--yes` → pede confirmação via `readline` (CLI direto). `--yes` skipa.
    - Aplica re-rodando `install` com o tarball novo (`npx qualy@latest install --scope <X> --yes`).
  - Output: `{ ok, status: "up-to-date"|"updated", installed_before, installed_after }`.
- **Verification:**
  - Unit: `cli/tests/unit/install/update.test.ts` — mocka `npm view`. Casos: igual; minor; major sem --yes (aborta); major com --yes (aplica); 4 classes de erro (network, auth, mirror sem versão, default) — cada uma assertando a mensagem específica.
  - E2E: skipado (depende do registry real); cobertura via mock.
- **Deps:** Task 2.1.
- **Files:** `cli/src/install/update.ts`, `cli/src/install/registry.ts` (npm view wrapper), tests.
- **Size:** M.

**Checkpoint C** — `npm run typecheck && npm test && npm run test:e2e`. Cobertura ≥ 90% em `cli/src/install/`. Sem isso, Phase 3 não começa.

---

### Phase 3 — Packaging & distribuição

#### Task 3.1 — `package.json` raiz: `bin` + `files` + shim
- **AC:**
  - `package.json` ganha:
    - `"bin": { "qualy": "bin/qualy.mjs" }`
    - `"files": ["cli/src/", "skills/", "commands/", "agents/", "bin/", "package.json", "README.md", "CHANGELOG.md"]`
    - `"private": false` (atual é `true` — bloqueia publish).
  - `bin/qualy.mjs` (D3) faz `spawn('node', ['--experimental-strip-types', resolveCliEntry(), ...args])`.
  - `cli/src/` é incluído no tarball; `cli/tests/`, `cli/node_modules/`, `.harn/` ficam de fora.
- **Verification:**
  - `npm pack --dry-run` lista exatamente os paths esperados (snapshot test em `cli/tests/e2e/install/pack-contents.test.ts`).
  - `npx ./qualy-*.tgz --version` em tmpdir imprime `0.1.0`.
- **Deps:** Phase 2 completa.
- **Files:** `package.json`, `bin/qualy.mjs`, `cli/tests/e2e/install/pack-contents.test.ts`.
- **Size:** S.

#### Task 3.2 — Bump para `0.1.0` + CHANGELOG
- **AC:**
  - `package.json` versão `0.0.0` → `0.1.0` (SPEC §9 item 2).
  - `cli/package.json` permanece `0.0.0` (D5 — não publicado isolado).
  - `CHANGELOG.md` ganha seção `0.1.0` listando os 3 subcomandos novos.
- **Verification:** `git diff` revisado por humano.
- **Deps:** Task 3.1.
- **Files:** `package.json`, `cli/package.json`, `CHANGELOG.md`.
- **Size:** XS.

#### Task 3.3 — GitHub Actions: publish on tag
- **AC:**
  - `.github/workflows/publish.yml`: trigger em `push` de tags `v*`. Steps: checkout → setup-node 22.6 → `npm ci` → `npm run typecheck && npm run lint && npm test && npm run test:e2e` → `npm publish --access public`.
  - Usa secret `NPM_TOKEN`. Concurrency group por tag para evitar publishes duplicados.
  - Workflow falha bloqueia publish (gate).
- **Verification:**
  - `act` ou push de tag em branch experimental → workflow roda até `npm publish --dry-run` (substituído ANTES do merge para não publicar de verdade).
  - Removida a flag `--dry-run` somente no commit que faz o primeiro publish real.
- **Deps:** Task 3.2.
- **Files:** `.github/workflows/publish.yml`.
- **Size:** S.

#### Task 3.4 — Primeiro publish manual (`v0.1.0`)
- **AC:**
  - Pre-flight checklist (todos verdes antes de criar a tag):
    - [ ] `npm pack --dry-run` lista exatamente os paths esperados (cross-check com Task 3.1).
    - [ ] `package.json` versão = `0.1.0`; `cli/package.json` = `0.0.0` (D5).
    - [ ] `CHANGELOG.md` `0.1.0` reflete os 3 subcomandos novos.
    - [ ] `NPM_TOKEN` no GitHub Secrets tem scope `automation` (não `read-only`); confirma via `gh secret list`.
    - [ ] Branch `main` está em sync com `origin/main`; sem commits locais não-pushed.
    - [ ] CI verde no último commit de main (typecheck + lint + test + test:e2e).
  - **Edição do workflow:** commit removendo `--dry-run` do step `npm publish` em `.github/workflows/publish.yml`. Esse commit vai para main **antes** da tag.
  - **Tag assinada:** `git tag -s v0.1.0 -m "v0.1.0 — npx installer"` (ou `-a` se GPG não configurado, registrar a exceção no CHANGELOG).
  - **Push:** `git push origin v0.1.0`. Workflow dispara automaticamente.
  - **Smoke test pós-publish (≤ 5 min após workflow verde):**
    - [ ] `npx qualy@0.1.0 --version` em tmpdir limpo imprime `0.1.0`.
    - [ ] `npx qualy@0.1.0 install --scope local --dry-run` em repo sintético sai 0.
    - [ ] `npm view qualy version` retorna `0.1.0`.
  - **Rollback plan:** se smoke test falhar, `npm unpublish qualy@0.1.0` dentro de 24h (janela do npm). Documentar incident em CHANGELOG.
- **Verification:** Checklist acima 100% verde antes de declarar shipped.
- **Deps:** Task 3.3.
- **Files:** `.github/workflows/publish.yml` (remoção do `--dry-run`), git tag (artefato externo).
- **Size:** S — mas é o evento mais sensível do projeto. Sem pressa.

**Checkpoint D** — Tarball válido + workflow verde + primeiro publish ok + smoke test ok. Pronto para Phase 4.

---

### Phase 4 — Documentação & paridade

#### Task 4.1 — README: nova seção "Instalação"
- **AC:**
  - Promove `npx qualy install` como caminho oficial.
  - 3 exemplos (user/project/local) com comentário explicando quando usar cada.
  - Nota curta: `install.sh --dev` é só para devs do qualy.
  - Link para `.harn/docs/npx-installer/SPEC.md` para detalhes.
- **Verification:** `npm run lint` (markdown lint, se configurado) + revisão humana.
- **Deps:** Phase 3.
- **Files:** `README.md`.
- **Size:** S.

#### Task 4.2 — `install.sh`: deprecation soft + paridade com `--scope user`
- **AC:**
  - `install.sh` imprime `[qualy/install] note: o caminho recomendado agora é \`npx qualy install\`. Use \`--dev\` apenas se estiver desenvolvendo o qualy localmente.` quando rodado sem `--dev`.
  - Comportamento de `install.sh --dev` permanece idêntico.
  - SPEC §7 "Always do — paridade entre install.sh e `npx qualy install --scope user`": adicionar teste e2e que compara o FS resultante de ambos os caminhos (mesmo conjunto de paths, ignorando timestamps e symlink vs file).
- **Verification:**
  - Unit/e2e: `cli/tests/e2e/install/install-sh-parity.test.ts`.
  - Manual: `./install.sh --dry-run` mostra a deprecation note.
- **Deps:** Phase 3.
- **Files:** `install.sh`, novo teste e2e.
- **Size:** S.

#### Task 4.3 — ADR 0010: distribuição via npm
- **AC:**
  - `docs/adrs/0010-npm-distribution.md` documenta D1, D2, D3, D4 com o consenso final.
  - Status `Accepted`, data ISO.
- **Verification:** Link no README + revisão humana.
- **Deps:** Phases 1–3.
- **Files:** `docs/adrs/0010-npm-distribution.md`.
- **Size:** S.

**Checkpoint E** — Todos os 9 critérios de SPEC §8 verdadeiros (ver §6 abaixo).

---

## 6. Mapa de SPEC §8 → Tasks

Cada checkbox de "Success Criteria" da SPEC tem cobertura explícita aqui.

| Critério SPEC §8 | Tasks que entregam |
|---|---|
| `npm pack` gera tarball com paths corretos | 3.1 |
| `npx ./qualy-*.tgz install --scope local --dry-run` exit 0 sem mexer FS | 2.1 (e2e) + 3.1 |
| `install --scope user` em VM nova ≤ 30s | 2.1 (informational, sem gate de CI) |
| `/lint:setup` funciona após `install --scope project` | 2.1 (e2e via slash command harness) |
| `uninstall` remove tudo do manifest | 2.2b (precedido por 2.2a — rename do legado) |
| `update` mostra diff de versão e pede confirmação | 2.3 |
| `install` em escopo com `install.sh` legacy (sem manifest) | 2.1 (caso especial: ausência de manifest, sobrescreve, cria novo) |
| Suite passa, cobertura ≥ 90% em `cli/src/install/` | Checkpoint B + Checkpoint C |
| `install.sh --dev` continua funcional | 4.2 |
| README documenta os 3 escopos | 4.1 |

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Shim `bin/qualy.mjs` quebra em algum Node 22.x edge | Alto (bloqueia publish) | Teste e2e em CI cruzando 22.6 / 22.latest / 24.x antes do publish (Task 3.3). |
| Rename de `uninstall` quebra `commands/lint:uninstall.md` ou `lint-migrator.md` em users já instalados | Médio | Rename é breaking, mas estamos em `0.x` (SPEC §9). CHANGELOG documenta + ADR. |
| `npm view` lento em conexões ruins faz `update` parecer travado | Baixo | Timeout 5s + log de progresso `[qualy/update] checking npm registry…`. |
| `--scope local` adiciona `.claude/` ao `.gitignore` que já tinha rule conflitante (`!.claude/keep-this`) | Baixo | Append simples no fim do arquivo; não reordena rules. SPEC §7 "Ask first" cobre o caso edge. |
| Tarball acidentalmente inclui `.harn/` ou `node_modules/` | Alto (vazamento + size) | Snapshot test em Task 3.1 (`pack-contents.test.ts`) bloqueia regressão. |

---

## 8. Out of scope (este plano)

Mantido alinhado a SPEC §10 + decisões deste plano:

- Suporte Windows nativo (PowerShell). WSL é validado por reflexo (Linux).
- Migração automática de `install.sh` para o manifest novo (usuários re-rodam `npx qualy install`).
- Auto-update background.
- Telemetria (SPEC §9 item 5).
- Multiple harness versions por escopo.
- Gerenciamento de cache npm/npx (responsabilidade do npm).
