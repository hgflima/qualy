/**
 * commands/lint/rollback.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 3 + SPEC §2/§6/§7.2 + PLAN §Resolução do CLI).
 *
 * `/lint:rollback` is the orchestrator that wraps the deterministic
 * `backup-restore` subcommand: it lists snapshots, asks which to apply,
 * prints a plan, then restores the user's files byte-for-byte WITHOUT
 * uninstalling oxc (escape hatch — SPEC §2 line 53).
 *
 * SPEC §4 line 296 caps the .md at 100 lines; SPEC §4 line 295 fixes the
 * required section list; PLAN §Resolução do CLI fixes the `QUALY_CLI=`
 * preamble (defined once in SKILL.md and reused here). These tests lock
 * that surface so drift in frontmatter, the snapshot-selection contract,
 * the exit-code mapping, or the relationship to /lint:uninstall breaks
 * here before reaching the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROLLBACK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "rollback.md",
);

const TEXT = readFileSync(ROLLBACK_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/rollback.md — file hygiene", () => {
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

describe("commands/lint/rollback.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:rollback", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:rollback\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:rollback slash command", () => {
    expect(frontmatter(TEXT)).toMatch(/\/lint:rollback/);
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

  it("declares argument-hint advertising the optional <timestamp> arg", () => {
    // Users may type `/lint:rollback 2026-05-03T12-00-00-000Z` to skip the
    // selection question.
    expect(frontmatter(TEXT)).toMatch(/^argument-hint:\s*\[<timestamp>\]\s*$/m);
  });
});

describe("commands/lint/rollback.md — required sections (SPEC §4 line 295)", () => {
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

describe("commands/lint/rollback.md — Resolução do CLI preamble (PLAN §190–198)", () => {
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

describe("commands/lint/rollback.md — CLI subcommand coverage (Fase 3)", () => {
  // The rollback flow MUST consult three CLI subcommands: list backups,
  // verify clean tree, and run the byte-for-byte restore.
  const SUBCOMMANDS = [
    "backup-list",
    "backup-restore",
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

  it("references the .lint-backup/<timestamp>/ snapshot directory (SPEC §2 line 53)", () => {
    expect(TEXT).toMatch(/\.lint-backup/);
  });
});

describe("commands/lint/rollback.md — escape-hatch contract (SPEC §2 line 53)", () => {
  it("mentions --ts as the snapshot selector (CLI flag)", () => {
    expect(TEXT).toMatch(/--ts/);
  });

  it("mentions --files as the subset selector (CLI flag)", () => {
    expect(TEXT).toMatch(/--files/);
  });

  it("mentions --strict for dirty-tree defense in depth", () => {
    expect(TEXT).toMatch(/--strict/);
  });

  it("clarifies it does NOT uninstall oxc (vs /lint:uninstall)", () => {
    // SPEC §2 line 53: "sem desinstalar oxc primeiro (escape hatch)".
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o desinstal|sem desinstal/);
  });

  it("offers /lint:uninstall as the follow-up when full removal is desired", () => {
    // Symmetry with commands/lint/uninstall.md which offers /lint:rollback
    // in the opposite direction.
    expect(TEXT).toMatch(/\/lint:uninstall/);
  });

  it("defaults to the most-recent snapshot (backups[0] descending)", () => {
    // SPEC §2 line 53: "Restaura o backup mais recente". The prompt MUST
    // surface this default so the user can accept it without picking a ts.
    expect(TEXT.toLowerCase()).toMatch(/mais recente|most.recent|recommended/);
  });
});

describe("commands/lint/rollback.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 0 to success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit code 1 to timestamp_not_found / backup_file_missing (RECOVERABLE_ERROR)", () => {
    expect(TEXT).toMatch(/`1`/);
    expect(TEXT.toLowerCase()).toMatch(/timestamp_not_found|backup_file_missing/);
  });

  it("maps exit code 3 to dirty-tree → git stash flow (SPEC §6 Always)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });

  it("maps exit code 4 to USAGE_ERROR (subset_not_in_backup, timestamp_empty, …)", () => {
    expect(TEXT).toMatch(/`4`/);
  });
});

describe("commands/lint/rollback.md — global conventions (SPEC §6)", () => {
  it("requires AskUserQuestion one-question-at-a-time (SPEC §4 line 330)", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
  });

  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("requires a plan-before-apply confirmation (SPEC §6 Always)", () => {
    expect(TEXT.toLowerCase()).toMatch(/imprim(ir|a) (o )?plano|plano antes de aplicar/);
  });
});
