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

  it("is at most 130 lines (Phase 3 added rule/category/import flows)", () => {
    const lines = TEXT.split("\n").length;
    expect(lines).toBeLessThanOrEqual(130);
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

describe("commands/lint/ignore/add.md — Resolução do CLI preamble (ADR 0013)", () => {
  it("uses the canonical $QUALY_DEV_BIN → $PWD → $HOME probe block (cli-bin-resolution SPEC §4)", () => {
    expect(TEXT).toContain('QUALY_BIN=""');
    expect(TEXT).toContain(
      '[ -n "$QUALY_DEV_BIN" ] && [ -f "$QUALY_DEV_BIN" ] && QUALY_BIN="$QUALY_DEV_BIN"',
    );
    expect(TEXT).toContain(
      '"$PWD/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"',
    );
    expect(TEXT).toContain(
      '"$HOME/.claude/skills/lint/node_modules/@hgflima/qualy/bin/qualy.mjs"',
    );
  });

  it("fails with exit 5 (MISSING_DEP) when the probe finds nothing", () => {
    expect(TEXT).toContain(
      '[ -z "$QUALY_BIN" ] && { echo "qualy not installed. Run \\`npx @hgflima/qualy install\\` first." >&2; exit 5; }',
    );
  });

  it("does not reference the legacy CLAUDE_PLUGIN_ROOT env var (ADR 0013)", () => {
    expect(TEXT).not.toMatch(/CLAUDE_PLUGIN_ROOT/);
  });

  it("does not reference the legacy QUALY_CLI variable (cli-bin-resolution v0.3.4)", () => {
    expect(TEXT).not.toMatch(/QUALY_CLI/);
    expect(TEXT).not.toMatch(/cli\/src\/index\.ts/);
  });

  it("invokes the materialized bin via `node \"$QUALY_BIN\"` (cli-bin-resolution SPEC §4)", () => {
    expect(TEXT).toContain('node "$QUALY_BIN"');
  });

  it("links back to SKILL.md as the canonical preamble source", () => {
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("commands/lint/ignore/add.md — CLI subcommand coverage (Phase 3)", () => {
  // Phase 3 flow consults: detect-stack (refuse), git-clean-check (--strict
  // gate), ignore-import-preview (≥5 brownfield import threshold — T3.4b),
  // category-info (category-rule blast radius — T3.5), ignore-blast-radius
  // (path-glob blast radius — T4.3), ignore-add (mutating write).
  const SUBCOMMANDS = [
    "detect-stack",
    "git-clean-check",
    "ignore-import-preview",
    "category-info",
    "ignore-blast-radius",
    "ignore-add",
  ] as const;

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

  it("wires --rule with quality-metrics + category options (Phase 3 — T3.3 + T3.5)", () => {
    const fluxo = TEXT.split("## Fluxo")[1]?.split("## Trade-offs")[0] ?? "";
    // Phase 3 surface must promise per-rule (quality-metrics/<rule>) AND
    // category (category:<name>) variants in the flow body.
    expect(fluxo).toMatch(/--rule/);
    expect(fluxo).toMatch(/quality-metrics/);
    expect(fluxo).toMatch(/category:/);
  });

  it("documents the category acknowledgement flag (SPEC §3.1.1)", () => {
    expect(TEXT).toMatch(/--i-know-this-disables-many/);
  });

  it("documents the brownfield import threshold (≥5 — T3.4b)", () => {
    // The slash command must call ignore-import-preview before the mutating
    // `ignore-add`, gating an AskUserQuestion at the ≥5 patterns threshold
    // (SPEC §8.2 deferred resolution).
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/ignore-import-preview/);
    expect(TEXT).toMatch(/[\s>]5\b|\b5 patterns/);
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
