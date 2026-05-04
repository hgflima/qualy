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

[Unreleased]: https://github.com/hgflima/qualy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hgflima/qualy/releases/tag/v0.1.0
