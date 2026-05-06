# Tasks: scope-resolution

> Checklist sequencial. Detalhes (acceptance, verification, files) em `PLAN.md`.

## Phase 1 — Contrato

- [x] **T1** — Criar `docs/adrs/0013-scope-resolution-probe.md` com bloco canônico
- [x] **T2** — Criar `cli/tests/unit/preamble-parity.test.ts` (esperado: vermelho ainda)
- [x] **T3** — Criar `cli/tests/e2e/preamble-resolution.test.ts` (esperado: verde)

### ✅ Checkpoint A
- [x] ADR 0013 mergeable
- [x] E2E verde
- [ ] Unit vermelho controlado (regex-mismatch nos 19)
- [x] `npm run typecheck` verde

## Phase 2 — Migrar 19 arquivos funcionais

- [x] **T4** — `skills/lint/SKILL.md`
- [x] **T5** — 4 agents (`lint-auditor`, `lint-detector`, `lint-installer`, `lint-migrator`)
- [x] **T6** — 6 commands top-level (`audit`, `report`, `rollback`, `setup`, `uninstall`, `update`)
- [x] **T7** — 4 commands `ignore/*` (`add`, `explain`, `list`, `remove`)
- [x] **T8** — 4 commands `rules/*` (`add`, `explain`, `list`, `remove`)

### ✅ Checkpoint B
- [x] `npx vitest run cli/tests/unit/preamble-parity.test.ts` verde
- [x] `grep -rln 'CLAUDE_PLUGIN_ROOT' --include="*.md" {skills,agents,commands}/` → 0
- [x] `grep -rln 'for cand in "\$PWD/.claude"' --include="*.md" {skills,agents,commands}/ | wc -l` → 19

## Phase 3 — Documentação histórica (6 arquivos)

- [x] **T9** — `README.md`
- [x] **T10** — ADR 0006 (cross-link + exemplo)
- [x] **T11** — ADR 0007 (cross-link + exemplo)
- [x] **T12** — ADR 0009 (exemplo)
- [ ] **T13** — `.harn/docs/mvp/PLAN.md` + `IMPLEMENTATION_PLAN.md`

### ✅ Checkpoint C
- [ ] `grep -rln 'CLAUDE_PLUGIN_ROOT' --include="*.md" .` → 0 (exceto referências históricas explícitas em ADR 0013)
- [ ] Cross-links 0006→0013 e 0007→0013 visíveis

## Phase 4 — Release

- [ ] **T14** — `CHANGELOG.md` entrada `[Unreleased]` / `[0.3.2]`
- [ ] **T15** — Smoke manual (project + user scopes) + suite verde

### ✅ Checkpoint D
- [ ] Todos os 12 critérios da SPEC §9 marcados
- [ ] PR aberto referenciando SPEC + ADR 0013
