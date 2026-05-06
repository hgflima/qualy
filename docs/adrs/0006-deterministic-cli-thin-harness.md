# ADR 0006 — CLI determinístico com harness fino

- Status: aceito
- Data: 2026-05-03
- Relacionados: ADR 0007 (runtime TS via `--experimental-strip-types`), ADR 0008 (rationale híbrida das recommendations), ADR 0009 (distribuição via `install.sh`), ADR 0013 (probe `$PWD → $HOME` para resolver `QUALY_CLI`)

## Contexto

O SPEC do `/lint` (`.harn/docs/mvp/SPEC.md`) descreve uma skill que faz detecção, instalação, parsing de configs, edição AST de arquivos do projeto-alvo, agregação de métricas, geração de recomendações e renderização de um report visual. Essas operações são determinísticas — entradas iguais devem produzir saídas iguais — e qualquer divergência se traduz em backups corrompidos, hooks duplicados, audit inconsistente ou rollback parcial.

Existem dois caminhos para implementá-las dentro do harness do Claude Code:

1. **Tudo no harness (`SKILL.md`, slash commands, subagents):** o modelo lê specs, executa `git`, parseia `package.json`, edita `vitest.config.ts` em texto puro, calcula thresholds, escreve o `.lint-audit/<ts>.json`. Cada chamada é uma reinterpretação probabilística do prompt.
2. **CLI TypeScript determinístico (`cli/src/`) com harness fino:** toda lógica imperativa vive em código testável; o harness só roteia a conversa e chama subcomandos do CLI.

A diretiva do autor (registrada em PLAN.md §Context) é maximizar determinismo. Reutilizar plugins existentes (`quality-metrics`) e ferramentas externas (`oxc`, `oxlint`, `oxfmt`, `ts-morph`) também exige um host estável que não dependa de improviso do modelo.

## Decisão

Adotar arquitetura em duas camadas:

1. **Camada determinística — `cli/src/`** (TypeScript, executado direto via `node --experimental-strip-types`):
   - Dispatcher único (`cli/src/index.ts`) por `process.argv[2]`.
   - Subcomandos isolados em `cli/src/commands/<grupo>/<subcomando>.ts` com contratos JSON publicados na tabela do PLAN §"Contratos CLI".
   - Utilitários compartilhados em `cli/src/lib/` (`git`, `fs-safe`, `json`, `pkg-manager`, `ts-config-edit`, `exit-codes`, `logger`).
   - Stdout sempre JSON (uma linha ou pretty); stderr para mensagens estruturadas; exit codes semânticos definidos em `cli/src/lib/exit-codes.ts` (`0=ok`, `1=erro recuperável`, `2=stack não suportada`, `3=working tree sujo`, …).
   - CLI **nunca** pergunta ao usuário — recebe respostas via flags/env.
   - CLI é **idempotente**: rodar duas vezes não duplica hooks, scripts ou backups.
   - Toda escrita no projeto-alvo passa por `safe-write` registrando arquivos tocados em `.lint-manifest.json` (necessário para `uninstall` completo).

2. **Camada harness — `skills/lint/SKILL.md`, `commands/lint/<x>.md`, `agents/lint-{detector,installer,auditor,migrator}.md`** (Markdown interpretado pelo modelo):
   - `SKILL.md` é o router conversacional (≤ 200 linhas) e define o pattern de resolução do CLI via probe `$PWD/.claude → $HOME/.claude` (ver ADR 0013 para o bloco canônico). Anteriormente o preâmbulo usava `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}`, abandonado porque o qualy nunca foi distribuído como plugin oficial — ver ADR 0013, seção Contexto.
   - `commands/lint/*.md` são orquestradores: chamam subcomandos do CLI em ordem e usam `AskUserQuestion` para confirmações ou inputs.
   - `agents/*.md` são wrappers finos que invocam o CLI e devolvem sumário estruturado (≤ 30 linhas).
   - Harness **nunca** parseia `package.json`, executa `git`/`grep`/`cloc`, ou edita configs diretamente — apenas chama o CLI e interpreta o JSON.

**Exceção autorizada (única).** O subagent `lint-auditor` consome `candidates` emitidos pelo `recs-generate` e escreve `rationale` final com contexto do código. Toda a parte determinística (cálculo de evidências, deltas, blast radius, IDs estáveis, `rationale_stub`) permanece no CLI; só a redação humanizada do `rationale` final é responsabilidade do modelo. Justificativa completa em ADR 0008.

## Consequências

**Positivas**

- Reprodutibilidade: cada subcomando é testável com vitest contra fixtures versionadas (`cli/tests/fixtures/{greenfield-ts,brownfield-eslint-prettier,legacy-monorepo,jest-with-coverage,unsupported-python}`). Bug em detecção/instalação vira teste, não conversa.
- Idempotência verificável: `install-*` rodando 2x produz o mesmo `.lint-manifest.json`; `uninstall` reverte para o estado pré-setup.
- Observabilidade: stdout JSON é parseável por testes e2e e por outros comandos; exit codes mapeados a mensagens user-friendly no harness.
- Custo de iteração baixo: alterar lógica não requer mudar prompts; alterar fluxo conversacional não requer mexer em código.
- Distribuição simples: o CLI é puro TS sem build (ADR 0007); `install.sh` (ADR 0009) copia/symlinka para `~/.claude/skills/lint/cli/`.
- Manutenção delimitada: `agents/lint-*.md` ficam pequenos e estáveis; mudanças de schema do audit afetam só `cli/src/lib/audit-schema.ts` (zod).

**Negativas / tradeoffs**

- Duplicação de papel quando uma operação é trivial: ainda assim ela vira subcomando do CLI para preservar o contrato "harness não toca FS".
- Subagents perdem flexibilidade — não podem improvisar comandos shell além dos subcomandos publicados.
- Aumenta a superfície de testes: cada subcomando precisa de fixture + asserção.
- O subagent `lint-auditor` introduz uma janela não-determinística (texto do `rationale`); mitigado por (i) `rationale_stub` determinístico no payload, (ii) teste e2e que compara `recommendations[i].rationale ≠ candidates[i].rationale_stub` (acceptance §7.6).

## Alternativas consideradas

- **Tudo no harness.** Rejeitada: depende de o modelo executar git e editar AST de configs sem regressão entre versões; não dá para auditar reproducibilidade.
- **CLI compilado (esbuild/tsup `dist/`).** Rejeitada para v1: adiciona build step e versionamento de artefatos; `--experimental-strip-types` cobre o caso (ADR 0007). `esbuild` permanece como dependência apenas para o `report-export` self-contained.
- **CLI híbrido (lógica em `.md` + helpers em TS).** Rejeitada: borra a fronteira "harness não escreve FS" e abre janela para inconsistência entre quem decide e quem aplica.

## Verificação

- `npm test` exercita os subcomandos contra fixtures.
- `npm run typecheck` garante que o contrato JSON de cada subcomando bate com `cli/src/lib/audit-schema.ts` quando aplicável.
- E2E final (PLAN §Verification): rodar `/lint:setup`, `/lint:audit`, `/lint:report`, `/lint:rollback` num projeto TS real produz os artefatos do SPEC §7 sem retoque manual.
