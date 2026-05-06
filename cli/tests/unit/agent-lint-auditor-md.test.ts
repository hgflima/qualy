/**
 * agents/lint-auditor.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 4 + SPEC §2/§4 Subagents + ADR 0008 +
 * PLAN §Resolução do CLI).
 *
 * `lint-auditor` is the Phase 4 subagent that enriches `recs-generate`'s
 * deterministic `candidates[]` (with `rationale_stub`) into the SPEC §3
 * `recommendations[]` (with prose `rationale`) and persists the result back
 * into `.lint-audit/<ts>.json`. ADR 0008 authorizes this subagent as the
 * SINGLE exception to ADR 0006 — it edits the audit JSON directly instead
 * of going through a CLI write subcommand.
 *
 * SPEC §4 line 296 caps the file at 150 lines; SPEC §4 line 295 fixes the
 * section list; PLAN §Resolução do CLI fixes the `QUALY_BIN=` preamble
 * (defined once in SKILL.md and reused here; canonical block updated in
 * v0.3.4 — see .harn/docs/cli-bin-resolution/SPEC.md §4); SPEC §4 line
 * 303 caps the structured summary at ≤30 lines.
 *
 * These tests lock that surface: drift in frontmatter, allowed tools (the
 * ADR 0008 exception specifically authorizes `Edit` — siblings forbid it),
 * caller list (only `/lint:audit`), summary budget, ADR 0008 cross-ref, or
 * section order breaks here before landing in the parent skill.
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
  "lint-auditor.md",
);

const TEXT = readFileSync(AGENT_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("agents/lint-auditor.md — file hygiene", () => {
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

describe("agents/lint-auditor.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint-auditor", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint-auditor\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the sole caller slash command (/lint:audit)", () => {
    // SPEC §2: lint-auditor is invoked exclusively by /lint:audit. ADR 0008
    // makes this the only allowed entry point — other slash commands
    // (`/lint:setup`, `/lint:update`, `/lint:rules:*`) must NOT trigger this
    // subagent because they don't operate on `.lint-audit/<ts>.json`.
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:audit/);
  });

  it("declares tools (Claude Code subagent frontmatter)", () => {
    expect(frontmatter(TEXT)).toMatch(/^tools:/m);
  });

  it("tools includes Bash (subagent invokes the CLI via recs-generate)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bBash\b/);
  });

  it("tools includes Read (subagent reads source files from evidence.top[])", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bRead\b/);
  });

  it("tools includes Edit (ADR 0008 authorized exception — direct write of `.lint-audit/<ts>.json`)", () => {
    // ADR 0008 §"Exceção autorizada (única)" explicitly allows this subagent
    // (and ONLY this subagent) to write directly without going through the
    // CLI. Other subagents (lint-detector, lint-installer, lint-migrator)
    // forbid Write/Edit/MultiEdit; lint-auditor MUST include `Edit` so it can
    // populate `recommendations[]` in the audit JSON. Drift either way (this
    // subagent missing Edit, OR a sibling adding Edit) breaks ADR 0008.
    const fm = frontmatter(TEXT);
    const match = fm.match(/^tools:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const tools = (match?.[1] ?? "").trim();
    expect(tools).toMatch(/\bEdit\b/);
  });
});

describe("agents/lint-auditor.md — required sections (SPEC §4 line 295)", () => {
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

describe("agents/lint-auditor.md — Resolução do CLI preamble (cli-bin-resolution SPEC §4)", () => {
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

describe("agents/lint-auditor.md — CLI subcommand coverage (PLAN §Fase 4)", () => {
  // The Phase 4 enrichment hinges on `recs-generate` (input) and
  // `.lint-audit/<ts>.json` (persistence target). The subagent must surface
  // both so the parent can wire the call.
  it("mentions the recs-generate CLI subcommand (input source)", () => {
    expect(TEXT).toMatch(/\brecs-generate\b/);
  });

  it("references the `.lint-audit/` artifact directory", () => {
    // SPEC §3 fixes the audit contract path. The subagent edits the JSON in
    // place — surfacing the path is part of the contract.
    expect(TEXT).toMatch(/\.lint-audit\//);
  });

  it("references `recommendations[]` as the persisted output (SPEC §3)", () => {
    expect(TEXT).toMatch(/recommendations(\[\]|\b)/);
  });

  it("references `candidates[]` as the deterministic input (ADR 0008 §Decisão item 1)", () => {
    expect(TEXT).toMatch(/candidates(\[\]|\b)/);
  });

  it("mentions `rationale_stub` (input field) and `rationale` (output field)", () => {
    // ADR 0008 invariante (i): rationale_stub is the deterministic anchor
    // emitted by the CLI; the subagent rewrites it into prose `rationale`.
    expect(TEXT).toMatch(/rationale_stub/);
    expect(TEXT).toMatch(/\brationale\b/);
  });
});

describe("agents/lint-auditor.md — ADR 0008 contract anchors", () => {
  it("cross-references ADR 0008 explicitly", () => {
    // The .md must point at the ADR so future readers understand why this
    // subagent is allowed to bypass ADR 0006.
    expect(TEXT).toMatch(/ADR 0008|0008-hybrid-recs-rationale/);
  });

  it("documents the byte-equal invariant on the non-rationale fields (ADR 0008 invariante (ii))", () => {
    // 7 of the 8 SPEC §3 recommendation fields must remain byte-equal between
    // candidates[i] and recommendations[i]. Drift would break the e2e
    // acceptance from SPEC §7.6.
    expect(TEXT.toLowerCase()).toMatch(/byte-igua|byte-equal|byte-iguais/);
  });

  it("documents the fallback-to-stub path (ADR 0008 invariante (iv))", () => {
    // When the subagent can't write prose with confidence (no evidence.top[],
    // unreadable file), it must copy rationale_stub literally. SPEC §7.6
    // acceptance is "≥1 rationale ≠ stub", not "all".
    expect(TEXT.toLowerCase()).toMatch(/fallback|stub literal|copia.*stub/);
  });

  it("documents the prohibition on recalculating numeric fields", () => {
    // ADR 0008 invariante (i) + (iii): subagent never recomputes
    // proposed_value, id, severity, blast_radius. Only rationale changes.
    expect(TEXT.toLowerCase()).toMatch(
      /n(ã|a)o recalcul|nunca recalcul|n(ã|a)o invente n(ú|u)meros|never recompute/,
    );
  });

  it("references the evidence.top[] cap (5 files per candidate)", () => {
    // docs/recs-heuristics.md §3 + ADR 0008 §Negativas line 59 cap at 5 files
    // per candidate to keep legacy-monorepo audits <30s (SPEC §7 line 478).
    expect(TEXT).toMatch(/evidence\.top|evidence/);
    expect(TEXT).toMatch(/\b5\b/);
  });
});

describe("agents/lint-auditor.md — exclusivity to /lint:audit", () => {
  // SPEC §2 + ADR 0008: this subagent is invoked ONLY by /lint:audit. The
  // .md must surface that exclusivity so the parent doesn't accidentally
  // trigger it from /lint:update or /lint:setup.
  it("declares /lint:audit as the exclusive caller", () => {
    expect(TEXT).toMatch(/\/lint:audit/);
  });

  it("explicitly excludes /lint:update from the caller list", () => {
    // /lint:update consumes recommendations[]; it does NOT trigger this
    // subagent. The .md must say so to prevent confusion.
    expect(TEXT).toMatch(/\/lint:update/);
    // The phrase must surface in a "não usar" / "nunca" context (not just
    // mention update as a downstream consumer).
    expect(TEXT.toLowerCase()).toMatch(/n(ã|a)o.*\/lint:update|nunca.*\/lint:update|never.*\/lint:update/);
  });
});

describe("agents/lint-auditor.md — summary contract (SPEC §4 line 303)", () => {
  it("declares the ≤30-line summary budget", () => {
    expect(TEXT).toMatch(/≤\s*30/);
  });

  it("delegates audit/update orchestration to the parent (SPEC §4 line 302)", () => {
    // The auditor must NOT run `audit` or `/lint:update` itself — only the
    // parent skill (`/lint:audit`) wires those. Single responsibility.
    expect(TEXT.toLowerCase()).toMatch(/n(ã|a)o (executa|invoca|roda).*audit|never (run|invoke).*audit|delegado/);
  });

  it("references the SPEC §7.6 acceptance criterion (rationale ≠ stub)", () => {
    // SPEC §7.6: "rationale legível, não stub". The subagent's job is
    // exactly to make this true for at least one recommendation.
    expect(TEXT).toMatch(/§7\.6|7\.6/);
  });

  it("documents idempotency on re-execution", () => {
    // Re-running the subagent must overwrite recommendations[] entirely
    // (not merge), so the parent can retry safely.
    expect(TEXT.toLowerCase()).toMatch(/idempot|re-execu|reescreve.*por completo|overwrite/);
  });

  it("references siblings without invoking them (single responsibility)", () => {
    // The .md must mention lint-detector / lint-installer / lint-migrator as
    // siblings (cross-ref) but explicitly state this subagent doesn't call
    // them — they have separate responsibilities (SPEC §4 line 302).
    expect(TEXT).toMatch(/lint-detector/);
    expect(TEXT).toMatch(/lint-installer/);
    expect(TEXT).toMatch(/lint-migrator/);
  });
});
