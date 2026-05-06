/**
 * agents/lint-installer.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §2/§4 Subagents + PLAN §Resolução do CLI).
 *
 * `lint-installer` is the Phase 2 wrapper subagent that drives the six
 * `install-*` CLI subcommands (deps → oxlint → hook → husky → coverage →
 * scripts) in deterministic order with per-layer opt-out. SPEC §4 line 296
 * caps the file at 150 lines; SPEC §4 line 295 fixes the section list;
 * PLAN §Resolução do CLI fixes the `QUALY_BIN=` preamble (defined once in
 * SKILL.md and reused here; canonical block updated in v0.3.4 — see
 * .harn/docs/cli-bin-resolution/SPEC.md §4); SPEC §4 line 303 caps the
 * structured summary at ≤30 lines.
 *
 * These tests lock that surface: drift in frontmatter, layer list, layer
 * order, opt-out language, summary budget, or section order breaks here
 * before landing in the parent skill.
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
  "lint-installer.md",
);

const TEXT = readFileSync(AGENT_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("agents/lint-installer.md — file hygiene", () => {
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

describe("agents/lint-installer.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint-installer", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint-installer\s*$/m);
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
    expect(fm).toMatch(/\/lint:(setup|update|rules)/);
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
});

describe("agents/lint-installer.md — required sections (SPEC §4 line 295)", () => {
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

describe("agents/lint-installer.md — Resolução do CLI preamble (cli-bin-resolution SPEC §4)", () => {
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
    // SKILL.md owns the preamble; agents/*.md should defer to it (PLAN
    // §Resolução do CLI: "definido uma vez em SKILL.md e reusado").
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("agents/lint-installer.md — install-* layer coverage (PLAN §Fase 2)", () => {
  // The Phase 2 install sequence MUST exercise every write subcommand
  // shipped by the CLI in cli/src/commands/install/.
  const LAYERS = [
    "install-deps",
    "install-oxlint",
    "install-hook",
    "install-husky",
    "install-coverage",
    "install-scripts",
  ] as const;

  for (const cmd of LAYERS) {
    it(`mentions install layer: ${cmd}`, () => {
      expect(TEXT).toContain(cmd);
    });
  }

  it("layers appear in canonical install order (deps → oxlint → hook → husky → coverage → scripts)", () => {
    // commands/lint/setup.md fixes this ordering: deps before any config
    // (oxlint can't run without oxlint installed); scripts last because they
    // reference paths from the prior installers. Reordering requires a patch
    // + test, not prompt-engineering.
    const positions = LAYERS.map((cmd) => TEXT.indexOf(cmd));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1);
    }
    for (const p of positions) {
      expect(p).toBeGreaterThan(-1);
    }
  });
});

describe("agents/lint-installer.md — opt-out per layer", () => {
  // The task spec says: "wrapper sobre install-* por camadas com opt-out".
  // The subagent must accept a skip list keyed by layer name so the parent
  // can disable individual installers (e.g. coverage when runner is none).
  it("documents the per-layer opt-out / skip mechanism", () => {
    expect(TEXT.toLowerCase()).toMatch(/opt-out|skip/);
  });

  it("references skip semantics for at least one installer layer", () => {
    // Spot-check that `skip` is wired to layers, not just mentioned.
    expect(TEXT).toMatch(/skip[^\n]*\b(coverage|husky|hook|deps|oxlint|scripts)\b/i);
  });

  it("documents that all six layers run by default (default = none skipped)", () => {
    // SPEC §6 Always: "imprimir plano antes de aplicar". Default behavior
    // must be the inclusive "all six" so the parent doesn't accidentally
    // omit a layer by forgetting to opt-in.
    expect(TEXT.toLowerCase()).toMatch(/default[^\n]*(all|todas)|todas as camadas/);
  });
});

describe("agents/lint-installer.md — exit handling and strict mode", () => {
  it("documents `--strict` propagation to the install-* commands", () => {
    expect(TEXT).toMatch(/--strict/);
  });

  it("documents abort-on-first-failure semantics", () => {
    // Parent must be able to trust that a non-zero exit halts the rest;
    // partial state is preserved in `.lint-manifest.json` for /lint:rollback.
    expect(TEXT.toLowerCase()).toMatch(/aborta|abort|falha|failed/);
  });
});

describe("agents/lint-installer.md — summary contract (SPEC §4 line 303)", () => {
  it("declares the ≤30-line summary budget", () => {
    expect(TEXT).toMatch(/≤\s*30/);
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

  it("references the `.lint-manifest.json` for post-condition verification", () => {
    // PLAN §Contratos CLI – manifest enables /lint:uninstall + /lint:rollback.
    // The summary must surface manifest entries so the parent can audit.
    expect(TEXT).toMatch(/\.lint-manifest\.json/);
  });

  it("delegates detection and migration to sibling subagents (SPEC §4 line 302)", () => {
    // The installer must NOT do detection or migration work — only point at
    // the sibling subagents. Single responsibility (SPEC §4 line 301).
    expect(TEXT).toMatch(/lint-detector/);
    expect(TEXT).toMatch(/lint-migrator/);
  });

  it("declares writes go through the CLI, not direct Write/Edit (ADR 0006)", () => {
    // ADR 0006: deterministic CLI / thin harness. The subagent must call
    // `install-*` via Bash, not edit files directly. This makes uninstall
    // byte-exact via .lint-manifest.json.
    expect(TEXT.toLowerCase()).toMatch(/cli|adr 0006/);
  });
});
