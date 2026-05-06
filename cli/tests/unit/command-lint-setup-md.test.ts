/**
 * commands/lint/setup.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §2/§7.1 + PLAN §Resolução do CLI).
 *
 * `/lint:setup` is the orchestrator for the greenfield install flow. The .md
 * file is intentionally thin — it routes user intent through `AskUserQuestion`
 * into the deterministic CLI subcommands. SPEC §4 line 296 caps it at 100
 * lines; SPEC §4 line 295 fixes the section list; PLAN §Resolução do CLI
 * fixes the `QUALY_CLI=` preamble (defined once in SKILL.md and reused here).
 *
 * These tests lock that surface: drift in frontmatter, install order, exit
 * code mapping, or required questions breaks here before reaching the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SETUP_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "setup.md",
);

const TEXT = readFileSync(SETUP_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/setup.md — file hygiene", () => {
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

describe("commands/lint/setup.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:setup", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:setup\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:setup slash command", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:setup/);
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
});

describe("commands/lint/setup.md — required sections (SPEC §4 line 295)", () => {
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

describe("commands/lint/setup.md — Resolução do CLI preamble (ADR 0013)", () => {
  it("uses the canonical $PWD → $HOME probe block (ADR 0013)", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI=""\nfor cand in "\$PWD\/\.claude" "\$HOME\/\.claude"; do\n {2}\[ -f "\$cand\/skills\/lint\/cli\/src\/index\.ts" \] && QUALY_CLI="\$cand\/skills\/lint\/cli\/src\/index\.ts" && break\ndone/,
    );
  });

  it("fails with exit 5 (MISSING_DEP) when the probe finds nothing", () => {
    expect(TEXT).toMatch(
      /\[ -z "\$QUALY_CLI" \] && \{ echo "qualy CLI not found in \\\$PWD\/\.claude or \\\$HOME\/\.claude\. Run \\`qualy install\\` first\." >&2; exit 5; \}/,
    );
  });

  it("does not reference the legacy CLAUDE_PLUGIN_ROOT env var (ADR 0013)", () => {
    expect(TEXT).not.toMatch(/CLAUDE_PLUGIN_ROOT/);
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

describe("commands/lint/setup.md — detection step coverage (SPEC §7.1)", () => {
  // The setup flow MUST consult every Phase 1 detector before writing.
  const DETECTORS = [
    "detect-stack",
    "git-clean-check",
    "detect-existing-linter",
    "detect-test-runner",
    "detect-stage",
  ] as const;

  for (const cmd of DETECTORS) {
    it(`mentions detector: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }
});

describe("commands/lint/setup.md — install order (SPEC §7.1)", () => {
  // SPEC §7.1 enumerates the artifacts; PLAN §Fase 2 fixes the deterministic
  // ordering (deps → presets → hook → husky → coverage → scripts). install-deps
  // must come first because every later subcommand depends on the binaries it
  // installs; install-scripts last because it merges paths to oxlint binaries.
  const INSTALL_ORDER = [
    "install-deps",
    "install-oxlint",
    "install-hook",
    "install-husky",
    "install-coverage",
    "install-scripts",
  ] as const;

  for (const cmd of INSTALL_ORDER) {
    it(`mentions installer: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("installers appear in the deterministic order required by PLAN §Fase 2", () => {
    const positions = INSTALL_ORDER.map((cmd) => TEXT.indexOf(cmd));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
    for (const p of positions) {
      expect(p).toBeGreaterThan(-1);
    }
  });
});

describe("commands/lint/setup.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 2 to unsupported-stack refusal (SPEC §1)", () => {
    expect(TEXT).toMatch(/`2`/);
  });

  it("maps exit code 3 to dirty-tree → git stash flow (SPEC §6 Always)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });
});

describe("commands/lint/setup.md — global conventions (SPEC §6)", () => {
  it("requires AskUserQuestion one-question-at-a-time (SPEC §4 line 330)", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    // "Nunca commitar automaticamente as mudanças do setup".
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("requires --strict on writes (defense-in-depth over git-clean-check)", () => {
    expect(TEXT).toMatch(/--strict/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("enumerates the three stage names from detect-stage", () => {
    expect(TEXT).toMatch(/greenfield/);
    expect(TEXT).toMatch(/brownfield-moderate/);
    expect(TEXT).toMatch(/legacy/);
  });

  it("defers existing-linter substitution to /lint:rollback or migrator (SPEC §7.2)", () => {
    // The setup command must NOT directly delete user configs — that's the
    // migrator's job in Phase 3. Check we route there instead.
    expect(TEXT).toMatch(/\/lint:rollback|lint-migrator/);
  });
});
