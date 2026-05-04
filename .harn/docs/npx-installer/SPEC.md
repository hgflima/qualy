# Spec: Instalador via npx

> Status: **Approved** — open questions resolvidas em 2026-05-04, pronto para fase Plan.
> Escopo: feature isolada (nova superfície de distribuição). Não substitui `.harn/docs/mvp/SPEC.md`, complementa-o.

## 1. Objective

Distribuir o harness Claude Code do qualy (`/lint` skill, slash commands, subagents, CLI) através do npm, de modo que qualquer usuário possa instalar em uma máquina nova com:

```bash
npx qualy install
```

sem clonar o repositório, sem rodar bash, e sem precisar de permissões fora do diretório alvo.

### Por quê

- Hoje a instalação exige `git clone qualy && ./install.sh`, o que é fricção significativa para usuários novos e exige confiança em executar bash de fonte arbitrária.
- O `install.sh` opera só em `~/.claude/`. Equipes querem versionar a config do harness por projeto (commit no repo) — não há suporte hoje.
- Sem registro de versão, é impossível reproduzir uma instalação entre máquinas/CIs ou auditar drift.

### Usuário-alvo

1. **Adopter individual** — quer experimentar o `/lint` em qualquer projeto sem pollute o `~/.claude/` global. Roda `npx qualy install --scope local`.
2. **Time de engenharia** — quer adotar o harness em um repo compartilhado com config commitada no git. Roda `npx qualy install` (default `--scope project`) e versiona `.claude/`.
3. **Power user** — quer o harness disponível globalmente para todos os seus projetos. Roda `npx qualy install --scope user`.
4. **Dev do qualy** — continua usando `./install.sh --dev` para symlinks que refletem edições locais imediatamente.

### Sucesso

- Em uma máquina com Node ≥ 22.6 e sem o repo qualy clonado, `npx qualy install` deixa o `/lint` funcional no Claude Code em ≤ 30s.
- `qualy uninstall` remove byte-a-byte tudo que `install` criou (manifest é a fonte de verdade).
- `qualy update` detecta nova versão no npm, mostra diff de versão e pede confirmação antes de aplicar.
- Os 3 escopos (`user`/`project`/`local`) coexistem na mesma máquina sem conflitos.

---

## 2. Tech Stack

| Camada | Tecnologia | Versão | Notas |
|---|---|---|---|
| Runtime | Node.js | ≥ 22.6 | Mantém `--experimental-strip-types` para .ts direto |
| Package format | ESM | — | `"type": "module"` |
| CLI parsing | Reaproveitar parser atual do `cli/` | — | Sem nova dependência |
| Distribuição | npm registry público | — | Pacote `qualy`, bin `qualy` |
| Manifest | JSON puro | — | `.lint-manifest.json` (já existe; estender com campos de versão) |
| User prompts | `AskUserQuestion` no caminho slash command; **não** no caminho CLI puro | — | CLI direto deve ser não-interativo (para CI). Confirmações ficam atrás de `--yes` ou prompt nativo via `readline`. |

**Sem novas runtime dependencies.** Tudo em stdlib Node + reuso do CLI atual.

---

## 3. Commands

```bash
# Build / typecheck (mesmo do projeto atual)
npm run typecheck            # tsc --noEmit no workspace cli
npm run lint                 # oxlint --config oxlint.fast.json .
npm run lint:deep            # oxlint --config oxlint.deep.json .
npm run format               # oxfmt --write .
npm run test                 # vitest run cli/tests/unit
npm run test:e2e             # vitest run cli/tests/e2e
npm run coverage             # vitest run --coverage

# Novos subcomandos do bin `qualy` (foco desta feature)
qualy install   [--scope user|project|local] [--dry-run] [--yes]
qualy uninstall [--scope user|project|local] [--dry-run] [--yes] [--keep-backup]
qualy update    [--scope user|project|local] [--dry-run] [--yes]

# Subcomandos existentes (continuam funcionando)
qualy detect-stack | install-deps | install-oxlint | install-hook | ...
qualy audit | recs-generate | recs-apply | ...
qualy backup-create | backup-list | backup-restore
```

**Verificação local da publicação (sem publicar de verdade):**
```bash
npm pack                                  # gera qualy-X.Y.Z.tgz
npx ./qualy-X.Y.Z.tgz install --dry-run   # smoke test do tarball
```

---

## 4. Project Structure

```
.harn/docs/npx-installer/
  SPEC.md                  ← este documento
  PLAN.md                  ← (próxima fase) plano técnico
  TASKS.md                 ← (fase 3) breakdown executável

cli/
  src/
    index.ts               ← entrypoint do bin `qualy` (estende com novos subcmds)
    install/               ← NOVO. Lógica do harness installer.
      install.ts           ← `qualy install`
      uninstall.ts         ← `qualy uninstall`
      update.ts            ← `qualy update`
      scope.ts             ← resolve user|project|local → path absoluto
      manifest.ts          ← read/write `.lint-manifest.json` com pin de versão
      copy.ts              ← copia artefatos do pacote npm para o escopo alvo
    commands/              ← subcomandos existentes (detect-stack, audit, etc.)
  tests/
    unit/install/          ← NOVO. Testes unitários por módulo.
    e2e/install/           ← NOVO. Fixtures: instalação completa em tmpdir.

skills/lint/               ← payload copiado pelo installer (sem mudança estrutural)
commands/lint*             ← idem
agents/lint-*              ← idem

install.sh                 ← MANTIDO como fallback dev (modo --dev symlink)
package.json               ← adicionar `"bin": { "qualy": "..." }` + `"files": [...]`
```

### Layout do payload no escopo alvo

Independente do escopo, o instalador escreve sempre a mesma estrutura **dentro** do diretório alvo:

```
<scope-root>/.claude/      (para project|local)
~/.claude/                 (para user)
  skills/lint/
    SKILL.md
    cli/                   ← cópia byte-a-byte de cli/ do pacote
  commands/
    lint.md
    lint:setup.md
    ...
  agents/
    lint-detector.md
    lint-installer.md
    ...
  .lint-manifest.json      ← rastreia tudo acima + versão instalada
```

### Resolução dos escopos

| `--scope`  | Path resolvido                  | `.gitignore`?              |
|------------|---------------------------------|-----------------------------|
| `user`     | `${HOME}/.claude/`              | N/A (fora do repo)          |
| `project`  | `${cwd}/.claude/`               | **Não** — meant for commit  |
| `local`    | `${cwd}/.claude/`               | **Sim** — installer adiciona `.claude/` ao `.gitignore` se não estiver |

**Nota:** `project` e `local` resolvem para o mesmo path. O que muda é o tratamento do `.gitignore` e o campo `scope` no manifest. Se o usuário tentar instalar `project` por cima de `local` (ou vice-versa), o installer detecta via manifest e pede confirmação.

---

## 5. Code Style

Seguir o estilo já existente em `cli/src/`. Exemplo concreto de um subcomando novo:

```typescript
// cli/src/install/install.ts
import type { Logger } from "../lib/logger.ts";
import { resolveScope, type Scope } from "./scope.ts";
import { copyPayload } from "./copy.ts";
import { writeManifest, readManifest } from "./manifest.ts";
import { readPackageVersion } from "./version.ts";

type InstallOptions = {
  scope: Scope;
  dryRun: boolean;
  yes: boolean;
};

type InstallResult =
  | { ok: true; scope: Scope; version: string; copied: number; skipped: number }
  | { ok: false; reason: "node-too-old" | "payload-missing" | "user-aborted"; detail?: string };

export async function install(opts: InstallOptions, log: Logger): Promise<InstallResult> {
  const target = resolveScope(opts.scope);
  const version = readPackageVersion();
  const prior = await readManifest(target);

  if (prior && prior.scope !== opts.scope) {
    log.warn(`existing manifest scope=${prior.scope} differs from requested ${opts.scope}; overwriting`);
  }

  const { copied, skipped } = await copyPayload({ target, dryRun: opts.dryRun }, log);
  if (!opts.dryRun) {
    await writeManifest(target, { scope: opts.scope, version, installer: "npx", installedAt: new Date().toISOString() });
  }

  return { ok: true, scope: opts.scope, version, copied, skipped };
}
```

### Convenções

- **Result types discriminados** (`{ ok: true, ... } | { ok: false, reason: ... }`), nunca exceptions para fluxo de controle. Exceptions só para bugs/invariants.
- **Side effects por trás de funções nomeadas** (`copyPayload`, `writeManifest`); puro vs. impuro é explícito.
- **Sem `any`**. Sem `as` casts exceto em parsing de JSON externo.
- **Logger injetado**, nunca `console.log` direto fora do entrypoint.
- **Naming**: `kebab-case` para arquivos, `camelCase` para funções, `PascalCase` para tipos.
- **Imports com extensão `.ts` explícita** (Node strip-types exige).
- **Comentários só para o "porquê" não-óbvio.** Nunca para "o quê".

---

## 6. Testing Strategy

### Framework
- **vitest** (já em uso). Sem nova dep.

### Níveis

| Nível | Localização | O que cobre |
|---|---|---|
| Unit | `cli/tests/unit/install/` | `scope.ts` (resolução de paths), `manifest.ts` (read/write/migração), `copy.ts` (idempotência, dry-run) com fs mockado por `tmpdir`. |
| Integração | `cli/tests/unit/install/install.test.ts` | `install/uninstall/update` end-to-end contra `tmpdir`, sem mock de fs, sem rede. |
| E2E | `cli/tests/e2e/install/` | Roda o bin compilado contra um repo sintético (mesma estratégia do `cli/tests/e2e/` atual), valida `.lint-manifest.json`, conta arquivos, verifica `--dry-run` não toca FS. |

### Cobertura

Manter o threshold global do projeto (definido em `vitest.config.ts`). Os módulos novos em `cli/src/install/` devem atingir **≥ 90%** statements (lógica determinística, sem I/O externo).

### Casos obrigatórios

- `install --scope user` em tmp `HOME` cria `<HOME>/.claude/...` e manifest com `scope: "user"`.
- `install --scope project` em tmp `cwd` cria `<cwd>/.claude/...` e **não** adiciona ao `.gitignore`.
- `install --scope local` em tmp `cwd` cria `<cwd>/.claude/...` **e** adiciona `.claude/` ao `.gitignore` (criando o arquivo se não existir).
- `install` sobre instalação existente sobrescreve sem perguntar (decisão: "Sobrescrever sempre").
- `install --dry-run` não muda nenhum byte no FS, mas reporta o plano completo.
- `uninstall` remove **apenas** os paths registrados no manifest (não toca arquivos órfãos do escopo).
- `update` quando `latest === installed` é no-op (reporta "up to date", exit 0).
- `update` quando `latest > installed` mostra diff de versão e exige confirmação (`--yes` para CI).
- Node < 22.6 aborta com mensagem clara (exit code != 0).

### Não-objetivos de teste

- Não testar a publicação no npm (manual, fora do CI).
- Não testar o `npx` em si (assumimos que funciona).

---

## 7. Boundaries

### Always do
- Registrar **toda** mutação no `.lint-manifest.json` (path + sha256 + scope + version).
- Validar `Node ≥ 22.6` antes de qualquer escrita.
- Suportar `--dry-run` em **todos** os subcomandos mutantes.
- Suportar `--yes` em **todos** os subcomandos para uso em CI.
- Manter paridade de comportamento entre `install.sh` e `npx qualy install` quando ambos atuam em `--scope user`.

### Ask first (uma pergunta por vez via `AskUserQuestion` quando invocado por slash command; via prompt simples no CLI direto)
- Antes de `update` aplicar uma mudança de versão major.
- Antes de adicionar `.claude/` ao `.gitignore` se o arquivo já existir e a entrada não estiver lá.
- Antes de qualquer `--scope project` em diretório que **não** seja repo git (`.git/` ausente) — sugerir `--scope local` ou abortar.

### Never do
- **Nunca** remover arquivos fora do conjunto rastreado pelo manifest. Qualquer arquivo "órfão" no escopo é tratado como propriedade do usuário.
- **Nunca** instalar global no npm (`npm install -g`) automaticamente. `npx` resolve sob demanda.
- **Nunca** editar `package.json` do projeto-alvo a partir do `qualy install` (apenas o `cli/` interno do qualy se preocupa com isso, em outros subcomandos).
- **Nunca** publicar no npm a partir de CI sem tag git assinada (operacional, não enforced no código).
- **Nunca** confiar que `cwd` é seguro: validar que escopos `project`/`local` resolvem para path dentro do `cwd` (anti path-traversal).

---

## 8. Success Criteria

Critérios objetivos e testáveis que precisam estar verdadeiros para a feature ser considerada pronta:

- [ ] `npm publish` (ou `npm pack`) gera tarball `qualy-X.Y.Z.tgz` que contém apenas: `cli/`, `skills/`, `commands/`, `agents/`, `package.json`, `README.md`, `CHANGELOG.md`. Nenhum `.harn/`, `tests/`, `node_modules/`, `.git*`.
- [ ] `npx ./qualy-X.Y.Z.tgz install --scope local --dry-run` em repo limpo imprime plano de cópia e exit code 0, sem tocar FS.
- [ ] `npx ./qualy-X.Y.Z.tgz install --scope user` em VM nova (sem repo qualy clonado) deixa `~/.claude/skills/lint/SKILL.md` presente em ≤ 30s.
- [ ] Após `install --scope project`, abrir Claude Code no repo, digitar `/lint:setup` e o slash command roda (i.e., as commands/agents foram descobertos no escopo project).
- [ ] `qualy uninstall --scope <X>` remove **todos** os paths listados no manifest desse escopo e remove o próprio manifest. `find <scope-root>/.claude/lint*` retorna vazio.
- [ ] `qualy update` quando há nova versão: imprime `installed: A.B.C → latest: X.Y.Z` e pede confirmação interativa (ou aceita `--yes`).
- [ ] `qualy install` em escopo já habitado por uma instalação via `install.sh` (sem manifest) sobrescreve e cria manifest novo, sem erro.
- [ ] Suite de testes (`npm test && npm run test:e2e`) passa, com cobertura ≥ 90% nos módulos novos `cli/src/install/`.
- [ ] `install.sh` continua funcional para devs (modo `--dev` symlink), com nota no `README.md` indicando que o caminho oficial é `npx qualy`.
- [ ] `README.md` na raiz documenta a seção "Instalação" priorizando `npx qualy install`, com exemplos para os 3 escopos.

---

## 9. Resolved Decisions

Questões anteriormente em aberto, resolvidas em 2026-05-04. Cada item é uma decisão vinculante para a fase Plan/Implementation.

1. **Nome do pacote no npm — `qualy`.** Verificado livre no registry (`npm view qualy` → E404 em 2026-05-04). Bin name: `qualy`. Sem fallback necessário.
2. **Versionamento — `0.x.x` até MVP estável.** Primeira release: `0.1.0`. Semver pleno só após declarar `1.0.0`. Sinaliza que a API pode quebrar entre minors. `0.x.y` patch para fixes; `0.X.0` minor para features ou breaking changes.
3. **CI de publicação — GitHub Actions em git tag.** Workflow dispara em tags `v*`, roda `npm run typecheck && npm run lint && npm test && npm run test:e2e`, depois `npm publish --access public`. Token via secret `NPM_TOKEN`. Bloqueia merge se suite falhar. (Workflow é tarefa separada do core installer, mas pertence à mesma feature.)
4. **`--scope local` em monorepo — `cwd` literal, sem heurística.** Instalador nunca sobe diretórios procurando workspace root. Se o usuário quer instalar no root do monorepo, ele faz `cd` para lá. Princípio: previsibilidade > esperteza.
5. **Telemetria — zero.** Nenhum evento de install/uninstall/update é coletado, nem para servidor próprio nem terceiros. Consistente com a filosofia atual do projeto. Sem flag de opt-in (não há infra que justifique).
6. **Drift de versão entre `npx` e `cli/` instalado — não alertar.** Cada `<scope>/skills/lint/cli/` é independente. `qualy <subcmd>` não checa o registry npm. Atualização é sempre explícita via `qualy update`. Justificativa: evita rede em comandos quentes e mantém comportamento determinístico offline.

---

## 10. Out of Scope (esta feature)

Coisas que **não** vamos resolver agora, para manter o escopo controlado:

- Auto-update silencioso em background (`qualy update` é sempre explícito).
- Suporte a Windows nativo (PowerShell). Foco: macOS + Linux. WSL deve funcionar.
- Distribuir via Homebrew, asdf, mise, etc. Apenas npm.
- Gerenciar múltiplas versões do harness por escopo (uma instalada por escopo).
- Migrar configurações de outros linters (eslint, prettier) — isso é responsabilidade do `qualy install-oxlint`, separado.
