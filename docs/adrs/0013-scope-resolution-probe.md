## ADR 0013 — Probe `$PWD → $HOME` para resolver `QUALY_CLI`

- Status: aceito
- Data: 2026-05-06
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0007 (runtime TS via `--experimental-strip-types`, superseded por 0011), ADR 0010 (npm distribution + `qualy install` com 3 scopes), ADR 0011 (runtime TS via `tsx`)

## Contexto

Os 19 arquivos do harness (`skills/lint/SKILL.md`, 4 `agents/lint-*.md`, 14 `commands/lint/**/*.md`) precisam executar o CLI determinístico (`cli/src/index.ts`, ADR 0006) a partir de um bloco Bash que roda no shell que o Claude Code dispara. Até hoje todos eles compartilhavam o snippet de uma linha:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

`CLAUDE_PLUGIN_ROOT` é uma env var setada pelo Claude Code apenas quando uma skill é carregada como **plugin oficial** (via marketplace). O qualy é distribuído por npm + `install.sh` (ADRs 0009, 0010, 0011) — nunca como plugin oficial — então essa var está sempre unset. A expansão `:-` cai sempre em `$HOME/.claude`.

`qualy install` (ADR 0010) suporta 3 scopes documentados em `cli/src/install/install.ts:55-58`:

| Scope     | Path destino           | Notas                                  |
|-----------|------------------------|----------------------------------------|
| `user`    | `${HOME}/.claude`      | Per-user, shared across projects       |
| `project` | `${cwd}/.claude`       | **Default** — committed; requires `.git/` |
| `local`   | `${cwd}/.claude`       | Gitignored                             |

`cli/src/install/install.ts:215` hardcoda `let scope: Scope = "project";`, então o caminho mais comum é instalar no projeto. Para qualquer usuário que rodou `qualy install` no default scope, o CLI mora em `${cwd}/.claude/` e o preâmbulo aponta para o lugar errado: `MODULE_NOT_FOUND` ou silêncio confuso.

## Decisão

Substituir o snippet de uma linha por um probe Bash inline em todos os 19 arquivos funcionais, na seguinte forma **literal** (byte-a-byte):

```bash
QUALY_CLI=""
for cand in "$PWD/.claude" "$HOME/.claude"; do
  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break
done
[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found in \$PWD/.claude or \$HOME/.claude. Run \`qualy install\` first." >&2; exit 5; }
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

Convenções fixadas:

- **Ordem do probe.** `$PWD/.claude` primeiro (cobre scopes `project` e `local`, que apontam para `${cwd}/.claude`). `$HOME/.claude` segundo (cobre scope `user`). A ordem reflete o default `scope: "project"` em `cli/src/install/install.ts:215` — mudar uma sem mudar a outra é regressão.
- **`CLAUDE_PLUGIN_ROOT` removido.** Não há plugin marketplace oficial do qualy; a var nunca foi setada na prática. Manter o nome induzia leitor a uma realidade que não existe.
- **Exit 5 = `MISSING_DEP`.** Reaproveita `cli/src/lib/exit-codes.ts` sem novos códigos. Alinhado com o mapeamento já documentado em `skills/lint/SKILL.md` (`5` → "Falta `oxlint`/`oxfmt`/`quality-metrics`. Rodar `/lint:setup` instala tudo.").
- **POSIX puro.** Sem `[[`, sem arrays, sem `<<<`, sem `set -u`. Roda em `bash` minimal.
- **Bloco fechado em `&&`.** Qualquer falha de probe leva ao `exit 5` final — nunca silenciar com `|| true` ou `2>/dev/null`.
- **Inline em cada arquivo** (não helper sourced — ver Alternativas).

A linha `node ...` permanece com o `<subcommand>` específico de cada arquivo (ex.: `setup.md` invoca `setup`, `audit.md` invoca `audit`); o teste de paridade (`cli/tests/unit/preamble-parity.test.ts`) compara apenas as 5 linhas do probe.

## Alternativas consideradas

### A) Helper sourced em `bin/qualy-resolve.sh`

- ✅ Single source of truth — alterar a lógica em 1 arquivo, não em 19.
- ❌ Chicken-and-egg: o helper precisa ser localizado **antes** de ele localizar o CLI. Replica o problema atual.
- ❌ Adiciona surface de instalação (script extra com bit de execução, path documentado, teste de boot).
- ❌ 5 linhas de Bash não justificam o overhead — o teste de paridade unit já garante drift zero.

Rejeitada.

### B) Detectar via `npx` / `command -v qualy`

- ✅ Usa o lookup nativo do shell.
- ❌ `npx` adiciona latência (resolve cache → download fallback) em cada invocação do harness.
- ❌ Quebra em scope `project` quando o usuário não publicou o pacote no registry — `npx qualy` resolve para a versão pública, não para `${cwd}/.claude/skills/lint/cli/src/index.ts`.
- ❌ Inverte a relação: o harness deveria rodar **o CLI instalado via `qualy install`**, não a versão "qualquer" do registry.

Rejeitada.

### C) Manter `CLAUDE_PLUGIN_ROOT` como primeira tentativa, com fallback novo

- ✅ Cobre hipoteticamente um futuro plugin marketplace.
- ❌ A var nunca está setada na prática. Manter o nome é cargo culting.
- ❌ Aumenta surface de teste (4º cenário e2e: `CLAUDE_PLUGIN_ROOT` setada).
- ❌ Se o qualy virar plugin oficial no futuro, abre-se ADR novo e atualiza este SPEC — nada se perde.

Rejeitada.

### D) Probe inline `$PWD → $HOME` (escolhida)

- ✅ Cobre os 3 scopes que `qualy install` documenta hoje (`user`, `project`, `local`).
- ✅ Mensagem de erro explícita aponta para a ação correta (`Run \`qualy install\` first.`).
- ✅ POSIX puro — funciona em `bash --noprofile --norc`.
- ✅ Test de paridade (`cli/tests/unit/preamble-parity.test.ts`) elimina drift entre os 19 arquivos.
- ❌ 5 linhas duplicadas em 19 arquivos. Aceitável dado o test de paridade.

## Consequências

**Positivas**

- `qualy install` no default scope `project` passa a funcionar no harness sem env var auxiliar.
- Falha sem instalação prévia agora é diagnosticável: stderr aponta o problema e a solução.
- Os 19 arquivos são byte-idênticos no bloco do probe — drift detectado por unit test.
- O snippet roda em `bash --noprofile --norc` (POSIX puro), portátil entre macOS/Linux/CI.

**Negativas / tradeoffs**

- 5 linhas inline em 19 arquivos (vs 1 linha antes). Mitigado: unit test garante paridade; alterações futuras ao bloco passam por update mecânico (find-replace) + suite verde.
- Quem dependia da semântica antiga (`CLAUDE_PLUGIN_ROOT` definido externamente) deixa de ter override. Nenhum caso real conhecido — qualy nunca foi distribuído como plugin oficial.
- ADR 0006 e 0007 mostravam o snippet antigo como exemplo. Atualizados nesta mesma mudança (cross-link `Related: ADR 0013` + bloco substituído nos exemplos).

**Verificação**

- `cli/tests/unit/preamble-parity.test.ts`: 3 asserções (regex match, byte-equivalência via `Set.size === 1`, count exato de 19 arquivos com `QUALY_CLI=`).
- `cli/tests/e2e/preamble-resolution.test.ts`: 4 cenários (PWD-only, HOME-only, ambos → PWD, nenhum → exit 5).
- Smoke manual: `D=$(mktemp -d) && cd "$D" && git init && qualy install` → preâmbulo extraído de `.claude/skills/lint/SKILL.md` resolve para `${D}/.claude/...`.

## Referências

- SPEC: `.harn/docs/fixes/scope-resolution/SPEC.md` (§6 contém o bloco canônico).
- `cli/src/install/install.ts:55-58` — definição dos 3 scopes.
- `cli/src/install/install.ts:215` — default `scope: "project"`.
- `cli/src/lib/exit-codes.ts` — `MISSING_DEP = 5`.
- ADR 0006 — Decisão de harness fino + CLI determinístico (cross-link).
- ADR 0007 — Runtime TS via `--experimental-strip-types` (cross-link; superseded por 0011 mas exemplos foram atualizados).
- ADR 0010 — `qualy install` + 3 scopes que o probe precisa cobrir.
