# ADR 0002 — Backup nomeado por timestamp + rollback byte-a-byte

- Status: aceito
- Data: 2026-05-04
- Relacionados: ADR 0001 (oxc-only v1), ADR 0006 (CLI determinístico com harness fino), ADR 0009 (instalação via `install.sh`)

## Contexto

O SPEC do `/lint` (`.harn/docs/mvp/SPEC.md`) trata reversibilidade como contrato, não bom-tom:

- §6 Always linha 382: *"Sempre criar `.lint-backup/<ISO-timestamp>/` antes de remover/sobrescrever qualquer arquivo de configuração de linter pré-existente."*
- §6 Never linha 411: *"Nunca remover arquivos de configuração de linter sem backup nomeado em `.lint-backup/`."*
- §2 linha 53: `/lint:rollback` é descrito como *"escape hatch"* — restaura sem desinstalar oxc.
- §7.2 acceptance: *"/lint:rollback restaura byte-a-byte os arquivos pré-existentes"* (anchor end-to-end).

A frase "backup nomeado" em SPEC §6 line 411 carrega três decisões implícitas que afetam quase todo o produto:

1. **Onde os bytes vivem?** Pasta dedicada (`.lint-backup/<ts>/`) versus reuso do git (`git stash`, branch temporário, `git worktree`)?
2. **Como o backup é descoberto?** Walk de FS sob `.lint-backup/`, manifest centralizado, ou ambos?
3. **Como o restore se compõe com o uninstall?** Restaurar config velha **e** desinstalar oxc é o fluxo padrão, ou são dois comandos ortogonais?

Essas escolhas têm consequências em cascata:

- O brownfield path do `/lint:setup` chama `backup-create` antes de `lint-installer` sobrescrever os configs do usuário (`commands/lint/setup.md` linhas 40+). Mover backup para git cria três commits novos por setup; mover para FS cria 1 árvore.
- `commands/lint/rollback.md` precisa enumerar timestamps. Sem manifest, o comando teria de fazer `glob('.lint-backup/*')` e parsear nomes — frágil contra `.lint-backup/.DS_Store` e symlinks.
- `commands/lint/uninstall.md` precisa decidir se backups acompanham a remoção (default), são preservados (`--keep-backup`), ou exigem comando dedicado.
- `cli/src/lib/fs-safe.ts` precisa decidir se entradas `kind: "backup"` participam do mesmo manifest dos outros artefatos qualy ou se há um manifest paralelo.
- O caso "usuário commitou `.lint-backup/`" (involuntário) passa a poluir o git history se a pasta não estiver no `.gitignore` template.

A pergunta arquitetural, então: **qual a primitiva de reversibilidade do `/lint:setup` em projetos brownfield?**

Sinais relevantes:

- Setup brownfield é **alto-risco** (substitui ESLint+Prettier configurados há meses) e **comum** (fixture `brownfield-eslint-prettier/` é um dos cinco T1; SPEC §7.2 marca como acceptance criterion explícito). Restore precisa ser *trivial* e *não-destrutivo*.
- O `git stash` é frágil: depende do estado do working tree em duas pontas (criação e restore), não sobrevive `git stash drop` acidental nem clone/checkout, e mistura mudanças do usuário com mudanças da skill.
- Manifest centralizado já existe (`.lint-manifest.json`) para os outros artefatos qualy — adicionar `kind: "backup"` ao mesmo formato custa zero arquivo novo.
- O usuário pode (e deve) commitar `.lint-backup/` se quiser snapshot durável — separar em pasta torna isso opt-in via `git add` em vez de subir junto com `.git/`.
- Rollback ≠ uninstall em narrativa: rollback é "voltar à minha config antiga sem perder o que aprendi do oxc"; uninstall é "remover oxc daqui". Acoplar os dois força quem usa um a passar pelo outro.
- Idempotência dos installers (`install-oxlint`/`install-hook`/etc) significa que setup pode ser re-executado sem corromper estado — o backup é a *primeira* invocação que precisa ser preservada.

## Decisão

A primitiva de reversibilidade de `/lint:setup` em brownfield é **um snapshot opt-in ao filesystem indexado pelo manifest, não pelo git**:

1. **Localização fixa**: `.lint-backup/<ISO-timestamp>/` dentro do `cwd` do projeto. Timestamp é filesystem-safe (`Date#toISOString()` com `:`/`.` substituídos por `-`, e.g. `2026-05-03T12-30-45-123Z`) — sortable lexicalmente em todo OS.
2. **Estrutura preserva caminho original**: arquivo `<cwd>/.eslintrc.json` é copiado para `<cwd>/.lint-backup/<ts>/.eslintrc.json`; `<cwd>/packages/api/jest.config.js` para `<cwd>/.lint-backup/<ts>/packages/api/jest.config.js`. Restore é `read(.lint-backup/<ts>/<src>) → write(<src>)` byte-a-byte.
3. **Manifest é fonte da verdade**: cada entrada de backup vira `kind: "backup"` em `.lint-manifest.json`. `backup-list` agrupa por timestamp lendo *o manifest* — nunca walk de FS (defesa contra `.DS_Store`, symlinks, restos de versões antigas). Entradas com timestamp órfão (path bogus) são silenciosamente droppadas.
4. **Rollback usa `skipManifest: true` no write**: arquivos restaurados são *do usuário*, não qualy-owned. As entradas `kind: "backup"` permanecem no manifest mesmo após restore — `/lint:rollback` é idempotente; `/lint:uninstall --keep-backup` continua funcionando.
5. **Uninstall por padrão deleta os snapshots**: SPEC §6 não exige preservação eterna, e a maioria dos usuários quer limpeza completa após validar a migração. O flag `--keep-backup` (PLAN §Contratos CLI line 87) preserva os arquivos *e* as entradas do manifest. `commands/lint/uninstall.md` pergunta antes (`AskUserQuestion`, default Recommended = preservar).
6. **Rollback não desinstala oxc**: `commands/lint/rollback.md` é o "escape hatch" SPEC §2 line 53 — restaura configs antigas, mantém oxc instalado, oferece `/lint:uninstall` no follow-up via `SlashCommand`. Simétrico: `/lint:uninstall.md` oferece `/lint:rollback` quando há backups.
7. **`--ts` é determinístico e auditável**: timestamp pode ser sobrescrito via `--ts <override>` para idempotência exata em e2e tests; default deriva de `now()`. Timestamp único por chamada — backups acumulam (uma snapshot por tentativa de migração).
8. **`.gitignore` template inclui `.lint-backup/`**: o backup é volatil por default. Usuário que quer snapshot durável commita explicitamente.

A composição final é:

```
brownfield setup:
  detect-existing-linter
  → backup-create --files [".eslintrc.json", ".prettierrc.json"]   (creates .lint-backup/<ts>/, manifest entries kind:backup)
  → install-* layers (overwrite the originals)
  → /lint:rollback restores via backup-restore --ts <ts>            (skipManifest:true; entries persist)
  → /lint:uninstall --keep-backup keeps the .lint-backup/ tree     (or default = delete it)
```

## Consequências

**Positivas**

- **Mensagem para o usuário é trivial**: "seu ESLint está em `.lint-backup/<ts>/`. Rode `/lint:rollback` para restaurar." Não exige conhecimento de git stash, nem branch acrobacy.
- **Falha-safe**: se o agente crashar entre `backup-create` e `install-*`, o backup já existe — o usuário pode `cp -r .lint-backup/<ts>/* .` manualmente como último recurso.
- **Sobrevive `git stash drop`/`reset --hard`**: o backup é arquivo committable, não estado de stash. Se usuário commitar `.lint-backup/`, vira parte da history.
- **Manifest único simplifica `/lint:uninstall`**: `loadManifest()` particiona entries em três classes (owned files, backup snapshots, merged/virtual) e o uninstall opera sobre `kind: "backup"` com a mesma API que sobre `kind: "preset"`/`"hook"`.
- **`backup-list` é trivial**: filtra entries por kind, agrupa por timestamp, sort descending lexical. Sem walk de FS.
- **`/lint:rollback` é ortogonal a `/lint:uninstall`**: usuário que quer voltar para ESLint sem desinstalar oxc faz `/lint:rollback`; quem quer remover tudo faz `/lint:uninstall --keep-backup` e depois `/lint:rollback`. Nenhuma decisão dupla forçada.
- **Idempotência por `--ts`**: e2e tests pinnam timestamp em `2026-05-03T12-00-00-000Z` e ganham asserts byte-exatos em `cli/tests/e2e/setup-rollback-brownfield.test.ts`.
- **Funciona em projetos sem git inicializado**: backup-create grava em FS independentemente de `.git/`. `/lint:setup` ainda pede working tree limpo (defesa em profundidade), mas o snapshot não depende de git ser saudável.

**Negativas / tradeoffs**

- **Pasta extra na árvore do usuário**: `.lint-backup/` aparece em listagens (`ls`, `tree`). Mitigado por `.gitignore` template e pela instrução explícita do `/lint:uninstall` perguntar se preserva.
- **Sem dedup entre snapshots**: dois `/lint:setup` (i.e. duas migrações em sequência) criam dois timestamps com cópias byte-a-byte; mesmo arquivo, mesma data, dois MB. Aceitável para configs (≤ KB cada) mas seria caro se algum dia incluíssemos `package-lock.json`. Não incluímos.
- **Não captura o estado do `package.json` original automaticamente**: `backup-create` recebe lista explícita de paths via `--files`. Quem orquestra (`commands/lint/setup.md`) decide o que entra. Tradeoff consciente — backup-tudo seria pesado e ruidoso para algo que `git diff` cobre.
- **Manifest pode ficar grande em monorepos**: 50 setups × 6 arquivos backed up = 300 entries `kind: "backup"`. Mitigado pelo `/lint:uninstall` deletar por default e por `backup-list` ordenar descending (recente primeiro, default em `/lint:rollback`).
- **Restore não detecta arquivos *novos* criados após o backup**: se o usuário gerou `.eslintrc.cjs` depois de `/lint:setup` (situação rara mas possível), `/lint:rollback` não vai removê-lo. Aceitável — restore restaura o que foi backed up, não o complemento. Documentado em `commands/lint/rollback.md` Trade-offs.

## Alternativas consideradas

- **Usar `git stash push`/`pop` em vez de `.lint-backup/`.** Rejeitada: stash não tem nome estável (índice mexe quando o usuário faz outros stashes); `git stash drop` acidental deleta sem aviso; não funciona em projeto sem `.git/`; mistura com mudanças do usuário no working tree (estamos justamente *exigindo* tree limpo antes do setup, então o stash ficaria com mudanças *só* da skill — útil em teoria mas muito frágil em prática).
- **Criar branch `qualy/backup/<ts>` automaticamente.** Rejeitada: poluição do `git branch -a`, força usuário a entender qualy/git interplay, conflita com proteções de branch (CI hooks pré-push, `pre-receive` corporativos), e requer cleanup explícito em `/lint:uninstall` (deletar branch local *e* remoto?).
- **Tar/zip de `.lint-backup/<ts>.tar.gz`.** Rejeitada: dificulta inspeção (`cat .eslintrc.json` vira `tar -xzf`), não ajuda em economia de espaço para configs pequenos, adiciona dependência (binário tar) ou implementação custom no Node.
- **Sem manifest — descobrir backups via FS walk.** Rejeitada: `.lint-backup/.DS_Store`, symlinks, partial writes (crash mid-cp), e diretórios criados manualmente pelo usuário todos viram lixo no `backup-list`. Manifest dá fonte única de verdade e auditável.
- **Backup obrigatório também em greenfield (snapshot do `package.json` antes de `install-scripts`).** Rejeitada: greenfield por definição não tem configs prévios de linter; o `package.json` é editado idempotentemente por `install-scripts` (3-way merge — adicionados/skipped/conflicts) e pode ser revertido via `/lint:uninstall` sem snapshot. Backup só faz sentido no path destrutivo (brownfield).
- **`backup-create` registra entries `kind: "backup"` mas `backup-restore` também as remove após restaurar.** Rejeitada: quebra idempotência (rodar `/lint:rollback` duas vezes deveria ser no-op, não erro), e impede que `/lint:uninstall --keep-backup` mantenha referência. `skipManifest: true` no write mantém entries; deletion é responsabilidade explícita do `/lint:uninstall`.
- **Acoplar `/lint:rollback` a `/lint:uninstall` (rollback sempre desinstala oxc).** Rejeitada: SPEC §2 line 53 explicita "escape hatch" — usuário pode querer voltar à config antiga *e* manter oxc para experimentar de novo depois. Acoplar mata esse caminho.

## Verificação

- **Schema**: `cli/src/lib/fs-safe.ts` declara `ManifestEntryKind` com `"backup"` na união (linha 66) — drift quebra `cli/tests/unit/fs-safe.test.ts` (validação de kinds permitidos no manifest).
- **Comando**: `cli/src/commands/backup/{create,list,restore}.ts` implementam o trio exato; `cli/tests/unit/backup-{create,list,restore}.test.ts` (27 + 15 + 26 testes) lockam timestamp safe-form, manifest shape, idempotência por `--ts`, atomic-ish file existence check, ordem descending de timestamps em `backup-list`, restore byte-exato com `skipManifest: true`.
- **Acoplamento setup→rollback**: `cli/tests/e2e/setup-rollback-brownfield.test.ts` materializa fixture `brownfield-eslint-prettier/`, captura pre-state byte-a-byte de `.eslintrc.json`/`.prettierrc.json`/`package.json`, roda backup-create + 6 install layers + backup-restore, e assert que cada arquivo é idêntico ao pre-state — assert dual SPEC §7.2 ("byte-a-byte") e ADR 0002 (manifest preserva entries pós-rollback).
- **Idempotência de rollback**: o mesmo e2e roda `backup-restore` duas vezes (com mutação intermediária do arquivo restaurado) e confirma bytes iguais + manifest com exatamente uma entry `kind: "backup"` por path.
- **Uninstall composability**: `cli/tests/unit/uninstall.test.ts` (20 testes) cobre `kept_backup: true` em `--keep-backup` (entries permanecem, FS preservado) vs default (entries removidas, dir deletada); paridade com a tabela de classes do manifest (owned/backup/merged-virtual).
- **Harness instructions**: `commands/lint/rollback.md` carrega trade-off explícito ("não desinstala oxc — escape hatch SPEC §2 line 53") + offer de `/lint:uninstall` no follow-up; `commands/lint/uninstall.md` simétrico com offer de `/lint:rollback`. Asserts em `cli/tests/unit/command-lint-rollback-md.test.ts` + `command-lint-uninstall-md.test.ts`.
- **`.gitignore` raiz** lista `.lint-backup/` (PLAN §Critical files convention) — backup é opt-in para versionamento.
