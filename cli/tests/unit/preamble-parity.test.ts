/**
 * Preamble parity across the 19 functional .md files
 * (SPEC §6 + §7 + ADR 0013, .harn/docs/fixes/scope-resolution/;
 * canonical block updated in v0.3.4 — see
 * .harn/docs/cli-bin-resolution/SPEC.md §4).
 *
 * Every functional `.md` file (the SKILL, the four `lint-*` agents and
 * the 14 `commands/lint/**` slash commands) must embed the canonical
 * `$QUALY_DEV_BIN → $PWD → $HOME` probe block byte-for-byte. Drift
 * between any two files is a regression — a single byte off and
 * operators get inconsistent resolution / error messages depending on
 * which entry point they hit.
 *
 * Migration is staged across two tasks (T7a, T7b): SKILL.md + the 14
 * commands flipped first, then the 4 agents. With T7b landed the
 * `MIGRATED` set covers all 19 files and the suite exercises every
 * probe.
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
 * The canonical probe block, frozen by SPEC §4 of cli-bin-resolution.
 * The trailing `node ...` line is intentionally excluded — its
 * `<subcommand>` token varies per file.
 */
const CANONICAL_PROBE = [
  'QUALY_BIN=""',
  "# Dev override (uso interno do repo qualy): aponta para bin/qualy.mjs local.",
  '[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"',
  "# Lookup padrão: cópia materializada por `qualy install`.",
  'if [ -z "$QUALY_BIN" ]; then',
  '  for cand in "$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs" \\',
  '              "$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"; do',
  '    [ -f "$cand" ] && QUALY_BIN="$cand" && break',
  "  done",
  "fi",
  '[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \\`npx @hgflima/qualy install\\` first." >&2; exit 5; }',
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
 * T7a flipped SKILL.md + the 14 commands; T7b added the four agents.
 */
const MIGRATED: ReadonlySet<string> = new Set<string>([
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
    // With T7b landed every functional file must initialise `QUALY_BIN=""`
    // exactly once (in the probe block). Any new functional `.md` either
    // adopts the canonical block (and shows up here) or is intentionally
    // legacy-free; this guard fires the moment a new file slips in
    // without the canonical preamble.
    const found = candidates
      .map((p) => p.split(sep).join("/"))
      .filter((p) => /QUALY_BIN=""/.test(readFunctional(p)));
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

  it("returns null for the legacy QUALY_CLI probe (v0.3.3)", () => {
    const legacy = [
      'QUALY_CLI=""',
      'for cand in "$PWD/.claude" "$HOME/.claude"; do',
      '  [ -f "$cand/skills/lint/cli/src/index.ts" ] && QUALY_CLI="$cand/skills/lint/cli/src/index.ts" && break',
      "done",
    ].join("\n");
    expect(extractProbeBlock(legacy)).toBeNull();
  });
});
