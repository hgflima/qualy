# SPEC — `lint-ignore`: excluir arquivos / rules-por-path da visão do qualy

**Status:** draft (aguardando confirmação)
**Owner:** @hgflima
**Created:** 2026-05-05

---

## 1. Objective

Permitir ao usuário do qualy excluir caminhos (globs) ou desabilitar rules específicas em caminhos específicos da análise do oxlint, com **metadata rastreável** (reason obrigatório, expiry opcional). Exposto em duas camadas que espelham a convenção já existente de `/lint:rules:*`:

- **CLI:** `qualy ignore <verb>` (4 subcomandos)
- **Slash commands:** `/lint:ignore:<verb>` (mesmos 4 verbos)

A intenção é tratar exclusões como **dívida técnica auditável**, não como um buraco escondido em config — toda exclusão tem motivo registrado, é listável, e exclusões com expiry vencida geram warning visível.

### Out of scope (v1)

- Per-package ou per-workspace overrides (monorepos com múltiplos `oxlint.*.json`)
- Auto-remoção de exclusões vencidas
- UI no `/lint:report` mostrando ignores (entra em iteração futura)
- Severity overrides per-path (só on/off para rules)

---

## 2. Architecture (storage & compilation)

### 2.1 Source of truth

`.harn/qualy/ignore.json` — manifesto qualy-managed.

```json
{
  "version": 1,
  "entries": [
    {
      "id": "ign-a3f1c2",
      "glob": "src/legacy/**",
      "rule": null,
      "reason": "Codebase legado, será reescrito em Q3",
      "expires": "2026-09-30",
      "createdAt": "2026-05-05T14:32:11.000Z",
      "createdBy": "user"
    },
    {
      "id": "ign-b71e08",
      "glob": "src/generated/**",
      "rule": "quality-metrics/wmc",
      "reason": "Código gerado automaticamente",
      "expires": null,
      "createdAt": "2026-05-05T14:35:00.000Z",
      "createdBy": "user"
    }
  ]
}
```

**Campos:**
- `id` — gerado por `ign-` + hash curto de `(glob, rule)`. Estável para remoção.
- `glob` — padrão (sintaxe oxlint/gitignore-compatible).
- `rule` — `null` significa exclusão de path inteiro; string (`quality-metrics/wmc`, `category:correctness`) significa rule-por-path.
- `reason` — obrigatório, free text.
- `expires` — `YYYY-MM-DD` ou `null`. Vencido = warn, **nunca** quebra build (decisão registrada).
- `createdBy` — `"user" | "imported"`. `"imported"` é o caso de migração da seção 2.4.

### 2.2 Audit trail

`.harn/qualy/docs/lint-decisions.md` — append-only, formato igual ao já usado por `/lint:rules:add|remove`. Toda mutação (add/remove/import) registra:

```markdown
## 2026-05-05T14:32:11Z — ignore:add

- glob: `src/legacy/**`
- rule: (path-only)
- reason: Codebase legado, será reescrito em Q3
- expires: 2026-09-30
- id: ign-a3f1c2
```

### 2.3 Compilation

A compilação roda em dois gatilhos:

1. **On mutation** — toda vez que `add`/`remove`/`import` modifica o manifesto, recompila imediatamente.
2. **On drift** — `qualy lint` e `qualy audit` comparam `mtime(.harn/qualy/ignore.json)` vs `mtime(oxlint.fast.json)` e `mtime(oxlint.deep.json)`. Se manifesto for mais novo que qualquer preset, recompila antes de rodar; caso contrário, pula (zero overhead no caminho quente).

Não há recompilação cega a cada invocação — drift check é barato e suficiente.

O manifesto é compilado para `oxlint.fast.json` e `oxlint.deep.json`:

- Entradas com `rule = null` → agregadas em `ignorePatterns[]`.
- Entradas com `rule != null` → agregadas em `overrides[]` (um bloco por glob, agrupando rules):
  ```json
  "overrides": [
    { "files": ["src/generated/**"], "rules": { "quality-metrics/wmc": "off" } }
  ]
  ```
- Duas seções marker garantem idempotência:
  ```json
  "ignorePatterns": [
    "_qualy:start_",
    "src/legacy/**",
    "_qualy:end_"
  ]
  ```
  Tudo entre os markers é gerenciado pelo qualy. Tudo fora é preservado byte-a-byte.

A compilação é determinística: mesmas entradas → mesmo output (ordem por `id`).

### 2.4 Migration (first-write)

Quando `qualy ignore add` (ou qualquer mutação) roda pela primeira vez e detecta `ignorePatterns[]` populado nos presets **fora** dos markers `_qualy:*`:

1. Cada pattern não-trackeado vira uma entrada com `createdBy: "imported"`, `reason: "Imported from oxlint preset on first qualy ignore mutation"`, `expires: null`, `id` derivado do pattern.
2. Registra batch import único em `lint-decisions.md`.
3. Próxima compilação move tudo para dentro dos markers.

Sem prompt, sem fricção — `recommended` da pergunta de migração.

---

## 3. CLI surface

Localização: `cli/src/commands/ignore/{add,remove,list,explain,compile}.ts`. Despachados pelo `cli/src/index.ts` no padrão `qualy ignore <verb>`.

### 3.1 `qualy ignore add`

```
qualy ignore add <glob> [--rule <rule-id>] --reason <txt> [--expires YYYY-MM-DD] [--strict]
```

- `<glob>` posicional, obrigatório.
- `--rule` opcional. Aceita:
  - `quality-metrics/<name>` ou rule nominal (`eslint/no-debugger`, etc.)
  - `category:<cat>` (`category:correctness`, `category:suspicious`, etc.) — **escopo amplo**: desliga todas as rules da categoria naquele path. Requer reconhecimento explícito (ver 3.1.1).
  - Sem flag = exclusão de path inteiro.
- `--reason` **obrigatório** (mesma política de `/lint:rules:remove`).
- `--expires` opcional. Validado como `YYYY-MM-DD`, deve ser futura.
- `--strict` recusa em working tree dirty (paridade com `/lint:rules:add`).
- `--i-know-this-disables-many` flag obrigatória quando `--rule category:*` é usado no CLI direto (ver 3.1.1).

#### 3.1.1 `category:*` semantics

Categorias agrupam dezenas de rules (ex.: `correctness` ≈ 80 rules). Para evitar desligamento acidental em massa:

- **CLI direto:** `qualy ignore add <glob> --rule category:correctness ...` exige `--i-know-this-disables-many`. Sem a flag, exit `1` com mensagem listando o tamanho da categoria e instruindo a confirmação.
- **Slash command:** `/lint:ignore:add` detecta `category:*` antes de chamar o CLI, lista as N rules que serão desligadas (resolvidas via metadata estática do oxlint), e pede confirmação via `AskUserQuestion` ("isso vai desligar 80 rules em src/generated/**, confirma?"). Após confirmação, injeta `--i-know-this-disables-many` automaticamente.
- **No manifesto:** entrada com `rule: "category:correctness"` é compilada expandindo a categoria — cada rule da categoria vira uma entrada `"<rule>": "off"` no override block. A entrada no `ignore.json` permanece compacta (`category:correctness`), só a expansão acontece na compilação.
- **Em `qualy ignore list`:** entradas com `category:*` são marcadas com `⚠ category (N rules)` para destaque visual.

**Exit codes:**
- `0` — sucesso
- `1` — recoverable: glob inválido / rule desconhecida / reason ausente / expires no passado
- `2` — refused (dirty tree + --strict)
- `5` — fatal: manifesto corrompido

**Side effects:**
1. Adiciona/atualiza entrada em `.harn/qualy/ignore.json`.
2. Recompila presets oxlint.
3. Append em `.harn/qualy/docs/lint-decisions.md`.

Idempotente: re-add do mesmo `(glob, rule)` atualiza `reason`/`expires` ao invés de duplicar (registra como `ignore:update` no log).

### 3.2 `qualy ignore remove`

```
qualy ignore remove <glob> [--rule <rule-id>] --reason <txt> [--strict]
```

- `--reason` obrigatório (paridade com `/lint:rules:remove` — toda remoção precisa motivo).
- Sem `--rule`, remove todas as entradas que matcham `glob` exato (path-only + per-path), pedindo confirmação se houver mais de uma.
- Exit `1` se `(glob, rule)` não existe no manifesto.

### 3.3 `qualy ignore list`

```
qualy ignore list [--expired] [--path <glob>] [--json]
```

Read-only. Imprime tabela:

```
ID         GLOB                  RULE                       REASON            EXPIRES      STATUS
ign-a3f1c2 src/legacy/**         (path-only)                Codebase legado…  2026-09-30   active
ign-b71e08 src/generated/**      quality-metrics/wmc        Código gerado…    -            active
ign-c92d44 src/old/**            (path-only)                Migração V2…      2026-04-01   ⚠ expired (34d)
```

- `--expired` filtra apenas entradas vencidas (exit `0` se nenhuma, exit `1` se houver — útil em CI).
- `--path` filtra por glob match.
- `--json` para consumo programático (slash command parseia).

### 3.4 `qualy ignore explain`

```
qualy ignore explain <glob> [--rule <rule-id>]
```

Read-only. Mostra entrada completa + linhas relevantes do `lint-decisions.md` (history de mutações naquela entrada).

### 3.5 `qualy ignore compile` (internal)

```
qualy ignore compile [--check]
```

Recompila manifesto → presets. `--check` apenas valida que presets estão sincronizados (exit `1` se drift detectado). Chamado internamente por `add`/`remove` e por `qualy lint` como safety net.

Não exposto como slash command — é detalhe de implementação.

---

## 4. Slash commands

Localização: `commands/lint/ignore/{add,remove,list,explain}.md`. Estrutura idêntica a `commands/lint/rules/*.md`:

- Frontmatter YAML com `description`, `argument-hint`, `allowed-tools` (`Bash(qualy ignore *)`, `AskUserQuestion`).
- One-question-at-a-time via `AskUserQuestion` para confirmar ações destrutivas e capturar `--reason` quando ausente.
- Mostra **blast radius** antes de aplicar (quantos arquivos serão afetados, rodando `oxlint --print-files` filtrado pelo glob).
- Nunca edita arquivos diretamente — sempre delega ao CLI (ADR 0006).

### 4.1 Convenções específicas

- `/lint:ignore:add` — se usuário não passar `--reason`, perguntar via `AskUserQuestion` com 3 opções comuns (`legacy code`, `generated code`, `vendored code`) + Other.
- `/lint:ignore:remove` — sempre confirma com blast radius ("removendo essa exclusão vai expor N novos arquivos ao lint, dos quais X têm violations atualmente"). Captura `--reason` via `AskUserQuestion`.
- `/lint:ignore:list` — sem prompts. Exit `1` redireciona p/ `/lint:ignore:add` se manifesto vazio? Não — apenas imprime "(no entries)".
- `/lint:ignore:explain` — sem prompts. Exit `1` se entrada não existe.

---

## 5. Project structure (deltas)

```
qualy/
├── cli/
│   └── src/
│       ├── commands/
│       │   └── ignore/                      ← NEW
│       │       ├── add.ts
│       │       ├── remove.ts
│       │       ├── list.ts
│       │       ├── explain.ts
│       │       └── compile.ts
│       ├── lib/
│       │   ├── ignore-manifest.ts           ← NEW (read/write/validate)
│       │   ├── ignore-compile.ts            ← NEW (manifest → oxlint config)
│       │   └── ignore-import.ts             ← NEW (migration)
│       └── index.ts                         ← UPDATED (dispatch ignore.*)
├── commands/
│   └── lint/
│       └── ignore/                          ← NEW
│           ├── add.md
│           ├── remove.md
│           ├── list.md
│           └── explain.md
└── .harn/
    └── qualy/                               ← NEW namespace
        ├── ignore.json                      (gerado on-demand)
        └── docs/
            └── lint-decisions.md            (migrado de docs/lint-decisions.md)
```

### 5.1 Migração de `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md`

Os comandos `/lint:rules:add` e `/lint:rules:remove` hoje gravam em `docs/lint-decisions.md` (raiz do projeto). Esta SPEC reloca para `.harn/qualy/docs/lint-decisions.md` para alinhar com a convenção `.harn/qualy/*`.

**Estratégia de migração (one-time, idempotente):**

1. **Quando dispara:** primeira execução pós-upgrade de qualquer mutação que escreve no decision log — `qualy ignore add|remove`, `qualy rules:add|remove`, ou novo comando `qualy migrate-decision-log` (manual).
2. **Detecção:** se `docs/lint-decisions.md` existe **e** `.harn/qualy/docs/lint-decisions.md` não existe → migrar.
3. **Ação:**
   - `mkdir -p .harn/qualy/docs`
   - `git mv docs/lint-decisions.md .harn/qualy/docs/lint-decisions.md` (se git tracked) ou `mv` direto.
   - Append entry no topo do arquivo migrado:
     ```markdown
     ## <timestamp> — meta:migrate-decision-log
     - from: docs/lint-decisions.md
     - to: .harn/qualy/docs/lint-decisions.md
     - reason: align with .harn/qualy/* convention
     ```
   - Se `docs/` ficou vazia, deixar como está (não removemos diretórios do usuário).
4. **Conflito (ambos existem):** se ambos os arquivos existem (provavelmente porque o usuário começou edição manual), abortar com exit `1` e mensagem instruindo merge manual. **Nunca** mergear automaticamente — risco de perder histórico.
5. **Rollback:** se mutação subsequente falhar, manter o move (decision log é append-only e independente da mutação).
6. **Atualização de código:** todos os call-sites em `cli/src/commands/rules/{add,remove}.ts` e novos `cli/src/commands/ignore/*.ts` leem o path via constant em `cli/src/lib/paths.ts` (`DECISION_LOG_PATH = '.harn/qualy/docs/lint-decisions.md'`). Sem hardcode espalhado.
7. **Slash commands:** `/lint:rules:add|remove` `.md` files são atualizados para referenciar o novo path em qualquer texto explanatório.

**Out of migration scope:**
- Não tocamos em `.lint-audit/` nem `.lint-manifest.json` — esses já têm seus próprios paths e não estão sob `docs/`.
- Não migramos histórico do git (move preserva via `git mv` se tracked).

**Migration de refs existentes:** ver seção 5.1.

---

## 6. Code style

Seguir convenções já presentes em `cli/src/commands/rules/{add,remove,list,explain}.ts`:

- TypeScript strict, sem `any`.
- CLI parsing via mesmo helper que `rules/*.ts` usa (verificar `cli/src/lib/`).
- Commander-style ou args manuais? — espelhar `rules/add.ts` exatamente.
- Errors retornam exit codes documentados; nada de throw para o topo.
- JSON outputs sempre passam por `JSON.stringify(obj, null, 2)` + newline final.

---

## 7. Testing strategy

Espelhar layout existente em `cli/tests/`:

### 7.1 Unit (`cli/tests/unit/commands/ignore/`)

- `add.test.ts` — args parsing, validation (glob/rule/expires), idempotência (re-add atualiza), id generation determinística.
- `remove.test.ts` — match exato, ambiguity (múltiplas entradas no mesmo glob), reason mandatório.
- `list.test.ts` — filtros `--expired`/`--path`, JSON output, exit codes.
- `explain.test.ts` — entry not found, history rendering.
- `compile.test.ts` — round-trip (compile → parse → assert), markers preservation, drift detection (`--check`).
- `import.test.ts` — primeira mutação importa ignorePatterns existentes; entradas duplicadas não re-importam.

### 7.2 E2E (`cli/tests/e2e/ignore-flow.test.ts`)

Cenários completos com fixtures reais:

1. **add path-only → run lint → file ignored.** Cria fixture com violation conhecida, exclui via `qualy ignore add`, roda `qualy lint`, espera 0 violations.
2. **add per-rule → violation in other rule still reported.** Exclui só `quality-metrics/wmc` em `src/x/**`, espera que `quality-metrics/cbo` ainda dispare no mesmo path.
3. **expired entry → warning printed, file still excluded.** Manipula `ignore.json` para injetar entrada vencida, roda lint, asserta warning no stderr e exclusão ainda ativa.
4. **migration import.** Fixture com `ignorePatterns` populado em `oxlint.fast.json`. Primeira `qualy ignore add` importa, log entry criado.
5. **slash command end-to-end.** Invoca `/lint:ignore:add` via harness do Claude Code (paridade com testes existentes de `/lint:rules:*`).

### 7.3 Fixtures

`cli/tests/fixtures/ignore-*/` com:
- `ignore-greenfield/` — projeto sem `ignorePatterns` prévios.
- `ignore-brownfield/` — projeto com `ignorePatterns` manuais (testa migration).
- `ignore-expired/` — manifesto pré-populado com entrada vencida.

---

## 8. Boundaries

### 8.1 Always do

- Persistir mutação no manifesto **antes** de tocar nos presets oxlint.
- Append em `lint-decisions.md` para toda mutação (criação, update, remoção, import).
- Validar `glob` (não-vazio, sem caracteres proibidos) e `rule` (existe no catálogo qualy) antes de gravar.
- Recompilar presets idempotentemente (markers `_qualy:start_`/`_qualy:end_`).
- Preservar byte-a-byte qualquer conteúdo dos presets fora dos markers.
- Uma pergunta por vez via `AskUserQuestion` nos slash commands (memória do usuário).

### 8.2 Ask first about

- Remoção de entradas com expiry passado (oferecer `keep` se usuário quer apenas renovar).
- Ambiguity em `remove` quando o `glob` casa múltiplas entradas (path-only + per-path).
- Migração (`import`) na primeira mutação se houver mais de 5 patterns para importar (acima desse limite, confirma).
- Mover `docs/lint-decisions.md` → `.harn/qualy/docs/lint-decisions.md` (one-time migration, requer confirmação).

### 8.3 Never do

- Quebrar build/CI por entrada vencida (decisão: warn-only).
- Editar `oxlint.{fast,deep}.json` fora dos markers `_qualy:*`.
- Permitir entrada sem `reason`.
- Deletar `ignore.json` automaticamente, mesmo se vazio (drift safety).
- Aceitar `expires` no passado em `add` (validation error, exit `1`).
- Modificar manifesto a partir do slash command (sempre via CLI — ADR 0006).
- Commitar `ignore.json` ou `lint-decisions.md` automaticamente (usuário decide).
- Aceitar `--rule category:*` no CLI direto sem `--i-know-this-disables-many` (validation error, exit `1`).
- Mergear automaticamente quando `docs/lint-decisions.md` e `.harn/qualy/docs/lint-decisions.md` coexistem (exit `1`, exige resolução manual).

---

## 9. Open questions

Todas as open questions foram resolvidas:

1. ✅ Recompilação: on-mutation + on-drift (mtime check). Ver §2.3.
2. ✅ `category:*`: aceito com confirmação obrigatória (slash command via `AskUserQuestion`, CLI direto via `--i-know-this-disables-many`). Ver §3.1.1.
3. ✅ Migração de `docs/lint-decisions.md`: incluída nesta SPEC. Ver §5.1.

---

## 10. Acceptance criteria (mínimo viável)

- [ ] `qualy ignore add src/legacy/** --reason "x"` cria entrada, recompila preset, lint passa em arquivo dentro do glob.
- [ ] `qualy ignore add src/x/** --rule quality-metrics/wmc --reason "y"` desabilita só essa rule no path; outras rules ainda disparam.
- [ ] `qualy ignore list` mostra todas entradas com status correto (active/expired).
- [ ] `qualy ignore list --expired` exit `1` quando há vencidas, exit `0` quando não.
- [ ] Entrada vencida → warning visível em stderr de `qualy lint`/`audit`, exclusão ainda ativa.
- [ ] Primeira mutação em projeto com `ignorePatterns` manuais importa-os automaticamente com `createdBy: "imported"`.
- [ ] `/lint:ignore:{add,remove,list,explain}` funcionam end-to-end via slash command harness.
- [ ] Working tree dirty + `--strict` em `add`/`remove` → exit `2` com mensagem instruindo `git stash`.
- [ ] Re-add de `(glob, rule)` igual atualiza in-place, registra como `ignore:update`.
- [ ] `--rule category:correctness` no CLI sem `--i-know-this-disables-many` → exit `1` com lista do tamanho da categoria.
- [ ] `/lint:ignore:add` com `category:*` lista as N rules e pede confirmação via `AskUserQuestion` antes de chamar o CLI.
- [ ] Drift check: editar manualmente `ignore.json` e rodar `qualy lint` → recompila antes de rodar; rodar duas vezes seguidas sem mutação → segunda invocação pula compilação.
- [ ] Migração one-time de `docs/lint-decisions.md`: arquivo é movido para `.harn/qualy/docs/lint-decisions.md` na primeira mutação pós-upgrade; conflito (ambos existem) → exit `1` com mensagem clara.
- [ ] Unit + e2e cobrem todos os cenários da seção 7.

---

## 11. Não está nesta SPEC (próximas iterações)

- Auto-renovação de expiry via `qualy ignore renew <id> --until YYYY-MM-DD`.
- `/lint:report` integração (mostrar painel de ignores + expired count).
- Bulk operations (`qualy ignore prune --expired-since 30d`).
- Severity overrides per-path (downgrade error → warn em vez de off).
- Per-package overrides em monorepos.
