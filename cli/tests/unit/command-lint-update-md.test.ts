/**
 * commands/lint/update.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 4 + SPEC §2/§6/§7.6 + PLAN §Resolução do CLI).
 *
 * `/lint:update` is the orchestrator that walks `audit.recommendations[]` one
 * by one with `AskUserQuestion` (apply/skip/explain), captures `--reason` for
 * loosening changes (SPEC §6), and delegates each application to `recs-apply`.
 * The .md file routes user intent through deterministic CLI subcommands
 * (`audit-latest`, `recs-blast-radius`, `recs-apply`); SPEC §4 line 296 caps
 * it at 100 lines; SPEC §4 line 295 fixes the section list; PLAN §Resolução
 * do CLI fixes the `QUALY_CLI=` preamble (defined once in SKILL.md).
 *
 * These tests lock that surface: drift in frontmatter, the audit↔update
 * coupling, the reason-gate semantics, the loosening-type enumeration, or the
 * `recs-apply --rec-id` invocation breaks here before reaching the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UPDATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "update.md",
);

const TEXT = readFileSync(UPDATE_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/update.md — file hygiene", () => {
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

describe("commands/lint/update.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:update", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:update\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:update slash command", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:update/);
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

  it("declares argument-hint with --rec-id (per-rec subset selection)", () => {
    expect(frontmatter(TEXT)).toMatch(/^argument-hint:\s*\[--rec-id\s*<id>\]/m);
  });
});

describe("commands/lint/update.md — required sections (SPEC §4 line 295)", () => {
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

describe("commands/lint/update.md — Resolução do CLI preamble (ADR 0013)", () => {
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

describe("commands/lint/update.md — CLI subcommand coverage (PLAN §Contratos CLI)", () => {
  // The update flow MUST consult three CLI subcommands in sequence:
  // audit-latest (read), recs-blast-radius (optional pre-apply preview),
  // recs-apply (mutation).
  it("references audit-latest as the source of truth for recommendations[]", () => {
    expect(TEXT).toContain("audit-latest");
  });

  it("references recs-blast-radius for pre-apply preview (SPEC §6 Always)", () => {
    // SPEC §6 Always line 391: "Sempre mostrar `blast_radius` ... antes de
    // aceitar uma recomendação de `/lint:update` que muda thresholds".
    expect(TEXT).toContain("recs-blast-radius");
  });

  it("references recs-apply as the mutation entry point", () => {
    expect(TEXT).toContain("recs-apply");
  });

  it("invokes recs-apply with --rec-id (per-rec, never batch)", () => {
    // PLAN §Contratos CLI line 79: `recs-apply --rec-id <id>`. SPEC §6 Never
    // line 421 forbids batch application.
    expect(TEXT).toMatch(/recs-apply[^`]*--rec-id/);
  });

  it("references git-clean-check as a gating pre-check", () => {
    expect(TEXT).toContain("git-clean-check");
  });

  it("references the .lint-audit/<ts>.json source path (SPEC §3)", () => {
    expect(TEXT).toMatch(/\.lint-audit\//);
  });
});

describe("commands/lint/update.md — audit↔update coupling (SPEC §6 line 66)", () => {
  // SPEC §6 line 66: "Se update rodar sem audit prévio (≤ 24h), oferece rodar
  // audit antes". The .md MUST surface both the missing-audit refusal and the
  // 24h staleness window.
  it("offers /lint:audit when no audit exists (audit_missing)", () => {
    expect(TEXT).toContain("/lint:audit");
    expect(TEXT.toLowerCase()).toMatch(/audit_missing|sem.*audit/);
  });

  it("declares the 24h staleness window for audit re-run prompt", () => {
    expect(TEXT).toMatch(/24h/);
  });

  it("references audit.generated_at as the staleness anchor", () => {
    // SPEC §3 line 246: audit payload carries `generated_at` ISO-8601.
    expect(TEXT).toContain("generated_at");
  });
});

describe("commands/lint/update.md — reason gate (SPEC §6 Always + Never)", () => {
  // SPEC §6 Always line 389 + Never line 423: any loosening change MUST
  // capture a reason via AskUserQuestion. The CLI enforces this via
  // `recs-apply` rejecting `reason_required` for the 3 loosening types.
  const LOOSENING_TYPES = [
    "lower-threshold",
    "remove-rule",
    "loosen-coverage",
  ] as const;

  for (const type of LOOSENING_TYPES) {
    it(`enumerates loosening type: ${type}`, () => {
      expect(TEXT).toContain(type);
    });
  }

  it("references the reason_required error from recs-apply", () => {
    // recs-apply rejects with `reason_required` when REASON_REQUIRED_TYPES
    // gets an empty `--reason`. The .md MUST surface this so the orchestrator
    // does not silently swallow the error.
    expect(TEXT).toContain("reason_required");
  });

  it("describes the second AskUserQuestion for capturing the reason", () => {
    // SPEC §6 line 419: "uma pergunta por vez via AskUserQuestion". The
    // reason capture is a SEPARATE call from the apply/skip/explain decision.
    expect(TEXT.toLowerCase()).toMatch(/motivo/);
  });
});

describe("commands/lint/update.md — apply/skip/explain decision (SPEC §3 line 285)", () => {
  // SPEC §3 line 285: "/lint:update itera recommendations[] e usa
  // AskUserQuestion (apply / skip / explain) para cada uma".
  const OPTIONS = ["Apply", "Skip", "Explain"] as const;

  for (const option of OPTIONS) {
    it(`enumerates AskUserQuestion option: ${option}`, () => {
      expect(TEXT).toContain(option);
    });
  }

  it("references AskUserQuestion as the prompt mechanism", () => {
    expect(TEXT).toContain("AskUserQuestion");
  });

  it("orders critical recommendations first (SPEC §3 line 285)", () => {
    // SPEC §3 line 285: "Recomendações com severity: critical (...) sobem ao
    // topo da fila".
    expect(TEXT.toLowerCase()).toMatch(/critical/);
  });
});

describe("commands/lint/update.md — delegated types (PLAN §Fase 4)", () => {
  // recs-apply returns applicable:false with a `delegate` field for 2 types
  // it does not itself apply. The orchestrator MUST route these.
  it("delegates fix-tooling to install-deps", () => {
    expect(TEXT).toContain("fix-tooling");
    expect(TEXT).toContain("install-deps");
  });

  it("delegates enable-tier to /lint:setup", () => {
    expect(TEXT).toContain("enable-tier");
    expect(TEXT).toContain("/lint:setup");
  });
});

describe("commands/lint/update.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 0 to applied-or-skipped success", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit code 1 to recoverable / audit_missing / reason_required", () => {
    expect(TEXT).toMatch(/`1`/);
  });

  it("maps exit code 3 to dirty-tree (--strict + working tree dirty)", () => {
    expect(TEXT).toMatch(/`3`/);
    expect(TEXT.toLowerCase()).toMatch(/git stash/);
  });

  it("maps exit code 4 to usage error", () => {
    expect(TEXT).toMatch(/`4`/);
  });
});

describe("commands/lint/update.md — global conventions (SPEC §6)", () => {
  it("uses one question per turn via AskUserQuestion (SPEC §6 line 419)", () => {
    expect(TEXT.toLowerCase()).toMatch(/uma pergunta por vez/);
  });

  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit|sem auto-commit/);
  });

  it("surfaces ADR 0008: rationale is enriched, not the stub", () => {
    // ADR 0008 fixes that `audit.recommendations[i].rationale` is enriched
    // by the lint-auditor subagent. The .md MUST show this so the
    // orchestrator displays the enriched prose, not the stub.
    expect(TEXT).toContain("rationale");
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o.*rationale_stub|enriquec/);
  });

  it("uses --strict on recs-apply (defense in depth)", () => {
    // SPEC §6 line 384: working tree clean before mutations. recs-apply
    // already calls dirtyFiles when --strict is set; orchestrator should
    // pass the flag through.
    expect(TEXT).toMatch(/--strict/);
  });
});
