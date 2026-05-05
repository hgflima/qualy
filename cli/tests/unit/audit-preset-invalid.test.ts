/**
 * T4.1 — `audit` distingue `preset_invalid` de `oxlint_missing`.
 *
 * SPEC §6 / PLAN.md B7: hoje qualquer falha com stdout vazio cai em
 * `oxlint_missing`. Quando o preset está inválido (caso comum: `/lint:setup`
 * gravou JSON com schema novo + oxlint antigo, ou um plugin não resolve), o
 * usuário precisa de mensagem acionável apontando para `/lint:setup` ou
 * `/lint:rollback`.
 *
 * Detecção: inspeciona `stderr` por âncoras de string. Lista intencionalmente
 * pequena — degrada para `oxlint_missing` se nada bater (preserva
 * comportamento atual para "binary not found" reais).
 */
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type AuditDeps,
  type RunFn,
  audit,
} from "../../src/commands/audit.ts";
import {
  type DetectStageResult,
  type DetectStageSignals,
} from "../../src/commands/detect-stage.ts";
import { type DetectTestRunnerResult } from "../../src/commands/detect-test-runner.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";
const FIXED_DATE = new Date("2026-05-05T10:00:00.000Z");

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

const STAGE_SIGNALS: DetectStageSignals = {
  first_commit_date: "2025-12-01T00:00:00.000Z",
  age_days: 153,
  source_files: 12,
  loc: 1280,
  churn_90d: 47,
  has_tests: true,
  todo_count: 3,
  todo_density_per_100_loc: 0.234,
  linter_present: false,
};

function fakeStage(): AuditDeps["detectStageFn"] {
  return () =>
    ({
      ok: true,
      cwd: ROOT,
      stage: "brownfield-moderate",
      signals: STAGE_SIGNALS,
    }) satisfies DetectStageResult;
}

function fakeRunner(): AuditDeps["detectTestRunnerFn"] {
  return () =>
    ({
      cwd: ROOT,
      runner: "vitest",
      coverage: {
        configured: false,
        config_files: [],
        current_thresholds: null,
      },
      framework_signals: { vitest: false, jest: false, mocha: false },
    }) satisfies DetectTestRunnerResult;
}

function memoryIO(initial: Record<string, string>): SafeIO {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      files.set(p, c);
    },
    mkdirFn: () => {
      /* in-memory */
    },
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => FIXED_DATE,
  };
}

const MINIMAL_DEEP_PRESET = JSON.stringify({
  $schema: "./node_modules/oxlint/configuration_schema.json",
  categories: { correctness: "error" },
});

function makeDeps(stderr: string): AuditDeps {
  const io = memoryIO({
    [pathJoin(ROOT, "oxlint.deep.json")]: MINIMAL_DEEP_PRESET,
  });
  const runFn: RunFn = () => ({
    ok: false,
    stdout: "",
    stderr,
    exitCode: 1,
  });
  return {
    safeIO: io,
    existsFn: io.existsFn,
    readFileFn: io.readFileFn,
    runFn,
    detectStageFn: fakeStage(),
    detectTestRunnerFn: fakeRunner(),
    now: () => FIXED_DATE,
  };
}

describe("audit — preset_invalid detection (T4.1)", () => {
  const PRESET_INVALID_FIXTURES: { name: string; stderr: string }[] = [
    {
      name: "Failed to parse oxlint configuration file",
      stderr:
        "Failed to parse oxlint configuration file at oxlint.deep.json: unknown field `_comment`, expected one of `$schema`, `plugins`",
    },
    {
      name: "Unknown plugin",
      stderr: "Unknown plugin: 'quality-metrics'",
    },
    {
      name: "Cannot find module (jsPlugins resolution failure)",
      stderr: "Error: Cannot find module 'quality-metrics' from /tmp/proj",
    },
    {
      name: "Unknown rule",
      stderr:
        "Unknown rule: 'quality-metrics/halstead-volume' (the plugin exports `halstead`)",
    },
  ];

  for (const fixture of PRESET_INVALID_FIXTURES) {
    it(`maps "${fixture.name}" to preset_invalid`, () => {
      const deps = makeDeps(fixture.stderr);
      const result = audit({ cwd: ROOT }, deps);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("preset_invalid");
      // Reason carries the trimmed first line of stderr so the user sees the
      // root cause, not just a generic "config broken" string.
      expect(result.reason).toContain(fixture.stderr.split("\n")[0].trim());
      // And points the user at the recovery path (SPEC §6).
      expect(result.reason).toMatch(/\/lint:setup|\/lint:rollback/);
    });
  }

  it("falls back to oxlint_missing when stderr matches no known anchor", () => {
    const deps = makeDeps("command not found: oxlint");
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("oxlint_missing");
  });

  it("falls back to oxlint_missing when stderr is empty", () => {
    const deps = makeDeps("");
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("oxlint_missing");
  });

  it("preset_invalid takes precedence even with multi-line stderr", () => {
    const deps = makeDeps(
      "  Failed to parse oxlint configuration file\n  caused by: unknown field `_comment`\n",
    );
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("preset_invalid");
    // First non-empty line is surfaced verbatim (after trim).
    expect(result.reason).toContain("Failed to parse oxlint configuration file");
  });
});
