# ADR 0009 — Distribuição via `install.sh` (em vez de plugin Claude Code nativo)

- Status: aceito
- Data: 2026-05-03
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0007 (runtime TS via `--experimental-strip-types`)

## Contexto

ADR 0006 fixou que o produto tem duas camadas físicas:

1. Harness Markdown — `skills/lint/`, `commands/lint/`, `agents/lint-*.md`.
2. CLI determinístico — `cli/src/` (TypeScript executado por `node --experimental-strip-types`, ADR 0007).

Para que o Claude Code descubra a skill, esses artefatos precisam estar resolvíveis pelo probe `$PWD/.claude → $HOME/.claude` (ver ADR 0013 para o bloco canônico) no layout fixado em `PLAN §Resolução do CLI`:

```
$TARGET_ROOT/                              (= $PWD/.claude ou $HOME/.claude)
├── skills/lint/SKILL.md
├── skills/lint/cli/src/index.ts          (← chamado pelo harness)
├── commands/lint/{setup,audit,update,…}.md
└── agents/lint-{detector,installer,auditor,migrator}.md
```

O repositório `qualy/` carrega esses arquivos numa árvore "fonte" diferente (`skills/`, `commands/`, `agents/`, `cli/` na raiz) — e precisa de um caminho explícito entre `git clone` e instalação utilizável.

A questão é: **como entregar essa cópia para o usuário, em v1, sem comprometer reprodutibilidade nem aumentar a superfície de manutenção?**

Restrições e sinais relevantes:

- SPEC §3 declara explicitamente: *"Distribuição. Por enquanto, instalação manual via cópia para `~/.claude/...`. Plugin publicável fica como evolução (ADR futura)."* — ou seja, plugin nativo está fora de escopo de v1 por decisão prévia do autor.
- O CLI roda direto do fonte (`cli/src/*.ts`) via `--experimental-strip-types` (ADR 0007). Não há `dist/`, não há etapa de build a ser empacotada — o que está em disco é o que executa. Isso favorece distribuição por cópia simples ou symlink, sem release artifacts.
- O autor precisa iterar no próprio `qualy/` enquanto usa a skill em outros projetos. Cópia plana força ciclo `editar → reinstalar`; symlink elimina o ciclo. Os dois modos são úteis em contextos diferentes.
- O harness do Claude Code usa hoje a árvore `~/.claude/{skills,commands,agents}/`. Não há um instalador padrão; cada skill resolve isso por conta própria.
- Operações de cópia/remoção em `$HOME/.claude` são intrinsecamente perigosas: um bug no instalador pode apagar trabalho do usuário. Qualquer mecanismo escolhido precisa ter guardas defensivas.
- O floor de Node 22.6 imposto por ADR 0007 precisa ser validado **antes** de qualquer cópia — não adianta instalar artefatos que não vão executar.

## Decisão

Adotar como mecanismo único de distribuição em v1: **um script Bash `install.sh` versionado no repositório**, executado pelo usuário após `git clone`, que valida pré-requisitos e copia (ou symlinka) os artefatos para `~/.claude/`.

Implicações concretas:

1. **Script único, em Bash, na raiz do repo.** `install.sh` é o ponto de entrada documentado no README. Sem instalador Node, sem `npm install -g`, sem `npx`. Bash está disponível em macOS/Linux/WSL — perfil alvo do Claude Code — e dispensa bootstrap.
2. **Dois modos: `copy` (default) e `--dev` (symlink).**
   - `copy` é o caminho seguro para usuários finais: snapshot do estado atual, edits no fonte não vazam para a instalação.
   - `--dev` (symlink) é para quem desenvolve em `qualy/`: edits em `cli/src/` ficam imediatamente visíveis ao Claude Code sem reinstalar. Acoplado ao zero-build-step do ADR 0007 — junto, formam o ciclo "editar `.ts` → executar".
3. **Validação de Node antes de qualquer escrita.** `require_node` aborta com exit 1 e mensagem acionável se `node --version` < 22.6 (ou se Node não existir no PATH). Coerente com ADR 0007 — instalar artefatos que não vão executar geraria erro confuso depois.
4. **Layout específico do CLI.** `cli/` é instalado em `<target>/skills/lint/cli/`, não em `<target>/cli/`. Isso satisfaz o pattern de resolução fixado em `PLAN §Resolução do CLI` (`<target>/skills/lint/cli/src/index.ts`, onde `<target>` é resolvido pelo probe `$PWD/.claude → $HOME/.claude` — ver ADR 0013) sem que o harness precise inventar paths.
5. **Idempotência explícita.** Re-rodar `install.sh` substitui artefatos no lugar (`rm -rf` do destino + cópia/symlink novo). Não há merge — cada `install.sh` produz o estado exato do fonte naquele momento. Em modo symlink, se o link já aponta para o source correto, é noop logado.
6. **Guarda defensiva contra remoção fora do alvo.** Função `assert_safe_target` recusa qualquer caminho que (i) seja vazio, (ii) seja `/`, `$HOME`, `$HOME/`, `$TARGET_ROOT`, `$TARGET_ROOT/`, ou (iii) não esteja sob `$TARGET_ROOT/`. Aplicada antes de todo `rm -rf`. É a barreira que torna seguro o uso de `rm -rf` em paths derivados.
7. **`--dry-run` obrigatório.** Modo que loga todas as operações (`copy x → y`, `symlink x -> y`) sem tocar o FS. Disponível desde a v1 — auditável antes de confiar.
8. **`--target <path>`.** Default `$HOME/.claude`, mas sobrescrevível. Necessário para testes (instalar num `mktemp -d`) e para usuários com layout customizado (e.g., scope `project` em `$PWD/.claude`, conforme probe do ADR 0013).
9. **Sem desinstalador no script.** `install.sh` não desinstala a si mesmo. A skill expõe `/lint:uninstall` para remover artefatos *que ela mesma criou no projeto-alvo* (via `.lint-manifest.json`); remover a instalação em `~/.claude/` é responsabilidade do usuário (`rm -rf ~/.claude/skills/lint ~/.claude/commands/lint ~/.claude/agents/lint-*`). Documentado no README.

## Consequências

**Positivas**

- Zero bootstrap: o usuário precisa só de Bash e Node ≥ 22.6 (que ele já precisa para usar o produto). Nenhum gerenciador de pacote intermediário.
- Auditável em uma sentada: `install.sh` é ~250 linhas de Bash sem dependências. O usuário pode lê-lo antes de executar — propriedade importante para um script que escreve em `$HOME/.claude`.
- Acoplado ao zero-build-step do ADR 0007: `--dev` (symlink) fecha o ciclo "editar `.ts` no `qualy/` → próxima invocação no Claude Code já vê o efeito". Sem isso, ADR 0007 perderia metade do valor.
- Idempotência grátis: como cada execução é "snapshot do fonte agora", não há estado parcial a reconciliar entre versões. Upgrade = `git pull && ./install.sh`.
- Guardas defensivas centralizadas em uma função (`assert_safe_target`) — invariante única, fácil de auditar em code review.
- Testável sem efeitos colaterais: `--dry-run` + `--target $(mktemp -d)` permite verificar instaladores em CI ou manualmente sem tocar `$HOME/.claude`.

**Negativas / tradeoffs**

- Distribuição manual (não-marketplace): o usuário precisa `git clone` + `./install.sh`. Não há descoberta via UI do Claude Code, não há atualização automática. Aceitável em v1 porque o público-alvo é técnico (autor + early users) e o produto ainda está calibrando contratos.
- Bash apenas: Windows nativo (sem WSL) fica fora. Mitigado pelo perfil alvo (devs usando Claude Code já costumam ter macOS/Linux/WSL); revisitável quando houver demanda real.
- Sem versionamento de instalação: o script não registra "qual versão do qualy está em `~/.claude/skills/lint`". Se o usuário instalou de duas árvores diferentes, não há reconciliação. Mitigado pela idempotência (sempre vence o último `install.sh`) e pela ausência de estado migrável entre versões em v1.
- Manutenção dupla quando o layout mudar: adicionar uma nova categoria (ex.: `themes/`) exige atualizar `install.sh` *e* o harness *e* a documentação. Custo aceito enquanto o número de categorias for pequeno (4 hoje).
- A guarda `assert_safe_target` depende de `$TARGET_ROOT` estar bem definido. Bug que zerasse `TARGET_ROOT` antes do check escaparia (o caminho viraria `/<sub>` e seria barrado pelo case `/`, mas a invariante depende de leitura cuidadosa). Mitigado por testes manuais documentados no PLAN §Fase 0 e pelo `--dry-run` como reflex padrão antes de instalar.

## Alternativas consideradas

- **Plugin Claude Code nativo (publicado em marketplace).** Rejeitada para v1: o formato/política de plugins ainda está em evolução, e empacotar agora congelaria decisões (estrutura de manifest, mecanismo de update, telemetria opt-in) que ainda dependem de aprendizado com early users. Reaberto em v2 quando os contratos do CLI estiverem estáveis (SPEC §8 já lista como evolução). Quando vier, `install.sh` continua útil para o modo `--dev` do mantenedor.
- **`npm install -g qualy` / pacote npm publicado.** Rejeitada: adicionaria uma fronteira de release (publish + bump + lockfile) sem ganho funcional sobre `git clone + ./install.sh`. Pior: misturar "pacote npm" com "skill do Claude Code" confunde mental model do usuário (que objeto é esse afinal?). O CLI não é consumido como lib — ninguém vai `import` dele.
- **Instruções manuais de cópia no README (sem script).** Rejeitada: cópia manual é frágil — usuário esquece um diretório, copia para o lugar errado, não valida Node, não tem `--dev`. Quando há 4 categorias com pattern de destino diferente (`skills/` por subdir, `commands/` por subdir, `agents/` por arquivo, `cli/` aninhado em `skills/lint/`), a chance de erro humano sobe rápido.
- **Instalador em Node (`node install.mjs`).** Rejeitada: requer que o usuário já tenha resolvido `cd qualy && npm install` antes de instalar — bootstrap circular. Bash não tem essa dependência. Além disso, um instalador escrito em TS exigiria `--experimental-strip-types` para rodar, criando referência circular ao próprio requisito que o instalador deveria validar.
- **Make / Justfile.** Rejeitada: `make` adiciona dependência implícita (nem todo macOS recente vem com `make` por padrão sem Xcode tools), e `just` exige instalação prévia. Bash é o mínimo denominador comum.
- **Suporte a Windows nativo via `install.ps1` espelho.** Rejeitada para v1: dobra a manutenção (duas implementações da mesma lógica defensiva) sem demanda concreta. Reaberto se aparecer usuário Windows-sem-WSL.

## Verificação

- `./install.sh --help` documenta modos e flags (`--dev`, `--target`, `--dry-run`).
- `./install.sh` em ambiente com Node < 22.6 → exit 1 com mensagem clara apontando o requisito e o ADR 0007 (verificado manualmente em Node 22.5).
- `./install.sh` em Node ≥ 22.6 cria `~/.claude/{skills/lint,commands/lint,agents/lint-*,skills/lint/cli}` (ou os "skip" lines correspondentes enquanto categorias estão vazias durante o bootstrap).
- Re-execução produz o mesmo estado em disco (idempotência manual: comparar `find ~/.claude -newer /tmp/marker` antes/depois deve diferir só nos timestamps, não em conteúdo).
- `./install.sh --dev --target $(mktemp -d)` cria symlinks que apontam de volta para `$SOURCE_ROOT` — verificável com `readlink`.
- `./install.sh --dry-run` não toca o FS (verificável: `find $TARGET -newer ...` vazio após execução).
- `assert_safe_target` recusa caminhos protegidos: testes manuais com `TARGET_ROOT=/tmp/x install_path foo /` e variantes (`$HOME`, vazio, fora de `$TARGET_ROOT`) — todos abortam com exit 1.
- E2E final (PLAN §Fase 7): após `./install.sh`, abrir Claude Code num projeto TS real e invocar `/lint:setup` resolve `cli/src/index.ts` pelo pattern do `SKILL.md` sem ajuste manual.
