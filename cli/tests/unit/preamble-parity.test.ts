/**
 * Preamble parity across the 19 functional .md files
 * (SPEC §6 + §7 + ADR 0013, .harn/docs/fixes/scope-resolution/).
 *
 * Every functional `.md` file (the SKILL, the four `lint-*` agents and
 * the 14 `commands/lint/**` slash commands) must embed the canonical
 * `$PWD → $HOME` probe block byte-for-byte. Drift between any two files
 * is a regression — a single byte off and operators get inconsistent
 * resolution / error messages depending on which entry point they hit.
 *
 * Migration is staged across tasks T4–T8: each task migrates a subgroup
 * and adds the corresponding paths to `MIGRATED`. The per-file parity
 * assertions skip until a path is moved into that set, so backpressure
 * stays green throughout Phase 2 while still flipping each file's check
 * to "real" the moment it is touched. Once T8 lands, `MIGRATED.size`
 * equals `FUNCTIONAL_FILES.length` and the suite exercises every probe.
 */
import { globSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The canonical 5-line probe block, frozen by ADR 0013 / SPEC §6.
 * The trailing `node ...` line is intentionally excluded — its
 * `<subcommand>` token varies per file.
 */
const CANONICAL_PROBE = [
  'QUALY_CLI=""',
  'for cand in "$PWD/.claude" "$HOME/.claude"; do',
  '  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break',
  "done",
  '[ -z "$QUALY_CLI" ] && { echo "qualy CLI not found in \\$PWD/.claude or \\$HOME/.claude. Run \\`qualy install\\` first." >&2; exit 5; }',
].join("\n");

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROBE_REGEX = new RegExp(escapeRegex(CANONICAL_PROBE));

function extractProbeBlock(content: string): string | null {
  const match = content.match(PROBE_REGEX);
  return match ? match[0] : null;
}

const FUNCTIONAL_FILES = [
  "skills/lint/SKILL.md",
  "agents/lint-auditor.md",
  "agents/lint-detector.md",
  "agents/lint-installer.md",
  "agents/lint-migrator.md",
  "commands/lint/audit.md",
  "commands/lint/report.md",
  "commands/lint/rollback.md",
  "commands/lint/setup.md",
  "commands/lint/uninstall.md",
  "commands/lint/update.md",
  "commands/lint/ignore/add.md",
  "commands/lint/ignore/explain.md",
  "commands/lint/ignore/list.md",
  "commands/lint/ignore/remove.md",
  "commands/lint/rules/add.md",
  "commands/lint/rules/explain.md",
  "commands/lint/rules/list.md",
  "commands/lint/rules/remove.md",
] as const;

/**
 * Paths whose preamble has been migrated to the canonical block.
 * Populated incrementally by T4–T8. Empty after T2 (this task) lands.
 *
 *   T4 → "skills/lint/SKILL.md"
 *   T5 → the four "agents/lint-*.md"
 *   T6 → the six "commands/lint/{audit,report,rollback,setup,uninstall,update}.md"
 *   T7 → the four "commands/lint/ignore/*.md"
 *   T8 → the four "commands/lint/rules/*.md"
 */
const MIGRATED: ReadonlySet<string> = new Set<string>([
  "skills/lint/SKILL.md",
  "agents/lint-auditor.md",
  "agents/lint-detector.md",
  "agents/lint-installer.md",
  "agents/lint-migrator.md",
]);

function readFunctional(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("preamble parity — canonical probe block", () => {
  for (const path of FUNCTIONAL_FILES) {
    const tester = MIGRATED.has(path) ? it : it.skip;
    tester(`${path} embeds the canonical probe block (byte-for-byte)`, () => {
      const content = readFunctional(path);
      expect(content).toMatch(PROBE_REGEX);
    });
  }

  const allMigrated = MIGRATED.size === FUNCTIONAL_FILES.length;
  const groupTester = allMigrated ? it : it.skip;
  groupTester(
    "all 19 functional files share an identical probe block",
    () => {
      const blocks = FUNCTIONAL_FILES.map((p) =>
        extractProbeBlock(readFunctional(p)),
      );
      const missing = FUNCTIONAL_FILES.filter((_p, i) => blocks[i] === null);
      expect(missing).toEqual([]);
      const unique = new Set(
        blocks.filter((b): b is string => b !== null),
      );
      expect(unique.size).toBe(1);
      expect(unique.values().next().value).toBe(CANONICAL_PROBE);
    },
  );

  it("functional file count is exactly 19 (regression guard for new commands/agents)", () => {
    const candidates = globSync(
      ["skills/**/*.md", "agents/**/*.md", "commands/**/*.md"],
      { cwd: REPO_ROOT },
    );
    const found = candidates
      .map((p) => p.split(sep).join("/"))
      .filter((p) => /QUALY_CLI=/.test(readFunctional(p)));
    expect(found.sort()).toEqual([...FUNCTIONAL_FILES].sort());
  });
});

describe("preamble parity — extractProbeBlock helper", () => {
  it("returns the canonical block when present", () => {
    const wrapped = `prose before\n${CANONICAL_PROBE}\nprose after\n`;
    expect(extractProbeBlock(wrapped)).toBe(CANONICAL_PROBE);
  });

  it("returns null when the canonical block is absent", () => {
    expect(extractProbeBlock("nothing here")).toBeNull();
  });

  it("returns null for the legacy CLAUDE_PLUGIN_ROOT one-liner", () => {
    const legacy =
      'QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"';
    expect(extractProbeBlock(legacy)).toBeNull();
  });
});
