/**
 * commands/lint/audit.md contract tests
 * (IMPLEMENTATION_PLAN.md §Fase 4 + SPEC §2/§7.5/§7.6 + PLAN §Resolução do CLI).
 *
 * `/lint:audit` is the read-only orchestrator that runs the deep oxlint preset,
 * aggregates violations by metric, and writes `.lint-audit/<ts>.json` for
 * `/lint:update` and `/lint:report` to consume. The .md file routes user intent
 * through the deterministic `audit` CLI subcommand. SPEC §4 line 296 caps it at
 * 100 lines; SPEC §4 line 295 fixes the section list; PLAN §Resolução do CLI
 * fixes the `QUALY_CLI=` preamble (defined once in SKILL.md and reused here).
 *
 * These tests lock that surface: drift in frontmatter, the read-only contract,
 * the metric coverage, or the audit↔update routing breaks here before reaching
 * the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AUDIT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "commands",
  "lint",
  "audit.md",
);

const TEXT = readFileSync(AUDIT_PATH, "utf8");

function frontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error("frontmatter not found");
  return match[1] ?? "";
}

describe("commands/lint/audit.md — file hygiene", () => {
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

describe("commands/lint/audit.md — YAML frontmatter", () => {
  it("starts with --- on the first line", () => {
    expect(TEXT.startsWith("---\n")).toBe(true);
  });

  it("declares name: lint:audit", () => {
    expect(frontmatter(TEXT)).toMatch(/^name:\s*lint:audit\s*$/m);
  });

  it("declares a description that begins with an activation cue (SPEC §4 line 294)", () => {
    const fm = frontmatter(TEXT);
    const match = fm.match(/^description:\s*(.+)$/m);
    expect(match).not.toBeNull();
    const value = (match?.[1] ?? "").trim();
    expect(value).toMatch(/^(Use when|Triggered by)/);
  });

  it("description references the /lint:audit slash command", () => {
    const fm = frontmatter(TEXT);
    expect(fm).toMatch(/\/lint:audit/);
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
});

describe("commands/lint/audit.md — required sections (SPEC §4 line 295)", () => {
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

describe("commands/lint/audit.md — Resolução do CLI preamble (PLAN §190–198)", () => {
  it("references the QUALY_CLI env var with CLAUDE_PLUGIN_ROOT fallback", () => {
    expect(TEXT).toMatch(
      /QUALY_CLI="\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/skills\/lint\/cli\/src\/index\.ts"/,
    );
  });

  it("invokes node with --experimental-strip-types (ADR 0007)", () => {
    expect(TEXT).toMatch(/node --experimental-strip-types "\$QUALY_CLI"/);
  });

  it("links back to SKILL.md as the canonical preamble source", () => {
    // SKILL.md owns the preamble; commands/*.md should defer to it (PLAN
    // §Resolução do CLI: "definido uma vez em SKILL.md e reusado").
    expect(TEXT).toMatch(/SKILL\.md/);
  });
});

describe("commands/lint/audit.md — pre-check coverage (SPEC §7.5)", () => {
  // The audit flow MUST consult detect-stack and check for installed presets
  // before invoking oxlint. git-clean-check is informational (audit is
  // read-only) — it should be mentioned but not gating.
  it("mentions detect-stack as the gating pre-check", () => {
    expect(TEXT).toContain("detect-stack");
  });

  it("mentions git-clean-check (informational)", () => {
    expect(TEXT).toContain("git-clean-check");
  });

  it("references the audit subcommand", () => {
    // The orchestrator delegates to `qualy audit`; the .md MUST mention the
    // CLI subcommand by name so the model invokes it correctly.
    expect(TEXT).toMatch(/\baudit\b/);
  });

  it("mentions the .lint-audit/<ts>.json output path (SPEC §3 contract)", () => {
    // SPEC §3 fixes the persistence path; SPEC §7.5 asserts it.
    expect(TEXT).toMatch(/\.lint-audit\//);
  });
});

describe("commands/lint/audit.md — metric coverage (SPEC §3 audit contract)", () => {
  // SPEC §3 audit contract → `violations.by_metric.{wmc, halstead, lcom, cbo,
  // dit}`. The summary the orchestrator shows the user must reference the
  // metric vocabulary so the user understands the output.
  const METRICS = ["wmc", "halstead", "lcom", "cbo", "dit"] as const;

  for (const metric of METRICS) {
    it(`mentions metric: ${metric}`, () => {
      // Case-insensitive — Halstead may be capitalized in prose.
      expect(TEXT.toLowerCase()).toContain(metric);
    });
  }
});

describe("commands/lint/audit.md — exit code mapping (lib/exit-codes.ts)", () => {
  it("maps exit code 0 to success (no error-level violations)", () => {
    expect(TEXT).toMatch(/`0`/);
  });

  it("maps exit code 1 to recoverable / errors-found state", () => {
    // SPEC §7.5 line 457: "Termina com exit code não-zero se houver
    // `error`-level". audit.ts maps that to RECOVERABLE_ERROR(1).
    expect(TEXT).toMatch(/`1`/);
  });

  it("maps exit code 2 to unsupported-stack refusal (SPEC §1)", () => {
    expect(TEXT).toMatch(/`2`/);
  });

  it("maps exit code 5 to missing-dep / preset-missing → /lint:setup", () => {
    expect(TEXT).toMatch(/`5`/);
    // The harness must route missing-dep to /lint:setup.
    expect(TEXT).toMatch(/\/lint:setup/);
  });
});

describe("commands/lint/audit.md — read-only contract (SPEC §6)", () => {
  // SPEC §6 line 63: "exceto `/lint:audit`, `/lint:status`, ... que são
  // read-only". The .md must surface that contract so the model does NOT
  // mutate configs.
  it("declares the command as read-only", () => {
    expect(TEXT.toLowerCase()).toMatch(/read-only/);
  });

  it("forbids automatic commits (SPEC §6 Never line 416)", () => {
    // "Nunca commitar automaticamente". audit writes only the audit JSON;
    // never commits.
    expect(TEXT.toLowerCase()).toMatch(/n[ãa]o commit/);
  });

  it("declares the supported stack envelope (SPEC §1)", () => {
    expect(TEXT).toMatch(/TS\/TSX\/JS\/JSX/);
  });

  it("routes missing-dep / preset-missing to /lint:setup (SPEC §6 escape hatch)", () => {
    // exit 5 must surface a clear remediation path.
    expect(TEXT).toMatch(/\/lint:setup/);
  });

  it("routes errors-found state to /lint:update (SPEC §6 audit↔update coupling)", () => {
    // SPEC §6 line 66: "audit grava JSON estruturado, update consome".
    expect(TEXT).toMatch(/\/lint:update/);
  });

  it("references the deep tier as the default audit tier", () => {
    // audit.ts:163 default tier = "deep" (falls back to fast).
    expect(TEXT.toLowerCase()).toMatch(/\bdeep\b/);
    expect(TEXT.toLowerCase()).toMatch(/\bfast\b/);
  });
});
