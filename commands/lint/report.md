---
name: lint:report
description: Use when the user asks to visualize the latest lint/quality audit, says "/lint:report", "abrir report", "open report", "ver dashboard de qualidade", "exportar snapshot do report", or wants the local visual dashboard (cards, charts, top-N violações, coverage) rendered offline. Boots an ephemeral 127.0.0.1 server reading `.lint-audit/<latest>.json`, opens the browser, then asks via `AskUserQuestion` whether to export a self-contained HTML snapshot to `quality-report/<timestamp>.html` (SPEC §2 + §6 Ask first). Read-only — the only optional side effect is the snapshot file when the user opts in. Refuses if no audit exists (exit `1`, routes to `/lint:audit`).
allowed-tools: Bash, AskUserQuestion, SlashCommand, Read
argument-hint: (none)
---

# /lint:report

Visualização do audit mais recente (SPEC §2 + §7.7). Sobe um servidor efêmero em `127.0.0.1:<porta-livre>`, abre o browser, e ao final pergunta se o usuário quer exportar um HTML self-contained para `quality-report/<timestamp>.html`. **Read-only por default** — o único side effect opcional é o snapshot quando o usuário aceita.

## Visão Geral

1. **Pré-checks (read-only):** `audit-latest` (lê `.lint-audit/<latest>.json`) → `git-clean-check` informativo.
2. **Servir:** `report-serve --cwd "$PWD"` (long-running). Captura `{ url, port, pid }` da primeira linha de stdout; abre o URL no browser; mantém o processo até o usuário sinalizar fim.
3. **Encerrar serve:** envia `SIGINT` ao `pid` retornado e aguarda fechar (SPEC §6 Never – nunca expor além de localhost; servidor sempre encerra antes de qualquer outra ação).
4. **Pergunta — Exportar?** `AskUserQuestion` ofertando `Exportar snapshot self-contained (Recommended)` / `Pular`. Sem auto-export (SPEC §6 Ask first line 405).
5. **Exportar (opcional):** `report-export --cwd "$PWD"` grava `quality-report/<ts>.html` com redaction ligado por default (SPEC §6 Never line 422). Mostra `path` e `bytes`.

O preâmbulo `QUALY_CLI=…` está definido em `skills/lint/SKILL.md` (Resolução do CLI). Reuse-o em cada chamada Bash.

## Quando usar

- Logo após `/lint:audit`: visualizar `summary`, top violações por métrica, treemap por arquivo e line de tendência por timestamp (SPEC §7.7 acceptance).
- Antes de `/lint:update`: inspecionar `recommendations[]` graficamente para decidir prioridade.
- Snapshot versionável: ao fechar uma sprint, exportar `quality-report/<ts>.html` para revisão assíncrona (anexo de PR, dashboard interno, share offline).
- Manutenção de tema: validar light/dark e `prefers-reduced-motion` (SPEC §4 a11y).

## Quando NÃO usar

- Sem `.lint-audit/<ts>.json` (`audit-latest` retorna `audit_missing`, exit `1`): roteie para `/lint:audit` antes (não há o que renderizar).
- Audit corrompido (`schema_validation_failed`/`parse_failed` em `audit-latest`): aborte; sugira re-rodar `/lint:audit`.
- Necessidade de expor o dashboard a outra máquina: bloqueado por design (SPEC §6 Never line 421 – host travado em `127.0.0.1`). Use o export self-contained e compartilhe o `.html`.
- Aplicar mudanças (rules, thresholds): este comando é read-only. Use `/lint:update` ou `/lint:rules:add|remove`.

## Fluxo

Use o preâmbulo do SKILL.md em cada Bash:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" <subcommand> --cwd "$PWD" "$@"
```

1. **`audit-latest`** — exit `1` (`audit_missing`/`read_failed`/`parse_failed`/`schema_validation_failed`): mostre o `error`/`reason` e roteie para `/lint:audit` via `SlashCommand`. Sem audit, não há report.
2. **`git-clean-check`** — informativo. O snapshot opcional grava em `quality-report/<ts>.html` (não muta nada já versionado), então **não bloqueie em tree sujo**. Mostre o estado ao usuário e siga.
3. **`report-serve --cwd "$PWD"`** — long-running. Inicie em background (`&`) e leia a 1ª linha de stdout: `{ ok, host, port, url, pid, audit_path }`. Ex.:
   ```bash
   node --experimental-strip-types "$QUALY_CLI" report-serve --cwd "$PWD" &
   SERVE_PID=$!
   ```
   Capture `url` e `pid` do JSON. Se exit imediato (`audit_missing`, `EADDRINUSE`): mostre `error`/`reason` e roteie conforme (audit → `/lint:audit`; porta → tente `--port 0` que é o default).
4. **Abrir browser:** `open "$URL"` (macOS) / `xdg-open "$URL"` (Linux). Se nenhum disponível, imprima o URL para o usuário abrir manualmente.
5. **Mostrar contexto ao usuário:** `host`, `port`, `url`, `audit_path`. Lembre de `127.0.0.1` (loopback only) e de que o serve continua até receber `SIGINT`.
6. **Encerrar serve antes da pergunta:** `kill -INT "$SERVE_PID" && wait "$SERVE_PID" 2>/dev/null`. SPEC §6 Never line 421 + line 419 (uma pergunta por vez): server precisa estar parado antes de `AskUserQuestion`, senão o estado fica ambíguo se o usuário cancelar.
7. **Pergunta — Exportar?** `AskUserQuestion` com 2 opções: `Exportar snapshot self-contained (Recommended)` / `Pular`. SPEC §6 Ask first line 405: "perguntar no fim de `/lint:report`, não automático".
8. **`report-export --cwd "$PWD"`** (somente se aceito) — emite `{ ok, path, bytes, redacted }`. Redaction ligada por default (SPEC §6 Never line 422); **NÃO** passe `--no-redact` salvo pedido explícito do usuário e contexto local de confiança.
9. **Pós-condição:** mostre `path` (relativo) + `bytes` + `redacted: true`. Sugira `git add quality-report/<ts>.html` se o usuário quiser versionar (sem auto-commit — SPEC §6 Never line 416).

## Mapeamento de exit codes

- `0` — sucesso (serve encerrado limpo; export, se solicitado, gravou). Mostre o sumário.
- `1` — `audit_missing`/`read_failed`/`parse_failed`/`schema_validation_failed` (em `audit-latest`); `start_failed` (em `report-serve` — `EADDRINUSE`, `audit_missing`); ou export recoverable (`invalid_cwd`, `asset_read_failed`, `assembly_failed`, `write_failed`). Mostre `error`/`reason` e roteie (audit → `/lint:audit`; porta → tente novamente; export → reportar e pular).
- `2` — não esperado em report (audit já filtrou stack). Reporte e aborte.
- `3` — não aplicável (report é read-only; sem `--strict` aqui).
- `4` — usage error: bug no harness; reporte.
- `5` — não esperado (sem subprocess oxlint neste comando). Se aparecer, roteie para `/lint:setup`.
- `70` — internal: aborte mostrando o erro.

## Trade-offs

- **`127.0.0.1` apenas (SPEC §6 Never line 421)**: server NUNCA expõe além do loopback. Compartilhamento usa o snapshot HTML self-contained. Sem `0.0.0.0`, sem túnel, sem flag de "expose".
- **Export opt-in (SPEC §6 Ask first line 405)**: snapshot só grava após `AskUserQuestion`. O default no caminho feliz é não exportar — pergunta sempre ocorre, default visual é `Exportar (Recommended)` somente para reduzir fricção, mas resposta é mandatória.
- **Redaction on por default (SPEC §6 Never line 422)**: `report-export` filtra `cwd`, paths absolutos, `process.env.*` e shapes de token conhecidas. `--no-redact` é só para preview local; o orquestrador NÃO passa o flag.
- **Server encerra antes da pergunta**: ordem fixa (serve → kill → ask → export). Evita estado ambíguo se o usuário cancelar a pergunta.
- **Sem auto-commit (SPEC §6 Never line 416)**: o snapshot fica não-staged. Usuário decide se versiona; sugira o `git add` mas NÃO rode commit.

## Verificação

- Smoke: `node --experimental-strip-types "$QUALY_CLI" report-serve --help` lista as flags `--cwd`/`--port` e descreve o JSON de stdout.
- E2E (PLAN §Fase 6 + SPEC §7.7): `/lint:report` num fixture com audit prévio sobe o servidor em `127.0.0.1:<porta-livre>`, retorna URL navegável, e — quando o usuário aceita — grava `quality-report/<ts>.html` que abre offline e renderiza idêntico ao servidor.
- E2E (SPEC §6 acoplamento): `/lint:report` sem `.lint-audit/` retorna exit `1` (`audit_missing`) e oferece `/lint:audit` via `SlashCommand`.
- Redaction: snapshot exportado não contém o `cwd` absoluto do autor nem strings de `process.env.*` (gating em `report/export.ts`).

## Referências

- `.harn/docs/mvp/SPEC.md` §2 (`/lint:report`), §4 (a11y + tema), §6 (Ask first export, Never expose, Never embed sensitive data), §7.7 (acceptance).
- `.harn/docs/mvp/PLAN.md` §Fase 6 + §Resolução do CLI + §Contratos CLI (`report-serve`/`report-export`).
- `skills/lint/SKILL.md` — preâmbulo `QUALY_CLI` e mapeamento de exit codes.
- `commands/lint/audit.md` — produtor do JSON que este comando consome.
- `docs/adrs/0005-report-ephemeral-server-with-export.md` — server efêmero + export self-contained.
- `docs/adrs/0006-deterministic-cli-thin-harness.md` — divisão harness/CLI.
