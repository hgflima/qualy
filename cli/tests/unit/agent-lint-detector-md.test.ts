/**
 * agents/lint-detector.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §2/§4 Subagents + PLAN §Resolução do CLI).
 *
 * `lint-detector` is the read-only Phase 1 wrapper subagent. The .md file is
 * intentionally thin — it routes the parent agent through the five `detect-*`
 * CLI subcommands and emits a fixed structured summary (≤30 lines, SPEC §4
 * line 303). SPEC §4 line 296 caps the file at 150 lines; SPEC §4 line 295
 * fixes the section list; PLAN §Resolução do CLI fixes the `QUALY_CLI=`
 * preamble (defined once in SKILL.md and reused here).
 *
 * These tests lock that surface: drift in frontmatter, detector list,
 * read-only contract, summary budget, or section order breaks here before
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
  "lint-detector.md",
);

const TEXT = readFileSync(AGENT_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("agents/lint-detector.md — file hygiene", () => {
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

describe("agents/lint-detector.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint-detector", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint-detector\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references at least one /lint:* slash command (caller surface)", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:(setup|status|audit|update)/);
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

  it("tools is read-only — no Write/Edit/MultiEdit (SPEC §4 line 302)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).not.toMatch(/\bWrite\b/);
    expect(tools).not.toMatch(/\bEdit\b/);
    expect(tools).not.toMatch(/\bMultiEdit\b/);
  });
});

describe("agents/lint-detector.md — required sections (SPEC §4 line 295)", () => {
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

describe("agents/lint-detector.md — Resolução do CLI preamble (ADR 0013)", () => {
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
    // SKILL.md owns the preamble; agents/*.md should defer to it (PLAN
    // §Resolução do CLI: "definido uma vez em SKILL.md e reusado").
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("agents/lint-detector.md — detector coverage (PLAN §Fase 1)", () => {
  // The Phase 1 detection sequence MUST exercise every read-only detector
  // shipped by the CLI in cli/src/commands/.
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

  it("detectors appear in canonical detection order (stack → git → linter → runner → stage)", () => {
    // PLAN §Fase 1 + commands/lint/setup.md fix this ordering: stack first
    // (cheapest abort), then git-clean (cheap recoverable), then linter +
    // runner (parallelizable inputs), and stage last (depends on git history).
    const positions = DETECTORS.map((cmd) => TEXT.indexOf(cmd));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
    for (const p of positions) {
      expect(p).toBeGreaterThan(-1);
    }
  });
});

describe("agents/lint-detector.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("documents exit `2` (unsupported-stack) early-exit (SPEC §1)", () => {
    expect(TEXT).toMatch(/`2`/);
    expect(TEXT.toLowerCase()).toMatch(/unsupported|n[ãa]o suportad/);
  });

  it("documents exit `3` (dirty-tree) does NOT abort detection", () => {
    // The detector must keep gathering signals even when the tree is dirty —
    // information is cheap; the parent decides whether to halt the flow.
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/dirty|sujo/);
  });
});

describe("agents/lint-detector.md — summary contract (SPEC §4 line 303)", () => {
  it("declares the ≤30-line summary budget", () => {
    expect(TEXT).toMatch(/≤\s*30/);
  });

  it("declares the read-only contract (no install / no migrate)", () => {
    // SPEC §4 line 302: detector tools must be read-only; SPEC §4 separates
    // detector / installer / migrator responsibilities.
    expect(TEXT.toLowerCase()).toMatch(/read-only/);
    expect(TEXT.toLowerCase()).toMatch(/n(ã|a)o (modifica|escreve|instala)/);
  });

  it("enumerates the three stage names from detect-stage", () => {
    expect(TEXT).toMatch(/greenfield/);
    expect(TEXT).toMatch(/brownfield-moderate/);
    expect(TEXT).toMatch(/legacy/);
  });

  it("enumerates the three runner values from detect-test-runner", () => {
    expect(TEXT).toMatch(/vitest/);
    expect(TEXT).toMatch(/jest/);
    expect(TEXT).toMatch(/\bnone\b/);
  });

  it("requires raw signals to back the stage classification (SPEC §6 Always)", () => {
    // SPEC §6 Always: "justificar com sinais brutos coletados". The detector
    // must surface them so the user can disagree with evidence.
    expect(TEXT.toLowerCase()).toMatch(/sinais brutos|signals/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("delegates writes to lint-installer or lint-migrator (SPEC §4 line 302)", () => {
    // The detector must NOT do install or migrate work — only point at the
    // sibling subagents. This is the read-only contract made explicit.
    expect(TEXT).toMatch(/lint-installer/);
    expect(TEXT).toMatch(/lint-migrator/);
  });
});
