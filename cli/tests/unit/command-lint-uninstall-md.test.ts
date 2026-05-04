/**
 * commands/lint/uninstall.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 3 + SPEC §2/§6/§7.2 + PLAN §Resolução do CLI).
 *
 * `/lint:uninstall` is the orchestrator that wraps the deterministic
 * `uninstall` subcommand of the CLI: it inventories the manifest, asks the
 * user whether to keep `.lint-backup/` snapshots, applies the plan, then
 * surfaces `merged_kept` for manual follow-up and offers `/lint:rollback`
 * when a previous-linter snapshot is available.
 *
 * SPEC §4 line 296 caps the .md at 100 lines; SPEC §4 line 295 fixes the
 * required section list; PLAN §Resolução do CLI fixes the `QUALY_CLI=`
 * preamble (defined once in SKILL.md and reused here). These tests lock
 * that surface so drift in frontmatter, the question contract, the exit
 * code mapping, or the merged_kept follow-up breaks here before reaching
 * the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UNINSTALL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "uninstall.md",
);

const TEXT = readFileSync(UNINSTALL_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/uninstall.md — file hygiene", () => {
  it("uses LF line endings (no CRLF)", () => {
    expect(TEXT.includes("\r\n")).toBe(false);
  });

  it("ends with a single trailing newline", () => {
    expect(TEXT.endsWith("\n")).toBe(true);
    expect(TEXT.endsWith("\n\n\n")).toBe(false);
  });

  it("does not contain a UTF-8 BOM", () => {
    expect(TEXT.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("is at most 100 lines (SPEC §4 line 296)", () => {
    const lines = TEXT.split("\n").length;
    expect(lines).toBeLessThanOrEqual(100);
  });
});

describe("commands/lint/uninstall.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:uninstall", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:uninstall\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:uninstall slash command", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:uninstall/);
  });

  it("declares allowed-tools (SPEC §4 line 293)", () => {
    expect(frontmatter(TEXT)).toMatch(/^allowed-tools:/m);
  });

  it("allowed-tools includes Bash and AskUserQuestion (orchestrator needs both)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^allowed-tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
  });

  it("declares argument-hint advertising the optional --keep-backup flag", () => {
    // Users may type `/lint:uninstall --keep-backup` to skip the question.
    expect(frontmatter(TEXT)).toMatch(/^argument-hint:\s*\[--keep-backup\]\s*$/m);
  });
});

describe("commands/lint/uninstall.md — required sections (SPEC §4 line 295)", () => {
  // SPEC §4 line 295: "Visão Geral, Quando usar, Quando NÃO usar, Fluxo,
  // Trade-offs, Verificação". All must be H2 headings, in order.
  const REQUIRED_SECTIONS = [
    "## Visão Geral",
    "## Quando usar",
    "## Quando NÃO usar",
    "## Fluxo",
    "## Trade-offs",
    "## Verificação",
  ] as const;

  for (const heading of REQUIRED_SECTIONS) {
    it(`contains heading: ${heading}`, () => {
      expect(TEXT).toContain(`\n${heading}\n`);
    });
  }

  it("sections appear in the order required by SPEC §4 line 295", () => {
    const positions = REQUIRED_SECTIONS.map((h) => TEXT.indexOf(`\n${h}\n`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
  });
});

describe("commands/lint/uninstall.md — Resolução do CLI preamble (PLAN §190–198)", () => {
  it("references the QUALY_CLI env var with CLAUDE_PLUGIN_ROOT fallback", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types (ADR 0007)", () => {
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("links back to SKILL.md as the canonical preamble source", () => {
    // SKILL.md owns the preamble; commands/*.md should defer to it (PLAN
    // §Resolução do CLI: "definido uma vez em SKILL.md e reusado").
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("commands/lint/uninstall.md — CLI subcommand coverage (Fase 3)", () => {
  // The uninstall flow MUST consult three CLI subcommands (read manifest,
  // list backups, run lint-uninstall) plus link to /lint:rollback for restore.
  const SUBCOMMANDS = [
    "backup-list",
    "lint-uninstall",
    "git-clean-check",
  ] as const;

  for (const cmd of SUBCOMMANDS) {
    it(`mentions subcommand: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("references the .lint-manifest.json source-of-truth", () => {
    expect(TEXT).toMatch(/\.lint-manifest\.json/);
  });

  it("references the .lint-backup/ snapshot directory", () => {
    expect(TEXT).toMatch(/\.lint-backup/);
  });

  it("offers /lint:rollback as the restore follow-up (SPEC §2 escape hatch)", () => {
    // The uninstall command MUST surface rollback when snapshots remain;
    // restore is delegated, not duplicated here.
    expect(TEXT).toMatch(/\/lint:rollback/);
  });
});

describe("commands/lint/uninstall.md — manifest partitioning (uninstall.ts contract)", () => {
  // The CLI partitions manifest entries into three classes (owned files,
  // backups, merged/virtual). The .md MUST surface this partition so the
  // user understands what gets deleted vs what stays for manual cleanup.
  it("mentions --keep-backup as the backup-preservation flag", () => {
    expect(TEXT).toMatch(/--keep-backup/);
  });

  it("references merged_kept (entries surfaced for manual follow-up)", () => {
    expect(TEXT.toLowerCase()).toMatch(/merged_kept|merged.kept|merged\/virtual/);
  });

  it("explains the dep follow-up (pkg-manager remove for kind:dep entries)", () => {
    // kind:"dep" entries point at virtual paths
    // (`package.json#devDependencies/<name>`) and need the package manager
    // to actually uninstall them.
    expect(TEXT.toLowerCase()).toMatch(/(npm|pnpm|yarn|bun) remove/);
  });
});

describe("commands/lint/uninstall.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 0 to success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit code 1 to manifest_missing / remove_failed (RECOVERABLE_ERROR)", () => {
    expect(TEXT).toMatch(/`1`/);
    expect(TEXT.toLowerCase()).toMatch(/manifest_missing|manifest missing/);
  });

  it("maps exit code 3 to dirty-tree → git stash flow (SPEC §6 Always)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });
});

describe("commands/lint/uninstall.md — global conventions (SPEC §6)", () => {
  it("requires AskUserQuestion one-question-at-a-time (SPEC §4 line 330)", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("requires a plan-before-apply confirmation (SPEC §6 Always)", () => {
    expect(TEXT.toLowerCase()).toMatch(/plano antes de aplicar|imprim(ir|a) (o )?plano/);
  });
});
