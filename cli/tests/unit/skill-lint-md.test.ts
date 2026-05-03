/**
 * skills/lint/SKILL.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §4 + PLAN §Resolução do CLI).
 *
 * The SKILL.md is the conversational router for the `/lint` family.
 * SPEC §4 line 296 caps it at 200 lines and demands YAML frontmatter
 * (name + description + allowed-tools); PLAN §190–198 requires that
 * the canonical CLI invocation pattern (`QUALY_CLI=...` + node
 * --experimental-strip-types) be defined once here and reused by
 * every command/agent `.md`.
 *
 * These tests lock that surface: drift in the frontmatter, the
 * preamble, the section list, or the line budget breaks here before
 * landing in the user-facing skill.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "skills",
  "lint",
  "SKILL.md",
);

const TEXT = readFileSync(SKILL_PATH, "utf8");

function frontmatter(text: string): string {
  // SPEC §4: "YAML frontmatter sempre em primeiro lugar".
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("skills/lint/SKILL.md — file hygiene", () => {
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

  it("is at most 200 lines (SPEC §4 line 296)", () => {
    const lines = TEXT.split("\n").length;
    expect(lines).toBeLessThanOrEqual(200);
  });
});

describe("skills/lint/SKILL.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    // SPEC §4: 'description deve começar pela ativação ("Use when…", "Triggered by…")'.
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint slash command surface", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/`?\/lint:setup`?/);
  });

  it("declares allowed-tools (SPEC §4 line 293)", () => {
    expect(frontmatter(TEXT)).toMatch(/^allowed-tools:/m);
  });

  it("allowed-tools includes Bash and AskUserQuestion (router needs both)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^allowed-tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
  });
});

describe("skills/lint/SKILL.md — required sections (SPEC §4 line 295)", () => {
  // SPEC §4 line 295 lists "Visão Geral, Quando usar, Quando NÃO usar, Fluxo,
  // Trade-offs, Verificação". Every one must appear as an H2 heading.
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

describe("skills/lint/SKILL.md — Resolução do CLI preamble (PLAN §190–198)", () => {
  it("defines the QUALY_CLI env var with CLAUDE_PLUGIN_ROOT fallback to $HOME/.claude", () => {
    // PLAN line 196: QUALY_CLI="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/lint/cli/src/index.ts"
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types (ADR 0007)", () => {
    // PLAN line 198: node --experimental-strip-types "$QUALY_CLI" <subcommand>
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("documents the canonical CLI output discipline (stdout JSON + stderr NDJSON)", () => {
    // PLAN §Princípios line 47: "JSON em stdout, erros em stderr".
    expect(TEXT).toMatch(/stdout/i);
    expect(TEXT).toMatch(/stderr/i);
  });

  it("documents the semantic exit-code map (matches lib/exit-codes.ts)", () => {
    // From cli/src/lib/exit-codes.ts: 0/1/2/3/4/5/70.
    expect(TEXT).toMatch(/`0`/);
    expect(TEXT).toMatch(/`2`/); // unsupported-stack
    expect(TEXT).toMatch(/`3`/); // dirty-tree
  });
});

describe("skills/lint/SKILL.md — routing surface", () => {
  // SPEC §2 lists the slash command family. The router must enumerate them
  // so the model can pick one without hallucinating.
  const COMMANDS = [
    "/lint:setup",
    "/lint:audit",
    "/lint:update",
    "/lint:report",
    "/lint:status",
    "/lint:uninstall",
    "/lint:rollback",
  ] as const;

  for (const cmd of COMMANDS) {
    it(`mentions ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("mentions the four rules subcommands", () => {
    for (const sub of ["list", "add", "remove", "explain"]) {
      expect(TEXT).toMatch(new RegExp(`/lint:rules:${sub}\\b`));
    }
  });
});

describe("skills/lint/SKILL.md — global conventions (SPEC §6)", () => {
  it("requires AskUserQuestion one-question-at-a-time (SPEC §4 line 330)", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("requires named backups before destructive substitution (SPEC §6 Always)", () => {
    expect(TEXT).toMatch(/\.lint-backup/);
  });

  it("requires append-only decision log (SPEC §4 line 315)", () => {
    expect(TEXT).toMatch(/lint-decisions\.md/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });
});
