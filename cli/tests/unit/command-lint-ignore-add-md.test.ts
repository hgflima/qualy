/**
 * commands/lint/ignore/add.md contract tests
 * (lint-ignore SPEC §4.1 + PLAN T2.7).
 *
 * `/lint:ignore:add` is the orchestrator that wraps `qualy ignore-add`:
 * it captures glob → reason → expires via AskUserQuestion (one question
 * at a time), refuses unsupported stacks, refuses dirty trees with
 * `--strict` (offers `git stash`), and delegates the write to the CLI
 * (ADR 0006). Phase 2 is path-only — no `--rule` semantics yet.
 *
 * These tests lock the markdown surface so drift in frontmatter, the
 * required sections, the question contract, or the exit-code mapping
 * breaks here before reaching the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ADD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "ignore",
  "add.md",
);

const TEXT = readFileSync(ADD_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/ignore/add.md — file hygiene", () => {
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

  it("is at most 100 lines (parity with /lint:rules:add)", () => {
    const lines = TEXT.split("\n").length;
    expect(lines).toBeLessThanOrEqual(100);
  });
});

describe("commands/lint/ignore/add.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:ignore:add", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:ignore:add\s*$/m);
  });

  it("declares a description that begins with an activation cue", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:ignore:add slash command", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:ignore:add/);
  });

  it("declares allowed-tools with Bash and AskUserQuestion", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^allowed-tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
  });

  it("declares argument-hint advertising glob + flags", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/^argument-hint:.*<glob>/m);
    expect(fm).toMatch(/--reason/);
    expect(fm).toMatch(/--expires/);
  });
});

describe("commands/lint/ignore/add.md — required sections", () => {
  // Mirrors the SPEC §4 line 295 list (parity with /lint:rules:add and
  // /lint:uninstall): Visão Geral → Quando usar → Quando NÃO usar → Fluxo
  // → Trade-offs → Verificação. All H2, in order.
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

describe("commands/lint/ignore/add.md — Resolução do CLI preamble", () => {
  it("references the QUALY_CLI env var with CLAUDE_PLUGIN_ROOT fallback", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types (ADR 0007)", () => {
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("links back to SKILL.md as the canonical preamble source", () => {
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("commands/lint/ignore/add.md — CLI subcommand coverage (Phase 2)", () => {
  // Path-only flow consults: detect-stack (refuse), git-clean-check
  // (--strict gate), ignore-add (mutating write).
  const SUBCOMMANDS = ["detect-stack", "git-clean-check", "ignore-add"] as const;

  for (const cmd of SUBCOMMANDS) {
    it(`mentions subcommand: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("references the .harn/qualy/ignore.json manifest", () => {
    expect(TEXT).toMatch(/\.harn\/qualy\/ignore\.json/);
  });

  it("references the .harn/qualy/docs/lint-decisions.md decision log", () => {
    expect(TEXT).toMatch(/\.harn\/qualy\/docs\/lint-decisions\.md/);
  });

  it("does NOT wire --rule yet (path-only Phase 2 — SPEC §3.1)", () => {
    // T3.3 will introduce per-rule semantics; the Phase 2 surface must
    // not promise it. The flag string can be mentioned only in a
    // forward-looking note, never as an active step.
    const fluxo = TEXT.split("## Fluxo")[1]?.split("## Trade-offs")[0] ?? "";
    expect(fluxo).not.toMatch(/--rule\s+\S/);
  });
});

describe("commands/lint/ignore/add.md — AskUserQuestion flow (SPEC §4.1)", () => {
  it("requires AskUserQuestion one-question-at-a-time", () => {
    expect(TEXT).toMatch(/AskUserQuestion/);
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("captures reason via AskUserQuestion with at least 4 options", () => {
    // SPEC §4.1: legacy code / generated code / vendored code / Other.
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/legacy/);
    expect(lower).toMatch(/generated/);
    expect(lower).toMatch(/vendored/);
    expect(lower).toMatch(/other|outro/);
  });

  it("captures expires via AskUserQuestion (No expiry / 90d / 180d / custom)", () => {
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/expires|expiry|expir/);
    expect(lower).toMatch(/no expiry|sem expir|sem expiração/);
    expect(lower).toMatch(/90/);
    expect(lower).toMatch(/180/);
  });
});

describe("commands/lint/ignore/add.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 0 to success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit code 1 to recoverable errors (invalid glob / reason / expires)", () => {
    expect(TEXT).toMatch(/`1`/);
  });

  it("maps exit code 2 to unsupported stack (detect-stack refusal)", () => {
    expect(TEXT).toMatch(/`2`/);
  });

  it("maps exit code 3 to dirty-tree → git stash flow (--strict)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });

  it("maps exit code 70 to manifest_corrupt (T2.8 contract)", () => {
    expect(TEXT).toMatch(/`70`/);
    expect(TEXT.toLowerCase()).toMatch(/manifest_corrupt|manifesto corromp/);
  });
});

describe("commands/lint/ignore/add.md — global conventions", () => {
  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("declares the supported stack envelope", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("requires reason as mandatory metadata (SPEC §3.1 + §6)", () => {
    expect(TEXT.toLowerCase()).toMatch(/reason.*(obrigat|mandatory|required)/);
  });
});
