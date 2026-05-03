# ADR 0007 — Runtime TS via `node --experimental-strip-types` (Node ≥ 22.6)

- Status: aceito
- Data: 2026-05-03
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0009 (distribuição via `install.sh`)

## Contexto

ADR 0006 fixou que toda a lógica imperativa do `/lint` vive em `cli/src/` (TypeScript). Falta decidir **como esse TS é executado** quando o usuário invoca um subcomando a partir do harness (`skills/lint/SKILL.md`, `commands/lint/*.md`, `agents/lint-*.md`).

Restrições herdadas do SPEC e do PLAN:

- O CLI é chamado de dentro de Bash blocks dos `.md` do harness, com o pattern fixado em `PLAN §Resolução do CLI`:
  ```bash
  QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
  node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
  ```
  Ou seja, o ponto de entrada referenciado é um **arquivo `.ts` em `src/`**, não um bundle.
- A distribuição é feita por `install.sh` (ADR 0009) que copia/symlinka `cli/` para `~/.claude/skills/lint/cli/`. Edits no fonte precisam ter efeito imediato no modo `--dev` (symlink) — incompatível com qualquer pipeline de build entre fonte e execução.
- A janela de iteração precisa ser curta: `npm test`/`npm run typecheck` rodam em segundos, e qualquer build step adicional vira atrito desproporcional para um CLI deste porte.
- O peer ecosystem (`oxc`, `oxlint`, `oxfmt`, `ts-morph`, `quality-metrics`) já exige versões recentes de Node, então um floor moderno é viável sem perder usuários alvo.

A questão é portanto: **qual mecanismo executa `cli/src/index.ts` diretamente, sem build, de forma estável e suportada?**

## Decisão

Adotar como runtime obrigatório: **Node ≥ 22.6 com a flag `--experimental-strip-types`** (sem nenhum loader externo, sem `tsx`/`ts-node`/`esbuild-register`, sem etapa de build do CLI).

Implicações concretas:

1. **Engine declarado.** `package.json` raiz fixa `"engines": { "node": ">=22.6.0" }`. `install.sh` valida `node --version` antes de qualquer cópia/symlink e aborta com mensagem clara em Node < 22.6.
2. **Pattern de invocação único.** Toda chamada do harness usa exatamente `node --experimental-strip-types <path>/cli/src/index.ts <sub>`. `SKILL.md` define o pattern uma vez; nenhum command/agent inventa variação.
3. **Sem `dist/` para o CLI.** O `tsconfig.json` raiz fixa `noEmit: true`. `npm run build` é noop documentado. O único uso autorizado de bundler no produto é `esbuild` invocado em runtime pelo `report-export` para gerar HTML self-contained (PLAN §Critical files).
4. **Restrição de sintaxe TS.** `--experimental-strip-types` apaga anotações de tipo em runtime mas **não compila** features que precisam de transformação (enums com inicialização runtime, `namespace` com valores, decorators legados, `import = require`). Convenção: usar apenas TS "type-only" — `interface`, `type`, type imports/exports — e `as const`/objetos para enums. `tsconfig.json` reforça com `verbatimModuleSyntax: true` e `isolatedModules: true`, que falham no `tsc --noEmit` se algum arquivo violar a restrição.
5. **`allowImportingTsExtensions: true`.** Imports internos do CLI usam extensão `.ts` explícita (ex.: `import { exitCodes } from "./lib/exit-codes.ts"`), porque é o que o Node aceita ao executar TS direto. O `tsc --noEmit` valida isso.
6. **Fronteira do ecossistema.** Dependências runtime do CLI (`ts-morph`, `chart.js`, `chartjs-chart-treemap`, `esbuild`) continuam vindo como `.js` em `node_modules/`; `--experimental-strip-types` só afeta arquivos `.ts` do próprio CLI, não os pacotes consumidos.

## Consequências

**Positivas**

- Zero etapas entre editar `cli/src/foo.ts` e ver o efeito num subcomando — crítico para o modo `--dev` do `install.sh` (symlink) e para a iteração local com Ralph.
- Sem artefatos versionados (`dist/`) e sem cache de build para invalidar; o repositório só carrega `src/` + lockfile.
- Distribuição simples: `install.sh` copia exatamente o que está em `cli/src/`. Não há "qual versão buildei?" — o que está em disco é o que executa.
- Menos superfície de ferramentas: nada de `tsx`, `ts-node`, `swc-node`, `esbuild-register`. Menos dependências, menos compatibilidade transitiva para vigiar.
- Alinhamento com runtime do harness: Claude Code já roda em Node moderno; o requisito Node 22.6 cabe no perfil de quem usa `oxc`.

**Negativas / tradeoffs**

- Floor de Node alto: usuários em Node 20 LTS não conseguem rodar — exige upgrade explícito. Mitigado por (i) mensagem de erro clara no `install.sh`, (ii) README documentando pré-requisito, (iii) `engines` no `package.json` raiz fazendo `npm install` avisar.
- Subset de TS: features que precisam de transformação (decorators legados, enums com valor, `namespace` com runtime) ficam proibidas. Restritivo, mas alinhado com a tendência do TC39/TypeScript moderno e detectável via `verbatimModuleSyntax`/`isolatedModules`.
- A flag `--experimental-strip-types` ainda é experimental no Node 22.x (estabiliza em 23.6+/24 LTS). Se a flag for renomeada num futuro próximo (ex.: `--strip-types` sem `experimental-`), o pattern de invocação no `SKILL.md` precisa atualizar em um único lugar — risco contido.
- Sem source maps em runtime para erros de TS — stack traces apontam para a posição no arquivo `.ts` original (que é o que queremos), mas debugger setups precisam estar cientes de que não há etapa de transformação.

## Alternativas consideradas

- **`tsx` (`npm install tsx` + `tsx cli/src/index.ts`).** Rejeitada: adiciona dependência runtime ao consumidor, exige bootstrap de `node_modules` antes do primeiro comando, e o pattern do `SKILL.md` ficaria acoplado ao binário `tsx` no PATH. `--experimental-strip-types` é nativo e sem deps.
- **`ts-node` / `ts-node-esm`.** Rejeitada: histórico de incompatibilidades com ESM + `NodeNext` + `verbatimModuleSyntax`; mais lento no startup; mantenedor já recomenda alternativas para projetos novos.
- **CLI compilado para `dist/` com `tsc -b` ou `tsup`.** Rejeitada para v1: vira artefato versionado, exige `prepack`/CI step antes de cada release, quebra o modo `--dev` (symlink só do `dist/`), e o ganho em performance é negligível para um CLI deste porte. Reaberto em v2 se o startup virar gargalo medido (não suposto).
- **Bundle único com esbuild (`cli/dist/qualy.mjs`).** Rejeitada para o CLI próprio: mesmo problema de etapa de build, mais a perda de stack traces nativos. `esbuild` continua autorizado dentro do `report-export` porque lá o objetivo é gerar um HTML self-contained para distribuição offline (escopo diferente — runtime de produto, não runtime de CLI).
- **Suportar Node 20 LTS via fallback (`tsx` quando flag indisponível).** Rejeitada: dois caminhos de execução = duas matrizes de bug. O custo de exigir Node 22.6 (uma versão que já está disponível em todas as distros de interesse e nos runners de CI padrão) é menor do que manter dois runtimes.

## Verificação

- `package.json#engines.node = ">=22.6.0"` (raiz) — `npm install` em Node < 22.6 emite warning audível.
- `install.sh` aborta cedo se `node --version` < 22.6 (verificado manualmente em Node 22.5 → exit 1; Node 22.6/24.x → ok). Anchor já registrado em IMPLEMENTATION_PLAN §Fase 0.
- `tsconfig.json` raiz fixa `verbatimModuleSyntax: true`, `isolatedModules: true`, `allowImportingTsExtensions: true`, `noEmit: true` — `npm run typecheck` falha se algum arquivo do CLI usar sintaxe que `--experimental-strip-types` não aceitaria.
- `npm test` roda via `vitest run` que executa o CLI direto através do strip-types loader; qualquer regressão de sintaxe quebra os unit tests.
- E2E final (PLAN §Verification, Fase 7): `node --experimental-strip-types cli/src/index.ts --help` lista subcomandos sem build prévio.
