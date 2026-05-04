# Matriz de compatibilidade — stacks suportadas e bloqueadas

Reference contract para `cli/src/commands/detect-stack.ts` (SPEC §1 — "Stack suportada (v1)" + §1 não-objetivos + §6 Always — "detectar a stack antes de qualquer escrita"). É o documento canônico para responder "por que oxc só, por que `*.vue`/`*.svelte` bloqueiam, qual marker file dispara recusa de qual linguagem, e o que muda quando uma stack nova for habilitada".

- Status: aceito v1 · Data: 2026-05-04
- Relacionados: SPEC §1 (stack suportada + não-objetivos), SPEC §6 Always (linha 380 — "sempre detectar a stack antes de qualquer escrita") + Never (linha 413 — "nunca instalar para stacks fora do oxc"), `cli/src/commands/detect-stack.ts` (implementação canônica), `cli/src/lib/exit-codes.ts#UNSUPPORTED_STACK` (exit `2`), `cli/tests/unit/detect-stack.test.ts` (lock dos casos), `cli/tests/fixtures/unsupported-python/` (fixture que exercita a recusa), `commands/lint/setup.md` (consumidor que aborta no exit `2`), `docs/stages.md` §7 ("stage é informacional em stacks não-suportadas; o gate é `detect-stack`"), ADR 0001 (oxc-only v1 — pendente)

## 1. Propósito

Antes de qualquer escrita (preset oxlint, hook `PostToolUse`, husky, package.json scripts), `/lint:setup` invoca `detect-stack` no projeto-alvo. O resultado é um veredito binário — **suportado** ou **bloqueado** — com sinais brutos e razão explícita. Stacks bloqueadas abortam o setup com mensagem padronizada apontando o que oxc cobre e onde abrir issue.

Esta matriz existe por três razões operacionais:

1. **Falso-positivo bloqueia setup legítimo**, e o usuário não tem como saber que `Cargo.toml` num repo TS de uma equipe full-stack disparou a recusa. O gatilho precisa ser auditável aqui antes de chegar no usuário via stderr.
2. **Falso-negativo instala em stack quebrada** (ex: passar bate em `.vue` SFC com WMC max=15), o que é pior que recusar — o usuário descobre depois de configurar husky e hook. SPEC §6 Never linha 413 é absoluto: "Nunca instalar para stacks fora do oxc".
3. **Habilitar stack nova** (ex: oxc cobrir Vue SFC nativamente em 2026-Q3) exige editar três pontos travados em sincronia: `UNSUPPORTED_MARKERS` / `UNSUPPORTED_FILE_EXTS` em `detect-stack.ts`, esta tabela, e a fixture `tests/fixtures/<stack>/` correspondente. Documentar a matriz separa "o que muda na decisão" de "o que muda no código".

**Invariante.** A decisão é determinística e single-rule:

```
supported = blockers.length === 0 && (tsFiles + tsxFiles + jsFiles + jsxFiles) > 0
```

Mesma árvore de arquivos + mesmos markers no root → mesmo veredito. Não há heurística, não há prioridade, não há "ambíguo → pergunta": a SPEC §1 lista o conjunto suportado e o detector é um classificador puro contra essa lista.

## 2. Stacks suportadas (v1)

oxc cobre quatro extensões — qualquer projeto cujo conteúdo se reduz a esse conjunto entra:

| Extensão | Linguagem | Conta como source para `supported` | Conta para `loc` em `detect-stage` |
|---|---|---|---|
| `.ts` | TypeScript | sim | sim |
| `.tsx` | TSX (TypeScript + JSX) | sim | sim |
| `.js` | JavaScript | sim | sim |
| `.jsx` | JSX (JavaScript + JSX) | sim | sim |

`SUPPORTED_FILE_EXTS` em `detect-stack.ts:61` é o lock — adicionar extensão exige PR ao detector + ADR 0001 (oxc-only v1 — pendente). `.cjs`, `.mjs`, `.cts`, `.mts` **não** entram na contagem hoje (oxc os reconhece, mas o impacto em `lsFilesByExt` ainda não foi auditado e LOC inflaria sem mudança real de cobertura — issue futura, não breaking).

**Anchor `git ls-files`.** A contagem usa `lsFilesByExt(cwd, [...])` (`cli/src/lib/git.ts`) — exatamente o mesmo anchor que `detect-stage` usa para LOC e que `audit.ts` usa para o universo de paths. Arquivos em `node_modules/`, `dist/`, `build/`, `.next/` não são tracked → não entram na contagem → SPEC §6 Never linha 417 ("Nunca rodar oxlint/oxfmt em paths fora do que `git ls-files` retorna") está cumprida pelo próprio detector.

## 3. Stacks bloqueadas — gatilhos canônicos

Dois mecanismos disjuntos de bloqueio. Qualquer um disparando torna `supported = false` e o exit code é `UNSUPPORTED_STACK = 2`.

### 3.1 Marker files no root

`UNSUPPORTED_MARKERS` em `detect-stack.ts:40-55` é a lista versionada. Probe via `existsSync(join(cwd, marker.file))` — não usa glob, não desce em subpastas, não probe `package.json` content (apenas presença).

| Marker file | `kind` reportado | Linguagem | Por quê |
|---|---|---|---|
| `pyproject.toml` | `python` | Python (PEP 518/621) | Canônico moderno; substitui setup.py em projetos pós-2020. |
| `setup.py` | `python` | Python (legacy) | Ainda dominante em libs antigas; coexiste com pyproject. |
| `Pipfile` | `python` | Python (Pipenv) | Sinal forte mesmo sem pyproject/setup. |
| `go.mod` | `go` | Go | Único gatilho viável — sem `go.mod`, não é módulo Go válido. |
| `Cargo.toml` | `rust` | Rust | Único gatilho — Cargo é o build system de fato. |
| `Gemfile` | `ruby` | Ruby | Sinal forte (Bundler); cobre Rails e libs. |
| `composer.json` | `php` | PHP | Composer é canônico; cobre Laravel/Symfony/etc. |
| `pom.xml` | `java` | Java (Maven) | Maven build descriptor. |
| `build.gradle` | `java` | Java/Kotlin (Gradle Groovy DSL) | Coexiste com `pom.xml` em alguns repos; Java por proxy. |
| `build.gradle.kts` | `java` | Java/Kotlin (Gradle Kotlin DSL) | Variante moderna; mesma classificação. |
| `mix.exs` | `elixir` | Elixir | Mix é o build system canônico. |

**Por que essa lista é deliberadamente narrow.** Cada marker é um arquivo **canônico** da linguagem (build system / dependency manager). Probes ambíguos como `requirements.txt` (pode ser gerado por `pip freeze` em qualquer projeto, inclusive Node), `.python-version` (pyenv, sinal fraco), `Makefile` (universal) ficam **fora**: false-positive aqui bloqueia setup legítimo. SPEC §1 não-objetivos lista Python/Go/Rust como bloqueio explícito; novos markers só entram se uma linguagem nova for adicionada à lista de bloqueio (ex: Crystal, Zig — não no escopo v1).

**Coexistência polyglot.** Repo full-stack com `package.json` + `pyproject.toml` (frontend TS + backend Python no mesmo monorepo) **bloqueia**. A heurística é restritiva por design: setup do qualy/lint instala hook `PostToolUse` que dispara em qualquer Edit/Write, e rodar oxlint num arquivo `.py` é nonsense. Workflow recomendado para polyglot: rodar `qualy detect-stack --cwd packages/frontend/` no subpath TS isolado.

### 3.2 Extensões de arquivo bloqueantes

`UNSUPPORTED_FILE_EXTS` em `detect-stack.ts:58` — apenas dois itens:

| Extensão | `kind` reportado | Por quê |
|---|---|---|
| `.vue` | `vue-sfc` | Single File Component do Vue mistura `<template>`, `<script>`, `<style>` no mesmo arquivo; oxc não tem parser SFC em v1. SPEC §1 não-objetivos lista explicitamente. |
| `.svelte` | `svelte-sfc` | Mesma razão estrutural — SFC com markup + script + style. SPEC §1 idem. |

Bloqueio se **qualquer** arquivo dessa extensão aparece em `git ls-files`. O `kind.file` reportado inclui contagem (`*.vue (4)`) para o usuário entender escala — `*.vue (1)` num repo de 200 arquivos pode ser legacy abandonado e justificar `git rm`; `*.vue (180)` é a stack principal e o usuário está no projeto errado.

**Por que extensão e não marker.** Vue/Svelte **podem** rodar em projeto TS sem marker root específico (não há `vue.config.js` obrigatório, `svelte.config.js` é opcional). A presença do arquivo é o único sinal confiável. Marker file `nuxt.config.ts` existe mas é redundante: se há `*.vue`, já bloqueou.

**Quando oxc cobrir SFC nativamente.** Habilitar = remover `.vue`/`.svelte` de `UNSUPPORTED_FILE_EXTS`, adicionar a `SUPPORTED_FILE_EXTS`, atualizar testes (`cli/tests/unit/detect-stack.test.ts`), atualizar esta tabela, atualizar SPEC §1, abrir ADR documentando a habilitação. Mudança breaking observável (`detectStack({}, {…vue files…})` muda de `supported: false` para `supported: true`) → bump menor de versão + nota em CHANGELOG.

## 4. Output do detector

```jsonc
{
  "ok": true,
  "cwd": "/abs/path",
  "supported": false,
  "signals": {
    "tsFiles": 3,
    "tsxFiles": 0,
    "jsFiles": 0,
    "jsxFiles": 0,
    "hasPackageJson": true,
    "vueFiles": 0,
    "svelteFiles": 0
  },
  "blockers": [
    { "kind": "python", "file": "pyproject.toml" }
  ],
  "supportedLanguages": ["ts"]
}
```

**Decisões de shape**:

- `signals` carrega contagens **mesmo quando bloqueado**. O usuário precisa ver "tenho 3 `.ts` mas o `pyproject.toml` tomou conta" para decidir se vai mover o subpath TS para outro repo ou se foi engano (ex: `pyproject.toml` legado de protótipo abandonado).
- `blockers` é **array**, não single field. Repo polyglot pode disparar múltiplos (ex: Python + Vue) — todos aparecem para o usuário ter o quadro completo e priorizar limpeza.
- `supportedLanguages` lista **só as extensões com count > 0**. Repo TS-only retorna `["ts"]`, nunca `["ts","tsx","js","jsx"]`. Consumidores (harness `setup.md`) usam isso para decidir se mostra "TypeScript-only project" ou "TS + JSX".
- `hasPackageJson` é flag separada (não está em `blockers` nem em `supported`). Existe um caso edge: repo TS sem `package.json` (ex: scripts soltos em `scripts/*.ts`) ainda passa como suportado se há `.ts` tracked. A flag deixa o harness avisar "package.json ausente — instalar deps via qual manager?" sem bloquear.

Em failure (apenas `git ls-files` quebrando — não-repo-git, permissão negada): `{ ok: false, error: "<git stderr>" }` com exit code `RECOVERABLE_ERROR` (1). USAGE_ERROR (4) cobre apenas flags inválidas (ex: `--cwd` sem valor).

## 5. Mapping exit code → decisão do harness

`commands/lint/setup.md` faz dispatch baseado no exit code, não no shape do JSON:

| Exit | Nome | Significado | Ação do harness |
|---|---|---|---|
| `0` | `OK` | `supported: true` (sem blockers, ≥1 source file) | prossegue para `detect-existing-linter` → `detect-stage` → fluxo de instalação |
| `1` | `RECOVERABLE_ERROR` | detecção quebrou (não é repo git, etc.) | aborta com mensagem "rode `git init` ou aponte `--cwd` para repo git" |
| `2` | `UNSUPPORTED_STACK` | bloqueado (markers ou extensões) | aborta com mensagem padronizada listando `blockers[]` + lista do que oxc cobre + link para issue tracker |
| `4` | `USAGE_ERROR` | flag malformada | aborta com `--help` |

**Por que exit code é o gate**, não `supported: false` no JSON. SPEC §6 Always linha 380 ("sempre detectar a stack antes de qualquer escrita") é cumprida quando o harness checa `$?` antes de qualquer `install-*`. Ler JSON e parsear `supported` introduz uma camada que pode falhar silenciosamente em pipes (ex: `jq` não instalado, JSON malformado por bug). Exit code é byte-único, não-parseável, e bate com a contract do shell — garantia operacional mais forte.

## 6. Edge cases conhecidos

| Cenário | Resultado | Por quê |
|---|---|---|
| Repo recém-`git init`, sem commit, sem arquivo | `UNSUPPORTED_STACK` (`supported: false`, `blockers: []`, `tsFiles: 0`) | Zero source files falha o gate `totalSupported > 0`. Day-zero scaffolding precisa criar pelo menos um `.ts` antes de `qualy /lint:setup` ser útil. |
| Repo TS válido, sem `package.json` | `OK` (`supported: true`, `hasPackageJson: false`) | Suportado, mas harness usará `hasPackageJson` para perguntar como instalar deps. |
| Repo TS + `Cargo.toml` (workspace polyglot) | `UNSUPPORTED_STACK`, `blockers: [{kind:"rust", file:"Cargo.toml"}]` | Marker root é absoluto. Workaround: `qualy --cwd packages/frontend`. |
| Repo TS + 1 `*.vue` legacy | `UNSUPPORTED_STACK`, `blockers: [{kind:"vue-sfc", file:"*.vue (1)"}]` | Extensão bloqueia regardless de quantidade. Usuário decide: `git rm` o legacy, ou esperar oxc cobrir SFC. |
| Repo TS + `requirements.txt` + sem outros markers Python | `OK` (`supported: true`) | `requirements.txt` **não** está em `UNSUPPORTED_MARKERS` (sinal fraco). Repo TS pode ter `requirements.txt` para um script Python isolado. |
| Repo TS + `Makefile` | `OK` (`supported: true`) | `Makefile` é universal — não bloqueia nada. |
| Pure-JSX (sem `.ts`, só `.jsx`) | `OK` (`supported: true`, `supportedLanguages: ["jsx"]`) | JSX é coberto por oxc; cenário válido para legacy CRA / repos JS-puros pré-TS. |
| Repo só com `.cjs` / `.mjs` / `.cts` / `.mts` | `UNSUPPORTED_STACK` | Não estão em `SUPPORTED_FILE_EXTS` hoje (ver §2 caveat). Habilitar é mudança versionada. |
| `package.json` existe mas não é JSON válido | irrelevante para `detect-stack` | Esse detector não lê `package.json` content; só checa existência. `detect-existing-linter` é quem se preocupa com parsing. |
| Repo TS + `composer.json` (PHP) + `package.json` válido | `UNSUPPORTED_STACK`, `blockers: [{kind:"php"}]` | Marker root absoluto. Subpath isolation é o workaround. |

## 7. Sinais explicitamente NÃO usados

A SPEC e a literatura sugerem outros heurísticos; cada um foi **deliberadamente** descartado:

- **Conteúdo de `package.json#engines`.** `engines.node` ou `engines.npm` não dizem nada sobre cobertura oxc. Repo TS pode ter `engines.python` por descuido (pacote npm que invoca script Python via `node-gyp`).
- **Presença de `tsconfig.json`.** Repo TS válido pode rodar sem tsconfig (scripts soltos via `node --experimental-strip-types`); inversamente, `tsconfig.json` sem `.ts` tracked é evidência fraca. A contagem direta de `.ts/.tsx/.js/.jsx` é mais honesta.
- **`requirements.txt` / `package-lock.json` para inferir stack primária.** Lockfiles dizem o que está instalado, não o que está sendo escrito. `package-lock.json` num repo Python que usa um util Node é falso-positivo.
- **`.python-version` / `.nvmrc` / `.tool-versions`.** Sinais de runtime version manager, não de stack. Frequente em repos polyglot ou CI.
- **Output de `cloc` ou `tokei`** (LOC por linguagem). Caro, requer binário externo, e a heurística "predominantemente TS → suportado mesmo com 1 `.py`" é exatamente o false-negative que SPEC §6 Never proíbe. A regra binária (qualquer marker bloqueante → bloqueia) é mais defensiva.
- **GitHub Linguist API.** Requer rede (quebra offline-first), requer ser repo público GitHub (quebra repos locais ou em GitLab/Gitea/etc.).
- **Conteúdo dos arquivos para detectar JSX dentro de `.js`.** Em v1 todo `.js` é tratado como suportado; oxc parseia JSX em `.js` quando configurado. Não há ganho em separar `.js-com-jsx` de `.js-puro` — preset oxlint é o mesmo.

## 8. Como o usuário discorda

A recusa do detector é **explícita e diagnosticável**, mas não negociável via flag. Opções do usuário:

1. **Mover o subpath TS para um diretório isolado** e rodar `qualy --cwd <subpath>`. É o workflow oficial para monorepos polyglot.
2. **Remover o marker** se for legacy abandonado (`git rm pyproject.toml`). Confirma que o setup do qualy é a postura desejada para o repo todo.
3. **Aguardar habilitação** (oxc cobrir Vue/Svelte SFC, suporte a `.cjs`/`.mjs`). Issue do qualy referenciando esta tabela é o canal recomendado.
4. **Não há flag `--force`.** SPEC §6 Never linha 412 ("Nunca usar `--no-verify`, `--force`, `git reset --hard`, `git clean -f`, `rm -rf` sem instrução explícita") aplica por extensão a `--force-stack`: se `detect-stack` recusou, instalar mesmo assim viola a invariante de SPEC §6 Never linha 413 ("Nunca instalar para stacks fora do oxc").

A inteligência fica em quem lê o output. `signals.tsFiles` + `blockers[]` dão evidência suficiente para decidir entre as opções acima sem precisar adivinhar.

## 9. Drift e versionamento

Locks em três níveis:

| Lock | Onde | O que trava |
|---|---|---|
| `cli/tests/unit/detect-stack.test.ts` | unit | classificação TS-only/JS-only; cada blocker (Python/Go/Rust/Vue/Svelte); multi-blocker; sem arquivos+sem blocker; falha git; contagem `.tsx` distinta de `.ts`; parser de flags |
| `cli/tests/fixtures/unsupported-python/EXPECTED.md` | fixture | contrato canônico para `pyproject.toml` → `kind:"python"` + exit `UNSUPPORTED_STACK` |
| `cli/tests/fixtures/greenfield-ts/EXPECTED.md` + `brownfield-eslint-prettier/EXPECTED.md` | fixture | caminho feliz (`supported: true`, `supportedLanguages: ["ts"]`) |

**Mudanças válidas sem ADR**:

- Adicionar marker file para uma linguagem **já bloqueada** (ex: `.python-version` para Python — embora o catálogo prefira ser narrow).
- Refinar o `kind.file` reportado (ex: incluir versão lida do marker) sem mudar `kind` em si.
- Estender testes com novos cenários sem alterar a regra de decisão.

**Mudanças que exigem ADR (cross-ref ADR 0001 — pendente)**:

- Adicionar nova linguagem a `UNSUPPORTED_MARKERS` (Crystal, Zig, Nim, etc.) — expansão de escopo de bloqueio precisa SPEC change.
- Remover bloqueio de `.vue` ou `.svelte` (oxc passou a cobrir SFC) — habilitação de stack nova.
- Adicionar `.cjs`/`.mjs`/`.cts`/`.mts` a `SUPPORTED_FILE_EXTS` — mudança observável de contagem.
- Trocar a regra binária por heurística percentual ("≥80% TS → suportado") — quebra a invariante de §1.
- Trocar o anchor `git ls-files` por `find` ou `cloc` — mudança de invariante cross-detector.

Versão atual: v1 (qualy MVP, 2026-05-04). Próximas revisões expandem `UNSUPPORTED_MARKERS` e habilitam extensões mas não removem campos de `signals` — consumidores (harness `setup.md`, audit JSON, `status`) podem confiar na estabilidade do shape.
