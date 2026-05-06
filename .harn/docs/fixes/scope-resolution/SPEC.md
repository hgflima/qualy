# Spec: scope-resolution

> Fix do preâmbulo bash que resolve `QUALY_CLI` em ~25 arquivos. O fallback atual (`${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}`) fura o cenário default do `qualy install` (scope `project` → `${cwd}/.claude/`) e quebra silenciosamente quando o CLI está no projeto, não em `$HOME`.

## 1. Contexto e motivação

`qualy install` (CLI moderno, ADR 0010) suporta 3 scopes documentados em `cli/src/install/install.ts:55-58`:

| Scope     | Path destino           | Notas                                  |
|-----------|------------------------|----------------------------------------|
| `user`    | `${HOME}/.claude`      | Per-user, shared across projects       |
| `project` | `${cwd}/.claude`       | **Default** — committed; requires `.git/` |
| `local`   | `${cwd}/.claude`       | Gitignored                             |

`cli/src/install/install.ts:215` hardcoda `let scope: Scope = "project";` — ou seja, o caminho mais comum é instalar no projeto, não em `$HOME`.

**O preâmbulo bash atual**, replicado em 25 arquivos:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <sub> --cwd "$PWD" "$@"
```

**Causa raiz.** `CLAUDE_PLUGIN_ROOT` é uma env var setada pelo Claude Code apenas quando uma skill é carregada como **plugin oficial** (via marketplace). O qualy é distribuído via npm/`install.sh` (ADRs 0009, 0010, 0011) — **nunca como plugin oficial**, então `CLAUDE_PLUGIN_ROOT` está sempre unset. A expansão `:-` cai em `$HOME/.claude`. Para qualquer usuário que usou o default scope `project`, o CLI mora em `${cwd}/.claude/` e o preâmbulo aponta para o lugar errado: `MODULE_NOT_FOUND` ou silêncio confuso.

**Por que escapou dos testes.** Suite e2e existente (`install-scopes.test.ts`, `install-sh-parity.test.ts`) executa o CLI a partir do checkout do repo, não a partir do output de `qualy install` em scope project. Nenhum teste invoca o preâmbulo literal contra um install em `${cwd}/.claude/`. Esse teste estava faltando.

## 2. Objective

Tornar o preâmbulo de cada um dos 25 arquivos consistentemente capaz de resolver o CLI em qualquer dos 3 scopes (`user`, `project`, `local`) que o `qualy install` documenta — falhando com mensagem clara quando o CLI realmente não foi instalado em nenhum lugar.

**User stories:**

- Como usuário que rodou `qualy install` (default scope `project`) num repo, quando o Claude Code carrega `/lint:status`, o preâmbulo encontra o CLI em `${PWD}/.claude/skills/lint/cli/src/index.ts` e executa sem erro.
- Como usuário que rodou `qualy install --scope user` (CLI em `$HOME/.claude/`), o preâmbulo continua funcionando — o probe respeita o fallback.
- Como usuário que esqueceu de rodar `qualy install`, recebo em stderr: `qualy CLI not found in $PWD/.claude or $HOME/.claude. Run \`qualy install\` first.` e exit 5 (`MISSING_DEP`, alinhado com `cli/src/lib/exit-codes.ts`).
- Como mantenedor, sei que os 25 preâmbulos não vão divergir entre si: um teste unit lê todos via glob, extrai o bloco e compara byte-a-byte.

## 3. Tech Stack

- **Bash**: POSIX-compatível (`for`, `[ ]`, `[ -f ]`, `&&`, `>&2`, `exit`). Nada de bashisms (`[[`, `<<<`, arrays).
- **Node**: `>=20.0.0` (mantido; `--experimental-strip-types` ainda é o runtime do CLI, ADR 0007 + 0011).
- **Vitest**: 2.x (mantido; novos testes em `cli/tests/unit/preamble-parity.test.ts` e `cli/tests/e2e/preamble-resolution.test.ts`).
- **Delta vs hoje**: zero novas deps. Mudança é puramente nos snippets `.md` + 1 ADR + 2 testes.

## 4. Commands

```
Install local deps:    npm install
Typecheck:             npm run typecheck
Lint:                  npm run lint
Test (unit):           npm test
Test (e2e):            npm run test:e2e
Test (single unit):    npx vitest run cli/tests/unit/preamble-parity.test.ts
Test (single e2e):     npx vitest run cli/tests/e2e/preamble-resolution.test.ts
Smoke local:           D=$(mktemp -d) && cd "$D" && git init && \
                       qualy install --dry-run && \
                       grep -A2 'QUALY_CLI=' .claude/skills/lint/SKILL.md
```

`npm run build` continua sendo placeholder — não há build step.

## 5. Project Structure

Mudanças isoladas — sem novos diretórios em `cli/src/`. Lista canônica das 25 ocorrências do preâmbulo (obtida via `grep -rln 'CLAUDE_PLUGIN_ROOT:-\$HOME/.claude' --include="*.md"`):

**Funcional (executado em runtime — 19 arquivos):**

```
skills/lint/SKILL.md
agents/lint-auditor.md
agents/lint-detector.md
agents/lint-installer.md
agents/lint-migrator.md
commands/lint/audit.md
commands/lint/report.md
commands/lint/rollback.md
commands/lint/setup.md
commands/lint/uninstall.md
commands/lint/update.md
commands/lint/ignore/add.md
commands/lint/ignore/explain.md
commands/lint/ignore/list.md
commands/lint/ignore/remove.md
commands/lint/rules/add.md
commands/lint/rules/explain.md
commands/lint/rules/list.md
commands/lint/rules/remove.md
```

**Documentação histórica (atualizada por consistência — 6 arquivos):**

```
README.md
docs/adrs/0006-deterministic-cli-thin-harness.md
docs/adrs/0007-runtime-ts-strip-types.md
docs/adrs/0009-install-script-distribution.md
.harn/docs/mvp/PLAN.md
.harn/docs/mvp/IMPLEMENTATION_PLAN.md
```

**Novos arquivos:**

```
docs/adrs/0013-scope-resolution-probe.md          # Novo ADR (Status: aceito)
cli/tests/unit/preamble-parity.test.ts            # Garante byte-equivalência dos 19 funcionais
cli/tests/e2e/preamble-resolution.test.ts         # Smoke real em PWD-only/HOME-only/ambos/nenhum
.harn/docs/fixes/scope-resolution/SPEC.md         # Este arquivo
.harn/docs/fixes/scope-resolution/PLAN.md         # Próximo (skill `agent-skills:plan`)
.harn/docs/fixes/scope-resolution/TASKS.md        # Após PLAN
```

Estruturas que **não** são tocadas: `cli/src/install/scope.ts`, `cli/src/install/install.ts`, `bin/qualy.mjs`, `package.json`, `tsconfig.json`, `.github/workflows/`. O fix é exclusivamente nos preâmbulos `.md` + tests.

## 6. Code Style

### Preâmbulo canônico (substitui a 1-line atual)

```bash
QUALY_CLI=""
for cand in "$PWD/.claude" "$HOME/.claude"; do
  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break
done
[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found in \$PWD/.claude or \$HOME/.claude. Run \`qualy install\` first." >&2; exit 5; }
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

### Convenções

- **Ordem do probe.** `$PWD/.claude` primeiro (cobre scopes `project` e `local`, que apontam para `${cwd}/.claude`). `$HOME/.claude` segundo (cobre scope `user`). Esta ordem reflete o default de `qualy install` (`scope: "project"`).
- **`CLAUDE_PLUGIN_ROOT` removido.** O qualy não é distribuído como plugin oficial do Claude Code. A var nunca está setada na prática; manter o nome induzia leitor a assumir uma realidade que não existe.
- **Exit 5 = `MISSING_DEP`.** Alinhado com `cli/src/lib/exit-codes.ts` e o mapeamento sugerido na própria SKILL.md (linha 52: `5` → "Falta `oxlint`/`oxfmt`/`quality-metrics`. Rodar `/lint:setup` instala tudo.").
- **POSIX puro.** Sem `[[`, sem arrays, sem `set -u`. Roda em `bash` invocado pelo Claude Code com flags default.
- **Bloco fechado em `&&`.** O preâmbulo nunca silencia erros — qualquer falha de probe leva ao `exit 5` final.
- **Comentário inline opcional.** Os arquivos funcionais não precisam de comentário (o código é auto-explicativo); o ADR 0013 carrega a justificativa.

### Manutenção

Os 19 arquivos funcionais devem ter o bloco **literal** (byte-a-byte). O `<subcommand>` na última linha varia por arquivo (e.g., `setup.md` invoca `setup`, `audit.md` invoca `audit`). O teste de paridade compara apenas as 5 linhas do probe — não a invocação final.

## 7. Testing Strategy

### Unit: `cli/tests/unit/preamble-parity.test.ts`

**O que prova.** Os 19 preâmbulos funcionais são byte-idênticos no bloco do probe.

**Estrutura:**

```ts
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const FUNCTIONAL_FILES = [
  "skills/lint/SKILL.md",
  "agents/lint-auditor.md",
  // ... 17 outros
];

const PROBE_REGEX = /QUALY_CLI=""\nfor cand in "\$PWD\/\.claude" "\$HOME\/\.claude"; do\n  \[ -f "\$cand\/skills\/lint\/cli\/src\/index\.ts" \] && QUALY_CLI="\$cand\/skills\/lint\/cli\/src\/index\.ts" && break\ndone\n\[ -z "\$QUALY_CLI" \] && \{ echo "qualy CLI not found in \\\$PWD\/\.claude or \\\$HOME\/\.claude\. Run `qualy install` first\." >&2; exit 5; \}/;

describe("preamble parity across funcional files", () => {
  it.each(FUNCTIONAL_FILES)("%s contains the canonical probe block", (path) => {
    const content = readFileSync(`${REPO_ROOT}/${path}`, "utf8");
    expect(content).toMatch(PROBE_REGEX);
  });

  it("all 19 functional files have the same probe block (byte-for-byte)", () => {
    const blocks = FUNCTIONAL_FILES.map((p) => extractProbeBlock(readFileSync(`${REPO_ROOT}/${p}`, "utf8")));
    const unique = new Set(blocks);
    expect(unique.size).toBe(1);
  });

  it("functional file count is 19 (regression guard for new commands/agents)", () => {
    const found = globSync("{skills,agents,commands}/**/*.md", { cwd: REPO_ROOT })
      .filter((p) => /QUALY_CLI=/.test(readFileSync(`${REPO_ROOT}/${p}`, "utf8")));
    expect(found.sort()).toEqual(FUNCTIONAL_FILES.sort());
  });
});
```

### E2E: `cli/tests/e2e/preamble-resolution.test.ts`

**O que prova.** O snippet bash literal funciona em 4 cenários de filesystem.

**Cenários:**

| # | Setup                                     | Esperado                          |
|---|-------------------------------------------|-----------------------------------|
| 1 | `$PWD/.claude/skills/lint/cli/src/index.ts` existe; `$HOME/.claude` vazio | `QUALY_CLI` resolve para PWD path; exit 0 |
| 2 | `$PWD/.claude` vazio; `$HOME/.claude/skills/lint/cli/src/index.ts` existe | `QUALY_CLI` resolve para HOME path; exit 0 |
| 3 | Ambos existem                             | `QUALY_CLI` resolve para PWD path (precedência); exit 0 |
| 4 | Nenhum existe                             | exit 5; stderr contém "qualy CLI not found" |

**Estrutura:**

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

describe("e2e: preamble bash snippet resolution", () => {
  // beforeEach: cria tmpHome + tmpPwd; sobrescreve HOME via env

  it("scenario 1: PWD-only", () => {
    seedCli(tmpPwd);
    const { stdout, status } = runProbe({ HOME: tmpHome, PWD: tmpPwd });
    expect(status).toBe(0);
    expect(stdout).toContain(`${tmpPwd}/.claude/skills/lint/cli/src/index.ts`);
  });

  it("scenario 4: nothing installed", () => {
    const { stderr, status } = runProbe({ HOME: tmpHome, PWD: tmpPwd });
    expect(status).toBe(5);
    expect(stderr).toContain("qualy CLI not found");
  });

  // ... cenários 2 e 3
});
```

### Coverage

- Cobertura unit do snippet em si é por inspeção de regex (não há código TS pra cobrir).
- E2E cobre 4 caminhos do shell script (PWD-found, HOME-found, both-prefer-PWD, neither).
- Total da suite continua ≥ 90% nos módulos `cli/src/install/` (SPEC §8 do MVP).

## 8. Boundaries

### Always do

- Manter os 19 arquivos funcionais byte-idênticos no bloco do probe (5 linhas que vão de `QUALY_CLI=""` até `[ -z "$QUALY_CLI" ] && { ... exit 5; }`).
- Atualizar a numeração do ADR (`0013-scope-resolution-probe.md`) — último em uso é `0012`.
- Cross-link ADR 0013 nos ADRs 0006 e 0007 (que mostravam o preâmbulo antigo).
- Validar `npm test` + `npm run test:e2e` verdes antes de commit.
- Smoke manual: `qualy install --scope project --dry-run` num tmp dir, depois `bash -c "<preâmbulo>"` para confirmar que resolve.

### Ask first

- Tocar arquivos em `cli/src/` (fora do escopo deste fix; o resolver é pure-bash, não TS).
- Mudar `cli/src/lib/exit-codes.ts` (exit 5 já existe; reuso direto).
- Renomear `MISSING_DEP` ou tocar mapeamento user-friendly em `SKILL.md` linha 50-52.
- Adicionar 4º path de busca (e.g., `$XDG_CONFIG_HOME/.claude`) — deixa pra follow-up se aparecer demanda real.

### Never do

- Reintroduzir `CLAUDE_PLUGIN_ROOT` "por garantia". Se um dia o qualy virar plugin oficial, abre-se ADR novo e atualiza o SPEC §6.
- Usar `bashisms` (`[[`, arrays, `<<<`) — Claude Code invoca o snippet em `bash` minimal.
- Silenciar a falha (`|| true`, `2>/dev/null`). Erro tem que chegar ao usuário.
- Hardcodar `/Users/<user>` ou `/home/<user>`. `$HOME` e `$PWD` são contrato do Claude Code.
- Mudar a ordem do probe sem mexer também no `cli/src/install/install.ts:215` (default scope) — eles têm que estar alinhados.
- Skipar o teste de paridade pra acelerar suite. Sem ele, drift entre 19 arquivos é certeza.

## 9. Success Criteria

Critérios objetivos e verificáveis. **Cada item deve estar verde antes do spec ser considerado entregue.**

- [ ] Os 19 arquivos funcionais (`skills/lint/SKILL.md`, 4 `agents/lint-*.md`, 14 `commands/lint/**/*.md`) contêm o bloco do probe canônico definido em §6, byte-a-byte idênticos.
- [ ] Os 6 arquivos de documentação histórica (`README.md`, `docs/adrs/0006-...md`, `docs/adrs/0007-...md`, `docs/adrs/0009-...md`, `.harn/docs/mvp/PLAN.md`, `.harn/docs/mvp/IMPLEMENTATION_PLAN.md`) refletem o preâmbulo novo nos exemplos/citações.
- [ ] `docs/adrs/0013-scope-resolution-probe.md` existe com Status `aceito`, Decisão clara, e Consequências enumerando o que muda vs ADRs 0006/0007.
- [ ] ADR 0006 ganha cross-link `Related: ADR 0013` na seção de decisão.
- [ ] ADR 0007 ganha cross-link `Related: ADR 0013`.
- [ ] `cli/tests/unit/preamble-parity.test.ts` existe e passa, cobrindo byte-equivalência + count de 19 arquivos funcionais.
- [ ] `cli/tests/e2e/preamble-resolution.test.ts` existe e passa, cobrindo os 4 cenários (PWD-only, HOME-only, ambos, nenhum).
- [ ] `npm test` (unit) e `npm run test:e2e` (e2e) verdes. Total de testes ≥ atual + 7 (estimativa: 4 cenários e2e + 3 asserções unit).
- [ ] `npm run typecheck` verde.
- [ ] `npm run lint` verde.
- [ ] Smoke manual: tmp dir com `git init` → `qualy install` (default scope `project`) → `bash -c "<preâmbulo>"` resolve para `${tmpdir}/.claude/skills/lint/cli/src/index.ts`. Repetir com `--scope user` em `$HOME=$tmpdir` para validar fallback.
- [ ] `CHANGELOG.md` documenta a mudança na próxima seção `[Unreleased]` ou `[0.X.Y]`.

## 10. Out of scope

Itens deliberadamente **não** cobertos por este spec:

- **Suporte a `CLAUDE_PLUGIN_ROOT`.** Removido conscientemente. Se houver plugin marketplace oficial no futuro, abre-se ADR novo.
- **Suporte a `$XDG_CONFIG_HOME`.** Default em Linux raro; usuários que querem isso podem `export HOME=$XDG_CONFIG_HOME`. Follow-up se aparecer demanda.
- **Refactor do `cli/src/install/scope.ts`.** O resolver bash espelha o que `resolveScope` já faz; manter os dois alinhados é responsabilidade do contributor que mexer em scope.ts.
- **Helper sourced (`bin/qualy-resolve.sh`).** Avaliado e descartado — chicken-and-egg de bootstrap não compensa pra 5 linhas de bash.
- **Mudança no exit code 5.** Reaproveita `MISSING_DEP` existente; sem novos códigos.
- **Migração de instalações antigas.** Quem já rodou `install.sh` em `$HOME/.claude` continua funcionando sem ação (fallback HOME cobre).

## 11. Open questions

Nenhuma — todas as decisões foram fechadas via `AskUserQuestion`:

1. Replicação inline em cada arquivo (vs helper sourced) — escolhido inline.
2. Probe `PWD → HOME` apenas, sem `CLAUDE_PLUGIN_ROOT`.
3. Falha clara com `exit 5` + mensagem em stderr (vs fallback silencioso ou `npx`).
4. Testes: unit (paridade) + e2e (3+1 cenários).
5. Escopo: 19 funcionais + 6 docs + 1 ADR novo.

Caso surjam ambiguidades durante Plan/Tasks/Implementation, voltam aqui antes de avançar.
