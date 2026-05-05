# qualy

Deterministic CLI + thin Claude Code harness for `oxlint` + `oxfmt` + `quality-metrics` on TypeScript/JavaScript projects. Stage-aware presets (greenfield / brownfield-moderate / legacy), audit + recommendations workflow, visual quality report, and reversible setup.

> Status: pre-1.0. The CLI surface and slash commands are stable; integration tests cover the full lifecycle (setup → audit → update → report → uninstall/rollback). Public release pending the remaining Phase 7 hardening tasks (`CHANGELOG.md`, `tests/scenarios/*`, `pnpm test:e2e`, manual validation).

## Requirements

- Node **≥ 22.6** (the CLI runs via `node --experimental-strip-types`, no build step — see `docs/adrs/0007-runtime-ts-strip-types.md`).
- Git (used for `git-clean-check`, stage detection signals, churn).
- A package manager already in use by the project (npm / pnpm / yarn / bun — auto-detected from the lockfile).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) for the slash commands and subagents.

Stack support is binary: `.ts/.tsx/.js/.jsx` only. Python, Go, Rust, Vue/Svelte SFC, etc. are recused with `exit 2` (`UNSUPPORTED_STACK`). See `docs/compatibility.md` and `docs/adrs/0001-oxc-only-v1.md`.

## Installation

Three scopes are supported. Pick the one that matches your workflow.

### `--scope user` — personal tool, every project

Use when qualy is part of your personal toolkit and you want it available across every project on your machine. Installs into `~/.claude/`.

```bash
npx @hgflima/qualy install --scope user
```

### `--scope project` — team-wide, versioned in the repo (default)

Use when the whole team should share the same harness. Installs into `<repo>/.claude/` and you commit it. Requires the working directory to be a git repository.

```bash
npx @hgflima/qualy install --scope project
# or simply: npx @hgflima/qualy install
```

### `--scope local` — solo experimentation, gitignored

Use when you want to try qualy in a repo without affecting teammates. Installs into `<repo>/.claude/` and adds `.claude/` to `.gitignore` automatically.

```bash
npx @hgflima/qualy install --scope local
```

After install, restart Claude Code (or open a new session) so it picks up the new skill, commands, and subagents. Re-running is idempotent. To remove everything tracked in the manifest, run `npx @hgflima/qualy uninstall`.

> **Note:** `./install.sh --dev` is **only** for developers working on qualy itself (symlink mode against a local clone). End users should always go through `npx @hgflima/qualy install`.

See [`.harn/docs/npx-installer/SPEC.md`](.harn/docs/npx-installer/SPEC.md) for the full installer specification (scope resolution, manifest schema, error classes), and [`docs/adrs/0010-npm-distribution.md`](docs/adrs/0010-npm-distribution.md) for the rationale behind shipping via npm (D1–D5: rename, manifest discriminator, bin shim, `npm view` for `update`, version skew between root and `cli/`).

## Slash commands

The harness lives in `commands/lint/` and `skills/lint/SKILL.md`. Inside Claude Code:

| Command                  | What it does                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `/lint`                  | Conversational router — asks one question, delegates to the right `/lint:*` command.            |
| `/lint:setup`            | Detects stack/stage/runner/existing linter, asks for confirmation, installs the full toolchain. |
| `/lint:status`           | Read-only summary: versions, presets, stage, hooks, coverage thresholds, theme.                 |
| `/lint:audit`            | Runs `oxlint --tier deep`, writes `.lint-audit/<ts>.json`, enriches `recommendations[]`.        |
| `/lint:update`           | Iterates the latest audit's recommendations one by one, asks before applying each.              |
| `/lint:report`           | Spins up an ephemeral local report (`127.0.0.1:<port>`), then offers a self-contained snapshot. |
| `/lint:rules:list`       | Shows active / available / disabled rules with origin.                                          |
| `/lint:rules:add`        | Enables a rule (with optional `--measure-blast-radius`), appends to `docs/lint-decisions.md`.   |
| `/lint:rules:remove`     | Disables a rule. `--reason` required (logged to `docs/lint-decisions.md`).                      |
| `/lint:rules:explain`    | Description, rationale, links, current/default value for a rule.                                |
| `/lint:rollback`         | Restores a `.lint-backup/<ts>/` snapshot (does not uninstall oxc — escape hatch).               |
| `/lint:uninstall`        | Removes everything tracked in `.lint-manifest.json`. `--keep-backup` preserves snapshots.       |

All slash commands surface the underlying CLI exit code (`0` ok, `1` recoverable, `2` unsupported-stack, `3` dirty-tree, `4` usage, `5` missing-dep, `70` internal — see `cli/src/lib/exit-codes.ts`) and never auto-commit.

## Lint ignore

For exclusions you actually want to track (legacy folders, generated code, vendored deps, per-rule waivers in specific paths), use the `/lint:ignore:*` family. Every entry has a mandatory reason, optional expiry, and is recorded in `.harn/qualy/docs/lint-decisions.md` — exclusions become auditable technical debt instead of hidden config.

Source of truth is `.harn/qualy/ignore.json`. The CLI compiles entries into `oxlint.{fast,deep}.json` between `_qualy:start_/_qualy:end_` markers (path-only entries → `ignorePatterns[]`; per-rule and category entries → `overrides[]`). Anything outside the markers is preserved byte-for-byte.

Three typical shapes:

```bash
# Path-only — exclude an entire folder from lint
/lint:ignore:add 'src/legacy/**' --reason "Legacy module, rewriting in Q3" --expires 2026-09-30

# Per-rule — silence one rule in a specific path, keep the rest enforced
/lint:ignore:add 'src/generated/**' --rule quality-metrics/wmc --reason "Auto-generated code"

# Category — disable a whole oxlint category in a path. The slash command
# resolves the category size first, asks for confirmation, then injects
# --i-know-this-disables-many automatically.
/lint:ignore:add 'src/legacy/**' --rule category:correctness --reason "Legacy migration"
```

| Command                | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/lint:ignore:add`     | Register or update an entry (path-only / per-rule / category). `--reason` mandatory.               |
| `/lint:ignore:remove`  | Drop an entry by `(glob, rule)`. `--reason` mandatory. Ambiguous match asks for disambiguation.    |
| `/lint:ignore:list`    | Inventory: active vs expired, days overdue, origin (`user`/`imported`), category size warnings.    |
| `/lint:ignore:explain` | Single-entry detail + decision-log history filtered by `id`.                                       |

Drift handling: `qualy audit` compares `mtime(.harn/qualy/ignore.json)` vs the presets and recompiles only when the manifest is newer. Expired entries surface as `ignore_expired` warnings on stderr — they never break the build.

Brownfield import: on the first mutation, `ignorePatterns[]` already present **outside** the markers are imported as `createdBy: "imported"` entries (silent for < 5 patterns; preview + confirmation via `qualy ignore-import-preview` for ≥ 5).

See [`.harn/docs/lint-ignore/SPEC.md`](.harn/docs/lint-ignore/SPEC.md) for the full specification (manifest schema, exit codes, SPEC §10 acceptance criteria).

## CLI

Each slash command is a thin wrapper over a deterministic CLI. You can invoke it directly:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" --help
node --experimental-strip-types "$QUALY_CLI" status --cwd "$PWD"
```

Contract: one JSON document on stdout per invocation, NDJSON + human messages on stderr, semantic exit codes. The CLI never asks questions — every interaction is the harness's job.

Subcommand list: `detect-stack`, `detect-stage`, `detect-existing-linter`, `detect-test-runner`, `git-clean-check`, `backup-{create,list,restore}`, `install-{oxlint,hook,husky,scripts,coverage,deps}`, `audit`, `audit-latest`, `recs-{generate,blast-radius,apply}`, `rules-{list,add,remove,explain}`, `ignore-{add,remove,list,explain,compile,import-preview,blast-radius}`, `category-info`, `status`, `report-{data,serve,export}`, `uninstall`. Run `qualy <subcommand> --help` for details.

## Architecture

Two layers, designed so the CLI is fully testable offline and the harness is the only place that asks questions:

```
cli/src/                 Deterministic TypeScript CLI (no build step, no runtime questions)
  commands/              Subcommand handlers (one per slash command verb)
  presets/               Stage × tier presets (oxlint + coverage), versioned
  templates/             Files copied into target projects (post-edit.sh, etc.)
  report/                Visual report (server + export, vanilla DOM, chart.js)
  lib/                   Shared helpers (git, fs-safe, json, ts-config-edit, ...)

skills/lint/SKILL.md     Conversational router (≤200 lines)
commands/lint/*.md       Slash command orchestrators (≤100 lines each)
agents/lint-*.md         Read-only / single-responsibility subagents (≤150 lines each)

docs/                    User-facing reference (stages, thresholds, coverage, audit format, ...)
docs/adrs/               Architectural decisions (0001 oxc-only, 0006 CLI determinístico, ...)
```

Read first: `docs/adrs/0006-deterministic-cli-thin-harness.md` (central principle) and `docs/adrs/0007-runtime-ts-strip-types.md` (why Node ≥ 22.6).

## Workflow examples

Greenfield project (no linter yet):

```
/lint:setup            # detect → confirm → install oxlint+oxfmt+husky+coverage
/lint:status           # verify
… write code …
/lint:audit            # measure
/lint:update           # apply recommendations one by one
/lint:report           # open the dashboard, optionally export a snapshot
```

Brownfield project with existing ESLint+Prettier:

```
/lint:setup            # detects existing linter, offers /lint:rollback path or migration
                       #   - backup-create snapshots .eslintrc / .prettierrc into .lint-backup/<ts>/
                       #   - installs oxlint stage=brownfield-moderate alongside
/lint:rollback         # if you change your mind: restores byte-for-byte from .lint-backup/
                       #   (does not uninstall oxc — explicit /lint:uninstall for that)
```

## Development

```bash
npm install                  # workspaces; vitest + typescript hoist to root node_modules/
npm run typecheck            # tsc --noEmit
npm test                     # vitest run (unit + e2e)
./install.sh --dev           # symlink for live iteration
```

Per-iteration validation suite: typecheck + lint (placeholder until oxlint lands on this repo) + tests + build (no-op via strip-types). All four must pass before commit.

## Key references

- Spec: `.harn/docs/mvp/SPEC.md`
- Plan: `.harn/docs/mvp/PLAN.md`
- ADRs: `docs/adrs/`
- User docs: `docs/{stages,thresholds,coverage,audit-format,report-design,compatibility,recs-heuristics}.md`

## License

Not yet declared. To be added before public release.
