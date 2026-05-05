/**
 * commands/lint/ignore/list.md contract tests
 * (lint-ignore SPEC §3.3 + §4.1 + PLAN T3.5).
 *
 * `/lint:ignore:list` is the read-only inventory wrapper around
 * `qualy ignore-list`: it surfaces active vs expired entries and the
 * `category_size` annotation, and only asks follow-up questions when the
 * user opts into a next step. These tests pin the markdown surface so
 * drift in frontmatter, sections, exit-code mapping, or the read-only
 * contract breaks here before reaching the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "ignore",
  "list.md",
);

const TEXT = readFileSync(LIST_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/ignore/list.md — file hygiene", () => {
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

describe("commands/lint/ignore/list.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:ignore:list", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:ignore:list\s*$/m);
  });

  it("declares an activation-cue description", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? "").trim()).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references /lint:ignore:list", () => {
    expect(frontmatter(TEXT)).toMatch(/\/lint:ignore:list/);
  });

  it("declares allowed-tools with Bash + AskUserQuestion + SlashCommand", () => {
    const tools = frontmatter(TEXT).match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? "";
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
    expect(tools).toMatch(/\bSlashCommand\b/);
  });

  it("declares argument-hint advertising --expired and --path", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/^argument-hint:.*--expired/m);
    expect(fm).toMatch(/--path/);
  });
});

describe("commands/lint/ignore/list.md — required sections", () => {
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

describe("commands/lint/ignore/list.md — CLI surface", () => {
  it("references the QUALY_CLI preamble", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types", () => {
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("delegates to ignore-list (CLI subcommand)", () => {
    expect(TEXT).toContain("ignore-list");
  });

  it("references detect-stack as the stack gate", () => {
    expect(TEXT).toContain("detect-stack");
  });

  it("does NOT call mutating subcommands (read-only)", () => {
    // Read-only: must never advise ignore-add / ignore-remove inline
    // beyond a routing suggestion. The simplest check: the Bash flow
    // section must not contain mutating subcommand names.
    const fluxo = TEXT.split("## Fluxo")[1]?.split("## Trade-offs")[0] ?? "";
    expect(fluxo).not.toMatch(/qualy ignore-add\b/);
    expect(fluxo).not.toMatch(/qualy ignore-remove\b/);
  });
});

describe("commands/lint/ignore/list.md — exit code mapping", () => {
  // Anchors mirror cli/src/commands/ignore/list.ts:
  //   0 success, 1 expired-with-flag, 70 manifest_corrupt.
  it("documents exit `0` for success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("documents exit `1` linked to --expired (CI gate, SPEC §10 #4)", () => {
    expect(TEXT).toMatch(/`1`/);
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/--expired/);
  });

  it("documents exit `70` for manifest_corrupt", () => {
    expect(TEXT).toMatch(/`70`/);
    expect(TEXT.toLowerCase()).toMatch(/manifest_corrupt/);
  });
});

describe("commands/lint/ignore/list.md — global conventions", () => {
  it("declares the supported stack envelope", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("describes category_size annotation (T3.3 — `⚠ category (N rules)`)", () => {
    // The slash must surface the `category_size` field that ignore-list
    // emits for `category:<known>` entries. Drift here breaks the visual
    // contract the user expects.
    expect(TEXT).toMatch(/category_size|category \(N rules\)|category \(\d+ rules\)/);
  });
});
