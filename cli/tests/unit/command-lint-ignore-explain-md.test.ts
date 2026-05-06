/**
 * commands/lint/ignore/explain.md contract tests
 * (lint-ignore SPEC §3.4 + §4.1 + PLAN T3.5).
 *
 * `/lint:ignore:explain` is the read-only single-entry inspector wrapping
 * `qualy ignore-explain`. It must surface the `(glob, rule)` resolution,
 * the ambiguity branch (ask `--rule` to disambiguate), the exit-code
 * mapping (1 not_found / ambiguous, 70 manifest_corrupt), and remain
 * read-only by default.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXPLAIN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "ignore",
  "explain.md",
);

const TEXT = readFileSync(EXPLAIN_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/ignore/explain.md — file hygiene", () => {
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

describe("commands/lint/ignore/explain.md — YAML frontmatter", () => {
  it("starts with ---", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:ignore:explain", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:ignore:explain\s*$/m);
  });

  it("declares an activation-cue description", () => {
    const match = frontmatter(TEXT).match(/^description:\s*(.+)$/m);
    expect((match?.[1] ?? "").trim()).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references /lint:ignore:explain", () => {
    expect(frontmatter(TEXT)).toMatch(/\/lint:ignore:explain/);
  });

  it("declares allowed-tools with Bash + AskUserQuestion + SlashCommand", () => {
    const tools = frontmatter(TEXT).match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? "";
    expect(tools).toMatch(/\bBash\b/);
    expect(tools).toMatch(/\bAskUserQuestion\b/);
    expect(tools).toMatch(/\bSlashCommand\b/);
  });

  it("declares argument-hint advertising <glob> and --rule", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/^argument-hint:.*<glob>/m);
    expect(fm).toMatch(/--rule/);
  });
});

describe("commands/lint/ignore/explain.md — required sections", () => {
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

describe("commands/lint/ignore/explain.md — CLI surface", () => {
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

  it("delegates to ignore-explain (CLI subcommand)", () => {
    expect(TEXT).toContain("ignore-explain");
  });

  it("references detect-stack", () => {
    expect(TEXT).toContain("detect-stack");
  });

  it("does NOT mutate state (read-only) — no ignore-add/remove in flow", () => {
    const fluxo = TEXT.split("## Fluxo")[1]?.split("## Trade-offs")[0] ?? "";
    expect(fluxo).not.toMatch(/qualy ignore-add\b/);
    expect(fluxo).not.toMatch(/qualy ignore-remove\b/);
  });
});

describe("commands/lint/ignore/explain.md — ambiguity branch", () => {
  it("documents entry_ambiguous → ask --rule via AskUserQuestion", () => {
    // SPEC §3.4: when the glob matches multiple entries, the slash must
    // ask the user via AskUserQuestion which one to inspect, then re-run
    // ignore-explain with --rule.
    const lower = TEXT.toLowerCase();
    expect(lower).toMatch(/entry_ambiguous|ambig/);
    expect(TEXT).toMatch(/--rule/);
  });

  it("mentions `--rule path` synonym for path-only entries", () => {
    expect(TEXT).toContain("--rule path");
  });

  it("mentions entry_not_found path", () => {
    expect(TEXT.toLowerCase()).toMatch(/entry_not_found|not[ -]found/);
  });
});

describe("commands/lint/ignore/explain.md — exit code mapping", () => {
  it("maps exit `0` to success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit `1` to entry_not_found / entry_ambiguous", () => {
    expect(TEXT).toMatch(/`1`/);
  });

  it("maps exit `70` to manifest_corrupt", () => {
    expect(TEXT).toMatch(/`70`/);
    expect(TEXT.toLowerCase()).toMatch(/manifest_corrupt/);
  });
});

describe("commands/lint/ignore/explain.md — global conventions", () => {
  it("declares the supported stack envelope", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("references the decision-log path", () => {
    expect(TEXT).toMatch(/\.harn\/qualy\/docs\/lint-decisions\.md/);
  });
});
