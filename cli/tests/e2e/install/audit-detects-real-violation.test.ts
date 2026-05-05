/**
 * T4.2 — E2E: install + audit detects a real WMC violation.
 *
 * Smoke test that catches regressions across the entire pipeline (B1-B6 in
 * `.harn/docs/fixes/quality-metrics-pipeline/PLAN.md`):
 *   B1+B2  preset must parse (no `_comment`, `jsPlugins` not `plugins`).
 *   B3     `jsPlugins` must carry an absolute path the runtime can resolve.
 *   B4     halstead is a single rule with `{maxVolume,maxEffort}`.
 *   B5     `metricKeyFromRule` accepts both `ns/rule` and `ns(rule)`.
 *   B6     `tooling.quality_metrics` reads from `node_modules/quality-metrics`
 *          (unscoped — the scoped name is a phantom).
 *
 * If any of those regress, this test fails — covering the entire chain in
 * one assertion bundle.
 *
 * Strategy: synthesize a tiny tmp project, symlink the qualy repo's own
 * `node_modules` into it (avoids a real `npm install` per test run, which
 * would be ~30 s and require network), then run `installOxlint` followed by
 * `audit` against a planted `src/big-class.ts` with 25 trivial methods —
 * comfortably above the greenfield WMC threshold (15).
 *
 * The qualy repo itself depends on `oxlint`, `oxfmt`, `quality-metrics`, and
 * `ts-morph`, so the symlink is byte-identical to a `npm install` of the
 * same versions in the fixture.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { type AuditDeps, audit } from "../../../src/commands/audit.ts";
import { installOxlint } from "../../../src/commands/install/oxlint.ts";
import { type DetectStageResult } from "../../../src/commands/detect-stage.ts";
import { type DetectTestRunnerResult } from "../../../src/commands/detect-test-runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

function classWith25Methods(): string {
  const methods = Array.from({ length: 25 }, (_v, i) => `  m${i + 1}(): number { return ${i + 1}; }`);
  return [
    "// Synthesized fixture — exercises quality-metrics/wmc.",
    "// 25 methods >> greenfield WMC threshold (15).",
    "export class BigClass {",
    ...methods,
    "}",
    "",
  ].join("\n");
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "qualy-e2e-audit-"));

  // Symlink node_modules from the qualy repo so the fixture sees the same
  // versions of oxlint, oxfmt, quality-metrics, ts-morph that the harness
  // ships with — without paying for a real `npm install` per test run.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));

  // oxlint reads `.gitignore` by default; without it the linter would recurse
  // into the symlinked node_modules and bury the planted violations under
  // diagnostics from third-party packages.
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "qualy-e2e-fixture", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "big-class.ts"), classWith25Methods());

  return dir;
}

describe("e2e: install + audit detects a real WMC violation (T4.2)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("greenfield preset surfaces src/big-class.ts in by_metric.wmc.top[0]", () => {
    const dir = writeFixture();
    cleanups.push(() => {
      // Guard: only allow recursive removal under tmpdir() to avoid
      // catastrophe if the symlink resolution is ever miswired.
      if (!dir.startsWith(tmpdir() + sep)) return;
      rmSync(dir, { recursive: true, force: true });
    });

    // Layer 1: install-oxlint (real path resolution into the symlinked
    // node_modules; this is what was broken pre-T1.3).
    const oxlintRes = installOxlint({ cwd: dir, stage: "greenfield" });
    expect(oxlintRes.ok, JSON.stringify(oxlintRes)).toBe(true);
    if (!oxlintRes.ok) return;

    // Layer 2: audit. Bin is the real oxlint from node_modules; subprocess
    // runs the real plugin against the planted file. Stage / test-runner
    // detection is stubbed because the fixture has no git history (and that
    // is orthogonal to what this test verifies — namely, the diagnostic
    // ingest pipeline).
    const oxlintBin = join(dir, "node_modules", ".bin", "oxlint");
    const stubStage: AuditDeps["detectStageFn"] = ({ cwd }) =>
      ({
        ok: true,
        cwd,
        stage: "greenfield",
        signals: {
          first_commit_date: null,
          age_days: 0,
          source_files: 1,
          loc: 30,
          churn_90d: 0,
          has_tests: false,
          todo_count: 0,
          todo_density_per_100_loc: 0,
          linter_present: false,
        },
      }) satisfies DetectStageResult;
    const stubRunner: AuditDeps["detectTestRunnerFn"] = ({ cwd }) =>
      ({
        cwd,
        runner: "vitest",
        coverage: { configured: false, config_files: [], current_thresholds: null },
        framework_signals: { vitest: false, jest: false, mocha: false },
      }) satisfies DetectTestRunnerResult;
    const result = audit(
      { cwd: dir, tier: "deep", oxlintBin },
      { detectStageFn: stubStage, detectTestRunnerFn: stubRunner },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const v = result.payload.violations;
    // Greenfield WMC is "error" severity at threshold 15 → 25 methods trips it.
    expect(v.summary.errors).toBeGreaterThanOrEqual(1);
    expect(v.by_metric.wmc.violations).toBeGreaterThanOrEqual(1);
    const top = v.by_metric.wmc.top[0];
    expect(top, "wmc top[0] must be populated").toBeDefined();
    if (!top) return;
    expect(top.file).toMatch(/big-class\.ts$/);
    // Note: oxlint's JSON output for quality-metrics rules carries the metric
    // value inside the `message` string, not as a structured `value` field.
    // The audit aggregator therefore leaves `top.value` undefined for these
    // diagnostics today. The regression we care about is "WMC violation
    // detected on the planted file at all" — surfacing the numeric value
    // would require message-string parsing in `normalizeDiagnostic`, out of
    // scope for T4.2.

    // Tooling block reflects the linked package (was always null pre-T3.1).
    expect(result.payload.tooling.quality_metrics).not.toBeNull();
    expect(result.payload.tooling.oxlint).not.toBeNull();
  });
});
