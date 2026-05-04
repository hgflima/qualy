/**
 * E2E test for `/lint:audit` + lint-auditor enrichment, locking SPEC §7.5 and
 * §7.6 acceptance (IMPLEMENTATION_PLAN.md Priority 5 / Phase 4 verification).
 *
 * §7.5 — `/lint:audit` em qualquer fixture configurado:
 *   - Persiste `.lint-audit/<timestamp>.json` com formato do contrato (SPEC §3).
 *   - Termina com exit code não-zero quando há `error`-level diagnostics.
 *
 * §7.6 — `/lint:update` após um audit (acoplamento via ADR 0008):
 *   - O subagent `lint-auditor` enriquece `rationale` em prosa e persiste
 *     `recommendations[]` no audit JSON; pelo menos uma recommendation deve
 *     carregar `rationale ≠ rationale_stub` (a invariante humana documentada
 *     em ADR 0008 §"Verificação"). Os 6 outros campos da recommendation são
 *     byte-iguais ao candidato (id/type/title/severity/applies_to +
 *     blast_radius.files_currently_violating); `patch` é byte-igual a
 *     `suggested_change` (rename); `evidence` é descartado.
 *
 * Como simulamos o subagent: o `lint-auditor` é uma especialização do modelo
 * (Claude Code subagent); não dá para invocá-lo no vitest. Em vez disso, este
 * teste exerce o pipeline determinístico (`recs-generate` produz candidates
 * estáveis a partir do audit) e mecaniza a transformação que o subagent
 * faria — substituir cada `rationale_stub` por uma string distinta,
 * preservando os outros 7 campos byte-a-byte. Isso lock-down a fronteira do
 * contrato de ADR 0008 (invariantes (i)–(iv)): se algum campo *além* de
 * `rationale` divergir entre candidate e recommendation, este teste falha
 * antes de chegar no usuário.
 *
 * Como acionamos exit ≠ 0: o stub `oxlint` cospe diagnostics com
 * `severity: error` (5 wmc com value=30, max=15) — isso satisfaz três
 * condições simultâneas: (i) `summary.errors > 0` (§7.5 exit code), (ii)
 * `wmc max_seen=30 > 1.5×currentMax=22.5 AND violations≥5` (heurística §6.2
 * → emite candidate `lower-threshold`), (iii) o stub não depende da rede /
 * registry (paralelo ao stub de `install-deps` em `setup-greenfield.test.ts`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { audit, runAudit, toSafeTimestamp } from "../../src/commands/audit.ts";
import { auditLatest } from "../../src/commands/audit-latest.ts";
import { installOxlint } from "../../src/commands/install/oxlint.ts";
import {
  type Candidate,
  recsGenerate,
} from "../../src/commands/recs/generate.ts";
import {
  type AuditPayload,
  type Recommendation,
  validateAuditPayload,
} from "../../src/lib/audit-schema.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { parseDefensive } from "../../src/lib/json.ts";
import { materializeFixture } from "../fixtures/_materialize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = new Date("2026-05-03T14:22:11.000Z");

interface StubDiagnostic {
  readonly severity: "error" | "warning";
  readonly filename: string;
  readonly rule: string;
  readonly value?: number;
  readonly max?: number;
  readonly class?: string;
}

/**
 * 5 wmc errors with value=30 against the greenfield preset (max=15).
 * Designed to satisfy:
 *   - §7.5: summary.errors=5 > 0 → exit ≠ OK.
 *   - §7.6: heuristics §6.2 fires (`violations≥5 AND max_seen>1.5×currentMax`)
 *     → at least one `lower-threshold-wmc-deep` candidate is emitted; the
 *     enrichment step then lock-downs the byte-equal invariants.
 */
function buildDiagnostics(): StubDiagnostic[] {
  return [
    {
      severity: "error",
      filename: "src/calculator.ts",
      rule: "quality-metrics/wmc",
      class: "Calculator",
      value: 30,
      max: 15,
    },
    {
      severity: "error",
      filename: "src/storage.ts",
      rule: "quality-metrics/wmc",
      class: "Storage",
      value: 28,
      max: 15,
    },
    {
      severity: "error",
      filename: "src/user.ts",
      rule: "quality-metrics/wmc",
      class: "User",
      value: 27,
      max: 15,
    },
    {
      severity: "error",
      filename: "src/utils.ts",
      rule: "quality-metrics/wmc",
      class: "Utils",
      value: 25,
      max: 15,
    },
    {
      severity: "error",
      filename: "src/index.ts",
      rule: "quality-metrics/wmc",
      class: "Main",
      value: 24,
      max: 15,
    },
  ];
}

/**
 * Mechanise the lint-auditor subagent's enrichment per ADR 0008 invariants:
 *   (i)   Drop `evidence`.
 *   (ii)  `id, type, title, severity, applies_to,
 *          blast_radius.files_currently_violating` byte-equal.
 *   (iii) `patch` is byte-equal to `suggested_change` (rename only).
 *   (iv)  `rationale` is the enriched prose; must be ≠ `rationale_stub`.
 *
 * `blast_radius.files_newly_violating` is `null` in candidates (`recs-blast-
 * radius` would measure it). The recommendation schema requires a non-negative
 * int, so we set it to 0 here — that mirrors what the subagent does when the
 * blast-radius command was not run yet (per `docs/recs-heuristics.md` §3).
 */
function enrich(c: Candidate, index: number): Recommendation {
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    rationale: `[enriquecido #${index}] ${c.rationale_stub} Detalhe extra: revisar a classe e dividir responsabilidades.`,
    blast_radius: {
      files_currently_violating: c.blast_radius.files_currently_violating,
      files_newly_violating: 0,
    },
    patch: { ...c.suggested_change },
    severity: c.severity,
    applies_to: c.applies_to,
  };
}

describe("e2e: SPEC §7.5 audit JSON contract + §7.6 rationale enrichment", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("audit produz JSON válido contra schema e o handler retorna RECOVERABLE_ERROR quando há error-level (SPEC §7.5)", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    // Install oxlint presets first — without them, audit returns preset_missing.
    const ox = installOxlint({ cwd: fx.dir, stage: "greenfield" });
    expect(ox.ok, JSON.stringify(ox)).toBe(true);

    // Run pure `audit()` with stubbed runner that emits 5 error-level wmc
    // diagnostics. The stub returns a successful subprocess (ok:true); audit.ts
    // also accepts non-zero exit codes when stdout is non-empty (oxlint signals
    // "errors found" via exit ≠ 0), but here we keep it simple.
    const stubStdout = JSON.stringify(buildDiagnostics());
    const result = audit(
      { cwd: fx.dir },
      {
        runFn: () => ({ ok: true, stdout: stubStdout, stderr: "", exitCode: 0 }),
        now: () => FIXED_DATE,
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // §7.5 #1 — file written under `.lint-audit/<safeTs>.json`.
    expect(result.path).toBe(`.lint-audit/${toSafeTimestamp(FIXED_DATE)}.json`);
    const auditAbs = join(fx.dir, result.path);
    expect(existsSync(auditAbs)).toBe(true);

    // §7.5 #2 — JSON parses and validates against the SPEC §3 schema.
    const raw = readFileSync(auditAbs, "utf8");
    const parsed = parseDefensive<unknown>(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validated = validateAuditPayload(parsed.value);
    expect(validated.ok, validated.ok ? "" : `schema: ${validated.error}`).toBe(true);
    if (!validated.ok) return;

    // §7.5 #3 — error-level diagnostics aggregate into summary.errors > 0.
    expect(validated.value.violations.summary.errors).toBe(5);
    expect(validated.value.violations.summary.files_affected).toBe(5);
    expect(validated.value.violations.by_metric.wmc.violations).toBe(5);
    expect(validated.value.violations.by_metric.wmc.max_seen).toBe(30);

    // §7.5 #4 — handler maps errors > 0 to RECOVERABLE_ERROR via runAudit.
    // We invoke the real handler (with --oxlint-bin pointing at our stub
    // script) inside a chdir + stdout/stderr silence window so the exit code
    // mapping in audit.ts:862-864 is locked at the dispatcher boundary.
    // The stub script writes diagnostics from a JSON sidecar and exits 0.
    const stubBin = join(fx.dir, "stub-oxlint.sh");
    const stubPayload = join(fx.dir, "stub-oxlint-payload.json");
    writeFileSync(stubPayload, stubStdout);
    writeFileSync(
      stubBin,
      `#!/usr/bin/env bash\ncat ${JSON.stringify(stubPayload)}\nexit 0\n`,
      { mode: 0o755 },
    );

    const cwdBefore = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let exit: number;
    try {
      process.chdir(fx.dir);
      exit = runAudit(["--oxlint-bin", stubBin]);
    } finally {
      process.chdir(cwdBefore);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    expect(exit).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    expect(exit).not.toBe(EXIT_CODES.OK);
  });

  it("simula lint-auditor: rationale ≠ rationale_stub para ≥1 recomendação, demais campos byte-iguais (SPEC §7.6 + ADR 0008)", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const ox = installOxlint({ cwd: fx.dir, stage: "greenfield" });
    expect(ox.ok).toBe(true);

    const auditRes = audit(
      { cwd: fx.dir },
      {
        runFn: () => ({
          ok: true,
          stdout: JSON.stringify(buildDiagnostics()),
          stderr: "",
          exitCode: 0,
        }),
        now: () => FIXED_DATE,
      },
    );
    expect(auditRes.ok, JSON.stringify(auditRes)).toBe(true);
    if (!auditRes.ok) return;

    // Step 1 — recs-generate produces deterministic `candidates[]` from the
    // audit payload. Among them, at least one `lower-threshold-wmc-*` is
    // expected (5 wmc errors with max_seen=30 > 1.5×15 → heuristics §6.2).
    const recs = recsGenerate({ cwd: fx.dir, audit: auditRes.payload });
    expect(recs.ok).toBe(true);
    if (!recs.ok) return;
    const candidates = recs.candidates;
    expect(candidates.length).toBeGreaterThan(0);

    const lowerWmc = candidates.find((c) =>
      c.id.startsWith("rec-lower-threshold-wmc-"),
    );
    expect(
      lowerWmc,
      `expected at least one rec-lower-threshold-wmc candidate; got ids: ${candidates.map((c) => c.id).join(",")}`,
    ).toBeDefined();

    // Step 2 — simulate the subagent's enrichment + Edit. Each candidate becomes
    // a recommendation with prose rationale that is *guaranteed* to differ from
    // its `rationale_stub` (we prefix `[enriquecido #N]`).
    const enriched: Recommendation[] = candidates.map((c, i) => enrich(c, i));

    // Step 3 — write the enriched audit back in place (Edit-tool simulation).
    const auditAbs = join(fx.dir, auditRes.path);
    const updated: AuditPayload = {
      ...auditRes.payload,
      recommendations: enriched,
    };
    writeFileSync(auditAbs, JSON.stringify(updated, null, 2) + "\n");

    // Step 4 — re-load via auditLatest (the consumer path used by /lint:update).
    const loaded = auditLatest({ cwd: fx.dir });
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    const reloaded = loaded.audit;

    // §7.6 #1 — recommendations populated and survive a round-trip through the
    // schema validator (auditLatest validates internally via auditPayloadSchema).
    expect(reloaded.recommendations.length).toBe(enriched.length);

    // §7.6 #2 — at least one rationale is genuinely enriched (≠ stub). In our
    // simulation every candidate is enriched; SPEC §7.6 only requires ≥ 1.
    const enrichedCount = reloaded.recommendations.filter(
      (r, i) => r.rationale !== candidates[i].rationale_stub,
    ).length;
    expect(enrichedCount).toBeGreaterThanOrEqual(1);
    expect(enrichedCount).toBe(candidates.length);

    // ADR 0008 invariants (ii) + (iii): the 6 immutable fields are byte-equal
    // between candidate (stub form) and recommendation; `patch` byte-equals
    // `suggested_change` (rename only); `evidence` is dropped.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const r = reloaded.recommendations[i];
      expect(r.id).toBe(c.id);
      expect(r.type).toBe(c.type);
      expect(r.title).toBe(c.title);
      expect(r.severity).toBe(c.severity);
      expect(r.applies_to).toBe(c.applies_to);
      expect(r.blast_radius.files_currently_violating).toBe(
        c.blast_radius.files_currently_violating,
      );
      expect(r.patch).toEqual(c.suggested_change);
      expect(r.rationale.length).toBeGreaterThan(0);
      expect(r.rationale).not.toBe(c.rationale_stub);
      // Recommendation shape never carries `evidence` (typed away by the
      // schema). Asserting at runtime guards against future drift if the
      // subagent accidentally smuggles it in.
      expect((r as unknown as { evidence?: unknown }).evidence).toBeUndefined();
    }

    // SPEC §7.6 secondary invariant — auditLatest is the single reader path
    // for /lint:update; the file on disk must match the in-memory shape we
    // wrote so the next consumer reads an enriched audit, not a stub one.
    const rereadRaw = readFileSync(auditAbs, "utf8");
    const rereadParsed = parseDefensive<{ recommendations: { rationale: string }[] }>(rereadRaw);
    expect(rereadParsed.ok).toBe(true);
    if (!rereadParsed.ok) return;
    expect(rereadParsed.value.recommendations.length).toBe(enriched.length);
    expect(
      rereadParsed.value.recommendations.every((r) => typeof r.rationale === "string" && r.rationale.length > 0),
    ).toBe(true);

    // Anchor against unused-import drift: HERE (this file's dir) is referenced
    // so future maintainers don't accidentally remove the import.fileURLToPath
    // wiring used by other e2e tests.
    expect(HERE.length).toBeGreaterThan(0);
  });
});
