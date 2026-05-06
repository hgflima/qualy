# Changelog

All notable changes to **qualy** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Status: **pre-1.0**. Until `1.0.0`, breaking changes may land on any minor
> version. Pin the install commit (`./install.sh` from a known SHA) if
> reproducibility matters across machines.

---

## [Unreleased]

---

## [0.3.0] — 2026-05-05

### Added

- **`lint-ignore` family — auditable exclusions for paths, per-rule waivers,
  and oxlint categories.** Source of truth at `.harn/qualy/ignore.json`
  (qualy-managed), compiled deterministically into `oxlint.{fast,deep}.json`
  between `_qualy:start_/_qualy:end_` markers — anything outside the markers
  is preserved byte-for-byte. Every mutation appends a structured entry to
  `.harn/qualy/docs/lint-decisions.md`. See
  [`.harn/docs/lint-ignore/SPEC.md`](.harn/docs/lint-ignore/SPEC.md) for the
  full specification (manifest schema, exit codes, §10 acceptance criteria).
  - **CLI:** `qualy ignore-{add,remove,list,explain,compile,import-preview,blast-radius}`
    + `qualy category-info <name>`. Path-only entries route to
    `ignorePatterns[]`; per-rule and category entries route to `overrides[]`.
  - **Slash commands:** `/lint:ignore:{add,remove,list,explain}`. Mandatory
    `--reason` is captured via `AskUserQuestion`; categories pull rule counts
    via `category-info` and require explicit acknowledgement
    (`--i-know-this-disables-many`) before mutating.
  - **Brownfield import.** On the first mutation, `ignorePatterns[]` already
    present outside the markers are imported as `createdBy: "imported"`
    entries — silent for < 5 patterns; preview + confirmation via
    `qualy ignore-import-preview` for ≥ 5.
  - **Drift detection in `qualy audit`.** Recompiles when manifest is newer
    than presets; pure no-op otherwise (a handful of `stat` calls). Expired
    entries surface as `ignore_expired` warnings on stderr — they never break
    the build.
  - **Blast-radius preview.** `qualy ignore-blast-radius <glob>` reports
    `files_in_glob` + sample (excluding `node_modules`/`.git`/`dist`/`.harn`/
    `.lint-audit`/`.lint-backup`). Used by `/lint:ignore:add` and
    `/lint:ignore:remove` before mutating.
- **One-time decision-log migration.** `docs/lint-decisions.md` is now stored
  at `.harn/qualy/docs/lint-decisions.md` (alongside the ignore manifest). On
  the first mutation by any `rules-*` / `recs-*` / `ignore-*` command, the
  legacy file is moved automatically (git-aware) with a
  `meta:migrate-decision-log` audit entry. Conflicts (both paths exist) abort
  with exit `1` for manual resolution.

### Changed

- `dependencies` now includes `fast-glob ^3.3.3` (used by
  `qualy ignore-blast-radius` for offline glob counting; `node:fs.glob` is
  only stable on Node ≥ 22 and qualy targets Node ≥ 20).
- Slash commands `/lint:rules:add`, `/lint:rules:remove`, `/lint:update` and
  the decision-log template now reference `.harn/qualy/docs/lint-decisions.md`
  instead of the legacy `docs/lint-decisions.md` path.

---

## [0.2.0] — 2026-05-05

Primeira release pós-`0.1.0` que de fato funciona após `npm install`.
`0.1.0` ficou no CHANGELOG mas nunca foi publicada como tag — dois bugs
mascarados a tornavam não-executável: (a) `--experimental-strip-types`
recusa código TypeScript dentro de `node_modules/`, e (b) o pipeline
`quality-metrics` referenciava o pacote por nome errado e o oxlint não
recebia o path absoluto via `jsPlugins[]`. Esta release fecha ambos.

### Fixed

- **Pacote publicado executa pós-`npm install`.** O shim `bin/qualy.mjs`
  passa a usar `tsx` como runtime (resolvido via
  `createRequire(import.meta.url).resolve("tsx/cli")`) em vez de
  `node --experimental-strip-types`. A flag nativa do Node recusa-se por
  design a stripar tipos de arquivos dentro de `node_modules/`, o que
  tornava `@hgflima/qualy@0.1.0` não-executável após `npm install` ou `npx`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Ver
  [ADR 0011](./docs/adrs/0011-tsx-runtime.md).
- **Pipeline `quality-metrics` integrado ao oxlint funciona end-to-end.**
  Conjunto de fixes do `fixes/quality-metrics-pipeline` (Phase 1–4):
  - `T1.1` — manifest passa a registrar `stage` (greenfield /
    brownfield-moderate / brownfield-legacy); `install-oxlint` escreve
    o campo, `rules-list` lê dele.
  - `T1.2` — presets descartam `_comment` (rejeitado pelo oxlint) e
    trocam `plugins` por `jsPlugins` (forma esperada pelo runtime).
  - `T1.3` / **ADR 0012** — `install-oxlint` resolve o pacote
    `quality-metrics` via `require.resolve` e patcha o caminho absoluto
    em `jsPlugins[]` no momento do write (presets ficam em
    `node_modules/`, oxlint só aceita path absoluto).
  - `T2.1` / `T2.2` — `oxlint.deep.json` colapsa o par `halstead-*` num
    único `quality-metrics/halstead-*` (5 rules canônicas) e corrige
    `lcom` option name.
  - `T2.3` — `metricKeyFromRule` aceita a forma `ns(rule)` (com
    parênteses) emitida por algumas versões do oxlint.
  - `T3.1` — referência ao pacote troca de `@oxc-project/quality-metrics`
    para `quality-metrics` (npm name oficial).
  - `T4.1` — `audit` distingue `preset_invalid` de `oxlint_missing`
    (mensagens diferentes; exit codes preservados).
  - `T4.2` — e2e cobre install + audit detectando uma violação WMC real,
    travando regressão de toda a cadeia.

### Changed

- **`engines.node` de `>=22.6.0` para `>=20.0.0`.** Alinha com o default
  de `actions/setup-node@v4` no CI e amplia a base de usuários que podem
  instalar o pacote sem upgrade de Node. tsx suporta Node ≥ 18; fixamos
  em 20 LTS por paridade.
- **Runtime deps do CLI publicado migradas para `dependencies` da raiz.**
  `tsx`, `zod`, `ts-morph`, `esbuild`, `chart.js` e `chartjs-chart-treemap`
  agora estão em `package.json#dependencies` (raiz). Antes ficavam só em
  `cli/package.json` (workspace privado, não publicado) e parcialmente em
  `devDependencies` — o que mascarava `ERR_MODULE_NOT_FOUND` por trás do
  bug primário de strip-types.
- **`scripts.build` (noop) atualiza a justificativa** para refletir tsx
  no lugar de strip-types. Segue sem build step real (`echo … && exit 0`).

### Added

- E2E `cli/tests/e2e/install/installed-tarball.test.ts` que faz
  `npm pack` + `npm install <tarball>` em tmpdir e executa o binário
  publicado (`./node_modules/.bin/qualy --version` e
  `qualy install --scope local --dry-run`). Trava a regressão do bug acima.
- ADRs **0010** (npm distribution rationale), **0011** (tsx runtime),
  **0012** (jsPlugins absolute-path resolution).

---

## [0.1.0] — 2026-05-04

### Added

- `qualy install --scope <user|project|local>` — instala o harness via `npx`,
  copiando `skills/`, `commands/`, `agents/` para o escopo escolhido com
  registro determinístico em `.qualy-manifest.json` (SPEC §3).
- `qualy uninstall --scope <user|project|local>` — remove byte-a-byte tudo
  que estiver listado no `.qualy-manifest.json` do escopo, sem afetar
  arquivos não rastreados.
- `qualy update --scope <user|project|local>` — refaz a cópia a partir do
  payload da versão atual, mantendo o manifesto consistente; mapeia 4
  classes de erro de rede/registry para mensagens recuperáveis.

### Breaking

- `qualy uninstall` (lint-stack) → renomeado para `qualy lint-uninstall`
  (D1). O nome `uninstall` agora pertence ao harness installer; quem
  precisa desinstalar a stack `oxlint+oxfmt+quality-metrics` deve usar
  `qualy lint-uninstall` ou `/lint:uninstall`.

### Added

- **CLI dispatcher** (`cli/src/index.ts`) with `--help`, `--version`, semantic
  exit codes (`cli/src/lib/exit-codes.ts`), structured logger
  (`cli/src/lib/logger.ts`), defensive JSON helpers (`cli/src/lib/json.ts`),
  and 28+ subcommands covering detection, install, audit, recommendations,
  backup/restore, report, rules, and status.
- **Slash commands** under `commands/lint/`: `/lint`, `/lint:setup`,
  `/lint:status`, `/lint:audit`, `/lint:update`, `/lint:report`,
  `/lint:rules:{list,add,remove,explain}`, `/lint:rollback`, `/lint:uninstall`
  (per SPEC §2).
- **Subagents** under `agents/`: `lint-detector`, `lint-installer`,
  `lint-auditor` (authorized rationale exception per ADR 0008),
  `lint-migrator`.
- **Stage detection** heuristic (`cli/src/commands/detect-stage.ts`)
  classifying repos as `greenfield` / `brownfield-moderate` / `legacy` from
  six deterministic signals (ADR 0003); thresholds locked in
  `STAGE_THRESHOLDS` and documented in `docs/stages.md` + `docs/thresholds.md`.
- **oxlint presets** (`presets/`) for greenfield / brownfield-moderate /
  legacy with `fast` / `deep` profiles (ADR 0001 — oxc only in v1).
- **Coverage presets** (`coverage-presets/`) for vitest and jest, calibrated
  per stage (`docs/coverage.md`).
- **Audit ↔ update contract** persisted via `.lint-audit/<timestamp>.json`
  (zod-validated `auditPayloadSchema`); decoupled by file with a 24h
  staleness gate (ADR 0004; `docs/audit-format.md`).
- **Recommendations engine** (`cli/src/commands/recs/{generate,blast-radius,apply}.ts`)
  with stable IDs, dry-run blast-radius via oxlint, and resumable
  `--rec-id` apply (ADR 0008; `docs/recs-heuristics.md`).
- **Quality report** with two coordinated channels sharing a single bundle
  pipeline: ephemeral local server bound to `127.0.0.1` and self-contained
  HTML export with sensitive-data redaction (ADR 0005; `docs/report-design.md`).
- **Backup / rollback** primitive: opt-in filesystem snapshots under
  `.lint-backup/<ISO-timestamp>/`, indexed by `.lint-manifest.json`,
  byte-for-byte restore (ADR 0002).
- **Test fixtures** (`cli/tests/fixtures/`): `greenfield-ts`,
  `brownfield-eslint-prettier`, `legacy-monorepo`, `jest-with-coverage`,
  `unsupported-python`, with deterministic `materializeFixture` helper
  (commit timestamp pinned for reproducibility).
- **Validation suite** wired at the workspace root: `npm run typecheck`,
  `npm test` (vitest), `npm run lint` (placeholder until oxlint lands),
  `npm run build` (no-op — Node 22.6 strips types at runtime).
- **Architectural Decision Records** 0001–0009 under `docs/adrs/` covering
  oxc-only scope, named backup/rollback, stage heuristic, audit/update
  coupling, report dual-channel, deterministic CLI + thin harness, runtime
  TS via `--experimental-strip-types`, hybrid recs rationale, and
  `install.sh` distribution.
- **User docs** under `docs/`: `stages.md`, `thresholds.md`, `coverage.md`,
  `audit-format.md`, `report-design.md`, `compatibility.md`,
  `recs-heuristics.md`.
- **Distribution**: `install.sh` (Bash) with `copy` (default) and `--dev`
  (symlink) modes, `--target`, `--dry-run`, `--help`, and a Node ≥ 22.6
  preflight guard (ADR 0009).
- **Root project files**: `README.md` (entry point routing to specs/ADRs),
  `package.json` with npm workspaces, root `tsconfig.json`
  (`NodeNext` + `strict` + `noEmit`), `.gitignore` covering `node_modules/`,
  `.lint-audit/`, `.lint-backup/`, `.lint-manifest.json`, `ralph.log`.

### Notes

- **Runtime floor.** Node ≥ 22.6 with `--experimental-strip-types` is
  required — there is no build step and no `dist/` artifact (ADR 0007).
- **Stack support.** v1 covers TypeScript / TSX / JavaScript / JSX only;
  Vue / Svelte SFCs and other stacks return `unsupported_stack` (exit 2)
  per `docs/compatibility.md` (ADR 0001).
- **Distribution.** Manual install via `./install.sh`; native plugin
  packaging is deferred to a future ADR.
- **No published version yet.** Install at `HEAD` of this repository.

---

[Unreleased]: https://github.com/hgflima/qualy/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/hgflima/qualy/releases/tag/v0.3.0
[0.2.0]: https://github.com/hgflima/qualy/releases/tag/v0.2.0
[0.1.0]: https://github.com/hgflima/qualy/releases/tag/v0.1.0
