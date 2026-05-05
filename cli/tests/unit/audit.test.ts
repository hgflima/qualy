/**
 * Contract tests for `audit` (IMPLEMENTATION_PLAN.md Phase 4).
 *
 * What is locked:
 *   - Payload shape validates against `auditPayloadSchema` (SPEC §3).
 *   - Subprocess seam: `runFn` is invoked exactly once with
 *     `oxlint --config <preset> --format json .` against the resolved tier.
 *   - Tier resolution prefers deep, falls back to fast, errors when neither
 *     preset is present.
 *   - rules_active is stitched from BOTH presets (fast + deep) when both
 *     exist, with deterministic ordering and `origin: preset:<stage>:<tier>`.
 *   - Diagnostics are aggregated into `summary` (errors/warnings/files
 *     affected) and `by_metric` (quality-metrics rule namespace).
 *   - oxlint binary missing produces `oxlint_missing` (MISSING_DEPENDENCY).
 *   - errors > 0 returns RECOVERABLE_ERROR via `runAudit`.
 *   - Output JSON is written under `.lint-audit/<safeTs>.json` and is NOT
 *     recorded in the manifest (audit reports are transient outputs).
 *   - `--strict` honors the dirty-tree gate before any subprocess runs.
 *   - parseAuditArgs covers every flag combination + error path.
 */
import { PassThrough } from "node:stream";
import { sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_DIR,
  type AuditDeps,
  type RunFn,
  audit,
  parseAuditArgs,
  toSafeTimestamp,
} from "../../src/commands/audit.ts";
import {
  type DetectStageResult,
  type DetectStageSignals,
} from "../../src/commands/detect-stage.ts";
import { type DetectTestRunnerResult } from "../../src/commands/detect-test-runner.ts";
import {
  AUDIT_SCHEMA_VERSION,
  validateAuditPayload,
} from "../../src/lib/audit-schema.ts";
import {
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { setLogLevel, setStreams } from "../../src/lib/logger.ts";
import { IGNORE_MANIFEST_PATH } from "../../src/lib/paths.ts";

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

const FIXED_DATE = new Date("2026-05-03T14:22:11.000Z");
const FIXED_GENERATED_AT = "2026-05-03T14:22:11.000Z";
const FIXED_SAFE_TS = "2026-05-03T14-22-11-000Z";

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

function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
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

const FAST_PRESET = JSON.stringify({
  $schema: "./node_modules/oxlint/configuration_schema.json",
  _comment:
    "qualy preset · stage=brownfield-moderate · tier=fast · generated=2026-05-03",
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
});

const DEEP_PRESET = JSON.stringify({
  $schema: "./node_modules/oxlint/configuration_schema.json",
  _comment:
    "qualy preset · stage=brownfield-moderate · tier=deep · generated=2026-05-03",
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  plugins: ["quality-metrics"],
  rules: {
    "quality-metrics/wmc": ["error", { max: 20 }],
    "quality-metrics/halstead-volume": ["warn", { max: 1000 }],
    "quality-metrics/halstead-effort": ["warn", { max: 400 }],
    "quality-metrics/lcom": ["warn", { max: 2 }],
    "quality-metrics/cbo": ["error", { max: 10 }],
    "quality-metrics/dit": ["warn", { max: 5 }],
  },
});

function pathJoin(...parts: string[]): string {
  return parts.join(sep);
}

function fakeStage(stage: "greenfield" | "brownfield-moderate" | "legacy" = "brownfield-moderate"):
  (opts: { cwd: string }) => DetectStageResult {
  return () => ({
    ok: true,
    cwd: ROOT,
    stage,
    signals: STAGE_SIGNALS,
    reasoning: `synthetic-${stage}`,
  });
}

const FAKE_TEST_RUNNER: DetectTestRunnerResult = {
  ok: true,
  cwd: ROOT,
  runner: "vitest",
  candidates: {
    vitest: {
      configs: ["vitest.config.ts"],
      pkg_dep: true,
      thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
      thresholds_source: "vitest.config.ts",
    },
    jest: { configs: [], pkg_dep: false, thresholds: null, thresholds_source: null },
  },
  coverage: {
    configured: true,
    current_thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
    current_values: null,
    source: "vitest.config.ts",
  },
};

function fakeRunner(): (opts: { cwd: string }) => DetectTestRunnerResult {
  return () => FAKE_TEST_RUNNER;
}

function diagnosticsFixture(): unknown[] {
  return [
    {
      severity: "error",
      filename: "src/big.ts",
      rule: "quality-metrics/wmc",
      class: "OrderProcessor",
      value: 38,
      max: 20,
    },
    {
      severity: "error",
      filename: "src/big.ts",
      rule: "quality-metrics/cbo",
      class: "OrderProcessor",
      value: 14,
      max: 10,
    },
    {
      severity: "warning",
      filename: "src/h.ts",
      rule: "quality-metrics/halstead-volume",
      value: 1840,
      max: 1000,
    },
    {
      severity: "warning",
      filename: "src/h.ts",
      rule: "quality-metrics/halstead-volume",
      value: 1100,
      max: 1000,
    },
    {
      severity: "error",
      filename: "src/foo.ts",
      rule: "correctness/no-debugger",
    },
    {
      severity: "warning",
      filename: "src/bar.ts",
      rule: "suspicious/no-shadow",
    },
  ];
}

function makeDeps(
  options: {
    files?: Record<string, string>;
    runOutput?: string;
    runOk?: boolean;
    runStderr?: string;
    runExitCode?: number;
    onRun?: (binary: string, args: readonly string[], cwd: string) => void;
    detectStageFn?: AuditDeps["detectStageFn"];
    detectTestRunnerFn?: AuditDeps["detectTestRunnerFn"];
    dirtyFilesFn?: AuditDeps["dirtyFilesFn"];
    checkDriftFn?: AuditDeps["checkDriftFn"];
  } = {},
): { deps: AuditDeps; io: ReturnType<typeof memoryIO>; calls: { binary: string; args: readonly string[]; cwd: string }[] } {
  const io = memoryIO(options.files ?? {});
  const calls: { binary: string; args: readonly string[]; cwd: string }[] = [];
  const runFn: RunFn = (binary, args, cwd) => {
    calls.push({ binary, args, cwd });
    options.onRun?.(binary, args, cwd);
    return {
      ok: options.runOk ?? true,
      stdout: options.runOutput ?? "[]",
      stderr: options.runStderr ?? "",
      exitCode: options.runExitCode ?? 0,
    };
  };
  const deps: AuditDeps = {
    safeIO: io,
    existsFn: io.existsFn,
    readFileFn: io.readFileFn,
    runFn,
    detectStageFn: options.detectStageFn ?? fakeStage(),
    detectTestRunnerFn: options.detectTestRunnerFn ?? fakeRunner(),
    dirtyFilesFn: options.dirtyFilesFn,
    now: () => FIXED_DATE,
    ...(options.checkDriftFn !== undefined ? { checkDriftFn: options.checkDriftFn } : {}),
  };
  return { deps, io, calls };
}

describe("toSafeTimestamp", () => {
  it("matches the format used by backup-create", () => {
    expect(toSafeTimestamp(FIXED_DATE)).toBe(FIXED_SAFE_TS);
  });
});

describe("audit — happy path", () => {
  it("aggregates diagnostics into the SPEC §3 contract", () => {
    const { deps, io, calls } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: FAST_PRESET,
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
      },
      runOutput: JSON.stringify(diagnosticsFixture()),
    });

    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One subprocess call; correct argv.
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("oxlint");
    expect(calls[0].args).toEqual(["--config", "oxlint.deep.json", "--format", "json", "."]);
    expect(calls[0].cwd).toBe(ROOT);

    expect(result.tier).toBe("deep");
    expect(result.path).toBe(`${AUDIT_DIR}/${FIXED_SAFE_TS}.json`);
    expect(result.timestamp).toBe(FIXED_SAFE_TS);
    expect(result.generated_at).toBe(FIXED_GENERATED_AT);

    const payload = result.payload;
    expect(payload.version).toBe(AUDIT_SCHEMA_VERSION);
    expect(payload.generated_at).toBe(FIXED_GENERATED_AT);
    expect(payload.stage).toBe("brownfield-moderate");
    expect(payload.stage_signals).toMatchObject({
      age_days: 153,
      loc: 1280,
      source_files: 12,
    });
    expect(payload.tooling.test_runner).toBe("vitest");
    expect(payload.tooling.coverage.configured).toBe(true);
    expect(payload.tooling.coverage.thresholds).toEqual({
      lines: 70,
      functions: 70,
      branches: 60,
      statements: 70,
    });

    // Violations summary covers every diagnostic regardless of metric.
    expect(payload.violations.summary).toEqual({
      errors: 3, // wmc, cbo, no-debugger
      warnings: 3, // halstead×2, no-shadow
      files_affected: 4, // big.ts, h.ts, foo.ts, bar.ts
    });

    expect(payload.violations.by_metric.wmc.violations).toBe(1);
    expect(payload.violations.by_metric.wmc.max_seen).toBe(38);
    expect(payload.violations.by_metric.wmc.top[0]).toEqual({
      file: "src/big.ts",
      class: "OrderProcessor",
      value: 38,
      max: 20,
    });
    expect(payload.violations.by_metric.cbo.violations).toBe(1);
    expect(payload.violations.by_metric.cbo.max_seen).toBe(14);
    expect(payload.violations.by_metric.halstead.violations).toBe(2);
    expect(payload.violations.by_metric.halstead.max_seen_volume).toBe(1840);
    expect(payload.violations.by_metric.halstead.top[0].value).toBe(1840);
    expect(payload.violations.by_metric.lcom.violations).toBe(0);
    expect(payload.violations.by_metric.dit.violations).toBe(0);

    // rules_active stitches BOTH presets (fast + deep) with deterministic order.
    const ruleNames = payload.rules_active.map((r) => `${r.rule}@${r.origin}`);
    expect(ruleNames).toContain("category:correctness@preset:brownfield-moderate:fast");
    expect(ruleNames).toContain("category:suspicious@preset:brownfield-moderate:fast");
    expect(ruleNames).toContain("category:correctness@preset:brownfield-moderate:deep");
    expect(ruleNames).toContain("quality-metrics/wmc@preset:brownfield-moderate:deep");

    const wmcRule = payload.rules_active.find((r) => r.rule === "quality-metrics/wmc");
    expect(wmcRule?.severity).toBe("error");
    expect(wmcRule?.options).toEqual({ max: 20 });

    expect(payload.recommendations).toEqual([]);

    // File written + bytes reported.
    const writtenAbs = pathJoin(ROOT, AUDIT_DIR, `${FIXED_SAFE_TS}.json`);
    const written = io.files.get(writtenAbs);
    expect(written).toBeDefined();
    expect(result.bytes).toBe(Buffer.byteLength(written ?? "", "utf8"));

    // Audit JSON is NOT recorded in the manifest (transient artifact).
    expect(io.files.get(pathJoin(ROOT, MANIFEST_FILENAME))).toBeUndefined();

    // The persisted JSON round-trips through the schema.
    const reparsed = JSON.parse(written ?? "");
    expect(validateAuditPayload(reparsed).ok).toBe(true);
  });

  it("falls back to fast tier when deep preset is absent", () => {
    const { deps, calls } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.fast.json")]: FAST_PRESET },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT, tier: "deep" }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe("fast");
    expect(calls[0].args).toEqual(["--config", "oxlint.fast.json", "--format", "json", "."]);
  });

  it("honors --tier fast even when deep is available", () => {
    const { deps, calls } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.fast.json")]: FAST_PRESET,
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
      },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT, tier: "fast" }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe("fast");
    expect(calls[0].args[1]).toBe("oxlint.fast.json");
  });

  it("respects --ts override", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
    });
    const result = audit(
      { cwd: ROOT, timestamp: "2099-12-31T00-00-00-000Z" },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timestamp).toBe("2099-12-31T00-00-00-000Z");
    expect(result.path).toBe(`${AUDIT_DIR}/2099-12-31T00-00-00-000Z.json`);
  });
});

describe("audit — output parsing variants", () => {
  it("accepts top-level array", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: JSON.stringify([
        { severity: "error", filename: "a.ts", rule: "correctness/x" },
      ]),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary.errors).toBe(1);
  });

  it("accepts {diagnostics: []} envelope", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: JSON.stringify({
        diagnostics: [
          { severity: "warning", filename: "a.ts", rule: "suspicious/x" },
        ],
      }),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary.warnings).toBe(1);
  });

  it("accepts NDJSON output", () => {
    const lines = [
      JSON.stringify({ severity: "error", filename: "a.ts", rule: "correctness/x" }),
      "",
      JSON.stringify({ severity: "warn", filename: "b.ts", rule: "suspicious/y" }),
    ].join("\n");
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: lines,
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary).toEqual({
      errors: 1,
      warnings: 1,
      files_affected: 2,
    });
  });

  it("ignores diagnostics missing required fields", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: JSON.stringify([
        { severity: "error" }, // no filename
        { filename: "a.ts" }, // no severity
        "garbage",
        { severity: "info", filename: "x.ts" }, // unrecognized severity
      ]),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary).toEqual({
      errors: 0,
      warnings: 0,
      files_affected: 0,
    });
  });

  it("treats empty stdout as zero violations", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary.errors).toBe(0);
  });

  it("caps top[] at 5 per metric, sorted by value desc", () => {
    const diagnostics = Array.from({ length: 8 }, (_, i) => ({
      severity: "warning",
      filename: `src/f${i}.ts`,
      rule: "quality-metrics/lcom",
      value: 10 - i,
      max: 2,
    }));
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: JSON.stringify(diagnostics),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.by_metric.lcom.violations).toBe(8);
    expect(result.payload.violations.by_metric.lcom.top).toHaveLength(5);
    expect(result.payload.violations.by_metric.lcom.top[0].value).toBe(10);
    expect(result.payload.violations.by_metric.lcom.top[4].value).toBe(6);
  });
});

describe("audit — error paths", () => {
  it("preset_missing when neither preset exists", () => {
    const { deps } = makeDeps({});
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("preset_missing");
  });

  it("oxlint_missing when binary returns empty stdout + non-ok", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOk: false,
      runOutput: "",
      runStderr: "command not found: oxlint",
      runExitCode: 127,
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("oxlint_missing");
  });

  it("non-zero oxlint exit with stdout is treated as success", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOk: false,
      runOutput: JSON.stringify([
        { severity: "error", filename: "a.ts", rule: "correctness/x" },
      ]),
      runStderr: "oxlint exited 1 because errors were found",
      runExitCode: 1,
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.violations.summary.errors).toBe(1);
  });

  it("stage_detection_failed when detectStage fails", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      detectStageFn: () => ({ ok: false, error: "git_failed" }),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("stage_detection_failed");
  });

  it("dirty_tree under --strict before any subprocess", () => {
    const { deps, calls } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      dirtyFilesFn: () => ({ ok: true, value: ["dirty.ts"] }),
    });
    const result = audit({ cwd: ROOT, strict: true }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("dirty_tree");
    expect(calls).toHaveLength(0); // never spawned oxlint
  });

  it("git_check_failed when dirty probe errors", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      dirtyFilesFn: () => ({ ok: false, error: "no git binary" }),
    });
    const result = audit({ cwd: ROOT, strict: true }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("git_check_failed");
  });
});

describe("audit — tooling versions", () => {
  it("reads installed versions from node_modules", () => {
    const { deps } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
        [pathJoin(ROOT, "node_modules", "oxlint", "package.json")]: JSON.stringify({
          version: "1.2.3",
        }),
        [pathJoin(ROOT, "node_modules", "oxfmt", "package.json")]: JSON.stringify({
          version: "0.4.0-alpha",
        }),
        [pathJoin(
          ROOT,
          "node_modules",
          "quality-metrics",
          "package.json",
        )]: JSON.stringify({ version: "0.9.1" }),
      },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.tooling.oxlint).toBe("1.2.3");
    expect(result.payload.tooling.oxfmt).toBe("0.4.0-alpha");
    expect(result.payload.tooling.quality_metrics).toBe("0.9.1");
  });

  it("returns null versions when packages are not installed", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.tooling.oxlint).toBeNull();
    expect(result.payload.tooling.oxfmt).toBeNull();
    expect(result.payload.tooling.quality_metrics).toBeNull();
  });
});

describe("audit — ignore-drift gate (T4.1)", () => {
  it("invokes checkDriftFn before any subprocess and continues on no-op", () => {
    const driftCalls: { cwd: string }[] = [];
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
      checkDriftFn: (cwd) => {
        driftCalls.push({ cwd });
        return {
          ok: true,
          recompiled: false,
          reason: "manifest_absent",
          files_changed: [],
        };
      },
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    expect(driftCalls).toEqual([{ cwd: ROOT }]);
  });

  it("recompile result is logged but does not fail audit", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
      checkDriftFn: () => ({
        ok: true,
        recompiled: true,
        files_changed: ["oxlint.fast.json", "oxlint.deep.json"],
      }),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
  });

  it("drift error (manifest_corrupt) propagates and skips oxlint", () => {
    const { deps, calls } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      checkDriftFn: () => ({
        ok: false,
        error: "manifest_corrupt",
        reason: "JSON parse failed: Unexpected token",
      }),
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_corrupt");
    expect(result.reason).toMatch(/JSON parse failed/);
    expect(calls).toHaveLength(0); // never spawned oxlint
  });

  it("default (no manifest, no statFn override) is a silent no-op", () => {
    // Real defaultStat → statSync against /proj/.harn/qualy/ignore.json which
    // does not exist on disk → null → manifest_absent. Existing tests rely on
    // this implicit no-op. This test pins the contract.
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
  });
});

describe("audit — expired ignore warnings (T4.2)", () => {
  // Build the on-disk path for `.harn/qualy/ignore.json` in a way that matches
  // however `loadIgnoreManifest` joins `cwd` with `IGNORE_MANIFEST_PATH`.
  const manifestPath = pathJoin(ROOT, ...IGNORE_MANIFEST_PATH.split("/"));

  function manifestFileFor(entries: Array<{
    id: string;
    glob: string;
    rule: string | null;
    reason: string;
    expires: string | null;
    createdAt?: string;
    createdBy?: "user" | "imported";
  }>): string {
    return JSON.stringify({
      version: 1,
      entries: entries.map((e) => ({
        id: e.id,
        glob: e.glob,
        rule: e.rule,
        reason: e.reason,
        expires: e.expires,
        createdAt: e.createdAt ?? "2026-01-01T00:00:00.000Z",
        createdBy: e.createdBy ?? "user",
      })),
    });
  }

  let capturedStderr = "";
  function captureStderr(): void {
    const stderr = new PassThrough();
    const stdout = new PassThrough();
    capturedStderr = "";
    stderr.on("data", (chunk) => {
      capturedStderr += String(chunk);
    });
    setLogLevel("warn");
    setStreams({ stderr, stdout });
  }

  afterEach(() => {
    setStreams({ stderr: process.stderr, stdout: process.stdout });
    setLogLevel("info");
  });

  it("omits ignore_warnings when manifest is absent", () => {
    const { deps } = makeDeps({
      files: { [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignore_warnings).toEqual([]);
  });

  it("returns empty warnings when no entries are expired", () => {
    const { deps } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
        [manifestPath]: manifestFileFor([
          {
            id: "ign-active1",
            glob: "src/legacy/**",
            rule: null,
            reason: "legacy code",
            expires: "2099-12-31",
          },
          {
            id: "ign-noexp",
            glob: "src/generated/**",
            rule: null,
            reason: "generated",
            expires: null,
          },
        ]),
      },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignore_warnings).toEqual([]);
  });

  it("surfaces a warning per expired entry with correct days_overdue", () => {
    captureStderr();
    const { deps } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
        [manifestPath]: manifestFileFor([
          // Expired by 1 day (FIXED_DATE = 2026-05-03).
          {
            id: "ign-d1",
            glob: "src/old/**",
            rule: null,
            reason: "stale",
            expires: "2026-05-02",
          },
          // Expired by 32 days.
          {
            id: "ign-d32",
            glob: "src/older/**",
            rule: "quality-metrics/wmc",
            reason: "stale wmc",
            expires: "2026-04-01",
          },
          // Active — must not appear in warnings.
          {
            id: "ign-active",
            glob: "src/keep/**",
            rule: null,
            reason: "future",
            expires: "2099-12-31",
          },
        ]),
      },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignore_warnings).toHaveLength(2);
    expect(result.ignore_warnings).toEqual(
      expect.arrayContaining([
        {
          id: "ign-d1",
          glob: "src/old/**",
          expires: "2026-05-02",
          days_overdue: 1,
        },
        {
          id: "ign-d32",
          glob: "src/older/**",
          expires: "2026-04-01",
          days_overdue: 32,
        },
      ]),
    );

    // logger.warn fires once per expired entry; never blocks the audit.
    const lines = capturedStderr.split("\n").filter((l) => l.length > 0);
    const warnings = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((rec) => rec["event"] === "ignore_expired");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      level: "warn",
      event: "ignore_expired",
      days_overdue: expect.any(Number),
    });
  });

  it("expired warnings never block audit ok status", () => {
    const { deps } = makeDeps({
      files: {
        [pathJoin(ROOT, "oxlint.deep.json")]: DEEP_PRESET,
        [manifestPath]: manifestFileFor([
          {
            id: "ign-old",
            glob: "src/dead/**",
            rule: null,
            reason: "old",
            expires: "2020-01-01",
          },
        ]),
      },
      runOutput: "[]",
    });
    const result = audit({ cwd: ROOT }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignore_warnings).toHaveLength(1);
    expect(result.ignore_warnings[0].days_overdue).toBeGreaterThan(0);
  });
});

describe("parseAuditArgs", () => {
  it("defaults", () => {
    const r = parseAuditArgs([], "/x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ cwd: "/x", strict: false });
  });

  it("--cwd / --tier / --ts / --strict / --oxlint-bin combined", () => {
    const r = parseAuditArgs(
      ["--cwd", "sub", "--tier", "fast", "--ts", "X", "--strict", "--oxlint-bin", "/usr/bin/oxlint"],
      sep === "/" ? "/x" : "C:\\x",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tier).toBe("fast");
    expect(r.value.timestamp).toBe("X");
    expect(r.value.strict).toBe(true);
    expect(r.value.oxlintBin).toBe("/usr/bin/oxlint");
  });

  it("rejects invalid tier", () => {
    const r = parseAuditArgs(["--tier", "all"], "/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invalid tier/);
  });

  it("rejects missing values", () => {
    for (const flag of ["--cwd", "--tier", "--ts", "--oxlint-bin"]) {
      const r = parseAuditArgs([flag], "/x");
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatch(/missing value/);
    }
  });

  it("--help / -h returns help sentinel", () => {
    expect(parseAuditArgs(["--help"], "/x")).toEqual({ ok: false, error: "help" });
    expect(parseAuditArgs(["-h"], "/x")).toEqual({ ok: false, error: "help" });
  });

  it("unknown flag rejected", () => {
    const r = parseAuditArgs(["--zonk"], "/x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown flag/);
  });
});
