# ADR 0012 — `jsPlugins` recebe path absoluto resolvido em runtime

> Status: aceito (2026-05-05). Implementação em
> `cli/src/commands/install/oxlint.ts` + tests em
> `cli/tests/unit/install-oxlint.test.ts`.

## Contexto

`oxlint 1.62.0` espera plugins externos sob a chave `jsPlugins` (a chave
`plugins` é só built-in). Cada entrada de `jsPlugins` é resolvida pelo binário
oxlint, **mas o resolver não trata bare specifiers** (`"quality-metrics"`):
ele falha com `Cannot find module 'quality-metrics'`. Apenas paths são
honrados.

Os 6 presets em `cli/src/presets/oxlint/<stage>.<tier>.json` precisam de uma
forma consistente, idempotente e portável de apontar para o pacote
`quality-metrics` instalado em `node_modules/` do projeto-alvo.

## Opções consideradas

### A) Path relativo no preset estático (`./node_modules/quality-metrics/...`)

- ✅ Config viaja byte-for-byte do preset para o projeto.
- ❌ Quebra quando oxlint é invocado de subpasta — o relative resolve a partir
  do cwd da invocação, não do diretório da config.
- ❌ Quebra em monorepos com `node_modules` hoisted no root.

### B) Path absoluto resolvido em runtime via `require.resolve` (escolhida)

- ✅ Funciona independente do cwd da invocação.
- ✅ Suporta hoisting (npm/pnpm/yarn) — `require.resolve("quality-metrics",
  { paths: [cwd] })` percorre a hierarquia padrão de Node.
- ❌ Path absoluto vaza para o config — quebra ao mover `node_modules` entre
  máquinas. Mitigado: `qualy install-oxlint` é idempotente; basta re-rodar
  após `npm ci` em outro host.

### C) Config TS/JS programática

- ✅ Resolve via import nativo de Node, sem patching textual.
- ❌ Oxlint marca config TS/JS como **experimental** (1.62.0); contrato pode
  mudar entre minors.
- ❌ Adiciona superfície de execução de código no path do linter — preset JSON
  é estático e auditável.

## Decisão

**Opção B.** `installOxlint` chama `require.resolve("quality-metrics",
{ paths: [opts.cwd] })` na primeira tier que precisar (lazy: o fast preset
não tem `jsPlugins`, então nem tenta) e re-grava o JSON do preset com a
substituição `"quality-metrics" → "<absolute path>"` em `jsPlugins[]`. O fast
preset segue byte-exato.

Quando `require.resolve` lança, retornamos
`{ ok: false, error: "quality_metrics_missing", reason: <stderr> }` com exit
`RECOVERABLE_ERROR` e mensagem orientando o usuário a re-rodar `/lint:setup`
(que invoca `install-deps` → `install-oxlint`).

Test seam: `deps.resolveModule?: (id, paths) => string` permite injetar um
stub determinístico nos unit tests sem depender de `node_modules` real.

## Consequências

- O preset gravado no projeto **não é** byte-exato em relação ao preset bundle
  — o `presets-oxlint.test.ts` valida o bundle estático; o
  `install-oxlint.test.ts` valida o ato de instalar com o path patcheado.
- Após `npm ci` ou `npm install` que recria `node_modules`, o path no preset
  segue válido se a máquina é a mesma. Mover o checkout entre máquinas exige
  re-rodar `qualy install-oxlint` (idempotente).
- Uninstall (`/lint:uninstall`) continua removendo o preset via manifest — o
  path absoluto não muda nada para esse fluxo.

## Referências

- `cli/src/commands/install/oxlint.ts` — `patchedPresetBytes` e a chamada
  `resolveModule`.
- `node_modules/quality-metrics/configs/oxlint.deep.json` — formato canônico
  do plugin, que também usa `jsPlugins`.
- `node_modules/oxlint/configuration_schema.json` — schema da config.
