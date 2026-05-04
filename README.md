# qualy

Deterministic CLI + thin Claude Code harness for `oxlint` + `oxfmt` + `quality-metrics` on TypeScript/JavaScript projects. Stage-aware presets (greenfield / brownfield-moderate / legacy), audit + recommendations workflow, visual quality report, and reversible setup.

> Status: pre-1.0. The CLI surface and slash commands are stable; integration tests cover the full lifecycle (setup → audit → update → report → uninstall/rollback). Public release pending the remaining Phase 7 hardening tasks (`CHANGELOG.md`, `tests/scenarios/*`, `pnpm test:e2e`, manual validation).

## Requirements

- Node **≥ 22.6** (the CLI runs via `node --experimental-strip-types`, no build step — see `docs/adrs/0007-runtime-ts-strip-types.md`).
- Git (used for `git-clean-check`, stage detection signals, churn).
- A package manager already in use by the project (npm / pnpm / yarn / bun — auto-detected from the lockfile).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) for the slash commands and subagents.

Stack support is binary: `.ts/.tsx/.js/.jsx` only. Python, Go, Rust, Vue/Svelte SFC, etc. are recused with `exit 2` (`UNSUPPORTED_STACK`). See `docs/compatibility.md` and `docs/adrs/0001-oxc-only-v1.md`.

## Install

```bash
git clone <this-repo> qualy
cd qualy
./install.sh                 # copy mode (default) — installs into ~/.claude/
./install.sh --dev           # symlink mode — source edits take effect immediately
./install.sh --target /path  # alternate install root
./install.sh --dry-run       # show what would happen
./install.sh --help
```

The installer copies `skills/lint/`, `commands/lint/`, `agents/lint-*.md`, and the `cli/` workspace into `<target>/skills/lint/cli/`. Re-running is idempotent. It refuses to delete anything outside `<target>/`. Node version is checked before any write.

Restart Claude Code (or open a new session) so it picks up the new skill / commands / subagents.

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

## CLI

Each slash command is a thin wrapper over a deterministic CLI. You can invoke it directly:

```bash
QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
node --experimental-strip-types "$QUALY_CLI" --help
node --experimental-strip-types "$QUALY_CLI" status --cwd "$PWD"
```

Contract: one JSON document on stdout per invocation, NDJSON + human messages on stderr, semantic exit codes. The CLI never asks questions — every interaction is the harness's job.

Subcommand list: `detect-stack`, `detect-stage`, `detect-existing-linter`, `detect-test-runner`, `git-clean-check`, `backup-{create,list,restore}`, `install-{oxlint,hook,husky,scripts,coverage,deps}`, `audit`, `audit-latest`, `recs-{generate,blast-radius,apply}`, `rules-{list,add,remove,explain}`, `status`, `report-{data,serve,export}`, `uninstall`. Run `qualy <subcommand> --help` for details.

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
