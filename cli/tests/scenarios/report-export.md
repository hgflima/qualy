# Cenário T2 — `/lint:report` com export self-contained

> Roteiro humano-legível para execução manual / semi-automatizada (SPEC §5 Tier T2). Cobre SPEC §7.7 (server efêmero + snapshot offline).
> Pré-requisito: `.lint-audit/<latest>.json` existente (após `/lint:audit`).

## Pré-condições

- `node --version` ≥ 22.6.
- `.lint-audit/` populado com pelo menos 1 audit válido (validado contra `auditPayloadSchema`).
- Browser instalado (`open` em macOS, `xdg-open` em Linux). Caso ausente, harness imprime URL para o usuário abrir manualmente.
- `esbuild` disponível em `node_modules/` (vendor para bundling do `app.ts` — ADR 0007 carve-out).

## Comando do usuário

```
/lint:report
```

## Sequência esperada

### 1. Pré-checks (read-only)

- `audit-latest` → exit `0` retorna `{ ok:true, path, timestamp, payload }`. Exit `1` (`audit_missing`/`read_failed`/`parse_failed`/`schema_validation_failed`) ⇒ harness mostra `error`/`reason` e roteia para `/lint:audit` via `SlashCommand` (sem audit, não há report).
- `git-clean-check` → informativo (snapshot opcional grava em `quality-report/<ts>.html`, não muta nada já versionado; SPEC §6 line 63 — não bloqueie).

### 2. Subir o servidor efêmero

```bash
node --experimental-strip-types "$QUALY_CLI" report-serve --cwd "$PWD" &
SERVE_PID=$!
```

Primeira linha de stdout: `{ ok:true, host:"127.0.0.1", port:<porta-livre>, url, pid, audit_path }`.

- `host` é literal `"127.0.0.1"` (lock em `cli/src/report/server.ts:60` — SPEC §6 Never line 421, nunca expõe além do loopback).
- `port` é alocada dinamicamente (default `--port 0` ⇒ kernel escolhe).
- `pid` é o do processo Node do server.

### 3. Abrir browser

`open "$URL"` (macOS) / `xdg-open "$URL"` (Linux). Se nenhum disponível, imprime o URL ao usuário para copiar/colar.

### 4. Mostrar contexto ao usuário

```
host: 127.0.0.1 (loopback only — SPEC §6 Never line 421)
port: 53827
url:  http://127.0.0.1:53827/
audit_path: .lint-audit/2026-05-04T17-22-08-000Z.json

O servidor permanece ativo até receber SIGINT.
```

### 5. Verificação visual no browser (manual)

| Componente             | Esperado                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| MetricCard (4 cards)   | errors, warnings, files_affected, max_seen_volume — ordem fixa (lock em `app.ts:buildMetricCards`) |
| ChartTreemap            | violações por arquivo, área proporcional ao count                                           |
| ChartLine (history)     | tendência por timestamp (audits prévios em `.lint-audit/`)                                  |
| ViolationsTable         | top-N violações por métrica                                                                 |
| Theme toggle (light/dark) | persistido via `localStorage` (espelhado entre `app.ts:resolveInitialTheme` e IIFE no head) |
| `prefers-reduced-motion` | tokens de motion colapsam para 0ms automaticamente (SPEC §4 a11y)                           |
| Skip-link               | focável via Tab, navega para `#main`                                                         |
| `aria-live` regions     | atualizam ao alternar tema                                                                   |

### 6. Encerrar serve antes da pergunta

```bash
kill -INT "$SERVE_PID" && wait "$SERVE_PID" 2>/dev/null
```

SPEC §6 Never line 421 + line 419: server precisa estar parado **antes** de `AskUserQuestion`. Estado ambíguo se o usuário cancelar enquanto o serve segue rodando.

### 7. Pergunta — Exportar? (`AskUserQuestion`, 2 opções)

```
Exportar snapshot self-contained (Recommended)
Pular
```

SPEC §6 Ask first line 405: pergunta sempre ocorre; default visual reduz fricção mas resposta é mandatória.

### 8. Export (somente se aceito)

```bash
node --experimental-strip-types "$QUALY_CLI" report-export --cwd "$PWD"
```

Stdout: `{ ok:true, path, bytes, redacted:true }`.

- `path` ⇒ `quality-report/<safe-ts>.html`.
- `redacted:true` por default (SPEC §6 Never line 422). Harness **NÃO** passa `--no-redact` salvo pedido explícito do usuário em contexto local de confiança.

#### O que a redaction filtra

| Categoria             | Substituição               | Detecção                                                       |
| --------------------- | -------------------------- | -------------------------------------------------------------- |
| `cwd` absoluto        | `<redacted>`               | comparação com `payload.cwd` exato                              |
| Paths absolutos       | `<redacted-path>`          | regex de `/.../`-shape com floor de 2 segmentos POSIX (evita URLs) |
| `process.env.NAME`    | `<redacted-env>`           | refs textuais a `process.env.*`                                 |
| Tokens                | `<redacted-token>`         | shapes `sk-`, `ghp_`, `xox[a-z]-`                               |

#### Defesas adicionais

- `escapeJsonForHtml` defende contra script-injection (escape `</script` + U+2028/U+2029) — ADR 0005.
- Headers do server ativo: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

### 9. Pós-condição

```
path: quality-report/2026-05-04T17-30-12-000Z.html (348 KB)
bytes: 356_092
redacted: true

Sugestão: git add quality-report/2026-05-04T17-30-12-000Z.html (sem auto-commit).
```

- `quality-report/<ts>.html` abre offline (sem servidor) e renderiza idêntico ao server (paridade visual SPEC §7.7 byte-a-byte modulo redaction + transporte CSS/JS inline vs externo).
- `quality-report/` versionável pelo usuário (artefato de revisão); `.lint-audit/` gitignored por default (estado interno).
- Snapshot **NÃO** entra em `.lint-manifest.json` (artefato do usuário, `/lint:uninstall` preserva).

## Caminhos negativos

| Cenário                                                | Comportamento esperado                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `.lint-audit/` ausente                                | Exit `1` (`audit_missing`) em `audit-latest`; harness oferece `/lint:audit`            |
| Audit corrompido (schema fail)                        | Exit `1` (`schema_validation_failed`); harness sugere re-rodar `/lint:audit`           |
| `EADDRINUSE` (porta tomada)                           | `report-serve` exit `1` (`start_failed`); tente novamente — kernel realoca em `--port 0` |
| Browser não disponível                                 | Harness imprime URL; usuário abre manualmente                                         |
| Usuário responde "Pular"                               | Sem `report-export`; sumário final mostra apenas `audit_path`                          |

## Verificação manual

- [ ] `host` é literal `"127.0.0.1"` (sem `0.0.0.0`, sem flag `--host`).
- [ ] Server encerra antes da `AskUserQuestion` de export (ordem fixa: serve → SIGINT → wait → ask → export).
- [ ] Snapshot abre offline (file://) e renderiza visualmente idêntico ao server.
- [ ] Snapshot inline: sem `<link rel="stylesheet">`, sem `<script src>` externos; `<style>...</style>` + `<script>...</script>` + `<script id="report-data">...</script>` em-document.
- [ ] Redaction substitui `cwd` do autor + paths absolutos no JSON inline. Strings `<redacted>` / `<redacted-path>` visíveis ao inspecionar source do snapshot.
- [ ] Theme toggle persiste entre reloads do snapshot (localStorage).
- [ ] `prefers-reduced-motion` colapsa transitions/animations.

## E2E automatizado (referência)

`cli/tests/e2e/report-export-self-contained.test.ts` cobre:
- bundle compartilhado entre `server.ts` e `export.ts` (paridade byte-a-byte do JS);
- ausência de `<link>`/`<script src>` externos no output;
- `<script id="report-data">` inline com `redacted:true`;
- redaction de `cwd`, paths absolutos, env refs, tokens.

`cli/tests/unit/report-server.test.ts` lock literal de `SERVER_HOST` + headers de segurança + whitelist de rotas.

Este roteiro T2 valida o caminho conversacional + visual (browser real, theme toggle, a11y) que os testes automatizados não cobrem.

## Referências

- SPEC §2 (`/lint:report`), §4 (a11y + tema), §6 (Ask first export, Never expose, Never embed sensitive data), §7.7 (acceptance).
- PLAN §Fase 6.
- `commands/lint/report.md`.
- `cli/src/report/{server,export,app,data-loader}.ts`.
- `docs/report-design.md` (princípios + theming), `docs/audit-format.md` (payload consumido).
- ADR 0005 (server efêmero com export self-contained), ADR 0006 (CLI determinístico), ADR 0007 (carve-out `esbuild`).
