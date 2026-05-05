/**
 * commands/lint/ignore/remove.md contract tests
 * (lint-ignore SPEC §3.2 + §4.1 + §6 + PLAN T3.5).
 *
 * `/lint:ignore:remove` is the mutating remover that wraps `qualy ignore-
 * remove`. SPEC §6 Always: every removal records a non-trivial reason —
 * `--reason` is mandatory and the slash must capture it via
 * `AskUserQuestion` before any write. The slash must also surface the
 * blast radius (verbal in P3, real in T4.3 with `ignore-blast-radius`)
 * before confirming, refuse dirty trees with `--strict` (offers `git
 * stash`), and disambiguate `entry_ambiguous` matches via `--rule`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REMOVE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "ignore",
  "remove.md",
);

const TEXT = readFileSync(REMOVE_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/ignore/remove.md — file hygiene", () => {
  it("uses LF line endings", () => {
    expect(TEXT.includes("\r\n")).toBe(false);
  });

  it("ends with a single trailing newline", () => {
    expect(TEXT.endsWith("\n")).toBe(true);
    expect(TEXT.endsWith("\n\n\n")).toBe(false);
  });

  it("does not contain a UTF-8 BOM", () => {
    expect(TEXT.charCodeAt(0)).not.toBe(0xfeff);
  });
});

describe("commands/lint/ignore/remove.md — YAML frontmatter", () => {
  it("starts with ---", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:ignore:remove", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:ignore:remove\s*$/m);
  });

  it("declares an activation-cue description", () => {
    const match = frontmatter(TEXT).match(/^description:\s*(.+)$/m);
    expect((match?.[1] ?? "").trim()).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references /lint:ignore:remove and mandatory --reason", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:ignore:remove/);
    expect(fm).toMatch(/--reason.*mandatory|mandatory.*--reason/i);
  });

  it("declares allowed-tools with Bash + AskUserQuestion + SlashCommand", () => {
    const tools = frontmatter(TEXT).match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? "";
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
    expect(tools).toMatch(/\bSlashCommand\b/);
  });

  it("declares argument-hint advertising <glob>, --rule, --reason", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/^argument-hint:.*<glob>/m);
    expect(fm).toMatch(/--rule/);
    expect(fm).toMatch(/--reason/);
  });
});

describe("commands/lint/ignore/remove.md — required sections", () => {
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

  it("sections appear in the canonical order", () => {
    const positions = REQUIRED_SECTIONS.map((h) => TEXT.indexOf(`\n${h}\n`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
  });
});

describe("commands/lint/ignore/remove.md — CLI surface", () => {
  it("references the QUALY_CLI preamble", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("delegates to ignore-remove (CLI subcommand)", () => {
    expect(TEXT).toContain("ignore-remove");
  });

  it("references detect-stack and git-clean-check pre-checks", () => {
    expect(TEXT).toContain("detect-stack");
    expect(TEXT).toContain("git-clean-check");
  });

  it("references ignore-explain for blast-radius preview", () => {
    expect(TEXT).toContain("ignore-explain");
  });
});

describe("commands/lint/ignore/remove.md — reason mandatory + blast radius", () => {
  it("requires AskUserQuestion to capture --reason (SPEC §6 Always)", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("documents reason_required exit branch", () => {
    expect(TEXT).toMatch(/reason_required/);
  });

  it("captures motive BEFORE the confirmation question", () => {
    // The flow must order: ask reason (Pergunta 1) → ask confirm (Pergunta 2).
    const lower = TEXT.toLowerCase();
    const reasonIdx = lower.indexOf("pergunta 1");
    const confirmIdx = lower.indexOf("pergunta 2");
    expect(reasonIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(reasonIdx);
  });

  it("documents blast radius messaging before destructive action", () => {
    // P3 surface: verbal blast radius ("expõe novos arquivos ao lint").
    // T4.3 will land the count + sample via `ignore-blast-radius`.
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/blast.radius|exp[oõ]e .* arquivos|arquivos.*lint/);
  });
});

describe("commands/lint/ignore/remove.md — ambiguity branch", () => {
  it("documents entry_ambiguous → ask --rule via AskUserQuestion", () => {
    expect(TEXT.toLowerCase()).toMatch(/entry_ambiguous|ambig/);
    expect(TEXT).toMatch(/--rule/);
  });

  it("mentions `--rule path` synonym for path-only entries", () => {
    expect(TEXT).toContain("--rule path");
  });
});

describe("commands/lint/ignore/remove.md — exit code mapping", () => {
  it("maps exit `0` to success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit `1` to recoverable errors (reason/not_found/ambiguous)", () => {
    expect(TEXT).toMatch(/`1`/);
  });

  it("maps exit `2` to unsupported stack", () => {
    expect(TEXT).toMatch(/`2`/);
  });

  it("maps exit `3` to dirty-tree → git stash flow (--strict)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });

  it("maps exit `70` to manifest_corrupt", () => {
    expect(TEXT).toMatch(/`70`/);
    expect(TEXT.toLowerCase()).toMatch(/manifest_corrupt/);
  });
});

describe("commands/lint/ignore/remove.md — global conventions", () => {
  it("forbids automatic commits (SPEC §6 Never)", () => {
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("declares the supported stack envelope", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("references the decision-log path", () => {
    expect(TEXT).toMatch(/\.harn\/qualy\/docs\/lint-decisions\.md/);
  });
});
