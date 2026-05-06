# Plan: scope-resolution

> Decompõe SPEC.md em tasks pequenas, verticais e verificáveis. Cada task deixa o repo em estado funcional. Checkpoints entre fases gateiam progresso.

## Overview

Substituir o preâmbulo bash (`CLAUDE_PLUGIN_ROOT:-$HOME/.claude`) em 25 arquivos `.md` por um probe `$PWD → $HOME` que cobre os 3 scopes do `qualy install` (`user`, `project`, `local`), com falha `exit 5` clara quando o CLI não está instalado. Sem mudanças em `cli/src/`.

## Architecture Decisions

- **Probe inline em cada arquivo** (não helper sourced) — chicken-and-egg de bootstrap não compensa para 5 linhas.
- **Ordem `$PWD/.claude` → `$HOME/.claude`** — reflete o default `scope: "project"` em `cli/src/install/install.ts:215`.
- **`CLAUDE_PLUGIN_ROOT` removido** — qualy nunca foi distribuído como plugin oficial; manter induzia leitor a uma realidade que não existe.
- **Exit 5 = `MISSING_DEP`** — reaproveita `cli/src/lib/exit-codes.ts` sem novos códigos.
- **Tests-first** — escrever unit + e2e antes de tocar nos 19 arquivos funcionais, para que cada migração já encontre o teste verdinho ou vermelho-determinístico.
- **TDD não-strict para os 19 arquivos** — o "teste" é o regex de paridade; o código é texto. A garantia vem do byte-equivalence + e2e do script standalone.

## Dependency Graph

```
ADR 0013 (texto canônico)
    │
    ├── unit test (preamble-parity)  ──┐
    │                                  │
    └── e2e test (preamble-resolution) ┴─→ aplicar nos 19 funcionais ──→ docs históricos ──→ CHANGELOG + smoke
```

## Task List

### Phase 1 — Contrato (ADR + testes)

#### Task 1: Criar ADR 0013 com bloco canônico

- [ ] **Description:** Documentar a decisão do probe `$PWD → $HOME`, justificar remoção de `CLAUDE_PLUGIN_ROOT`, listar consequências vs ADRs 0006/0007.
- [ ] **Acceptance:**
  - [ ] `docs/adrs/0013-scope-resolution-probe.md` criado, status `aceito`, data `2026-05-06`.
  - [ ] Seções: Contexto, Decisão (com bloco bash literal de §6), Alternativas consideradas (helper sourced, npx, env var), Consequências, Related ADRs (0006, 0007, 0010).
  - [ ] Bloco bash dentro do ADR é byte-idêntico ao SPEC §6 (5 linhas + linha node).
- [ ] **Verification:**
  - [ ] `rtk ls docs/adrs/0013-*.md` retorna 1 arquivo.
  - [ ] `grep -c 'for cand in "\$PWD/.claude" "\$HOME/.claude"' docs/adrs/0013-*.md` ≥ 1.
- [ ] **Files:** `docs/adrs/0013-scope-resolution-probe.md`
- [ ] **Scope:** S (1 arquivo novo)
- [ ] **Deps:** None

#### Task 2: Unit test de paridade (`preamble-parity.test.ts`)

- [ ] **Description:** Test que lê os 19 arquivos funcionais, extrai o bloco do probe e prova byte-equivalence + count.
- [ ] **Acceptance:**
  - [ ] `cli/tests/unit/preamble-parity.test.ts` criado.
  - [ ] Constante `FUNCTIONAL_FILES` com os 19 paths exatos do SPEC §5.
  - [ ] 3 asserções: (a) cada arquivo casa `PROBE_REGEX`, (b) Set de blocos extraídos tem `size === 1`, (c) glob `{skills,agents,commands}/**/*.md` filtrado por `QUALY_CLI=` retorna exatamente os 19 paths.
  - [ ] Helper `extractProbeBlock(content)` isolado e testável.
- [ ] **Verification:**
  - [ ] `npx vitest run cli/tests/unit/preamble-parity.test.ts` — espera-se **vermelho** ainda (nenhum arquivo migrado), mas com falhas claras "expected to match PROBE_REGEX". Capturar saída para confirmar diagnóstico, não verde.
  - [ ] Test aparece em `npm test` output.
- [ ] **Files:** `cli/tests/unit/preamble-parity.test.ts`
- [ ] **Scope:** S
- [ ] **Deps:** Task 1 (define o bloco canônico)

#### Task 3: E2E test do snippet bash (`preamble-resolution.test.ts`)

- [ ] **Description:** Test executa o probe bash standalone em 4 cenários (PWD-only, HOME-only, ambos, nenhum), validando resolução e exit code.
- [ ] **Acceptance:**
  - [ ] `cli/tests/e2e/preamble-resolution.test.ts` criado.
  - [ ] `beforeEach` cria `tmpHome` e `tmpPwd` via `mkdtempSync`; sobrescreve `HOME` e `PWD` no env do child.
  - [ ] 4 cenários da tabela SPEC §7:
    - [ ] PWD-only → exit 0, stdout contém `<tmpPwd>/.claude/skills/lint/cli/src/index.ts`.
    - [ ] HOME-only → exit 0, stdout contém `<tmpHome>/...`.
    - [ ] Ambos → exit 0, resolve para PWD (precedência).
    - [ ] Nenhum → exit 5, stderr contém `qualy CLI not found`.
  - [ ] Snippet bash do test é a string literal do SPEC §6 (não importa de outro arquivo nesta fase — texto puro).
  - [ ] Probe roda em `bash` minimal (`bash --noprofile --norc -c '...'`) — sem bashisms.
- [ ] **Verification:**
  - [ ] `npx vitest run cli/tests/e2e/preamble-resolution.test.ts` — espera-se **verde** (snippet standalone independe da migração dos 19 arquivos).
- [ ] **Files:** `cli/tests/e2e/preamble-resolution.test.ts`
- [ ] **Scope:** M (1 arquivo, ~150 linhas com 4 cenários + setup)
- [ ] **Deps:** Task 1

### Checkpoint A — Contrato selado

- [ ] ADR 0013 mergeable.
- [ ] E2E verde.
- [ ] Unit vermelho de forma controlada (regex-mismatch nos 19 funcionais — esperado).
- [ ] `npm run typecheck` verde.

---

### Phase 2 — Migrar 19 arquivos funcionais

> Cada task substitui o bloco antigo (linha única `QUALY_CLI=...`) pelo bloco novo (5 linhas + node). Texto literal definido em SPEC §6. **`<subcommand>` na linha node varia por arquivo** (ex.: `setup.md` invoca `setup`).

#### Task 4: Migrar `skills/lint/SKILL.md`

- [ ] **Acceptance:**
  - [ ] Bloco antigo removido, bloco canônico (5 linhas) inserido.
  - [ ] Linha `node ...` preservada com o subcommand correto.
- [ ] **Verification:** `grep -c 'for cand in "\$PWD/.claude"' skills/lint/SKILL.md` retorna `1`. Nenhuma menção a `CLAUDE_PLUGIN_ROOT` no arquivo.
- [ ] **Files:** `skills/lint/SKILL.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Task 1

#### Task 5: Migrar 4 agents (`lint-auditor`, `lint-detector`, `lint-installer`, `lint-migrator`)

- [ ] **Acceptance:** Mesma regra do Task 4 aplicada em cada um dos 4 arquivos `agents/lint-*.md`.
- [ ] **Verification:** `grep -l 'for cand in "\$PWD/.claude"' agents/lint-*.md | wc -l` retorna `4`.
- [ ] **Files:** `agents/lint-auditor.md`, `agents/lint-detector.md`, `agents/lint-installer.md`, `agents/lint-migrator.md`
- [ ] **Scope:** S (4 arquivos)
- [ ] **Deps:** Task 1

#### Task 6: Migrar 6 commands top-level (`audit`, `report`, `rollback`, `setup`, `uninstall`, `update`)

- [ ] **Acceptance:** Mesma regra. Subcommand varia (`audit`, `report`, etc.).
- [ ] **Verification:** `grep -l 'for cand in "\$PWD/.claude"' commands/lint/{audit,report,rollback,setup,uninstall,update}.md | wc -l` retorna `6`.
- [ ] **Files:** `commands/lint/{audit,report,rollback,setup,uninstall,update}.md`
- [ ] **Scope:** M (6 arquivos)
- [ ] **Deps:** Task 1

#### Task 7: Migrar 4 commands `ignore/*` (`add`, `explain`, `list`, `remove`)

- [ ] **Acceptance:** Mesma regra.
- [ ] **Verification:** `grep -l 'for cand in "\$PWD/.claude"' commands/lint/ignore/*.md | wc -l` retorna `4`.
- [ ] **Files:** `commands/lint/ignore/{add,explain,list,remove}.md`
- [ ] **Scope:** S (4 arquivos)
- [ ] **Deps:** Task 1

#### Task 8: Migrar 4 commands `rules/*` (`add`, `explain`, `list`, `remove`)

- [ ] **Acceptance:** Mesma regra.
- [ ] **Verification:** `grep -l 'for cand in "\$PWD/.claude"' commands/lint/rules/*.md | wc -l` retorna `4`.
- [ ] **Files:** `commands/lint/rules/{add,explain,list,remove}.md`
- [ ] **Scope:** S (4 arquivos)
- [ ] **Deps:** Task 1

### Checkpoint B — 19 funcionais migrados

- [ ] `npx vitest run cli/tests/unit/preamble-parity.test.ts` **verde** (3 asserções).
- [ ] `grep -rln 'CLAUDE_PLUGIN_ROOT' --include="*.md" {skills,agents,commands}/` retorna 0 hits.
- [ ] `grep -rln 'for cand in "\$PWD/.claude"' --include="*.md" {skills,agents,commands}/ | wc -l` retorna `19`.

---

### Phase 3 — Documentação histórica (6 arquivos)

> Atualizar exemplos/citações para refletir o preâmbulo novo. **Não** alterar a lógica desses arquivos — apenas snippets e referências.

#### Task 9: `README.md`

- [ ] **Acceptance:** Qualquer bloco bash que mostre o preâmbulo antigo passa a usar o novo. Adicionar nota breve referenciando ADR 0013 se houver seção de troubleshooting.
- [ ] **Verification:** `grep -c 'CLAUDE_PLUGIN_ROOT' README.md` retorna `0`.
- [ ] **Files:** `README.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Task 1

#### Task 10: ADR 0006 — cross-link + exemplo

- [ ] **Acceptance:**
  - [ ] Linha `Related: ADR 0013` adicionada na seção de Decisão (ou rodapé "Related ADRs").
  - [ ] Qualquer exemplo de preâmbulo no corpo do ADR atualizado para o bloco novo.
  - [ ] Nenhuma menção solta a `CLAUDE_PLUGIN_ROOT` sem contexto histórico ("anteriormente usávamos…").
- [ ] **Verification:** `grep 'ADR 0013' docs/adrs/0006-deterministic-cli-thin-harness.md` retorna ≥ 1 hit.
- [ ] **Files:** `docs/adrs/0006-deterministic-cli-thin-harness.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Task 1

#### Task 11: ADR 0007 — cross-link + exemplo

- [ ] **Acceptance:** Mesmo padrão do Task 10.
- [ ] **Verification:** `grep 'ADR 0013' docs/adrs/0007-runtime-ts-strip-types.md` retorna ≥ 1 hit.
- [ ] **Files:** `docs/adrs/0007-runtime-ts-strip-types.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Task 1

#### Task 12: ADR 0009 — atualizar exemplo

- [ ] **Acceptance:** Exemplos do preâmbulo no ADR de install-script atualizados (sem necessariamente cross-linkar 0013, mas sem deixar `CLAUDE_PLUGIN_ROOT` no corpo).
- [ ] **Verification:** `grep -c 'CLAUDE_PLUGIN_ROOT' docs/adrs/0009-install-script-distribution.md` retorna `0`.
- [ ] **Files:** `docs/adrs/0009-install-script-distribution.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Task 1

#### Task 13: `.harn/docs/mvp/PLAN.md` e `IMPLEMENTATION_PLAN.md`

- [ ] **Acceptance:** Snippets do preâmbulo nos planos do MVP atualizados. Nota inline `(atualizado pelo SPEC scope-resolution)` opcional.
- [ ] **Verification:** `grep -c 'CLAUDE_PLUGIN_ROOT' .harn/docs/mvp/PLAN.md .harn/docs/mvp/IMPLEMENTATION_PLAN.md` retorna `0`.
- [ ] **Files:** `.harn/docs/mvp/PLAN.md`, `.harn/docs/mvp/IMPLEMENTATION_PLAN.md`
- [ ] **Scope:** S (2 arquivos)
- [ ] **Deps:** Task 1

### Checkpoint C — Docs históricas alinhadas

- [ ] `grep -rln 'CLAUDE_PLUGIN_ROOT' --include="*.md" .` retorna **0 hits no repo todo** (exceto eventuais referências históricas explícitas no ADR 0013).
- [ ] Cross-links 0006→0013 e 0007→0013 visíveis.

---

### Phase 4 — Release

#### Task 14: `CHANGELOG.md`

- [ ] **Acceptance:**
  - [ ] Entrada na próxima seção `[Unreleased]` (ou `[0.3.2]` se já fechado).
  - [ ] Categoria `Fixed` com 1-2 linhas: probe `$PWD → $HOME` em 19 arquivos + ADR 0013.
  - [ ] Sem usar palavras "complex"/"risk".
- [ ] **Verification:** `grep -A2 'scope-resolution\|preâmbulo\|QUALY_CLI' CHANGELOG.md` mostra entrada nova.
- [ ] **Files:** `CHANGELOG.md`
- [ ] **Scope:** XS
- [ ] **Deps:** Phase 3 completa

#### Task 15: Smoke manual + verificação final

- [ ] **Acceptance:**
  - [ ] `npm test` verde (unit suite inteira).
  - [ ] `npm run test:e2e` verde (e2e suite inteira).
  - [ ] `npm run typecheck` verde.
  - [ ] `npm run lint` verde.
  - [ ] Smoke 1 (project scope): `D=$(mktemp -d) && cd "$D" && git init && qualy install --scope project` → preâmbulo extraído de `.claude/skills/lint/SKILL.md` resolve com `bash -c "$probe"` para `${D}/.claude/...`.
  - [ ] Smoke 2 (user scope): repetir com `HOME=$(mktemp -d)` e `--scope user` para validar fallback.
- [ ] **Verification:** Suite verde + 2 smokes manuais documentados em comentário no PR ou em nota interna.
- [ ] **Files:** None (validação)
- [ ] **Scope:** S
- [ ] **Deps:** Tasks 1–14

### Checkpoint D — Pronto para merge

- [ ] Todos os 12 critérios da SPEC §9 (Success Criteria) marcados.
- [ ] PR aberto com referência a SPEC + ADR 0013.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Drift byte-a-byte entre os 19 arquivos durante migração manual | High (test de paridade reprova) | Aplicar via copy-paste do mesmo string buffer; rodar unit test após cada subgrupo (Tasks 4, 5, 6, 7, 8). |
| Subcommand errado ao reescrever bloco | Medium (comando quebra em runtime) | Inspecionar diff de cada arquivo antes de commitar — a linha `node ...` deve manter o mesmo subcommand do bloco antigo. |
| ADR 0013 numbering colide se outra branch também usar 0013 | Low | Verificar `git fetch && ls docs/adrs/0013-*` antes de criar. |
| E2E flaky em CI por env var leakage | Low-Medium | Usar `bash --noprofile --norc` + env explícita no `execFileSync`; nunca confiar em `process.env` herdado. |
| Glob do test de paridade pega novo arquivo `.md` futuro com `QUALY_CLI=` | Medium (test passa a falhar quando alguém adiciona um command) | Asserção (c) é exatamente esse guard. Falha bem-vinda — força contributor a atualizar `FUNCTIONAL_FILES`. |

## Open Questions

Nenhuma — SPEC §11 já fechou todas. Caso surja durante implementação, voltar ao SPEC antes de seguir.

## Verification Antes de Implementar

- [x] Toda task tem acceptance + verification.
- [x] Tasks XS/S/M apenas (nenhum L+).
- [x] Dependências mapeadas (todas dependem de Task 1; demais são paralelas dentro da fase).
- [x] Checkpoints A/B/C/D entre fases.
- [ ] Humano revisou e aprovou.
