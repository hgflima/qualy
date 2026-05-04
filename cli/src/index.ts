/**
 * qualy CLI dispatcher.
 *
 * Entry point invoked by harness `.md` files (PLAN §Resolução do CLI):
 *
 *   node --experimental-strip-types cli/src/index.ts <subcommand> --cwd <path> [...]
 *
 * The subcommand registry below is the canonical list from PLAN §Contratos CLI.
 * Phase 0 deliberately leaves every subcommand as a `notImplemented` stub —
 * later phases swap stub handlers for real implementations in-place. Adding a
 * new subcommand means (i) appending to SUBCOMMANDS and (ii) wiring its
 * handler.
 *
 * Output discipline (PLAN §Princípios + logger.ts):
 *   - Stdout: at most one canonical JSON document per invocation (via output()).
 *   - Stderr: NDJSON via logger plus the human-readable `--help` text.
 */
import { runAudit } from "./commands/audit.ts";
import { runAuditLatest } from "./commands/audit-latest.ts";
import { runBackupCreate } from "./commands/backup/create.ts";
import { runBackupList } from "./commands/backup/list.ts";
import { runBackupRestore } from "./commands/backup/restore.ts";
import { runDetectExistingLinter } from "./commands/detect-existing-linter.ts";
import { runDetectStack } from "./commands/detect-stack.ts";
import { runDetectStage } from "./commands/detect-stage.ts";
import { runDetectTestRunner } from "./commands/detect-test-runner.ts";
import { runGitCleanCheck } from "./commands/git-clean-check.ts";
import { runInstallCoverage } from "./commands/install/coverage.ts";
import { runInstallDeps } from "./commands/install/deps.ts";
import { runInstallHook } from "./commands/install/hook.ts";
import { runInstallHusky } from "./commands/install/husky.ts";
import { runInstallOxlint } from "./commands/install/oxlint.ts";
import { runInstallScripts } from "./commands/install/scripts.ts";
import { runRecsApply } from "./commands/recs/apply.ts";
import { runRecsBlastRadius } from "./commands/recs/blast-radius.ts";
import { runRecsGenerate } from "./commands/recs/generate.ts";
import { runRulesAdd } from "./commands/rules/add.ts";
import { runRulesExplain } from "./commands/rules/explain.ts";
import { runRulesList } from "./commands/rules/list.ts";
import { runRulesRemove } from "./commands/rules/remove.ts";
import { runStatus } from "./commands/status.ts";
import { runUninstall } from "./commands/uninstall.ts";
import { runReportData } from "./report/data-loader.ts";
import { runReportServe } from "./commands/report/serve.ts";
import { EXIT_CODES, type ExitCode } from "./lib/exit-codes.ts";
import { logger, output } from "./lib/logger.ts";

const VERSION = "0.0.0";
const BIN_NAME = "qualy";

export type Handler = (argv: readonly string[]) => Promise<ExitCode> | ExitCode;

export interface Subcommand {
  readonly name: string;
  readonly summary: string;
  readonly handler: Handler;
}

function notImplemented(name: string): Handler {
  return () => {
    logger.error("subcommand_not_implemented", { subcommand: name });
    output({ ok: false, error: "not_implemented", subcommand: name });
    return EXIT_CODES.RECOVERABLE_ERROR;
  };
}

/**
 * Canonical subcommand list (PLAN §Contratos CLI). Order here drives `--help`
 * output, so keep it grouped by phase: detection → backup → install → audit →
 * recs → rules → status → report → uninstall.
 */
const SUBCOMMAND_LIST: ReadonlyArray<readonly [name: string, summary: string]> = [
  ["detect-stack", "Classify project stack as supported (TS/JS) or blocked"],
  ["detect-stage", "Heuristic project stage: greenfield | brownfield-moderate | legacy"],
  ["detect-existing-linter", "Find existing ESLint/Prettier/Biome/dprint configs"],
  ["detect-test-runner", "Detect vitest/jest and their current coverage thresholds"],
  ["git-clean-check", "Assert the git working tree is clean before mutating commands"],
  ["backup-create", "Snapshot files into .lint-backup/<ISO-timestamp>/"],
  ["backup-list", "List existing backups under .lint-backup/"],
  ["backup-restore", "Restore a backup byte-for-byte by --ts"],
  ["install-oxlint", "Write oxlint.<tier>.json from the stage's preset"],
  ["install-hook", "Merge .claude/settings.json + write .claude/hooks/post-edit.sh"],
  ["install-husky", "Install .husky/pre-commit + .lintstagedrc.js"],
  ["install-scripts", "Idempotently merge scripts into package.json"],
  ["install-coverage", "Configure vitest/jest coverage thresholds"],
  ["install-deps", "Install runtime deps via npm/pnpm/yarn/bun (lockfile-driven)"],
  ["audit", "Run oxlint+oxfmt+quality-metrics, write .lint-audit/<ts>.json"],
  ["audit-latest", "Read the most recent .lint-audit/*.json"],
  ["recs-generate", "Deterministic heuristics → candidates[] (rationale_stub only)"],
  ["recs-blast-radius", "Dry-run a rec's config and count newly/no-longer-violating files"],
  ["recs-apply", "Apply a rec patch + append decision to docs/lint-decisions.md"],
  ["rules-list", "List active, available, and disabled rules with their origin"],
  ["rules-add", "Enable a rule (severity/threshold) and log decision"],
  ["rules-remove", "Disable a rule (--reason required) and log decision"],
  ["rules-explain", "Explain a rule: description, rationale, threshold, links"],
  ["status", "Aggregate versions, presets, stage, hooks, coverage, theme"],
  ["report-data", "Aggregate audit + history + coverage + git into report JSON"],
  ["report-serve", "Serve the visual report on 127.0.0.1 (long-running)"],
  ["report-export", "Write a self-contained HTML report"],
  ["uninstall", "Remove every artifact tracked in .lint-manifest.json"],
];

/**
 * Real handler overrides applied on top of the default `notImplemented` map as
 * commands are wired phase-by-phase. Keep handlers thin — they parse argv and
 * delegate to `commands/<name>.ts`.
 */
const HANDLER_OVERRIDES: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ["audit", runAudit],
  ["audit-latest", runAuditLatest],
  ["backup-create", runBackupCreate],
  ["backup-list", runBackupList],
  ["backup-restore", runBackupRestore],
  ["detect-stack", runDetectStack],
  ["detect-stage", runDetectStage],
  ["detect-existing-linter", runDetectExistingLinter],
  ["detect-test-runner", runDetectTestRunner],
  ["git-clean-check", runGitCleanCheck],
  ["install-coverage", runInstallCoverage],
  ["install-deps", runInstallDeps],
  ["install-hook", runInstallHook],
  ["install-husky", runInstallHusky],
  ["install-oxlint", runInstallOxlint],
  ["install-scripts", runInstallScripts],
  ["recs-apply", runRecsApply],
  ["recs-blast-radius", runRecsBlastRadius],
  ["recs-generate", runRecsGenerate],
  ["rules-add", runRulesAdd],
  ["rules-explain", runRulesExplain],
  ["rules-list", runRulesList],
  ["rules-remove", runRulesRemove],
  ["status", runStatus],
  ["uninstall", runUninstall],
  ["report-data", runReportData],
  ["report-serve", runReportServe],
]);

const SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map(
  SUBCOMMAND_LIST.map(([name, summary]) => [
    name,
    {
      name,
      summary,
      handler: HANDLER_OVERRIDES.get(name) ?? notImplemented(name),
    },
  ]),
);

function helpText(): string {
  const widest = SUBCOMMAND_LIST.reduce((max, [name]) => Math.max(max, name.length), 0);
  const rows = SUBCOMMAND_LIST.map(
    ([name, summary]) => `  ${name.padEnd(widest, " ")}  ${summary}`,
  ).join("\n");
  return [
    `${BIN_NAME} ${VERSION}`,
    "",
    "Usage:",
    `  ${BIN_NAME} <subcommand> [--cwd <path>] [--json] [flags...]`,
    `  ${BIN_NAME} --help | --version`,
    "",
    "Subcommands:",
    rows,
    "",
    "Globals:",
    "  --cwd <path>     Run the subcommand against <path> (default: process cwd)",
    "  --json           Emit canonical JSON to stdout (default: true)",
    "  --help, -h       Show this help",
    "  --version, -v    Print version and exit",
    "",
    `Run \`${BIN_NAME} <subcommand> --help\` for details once subcommands are wired.`,
    "",
  ].join("\n");
}

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function isVersionFlag(arg: string | undefined): boolean {
  return arg === "--version" || arg === "-v";
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    process.stderr.write(helpText());
    return EXIT_CODES.USAGE_ERROR;
  }

  if (isHelpFlag(first)) {
    process.stderr.write(helpText());
    return EXIT_CODES.OK;
  }

  if (isVersionFlag(first)) {
    output({ name: BIN_NAME, version: VERSION });
    return EXIT_CODES.OK;
  }

  const sub = SUBCOMMANDS.get(first);
  if (!sub) {
    logger.error("unknown_subcommand", { subcommand: first });
    output({ ok: false, error: "unknown_subcommand", subcommand: first });
    process.stderr.write(helpText());
    return EXIT_CODES.USAGE_ERROR;
  }

  return sub.handler(rest);
}

/** Subcommand registry, exported for tests and future wiring. */
export function listSubcommands(): readonly Subcommand[] {
  return Array.from(SUBCOMMANDS.values());
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("internal_error", { message });
      output({ ok: false, error: "internal_error", message });
      process.exit(EXIT_CODES.INTERNAL_ERROR);
    });
}
