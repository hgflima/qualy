# Cenário T2 — `/lint:setup` em stack não suportada (ex: Python)

> Roteiro humano-legível para execução manual / semi-automatizada (SPEC §5 Tier T2). Cobre SPEC §7.4 (recusa imediata, sem escrita).
> Fixture base: `cli/tests/fixtures/unsupported-python/` materializada via `materializeFixture("unsupported-python")`.

## Pré-condições

- `node --version` ≥ 22.6.
- Fixture materializada (cp + `git init` + commit determinístico): `pyproject.toml` no root, 3 fontes Python em `src/unsupported_python/`, **sem** `package.json`, **sem** qualquer `.ts/.tsx/.js/.jsx` no working tree.
- `cli/tests/fixtures/unsupported-python/EXPECTED.md` documenta o estado canônico esperado dos detectores.

## Comando do usuário

```
/lint:setup
```

## Sequência esperada

### 1. Detecção (read-only — primeira chamada `detect-stack`)

```bash
node --experimental-strip-types "$QUALY_CLI" detect-stack --cwd "$PWD"
```

Stdout JSON canônico:

```jsonc
{
  "supported": false,
  "extensions": { "ts": 0, "tsx": 0, "js": 0, "jsx": 0 },
  "blockers": [
    { "kind": "python", "file": "pyproject.toml" }
  ],
  "signals": {
    "hasPackageJson": false
  }
}
```

Exit code: `2` (`UNSUPPORTED_STACK`).

### 2. Resposta do harness — recusa imediata

SPEC §6 Always line 380: "sempre detectar a stack antes de qualquer escrita; se incompatível com oxc, recusar com mensagem explícita listando o que oxc suporta".

O harness **NÃO** dispara `AskUserQuestion`, **NÃO** prossegue para `git-clean-check`/`detect-existing-linter`/etc, **NÃO** escreve nada. Mensagem ao usuário:

```
qualy v1 não suporta esta stack.

Detectado:
  - python (pyproject.toml)

Stacks suportadas: TypeScript (.ts/.tsx) e JavaScript (.js/.jsx).

O que aconteceu:
  - detect-stack retornou exit 2 (UNSUPPORTED_STACK).
  - Nenhum arquivo foi modificado.

Próximos passos:
  - Para projetos TypeScript/JavaScript: rode /lint:setup no diretório certo
    (cli/tests/fixtures/unsupported-python/ não tem código TS/JS detectável).
  - Para Python/Go/Rust/Vue/Svelte: este projeto é fora do escopo do qualy v1.
    Veja docs/compatibility.md para a matriz completa de stacks bloqueadas.
  - Acompanhe SPEC §10 / open question sobre evolução do oxc para novas stacks.
```

### 3. Pós-condição

- Working tree byte-a-byte idêntico ao pré-comando: `git status --porcelain=v1` retorna vazio.
- `node_modules/` não tocado (sem `install-deps`).
- Sem `.lint-manifest.json`, sem `.lint-backup/`, sem `oxlint.fast.json`/`oxlint.deep.json`, sem `.claude/hooks/`, sem `.husky/`.
- Sem entries em manifest (não existe).
- Sem `AskUserQuestion` disparada.

## Variantes da fixture (todas devem recusar)

| Trigger no root              | `kind` reportado em `blockers[]` | Justificativa                            |
| ---------------------------- | -------------------------------- | ---------------------------------------- |
| `pyproject.toml` (PEP 518/621) | `python`                         | fixture canônica `unsupported-python/`   |
| `setup.py`                    | `python`                         | layout legacy Python                     |
| `Pipfile`                    | `python`                         | layout pipenv                             |
| `go.mod`                     | `go`                             | módulo Go                                 |
| `Cargo.toml`                 | `rust`                           | crate Rust                                |
| `Gemfile`                    | `ruby`                           | Bundler Ruby                              |
| `composer.json`              | `php`                            | Composer PHP                              |
| `pom.xml`                    | `java`                           | Maven Java                                |
| `build.gradle` / `build.gradle.kts` | `java`                    | Gradle (Java/Kotlin)                      |
| `mix.exs`                    | `elixir`                         | Mix Elixir                                |
| `*.vue`                      | `vue`                            | Single File Component (oxc não cobre v1)  |
| `*.svelte`                   | `svelte`                         | Single File Component (oxc não cobre v1)  |

Multi-blocker (ex: `pyproject.toml` + `Cargo.toml` no mesmo root) ⇒ array `blockers[]` com mais de uma entry; ainda exit `2`.

## Variantes do `detect-stack` que NÃO bloqueiam

| Estado                                                      | Resultado                                          |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Repo TS puro (`.ts`-only, sem markers)                     | `supported:true`, exit `0`                         |
| Repo JS puro (`.js`-only, sem markers)                     | `supported:true`, exit `0`                         |
| `package.json` ausente mas com `.ts/.js`                   | `supported:true` (gate é "code TS/JS detectável + zero blockers"; `install-*` falham depois com erros recuperáveis específicos) |
| `requirements.txt` isolado sem `pyproject.toml`/`setup.py` | NÃO blocker (não está em `UNSUPPORTED_MARKERS`) — recusa só se o projeto também tiver zero TS/JS (gate "totalSupported > 0") |

`docs/compatibility.md` §3.1 documenta os 11 marker files monitorados e o que ficou deliberadamente fora.

## Verificação manual

- [ ] Exit `2` (`UNSUPPORTED_STACK`) é o gate decisivo (não `supported:false` no JSON; harness consulta exit code, não shape).
- [ ] Mensagem ao usuário lista stacks suportadas explicitamente (`TS/TSX/JS/JSX`).
- [ ] Mensagem aponta para `docs/compatibility.md` (matriz completa).
- [ ] Nenhum `AskUserQuestion` disparado.
- [ ] Working tree byte-a-byte idêntico (`git diff` vazio, `git status --porcelain` vazio).
- [ ] Nenhum diretório `qualy`-owned criado (`.lint-manifest.json`, `.lint-backup/`, `.lint-audit/`, `quality-report/` ausentes).
- [ ] Sem flag `--force-stack` ou `--allow-unsupported` (SPEC §6 Never line 412–413; ADR 0001 — bypass exige fork explícito do detector).

## E2E automatizado (referência)

`cli/tests/unit/detect-stack.test.ts` cobre:
- classificação correta de TS-only / JS-only / blockers Python/Go/Rust/Vue/Svelte / multi-blocker / sem arquivos+sem blocker.

`cli/tests/unit/detectors-fixtures.test.ts` valida contra a fixture `unsupported-python/` materializada:
- `detect-stack` exit `2` shape com blockers `[{kind:"python", file:"pyproject.toml"}]` e `signals.hasPackageJson:false`;
- demais detectores são **informacionais** (gate é `detect-stack`; classificariam como greenfield com LOC=0/`todo_density=null`).

`cli/tests/unit/templates-post-edit.test.ts` lock estático das 4 extensões positivas (`.ts/.tsx/.js/.jsx`) + 5 negativas explícitas (`.py/.rs/.go/.vue/.svelte`).

Este roteiro T2 valida a mensagem ao usuário (literal, traduzido para português, com cross-ref a `docs/compatibility.md`) e a ausência de side effects no FS — coisas que os testes unitários não cobrem completamente.

## Referências

- SPEC §1 (stack suportada + não-objetivos), §2 (`/lint:setup`), §6 (Always line 380, Never line 412–413), §7.4 (acceptance).
- PLAN §Fase 1.
- `commands/lint/setup.md` (passo 1 do fluxo aborta em exit 2).
- `cli/src/commands/detect-stack.ts:40-58` (catálogo `UNSUPPORTED_MARKERS`).
- `cli/tests/fixtures/unsupported-python/EXPECTED.md`.
- `docs/compatibility.md` (matriz completa de stacks).
- ADR 0001 (oxc-only v1), ADR 0006 (CLI determinístico).
