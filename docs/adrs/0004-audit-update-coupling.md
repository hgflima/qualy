# ADR 0004 — Acoplamento `/lint:audit` ↔ `/lint:update` por arquivo persistente

- Status: aceito
- Data: 2026-05-04
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0008 (rationale híbrida — `recommendations[]` é a fronteira CLI↔subagent), `cli/src/commands/audit.ts`, `cli/src/commands/audit-latest.ts`, `cli/src/commands/recs/apply.ts`, `commands/lint/audit.md`, `commands/lint/update.md`, SPEC §2 (comandos), SPEC §3 (contrato `.lint-audit/<ts>.json`), SPEC §6 (`/lint:audit` e `/lint:update` são acoplados por contrato — line 66), SPEC §7.5–7.6 (acceptance), `docs/audit-format.md`

## Contexto

O SPEC §2 declara dois comandos distintos com responsabilidades complementares:

> `/lint:audit` — Análise estratégica (...) **persiste resultado em `.lint-audit/<timestamp>.json`** para `/lint:update` consumir. Não modifica configs.
>
> `/lint:update` — Lê o audit mais recente em `.lint-audit/` e aplica as recomendações **uma por vez** com `AskUserQuestion`.

E o SPEC §6 line 66 fixa a regra do acoplamento:

> `/lint:audit` e `/lint:update` são acoplados por contrato: audit grava JSON estruturado, update consome. Se update rodar sem audit prévio (≤ 24h), oferece rodar audit antes.

A pergunta que o ADR responde: **qual a fronteira certa entre audit e update?**

Há um espectro plausível, e cada ponto tem implicações dramaticamente diferentes para reprodutibilidade, custo de modelo, contexto do harness e UX:

- **Tight coupling em memória**: `/lint:update` invoca o pipeline de audit internamente, recebe o payload via stdout, itera as recomendações na mesma sessão. Sem persistência. Sem `audit-latest`. Sem 24h gate.
- **Loose coupling via arquivo persistente** (a decisão): `/lint:audit` grava `.lint-audit/<ts>.json`; `/lint:update` lê o mais recente (o `lint-auditor` da ADR 0008 enriqueceu `recommendations[]` no meio do caminho); 24h gate é uma `AskUserQuestion` defensiva, não um erro.
- **Acoplamento por banco de dados** (SQLite local): consultas estruturadas, índices por timestamp, joins entre audits sucessivos.
- **Single command** (`/lint:update` faz tudo): elimina o gap entre audit e apply, mas perde o "audit é read-only — nunca modifica".

Sinais de fundo que pesam na escolha:

- O audit é **caro**: subprocess oxlint full (fast + deep), parse de toda a stdout do oxlint, chamada do `lint-auditor` (subagent que lê arquivos via ts-morph para enriquecer `rationale`). O legacy-monorepo orça <30s no SPEC §7 line 478. O update, em contraste, é **leve**: ler 1 arquivo JSON, iterar `recommendations[]` com `AskUserQuestion`, aplicar patches via `recs-apply` (edits cirúrgicos em presets ou config de coverage).
- ADR 0006 fixa que toda lógica imperativa fica em CLI determinístico, e ADR 0008 abre uma exceção única autorizada: o `lint-auditor` reescreve `rationale` em prosa. Esse pipeline em duas etapas (`recs-generate` stubs → `lint-auditor` enriquece → persiste) já depende de ter um lugar para gravar `recommendations[]` que não seja a memória do harness.
- SPEC §6 Always line 388–390 e Never line 416, 419, 420, 423, 424 colocam várias travas que pressupõem persistência: blast-radius mostrado antes de aplicar (precisa do número calculado em algum lugar estável), `docs/lint-decisions.md` append-only (precisa do `id` de uma recommendation que sobreviva entre sessões), uma rec por vez (`--rec-id` precisa funcionar entre invocações).
- O audit produz um **artefato auditável**: o usuário fechou a sessão de `/lint:update` no meio? Volta amanhã, roda `recs-apply --rec-id rec-007` direto. O audit é a memória do que foi decidido medir.
- A janela de 24h não é um número derivado — é uma escolha calibrada: tempo suficiente para uma sessão de trabalho real (manhã + tarde), curto o suficiente para que mudanças no código (commits, refactors) não invalidem silenciosamente os números do audit.

A questão é portanto: **como conectar audit e update preservando reprodutibilidade, offline-first, separação de read-only vs. write, e a regra de "uma rec por vez com confirmação"?**

## Decisão

Audit e update são acoplados **exclusivamente por arquivo persistente versionado** (`.lint-audit/<safe-timestamp>.json`), validado via schema zod (`auditPayloadSchema`) na leitura. Não há estado em memória compartilhado entre os dois comandos. A bridge é o subcomando `audit-latest` que aplica seleção lexical descendente sobre `readdirSync`.

Implicações concretas, lockadas em código + testes:

1. **Audit persiste; update apenas lê.** `cli/src/commands/audit.ts` é o único componente do CLI que escreve em `.lint-audit/`. `cli/src/commands/audit-latest.ts` faz `readdirSync(.lint-audit/)`, escolhe o filename lexicalmente maior, valida via `validateAuditPayload`, retorna `{ ok, cwd, path, timestamp, audit }`. Update nunca instancia `auditPayloadSchema` para escrever — só para validar. O lint-auditor (ADR 0008) é a única exceção que reabre o arquivo: reescreve `recommendations[]` por completo (não merge), ainda dentro da janela do `/lint:audit`.

2. **Schema validation na leitura é a fronteira de segurança.** `audit-latest` chama `parseDefensive` + `validateAuditPayload`. Drift entre o writer (`audit.ts`) e o reader (`update.md` via `audit-latest` → `recs-apply`) surface como `schema_validation_failed` exit `1` — não como `recs-apply` aplicando um patch malformado em silêncio. SPEC §6 Always "registrar add/remove de rules em docs/lint-decisions.md" depende disso: um `recommendation` sem `id` ou com `type` desconhecido NUNCA chega ao apply.

3. **Janela de 24h é `AskUserQuestion`, não erro.** O `commands/lint/update.md` passo 2 calcula `now - audit.generated_at`. Se > 24h, oferece duas opções via `AskUserQuestion`: `Rodar /lint:audit antes (Recommended)` / `Continuar com o audit existente`. Default = re-rodar. Não é um exit code não-zero — é fricção visível, não um bloqueio. O usuário em situação atípica (sem rede, ambiente isolado, debug) pode optar por continuar; a decisão fica registrada no log da sessão.

4. **Sem audit → exit `1` (`audit_missing`), oferta de rodar `/lint:audit`.** SPEC §6 line 66 "Se update rodar sem audit prévio (≤ 24h), oferece rodar audit antes". `audit-latest` retorna `{ ok: false, error: "audit_missing" }` quando o diretório não existe ou está vazio. `commands/lint/update.md` passo 1 mapeia esse exit `1` para `SlashCommand` invocando `/lint:audit`. Não é UX punitiva — é orientação clara.

5. **`recs-apply --rec-id <id>` é resumível entre sessões.** Como `audit.recommendations[]` está persistido (ADR 0008: enriquecido pelo subagent), o ID da rec é estável entre invocações. O usuário fechou o terminal no meio de `/lint:update`? Reabre, roda `node $QUALY_CLI recs-apply --rec-id rec-007 --reason "..."` direto. Sem audit em memória; sem necessidade de reabrir a sessão de update.

6. **Audit nunca é deletado automaticamente.** SPEC §6 Never line 424: "Nunca remover `.lint-audit/<timestamp>.json` automaticamente — usuário decide quando limpar (sugere git ignore opcional)". O `.gitignore` raiz (line 8) lista `.lint-audit/` por default — volátil por escolha (não polui o repo), mas trivialmente versionável se o usuário comentar a linha. Audits sucessivos acumulam, formando o trail histórico que `/lint:report` consome (`cli/src/report/data-loader.ts:97`).

7. **Audit é read-only por contrato; update é o write-side.** SPEC §6 convenções line 63: read-only commands (`/lint:audit`, `/lint:status`, `/lint:rules:list`, `/lint:rules:explain`, `/lint:report`) NÃO pedem confirmação antes de rodar. Comandos com escrita (`/lint:setup`, `/lint:update`, `/lint:rules:add|remove`, `/lint:rollback`, `/lint:uninstall`) imprimem plano + pedem confirmação. Essa simetria só funciona porque audit grava em `.lint-audit/` (área indexada, audit-trail) — não em `oxlint.fast.json` ou `package.json`.

8. **Acoplamento opera em uma direção: audit → update, nunca update → audit.** Update não pode mutar `audit.recommendations[]` para "marcar como aplicada". O log de aplicação fica em `docs/lint-decisions.md` (append-only via `recs-apply`) e no manifest (`cli/src/lib/fs-safe.ts:ManifestEntry` com `kind: "rec-apply"|"threshold-raise"|...`). Re-rodar `/lint:update` no mesmo audit é idempotente: `recs-apply` reaplica e o manifest evita duplicar. Para "saber o que ainda falta", o usuário roda `/lint:audit` novo (que reflete o estado pós-apply em `rules_active`/`tooling`/`violations`).

## Consequências

**Positivas**

- **Reprodutibilidade ponto-a-ponto**: o mesmo `.lint-audit/<ts>.json` produz exatamente o mesmo conjunto de patches em qualquer máquina. `recs-apply` é determinístico (ADR 0006); `audit-latest` é só leitura ordenada. Time team review pode pegar o arquivo, ler em outra máquina, e ver as mesmas recomendações.
- **Offline-first**: depois que o audit foi gravado (com `recommendations[]` enriquecido pelo `lint-auditor` da ADR 0008), `/lint:update` não precisa de rede nem do modelo. `recs-apply` lê arquivo, edita preset, escreve manifest. Funciona em túnel SSH, em CI, em VM isolada.
- **Resume cirúrgico**: `--rec-id <id>` permite aplicar uma rec específica fora de ordem, em sessão futura, em script automatizado. A estabilidade de IDs (regra `type + slug` em `docs/recs-heuristics.md` §4) protegida pela persistência do audit é o que torna isso viável.
- **Audit trail histórico**: cada `/lint:audit` deixa um arquivo. `/lint:report` consome todos (`cli/src/report/data-loader.ts:loadHistory`) para mostrar tendência por timestamp. Sem persistência, regressões só seriam visíveis via diff manual — perderíamos o `history[]` do `ReportData`.
- **Separação read-only / write reforçada**: audit nunca toca em config; update nunca recalcula violações. Mudar essa fronteira virou impossível sem deletar o arquivo intermediário — ou seja, virou explícito.
- **Crash safety**: se `/lint:update` crashar no meio do loop de recs (modelo timeout, usuário ctrl-C), o audit permanece. Próxima invocação retoma do mesmo conjunto de candidatos. Sem perda de trabalho computacional.
- **Schema-as-contract**: drift entre `audit.ts` (writer) e `recs-apply.ts` (reader) é detectado em runtime pelo `validateAuditPayload`. Adicionar campo novo no audit sem propagar para `auditPayloadSchema` quebra `audit-latest` antes de chegar em update — falha rápida e visível.
- **Janela de 24h dá conforto sem prender o usuário**: para 95% dos casos (sessão "rodei audit de manhã, agora à tarde aplico"), nem aparece a pergunta. Para os casos "audit de 3 dias atrás", o usuário ganha visibilidade da staleness sem ser bloqueado.

**Negativas / tradeoffs**

- **Audit pode ficar stale**: se o usuário commita refactors entre audit e update, os números (`violations.by_metric.*`, `blast_radius.files_currently_violating`) ficam desatualizados. Mitigado por (i) janela de 24h com `AskUserQuestion`, (ii) `recs-blast-radius` ser invocado opcionalmente em `commands/lint/update.md` passo 6 antes de cada apply (recalcula `files_newly_violating` em cima do FS atual, não confia no número do audit), (iii) `recs-apply` ler `rules_active` do audit mas validar contra preset atual antes de escrever (drift surface como `preset_missing`/`schema_validation_failed`).
- **Acumulação de audits**: cada `/lint:audit` adiciona um arquivo a `.lint-audit/`. Em projeto com uso intenso (audit semanal por 6 meses), são ~25 arquivos. Mitigado por (i) `.gitignore` default (não polui histórico git), (ii) tamanho típico de cada audit é <50KB, (iii) `/lint:report` consome todos como vantagem (history line chart), não como dívida. SPEC §6 Never line 424 protege contra deletar automaticamente — o trade é favorável a "nunca perde dado" vs "diretório fica grande".
- **Janela de 24h é arbitrária**: 24h não é derivado de fórmula, é cultural ("uma sessão de trabalho"). Para projeto de baixa cadência (commit/mês), 24h pode ser conservador demais; para projeto de alta cadência (commits a cada hora), pode ser permissivo. Mitigado por ser uma `AskUserQuestion` (não bloqueio) — o usuário avalia caso a caso. Aceitamos a calibração imperfeita porque a alternativa (configurável via flag) introduz superfície de UX sem ROI claro.
- **`audit.recommendations[]` em duas fases**: o `audit` puro escreve `recommendations: []` vazio (gerado por `recs-generate` é mantido apenas como `candidates[]` efêmero); o `lint-auditor` reabre o arquivo e persiste a versão enriquecida. Janela transitória onde `recs-apply` retornaria `recommendation_not_found` se o subagent crashar entre os dois passos. Mitigado por (i) `commands/lint/audit.md` chamar o subagent de forma blocking (não retorna controle até o write final), (ii) o subagent ser idempotente (re-run reescreve por completo), (iii) `lint-auditor` ter fallback "copiar `rationale_stub` literal" para nunca emitir array vazio. Reconhecido em ADR 0008 §Negativas item 3.
- **Acoplamento implícito por filename ordering**: `audit-latest` confia que `toSafeTimestamp` produz strings lexicalmente sortable. Se essa propriedade quebrar (mudança no formato), update consome o audit errado. Mitigado por testes unitários em `audit-latest.test.ts` + `audit.test.ts` que travam o formato do timestamp; mudança no formato exige update simultâneo dos dois lados.
- **Sem invalidação automática quando preset muda**: se o usuário rodou `/lint:rules:add` entre audit e update, o `rules_active` do audit reflete o estado anterior. `recs-apply` valida contra o preset atual antes de escrever — drift surface como erro recuperável, mas o usuário não é avisado proativamente. Mitigado pela janela de 24h (mudança de regras geralmente acompanha sessão de trabalho ativa).

## Alternativas consideradas

- **Tight coupling em memória (`/lint:update` invoca audit internamente).** Rejeitada: viola SPEC §2 que define os comandos como independentes; perde o audit-trail histórico (cada `/lint:report` precisaria re-rodar audit do zero); perde a capacidade de resume entre sessões; força o custo de audit (~30s no legacy-monorepo) em cada `/lint:update`, mesmo quando o usuário só quer aplicar 1 rec. Empacota dois comandos em um e arruina o "audit é read-only".
- **Single command que faz tudo (`/lint:audit-and-apply`).** Rejeitada: viola SPEC §6 line 420 ("Nunca aplicar uma recomendação de `/lint:update` em batch — uma por vez com confirmação") porque colapsa medir + decidir + aplicar em um único fluxo conversacional. Também viola a separação read-only / write da convenção §6 line 63. Pior: usuário não consegue rodar audit no PR review sem aplicar nada (caso comum de "deixa eu ver o estado" sem intenção de modificar).
- **Acoplamento via SQLite local.** Rejeitada: overkill. JSON único por audit é suficiente; queries estruturadas não são necessárias (o consumer só precisa do mais recente + history para charts); SQLite adiciona dep nativa que viola "Node 22.6+ direto, sem build step" (ADR 0007); diff/git review fica opaco (SQLite binary não é lido em PR review como JSON é).
- **Sem janela de staleness (audit eterno é válido).** Rejeitada: audit de semanas atrás aplica patches contra `rules_active` que pode não existir mais; `blast_radius.files_currently_violating` mente sobre o estado atual; usuário pode aplicar threshold "apertar para 14 baseado em distribuição" quando o código já mudou e a distribuição é outra. SPEC §6 line 66 explicitamente quer a oferta de re-rodar — não inventamos, executamos a regra.
- **Hard-fail quando audit > 24h (sem `AskUserQuestion`).** Rejeitada: viola SPEC §6 Always line 383 (uma pergunta por vez via `AskUserQuestion` para escolhas não-triviais). Audit stale é uma escolha não-trivial; bloquear sem pergunta empurra o usuário para edge case (precisa rodar audit em ambiente sem rede ou similar) sem escape hatch. Friction visible > friction punitiva.
- **Auto-cleanup de audits antigos (>30 dias).** Rejeitada: viola SPEC §6 Never line 424 explicitamente. Também invalida o history line chart de `/lint:report` (a régua temporal se trunca). O custo de "diretório com 25 arquivos pequenos" é zero comparado ao custo de "perdi o trend histórico do projeto".
- **Acoplamento por API HTTP local (audit serve, update consome).** Rejeitada: introduz processo daemon que precisa ficar de pé entre sessões; conflita com filosofia "CLI puro, stdout JSON, exit code semântico" (ADR 0006); duplica `/lint:report` (que já tem servidor efêmero — ADR 0005). Sem benefício sobre arquivo no FS.
- **Update fica idempotente reabrindo `recs-apply` em loop até `recommendation_not_found`.** Rejeitada parcial: a idempotência já existe via manifest (re-aplicar mesma rec é noop), mas confiar nela como mecanismo de "marca como aplicada" perde a separação SPEC §6 ("uma por vez com confirmação"). Manifest é fonte da verdade para "o que mudou no projeto"; audit é fonte da verdade para "o que foi medido". Não os mistura.

## Verificação

- **Unit (writer):** `cli/src/commands/audit.ts` escreve em `.lint-audit/<safe-timestamp>.json` via `safeWriteFile`; `audit.test.ts` lock o caminho relativo (`AUDIT_DIR = ".lint-audit"`) e o formato do timestamp.
- **Unit (reader):** `cli/src/commands/audit-latest.ts` faz seleção lexical descendente; `audit-latest.test.ts` cobre (i) diretório ausente → `audit_missing`, (ii) diretório vazio (sem `.json`) → `audit_missing`, (iii) arquivo malformado → `parse_failed`, (iv) schema drift → `schema_validation_failed`, (v) múltiplos arquivos → escolhe o lexicalmente maior, (vi) saída shape `{ ok, cwd, path, timestamp, audit }`.
- **Schema-as-contract:** `cli/src/lib/audit-schema.ts` exporta `auditPayloadSchema` com `version: z.literal("1")`, `generated_at: z.string().datetime()`, `recommendations: z.array(recommendationSchema)`. `validateAuditPayload` é chamado em `audit.ts` (antes de gravar — fail fast no writer) e em `audit-latest.ts` (na leitura — fail fast no reader). Testes em `audit-schema.test.ts` cobrem todos os campos e variantes de `Recommendation["type"]`.
- **Contrato `audit → update`:** `cli/src/commands/recs/apply.ts` linha 9 documenta "Per ADR 0008 the canonical input is `audit.recommendations[]`"; `recs-apply.test.ts` (43 testes) sempre constroem `recommendations[]` via `validateAuditPayload`, nunca leem `candidates`.
- **Janela de 24h:** `commands/lint/update.md` passo 2 calcula `now - audit.generated_at`; lock estático em `cli/tests/unit/command-lint-update-md.test.ts` que assere a presença da menção a "24h" + `AskUserQuestion` "Rodar /lint:audit antes (Recommended)".
- **Audit ausente → oferta de `/lint:audit`:** `commands/lint/update.md` passo 1 mapeia exit `1` (`audit_missing`) para `SlashCommand` invocando `/lint:audit`; lock estático em `cli/tests/unit/command-lint-update-md.test.ts`.
- **Resume entre sessões:** `cli/src/commands/recs/apply.ts` aceita `--rec-id` standalone (sem flag `--audit` explícito; default usa `audit-latest`). `recs-apply.test.ts` cobre o caminho "passou só `--rec-id`, encontrou via `audit-latest`".
- **`.gitignore` default:** `.gitignore` raiz line 8 lista `.lint-audit/`; lock em `cli/tests/unit/templates-gitignore.test.ts`.
- **E2E (PLAN §Fase 4):** `cli/tests/e2e/setup-greenfield.test.ts` ramo audit + update aplica 1 rec `lower-threshold`, fecha o "shell", reabre, roda `recs-apply --rec-id <id>` direto, assere idempotência (segundo run retorna `recommendation_not_found` ou patch noop). E2E de SPEC §6 acoplamento: `/lint:update` sem `.lint-audit/` exit `1` + roteamento para `/lint:audit`.
- **History trail consumido pelo report:** `cli/src/report/data-loader.ts:loadHistory` lê `readdirSync(.lint-audit/)`, valida cada via `auditPayloadSchema`, monta `history[]` ordenado por timestamp; `data-loader.test.ts` lock o contrato.
