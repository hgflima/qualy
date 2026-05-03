/**
 * agents/lint-migrator.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 3 + SPEC §2/§4 Subagents + PLAN §Resolução do CLI).
 *
 * `lint-migrator` is the Phase 3 wrapper subagent that drives the four
 * backup/uninstall CLI subcommands (`backup-create`, `backup-list`,
 * `backup-restore`, `uninstall`) for three discriminated modes
 * (`migrate | restore | uninstall`). SPEC §4 line 296 caps the file at 150
 * lines; SPEC §4 line 295 fixes the section list; PLAN §Resolução do CLI
 * fixes the `QUALY_CLI=` preamble (defined once in SKILL.md and reused
 * here); SPEC §4 line 303 caps the structured summary at ≤30 lines.
 *
 * These tests lock that surface: drift in frontmatter, mode list, CLI
 * subcommand coverage, summary budget, or section order breaks here before
 * landing in the parent skill.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "agents",
  "lint-migrator.md",
);

const TEXT = readFileSync(AGENT_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("agents/lint-migrator.md — file hygiene", () => {
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

  it("is at most 150 lines (SPEC §4 line 296)", () => {
    const lines = TEXT.split("\n").length;
    expect(lines).toBeLessThanOrEqual(150);
  });
});

describe("agents/lint-migrator.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint-migrator", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint-migrator\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the three caller slash commands (SPEC §2)", () => {
    // SPEC §2: lint-migrator is invoked by /lint:setup (migration mode),
    // /lint:rollback (restore), and /lint:uninstall.
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:setup/);
    expect(fm).toMatch(/\/lint:rollback/);
    expect(fm).toMatch(/\/lint:uninstall/);
  });

  it("declares tools (Claude Code subagent frontmatter)", () => {
    expect(frontmatter(TEXT)).toMatch(/^tools:/m);
  });

  it("tools includes Bash (subagent invokes the CLI)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bBash\b/);
  });

  it("tools does NOT include Write/Edit/MultiEdit (writes via CLI — ADR 0006)", () => {
    // ADR 0006: deterministic CLI / thin harness. The migrator must NOT edit
    // files directly — every mutation flows through `safeWriteFile` in the
    // CLI so .lint-manifest.json stays authoritative.
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).not.toMatch(/\bWrite\b/);
    expect(tools).not.toMatch(/\bEdit\b/);
    expect(tools).not.toMatch(/\bMultiEdit\b/);
  });
});

describe("agents/lint-migrator.md — required sections (SPEC §4 line 295)", () => {
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

describe("agents/lint-migrator.md — Resolução do CLI preamble (PLAN §190–198)", () => {
  it("references the QUALY_CLI env var with CLAUDE_PLUGIN_ROOT fallback", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types (ADR 0007)", () => {
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("links back to SKILL.md as the canonical preamble source", () => {
    // SKILL.md owns the preamble; agents/*.md should defer to it (PLAN
    // §Resolução do CLI: "definido uma vez em SKILL.md e reusado").
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("agents/lint-migrator.md — CLI subcommand coverage (PLAN §Fase 3)", () => {
  // The Phase 3 migration sequence MUST exercise every backup/uninstall
  // subcommand shipped by the CLI in cli/src/commands/.
  const SUBCOMMANDS = [
    "backup-create",
    "backup-list",
    "backup-restore",
    "uninstall",
  ] as const;

  for (const cmd of SUBCOMMANDS) {
    it(`mentions CLI subcommand: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("references the `.lint-manifest.json` source of truth", () => {
    // All three modes hinge on the manifest: migrate appends `kind:"backup"`,
    // restore preserves entries via skipManifest, uninstall partitions by kind.
    expect(TEXT).toMatch(/\.lint-manifest\.json/);
  });

  it("references the `.lint-backup/` directory layout (SPEC §6 Always)", () => {
    // SPEC §6 Always: "criar `.lint-backup/<ISO-timestamp>/` antes de remover
    // ou sobrescrever". The migrator must surface that path so the parent
    // can guide the user.
    expect(TEXT).toMatch(/\.lint-backup/);
  });
});

describe("agents/lint-migrator.md — three migration modes (SPEC §2 callers)", () => {
  // SPEC §2: lint-migrator is the subagent for /lint:setup (when a previous
  // linter exists), /lint:rollback (restore), and /lint:uninstall. The .md
  // must surface these as discriminated modes so the parent passes a clear
  // intent instead of inferring from flags.
  const MODES = ["migrate", "restore", "uninstall"] as const;

  for (const mode of MODES) {
    it(`documents mode: ${mode}`, () => {
      expect(TEXT.toLowerCase()).toMatch(new RegExp(`\\b${mode}\\b`));
    });
  }

  it("modes appear in canonical order (migrate → restore → uninstall)", () => {
    // The order mirrors the phase lifecycle: migrate happens during setup
    // (linter prévio detectado), restore is the escape hatch, uninstall is
    // the terminal teardown. Reordering requires a patch + test. Anchored
    // to the `**Modo \`<name>\`**` label (the unique mode header used in
    // Quando usar) so bare mentions of `uninstall` as a CLI subcommand in
    // Visão Geral don't perturb the ordering.
    const lower = TEXT.toLowerCase();
    const positions = MODES.map((m) => lower.indexOf(`**modo \`${m}\`**`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
    for (const p of positions) {
      expect(p).toBeGreaterThan(-1);
    }
  });

  it("documents the `--keep-backup` flag for the uninstall mode", () => {
    // /lint:uninstall surfaces `--keep-backup` via Pergunta 1 (Recommended:
    // preservar). The migrator must accept that decision and propagate.
    expect(TEXT).toMatch(/--keep-backup/);
  });
});

describe("agents/lint-migrator.md — exit handling and strict mode", () => {
  it("documents `--strict` propagation to the write subcommands", () => {
    expect(TEXT).toMatch(/--strict/);
  });

  it("documents abort-on-first-failure semantics", () => {
    // Parent must be able to trust that a non-zero exit halts the rest;
    // partial state is preserved in `.lint-manifest.json` for /lint:rollback.
    expect(TEXT.toLowerCase()).toMatch(/aborta|abort|falha|failed/);
  });
});

describe("agents/lint-migrator.md — summary contract (SPEC §4 line 303)", () => {
  it("declares the ≤30-line summary budget", () => {
    expect(TEXT).toMatch(/≤\s*30/);
  });

  it("delegates detection and installation to sibling subagents (SPEC §4 line 302)", () => {
    // The migrator must NOT do detection or installation work — only point at
    // the sibling subagents. Single responsibility (SPEC §4 line 301).
    expect(TEXT).toMatch(/lint-detector/);
    expect(TEXT).toMatch(/lint-installer/);
  });

  it("declares writes go through the CLI, not direct Write/Edit (ADR 0006)", () => {
    // ADR 0006: deterministic CLI / thin harness. The subagent must call
    // backup/uninstall via Bash, not edit files directly. This makes the
    // operations byte-exact via .lint-manifest.json.
    expect(TEXT.toLowerCase()).toMatch(/cli|adr 0006/);
  });

  it("references the SPEC §7.2 byte-for-byte acceptance criterion", () => {
    // SPEC §7.2: brownfield-eslint-prettier setup → rollback restores
    // byte-for-byte. The migrator is the subagent that makes that work.
    expect(TEXT).toMatch(/§7\.2|byte-a-byte|byte-for-byte/);
  });
});
