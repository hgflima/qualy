# ADR 0008 — Recommendations híbridas (CLI determinístico + `rationale` enriquecido pelo subagent)

- Status: aceito
- Data: 2026-05-03
- Relacionados: ADR 0006 (CLI determinístico com harness fino), ADR 0007 (runtime TS via `--experimental-strip-types`), `docs/recs-heuristics.md` (tabela de heurísticas), SPEC §3 (contrato de audit), SPEC §7.5–7.6 (acceptance criteria), PLAN §Princípios item 3, `cli/src/lib/audit-schema.ts` (zod)

## Contexto

O SPEC §3 fixa que cada entrada de `recommendations[]` no `.lint-audit/<ts>.json` carrega oito campos:

```jsonc
{ "id", "type", "title", "rationale", "blast_radius", "patch", "severity", "applies_to" }
```

Sete desses campos são puramente estruturais ou numéricos — derivam de regras determinísticas sobre o restante do payload (`stage`, `tooling`, `violations.by_metric`, `rules_active`). O oitavo, `rationale`, é diferente: o SPEC §7.6 + acceptance §6 (ver `commands/lint/update.md`) exige que `/lint:update` mostre **prosa legível ao humano** ("Distribuição empírica permite threshold mais rígido sem inflar warnings.") — não o template determinístico ("max_seen=12 < 0.7 × max=20 (greenfield); apertar para round(max_seen × 1.2)=14.").

ADR 0006 estabeleceu como invariante "o harness não escreve FS, o CLI nunca pergunta, toda lógica imperativa é determinística e testável". Isso entra em tensão com `rationale`:

- Um `rationale` puramente determinístico (template parametrizado) é **medível** mas **opaco**: cita números, mas não explica *por que* a métrica ficou alta naquele projeto, nem traduz para a linguagem do código que o usuário está vendo. SPEC §7.6 acceptance ficaria automaticamente verde, mas o usuário lê "max_seen=38 > 1.5×max=20" e fecha a sessão.
- Um `rationale` 100% gerado por modelo é **legível** mas **não-determinístico**: mesmo audit pode gerar prosa diferente em runs sucessivas, o que invalida testes de regressão (`recs[i] === recs[i]` byte-a-byte) e abre janela para drift entre o que o CLI calculou e o que o subagent escreveu (ex: o número 14 no template vira 12 na prosa por alucinação).

Os outros campos não têm essa tensão. `id`, `type`, `severity`, `blast_radius`, `patch`, `applies_to`, `title` são todos derivados por heurística (ver `docs/recs-heuristics.md` §6) e cabem em código sem perda de utilidade — `title` em particular é uma frase curta com placeholders preenchidos por interpolação, não exige contexto além do payload.

A questão é portanto: **como produzir `rationale` legível preservando a invariante "cálculo determinístico no CLI" do ADR 0006?**

## Decisão

Adotar um pipeline em **duas etapas com fronteira explícita** entre código e modelo:

1. **`recs-generate` (CLI determinístico)** consome `.lint-audit/<ts>.json` validado pelo `auditPayloadSchema` e emite `candidates[]` — todos os 8 campos exceto `rationale`, mais um nono campo `rationale_stub` calculado por template (ver `docs/recs-heuristics.md` §5). `candidates` NÃO é persistido em `.lint-audit/<ts>.json`; é stdout efêmero do subcomando, lido pelo subagent. O contrato é puro: mesmo audit → mesmos candidatos byte-a-byte (testado em `cli/tests/unit/recs-generate.test.ts`).

2. **`lint-auditor` (subagent autorizado)** recebe os `candidates` via Bash subprocess, lê o código-fonte das `evidence.top[]` referenciadas (ts-morph/Read), reescreve cada `rationale_stub` em prosa humana, monta `recommendations[]` com os 8 campos do SPEC §3 (drop do `rationale_stub`, mantém todo o resto byte-a-byte), e persiste `recommendations[]` no mesmo arquivo `.lint-audit/<ts>.json` que o `audit` deixou.

3. **`recs-apply` (CLI determinístico)** lê `audit.recommendations[]` (não `candidates`) — esse é o contrato ponto-a-ponto entre o subagent e o resto do CLI. Documentado em `cli/src/commands/recs/apply.ts` linha 9: "Per ADR 0008 the canonical input is `audit.recommendations[]`."

**Exceção autorizada (única).** ADR 0006 §"Decisão" item 2 diz que "subagents são wrappers finos que invocam o CLI e devolvem sumário". `lint-auditor` é a **única** exceção: além de chamar o CLI, ele escreve prosa em um campo (`rationale`) e persiste o resultado de volta no `.lint-audit/<ts>.json`. Toda a parte numérica permanece no CLI; só a redação do `rationale` é responsabilidade do modelo.

**Invariantes que protegem a fronteira.**

- (i) `rationale_stub` é calculado e testado no CLI com bytes literais — drift na heurística quebra `recs-generate.test.ts` antes de chegar no subagent.
- (ii) O subagent só pode editar o campo `rationale`. Os outros 8 campos (`id`, `type`, `title`, `evidence`, `suggested_change`/`patch`, `blast_radius`, `severity`, `applies_to`) precisam permanecer byte-iguais entre `candidates[i]` e `recommendations[i]`. SPEC §7.6 acceptance e2e adiciona uma asserção dupla: `recommendations[i].rationale ≠ candidates[i].rationale_stub` (prosa enriquecida) E `pick(recommendations[i], 8 fields) === pick(candidates[i], 8 fields)` (numéricos preservados) — ver PLAN §Fase 4 line 245.
- (iii) `id` é derivado de `type + slug` em `recs-generate` (regras em `docs/recs-heuristics.md` §4) e nunca recalculado pelo subagent. Estabilidade de ID entre runs sucessivas é o que permite `recs-apply --rec-id <id>` funcionar offline depois que o usuário fechou a sessão de `/lint:update`.
- (iv) `lint-auditor` pode pular candidatos cuja prosa não consegue redigir com confiança (sem `evidence.top[]` ou sem acesso ao arquivo) — nesse caso ele copia `rationale_stub` literal para `rationale`. SPEC §7.6 acceptance contempla esse fallback medindo "no mínimo 1 recommendation com rationale ≠ rationale_stub", não "todas".

## Consequências

**Positivas**

- O contrato `audit → /lint:update` permanece intacto: `recs-apply` lê de uma fonte canônica (`recommendations[]`) e ignora a existência de `candidates` — o resto do CLI não precisa saber que existe um subagent intermediário.
- `recs-generate.test.ts` testa a parte mensurável (IDs, severidades, gatilhos numéricos, `rationale_stub` literal) sem precisar invocar o modelo. A suite é determinística e cobre 8 heurísticas × 4 critérios cada (positivo / negativo / fronteira user-override / idempotência byte-exact) — drift quebra a backpressure antes do harness.
- O subagent ganha um job pequeno e bem definido: receber `candidates`, decidir se pode reescrever cada `rationale_stub` (sim → prosa; não → copiar stub literal), persistir. Não toma decisões numéricas; não inventa recomendações fora da lista. Reduz superfície de prompt e reduz o risco de alucinação significativa.
- Reproducibilidade preservada onde importa: `recs-apply` aplica o mesmo `patch` independentemente da prosa que ficou em `rationale`. Se o usuário re-roda `/lint:update` em uma máquina diferente, os comandos aplicados são exatamente os mesmos.
- Distribuição offline permanece viável: depois que `lint-auditor` rodou uma vez e persistiu `recommendations[]`, o `/lint:update` não precisa do modelo de novo — `recs-apply` funciona sem rede.
- A acceptance §7.6 ("rationale legível, não stub") fica testável via grep-style: `expect(rec.rationale).not.toBe(stub)` é uma asserção que o modelo não consegue burlar sem violar a fronteira.

**Negativas / tradeoffs**

- **Não-determinismo isolado**: dois runs de `/lint:audit` seguido de `lint-auditor` no mesmo projeto podem produzir `recommendations[i].rationale` diferentes em prosa. Mitigado por (i) os outros 8 campos comparáveis byte-a-byte, (ii) `recs-apply` ignorar `rationale`, (iii) testes que comparam *estrutura* não *prosa*.
- **Custo de invocação do modelo**: `lint-auditor` é invocado uma vez por `/lint:audit` (pelo `commands/lint/audit.md`, próxima task). Em `legacy-monorepo` (10k+ LOC) com ~30 candidatos, isso é dezenas de chamadas de Read na pior das hipóteses. Mitigado por (i) cap em 5 entries por `evidence.top[]` (ver `recs-heuristics.md` §3), (ii) fallback "copiar stub literal" quando sem confiança, (iii) acceptance §7 line 478 trava budget de <30s no `legacy-monorepo`.
- **Janela de inconsistência transitória**: entre o subprocess de `recs-generate` retornar e o `lint-auditor` persistir `recommendations[]`, o `.lint-audit/<ts>.json` carrega `recommendations: []` (audit emite vazio por default). Se o subagent crashar no meio, o arquivo fica sem recommendations e `recs-apply --rec-id <id>` retorna `recommendation_not_found`. Mitigado por (i) `lint-auditor` ser idempotente (re-run reescreve `recommendations[]` por completo, não merge), (ii) `commands/lint/audit.md` chama o subagent de forma blocking — não retorna controle ao usuário até o write final.
- **Surface de teste maior**: a acceptance §7.6 precisa de teste e2e com ambiente que invoque o modelo (vs. o resto do CLI que testa via puro vitest). PLAN §Fase 4 line 245 reconhece isso explicitamente.

## Alternativas consideradas

- **`rationale` 100% no CLI (template determinístico).** Rejeitada: o template precisa cobrir 8 tipos × estágios × variações de evidência sem soar mecânico — viraria switch case gigante e ainda assim leria como "max_seen=38 > 1.5×max=20", que SPEC §7.6 acceptance proíbe explicitamente ("rationale legível, não stub"). O `rationale_stub` da `docs/recs-heuristics.md` §5 já é essa versão; o ponto da ADR é aceitar que o stub não é suficiente sem perder a parte numérica determinística.
- **`rationale` 100% no subagent (sem `rationale_stub`).** Rejeitada: o subagent teria que recalcular o gatilho ("é raise ou lower? proposed=14 ou 12?") a partir do payload bruto. Janela de drift onde a prosa diz 14 mas o `patch` aplica 12 (alucinação) — silently incorrect, exatamente o que ADR 0006 quer evitar. Manter `rationale_stub` no candidate dá ao subagent uma âncora numérica para parafrasear, e ao teste e2e uma asserção dupla (drift do número quebra o teste).
- **Persistir `candidates[]` separados de `recommendations[]` no mesmo arquivo.** Rejeitada: duplica fonte da verdade. `recs-apply` teria que escolher entre os dois e o contrato vira ambíguo. Manter `candidates` como output efêmero de `recs-generate` (apenas stdout, nunca persistido) e `recommendations[]` como única fonte canônica em `.lint-audit/<ts>.json` mantém o invariant "uma operação, uma fonte da verdade".
- **Dois subcomandos: `recs-generate-stubs` + `recs-enrich-rationale` (ambos no CLI).** Rejeitada: o segundo precisaria carregar lógica de NLP/templating sofisticada. Acabaria sendo um modelo embutido — perdendo o ponto de ter um modelo full-featured já à mão (Claude). Pior trade-off em todas as dimensões.
- **Hardcode `rationale` no preset.** Rejeitada: prosa não pode depender só do estágio; depende dos arquivos do projeto-alvo (qual classe, qual métrica, qual valor). Ficaria genérico ("Considere refatorar essa classe.") — viola SPEC §6 Always "justificar com sinais brutos".
- **Subagent escreve `rationale` E recalcula `proposed_value`.** Rejeitada: viola ADR 0006 — recoloca decisão numérica no modelo. Mantida a invariante de que `proposed_value` é determinístico (ver `docs/recs-heuristics.md` §6.1–6.2 para fórmulas) e o subagent não pode tocar nele.

## Verificação

- **Unit (CLI):** `cli/tests/unit/recs-generate.test.ts` (37 testes) trava `rationale_stub` literal por heurística — drift na regra de geração quebra antes de chegar no subagent. Sem invocação de modelo.
- **Schema:** `cli/src/lib/audit-schema.ts` exporta `recTypeSchema`, `recSeveritySchema`, `recommendationSchema` e `auditPayloadSchema` com `recommendations: z.array(recommendationSchema)`. `validateAuditPayload` rejeita `recommendations[i]` sem `rationale` ou com tipo desconhecido. `recs-apply` chama o validator antes de qualquer write — drift no shape do que o subagent persistiu surface como `schema_validation_failed` exit 1, não como aplicação silenciosa de patch errado.
- **Contrato `audit → update`:** `recs-apply` lê de `audit.recommendations[]`. Documentado em `cli/src/commands/recs/apply.ts` linha 9 + testado em `cli/tests/unit/recs-apply.test.ts` (43 testes) que sempre constroem `recommendations[]` (não `candidates`).
- **E2E (PLAN §Fase 4 line 245):** acceptance §7.5 (audit produz JSON válido; exit ≠0 quando há `error`-level violations) + §7.6 (rationale ≠ rationale_stub em pelo menos uma recommendation enriquecida) — implementado como teste e2e que (i) roda `/lint:audit` em um fixture configurado, (ii) invoca `lint-auditor` (subagent), (iii) reabre `.lint-audit/<ts>.json` e assere que `recommendations[i].rationale !== candidates[i].rationale_stub` para ao menos um índice + que os outros 8 campos batem byte-a-byte entre os dois arrays. Esse teste é a prova viva da fronteira.
- **Performance:** SPEC §7 line 478 trava `lint-auditor` em <30s no `legacy-monorepo` (10k+ LOC). Cap de 5 entries por `evidence.top[]` (`docs/recs-heuristics.md` §3) limita o número de leituras de arquivo por candidato.
