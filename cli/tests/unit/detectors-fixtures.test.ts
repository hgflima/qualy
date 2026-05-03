/**
 * Integration tests that exercise every detector against every fixture under
 * `cli/tests/fixtures/`. Acceptance for IMPLEMENTATION_PLAN.md Priority 2 —
 * the last gap of Phase 1: "Escrever testes unitários vitest para cada detector
 * contra cada fixture relevante". Each `EXPECTED.md` documents the per-fixture
 * contract; this file is the executable mirror of those documents.
 *
 * Why integration (real git) rather than mocked seams: the per-detector unit
 * tests already cover branch logic with `setGitRunner` / `existsFn` / `readFileFn`
 * stubs (`detect-stack.test.ts`, `detect-existing-linter.test.ts`, etc.). The
 * gap was *wiring* — that real `git ls-files`, `git status`, `git log` produce
 * the bytes detectors expect when handed a real on-disk fixture. The cost is
 * the materialization round-trip (cp + git init + commit) per `it`; this is
 * acceptable because each test runs in <1s and the fixtures are tiny.
 *
 * Determinism levers:
 *   - `materializeFixture` pins author/email/branch and uses commit date
 *     `2025-01-01T00:00:00Z` by default.
 *   - `detectStage` accepts an injected `now: () => Date` — used to drive
 *     `age_days` deterministically (e.g. 0d for greenfield, 1500d for legacy).
 *   - `churn_90d` cannot be deterministic here: `git rev-list --since=90 days ago`
 *     uses the system clock, not the injected `now`. Since fixtures commit at
 *     2025-01-01 and the test host clock is always later, `churn_90d` is
 *     reliably `0` — we assert it as a sanity check, not as a controlled signal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectStack } from "../../src/commands/detect-stack.ts";
import { detectExistingLinter } from "../../src/commands/detect-existing-linter.ts";
import { detectTestRunner } from "../../src/commands/detect-test-runner.ts";
import { detectStage } from "../../src/commands/detect-stage.ts";
import { gitCleanCheck } from "../../src/commands/git-clean-check.ts";
import { status } from "../../src/commands/status.ts";
import { materializeFixture } from "../fixtures/_materialize.ts";

const COMMIT_DATE_ISO = "2025-01-01T00:00:00.000Z";
/** Convenience: pinned `now` so `age_days === 0`. */
const nowAtCommit = () => new Date(COMMIT_DATE_ISO);

describe("detectors against fixtures/greenfield-ts/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detect-stack: supported, 5 .ts, no blockers, hasPackageJson", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = detectStack({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supported).toBe(true);
    expect(r.signals.tsFiles).toBe(5);
    expect(r.signals.tsxFiles).toBe(0);
    expect(r.signals.jsFiles).toBe(0);
    expect(r.signals.jsxFiles).toBe(0);
    expect(r.signals.hasPackageJson).toBe(true);
    expect(r.signals.vueFiles).toBe(0);
    expect(r.signals.svelteFiles).toBe(0);
    expect(r.blockers).toEqual([]);
    expect(r.supportedLanguages).toEqual(["ts"]);
  });

  it("detect-existing-linter: empty linters and formatters", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = detectExistingLinter({ cwd: fx.dir });
    expect(r.linters).toEqual([]);
    expect(r.formatters).toEqual([]);
  });

  it("detect-test-runner: runner='none', no thresholds", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = detectTestRunner({ cwd: fx.dir });
    expect(r.runner).toBe("none");
    expect(r.candidates.vitest.configs).toEqual([]);
    expect(r.candidates.vitest.pkg_dep).toBe(false);
    expect(r.candidates.vitest.thresholds).toBeNull();
    expect(r.candidates.jest.configs).toEqual([]);
    expect(r.candidates.jest.pkg_dep).toBe(false);
    expect(r.candidates.jest.thresholds).toBeNull();
    expect(r.coverage.configured).toBe(false);
    expect(r.coverage.current_thresholds).toBeNull();
    expect(r.coverage.source).toBeNull();
  });

  it("git-clean-check: clean, no dirty files", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = gitCleanCheck({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clean).toBe(true);
    expect(r.dirtyFiles).toEqual([]);
  });

  it("detect-stage: greenfield (age=0d, LOC=420, no linter)", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = detectStage({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("greenfield");
    expect(r.signals.age_days).toBe(0);
    expect(r.signals.first_commit_date).toBe(COMMIT_DATE_ISO);
    expect(r.signals.source_files).toBe(5);
    expect(r.signals.loc).toBe(420);
    expect(r.signals.has_tests).toBe(false);
    expect(r.signals.todo_count).toBe(0);
    expect(r.signals.todo_density_per_100_loc).toBe(0);
    expect(r.signals.linter_present).toBe(false);
    expect(r.signals.churn_90d).toBeGreaterThanOrEqual(0);
  });

  it("status: aggregates greenfield stage, no presets/hooks, default theme", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    const r = status({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    expect(r.stage.detected).toBe("greenfield");
    expect(r.coverage.runner).toBe("none");
    expect(r.coverage.configured).toBe(false);
    expect(r.coverage.current_thresholds).toBeNull();
    expect(r.presets.oxlint_fast).toBeNull();
    expect(r.presets.oxlint_deep).toBeNull();
    expect(r.hooks.claude_post_edit_script).toBe(false);
    expect(r.hooks.claude_settings_hook).toBe(false);
    expect(r.hooks.husky_pre_commit).toBe(false);
    expect(r.hooks.lint_staged_config).toBeNull();
    expect(r.theme).toBe("linear-design-md");
    expect(r.versions.oxlint).toBeNull();
    expect(r.versions.vitest).toBeNull();
    expect(r.versions.jest).toBeNull();
  });
});

describe("detectors against fixtures/brownfield-eslint-prettier/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detect-stack: supported, 8 .ts files, no blockers", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = detectStack({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supported).toBe(true);
    expect(r.signals.tsFiles).toBe(8);
    expect(r.signals.jsFiles).toBe(0);
    expect(r.signals.hasPackageJson).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.supportedLanguages).toEqual(["ts"]);
  });

  it("detect-existing-linter: eslint linter + prettier formatter, both with pkg_dep=true", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = detectExistingLinter({ cwd: fx.dir });
    expect(r.linters).toEqual([
      { name: "eslint", configs: [".eslintrc.json"], pkg_dep: true },
    ]);
    expect(r.formatters).toEqual([
      { name: "prettier", configs: [".prettierrc.json"], pkg_dep: true },
    ]);
  });

  it("detect-test-runner: runner='none', no candidates, no thresholds", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = detectTestRunner({ cwd: fx.dir });
    expect(r.runner).toBe("none");
    expect(r.candidates.vitest.configs).toEqual([]);
    expect(r.candidates.jest.configs).toEqual([]);
    expect(r.candidates.vitest.pkg_dep).toBe(false);
    expect(r.candidates.jest.pkg_dep).toBe(false);
    expect(r.coverage.configured).toBe(false);
  });

  it("git-clean-check: clean", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = gitCleanCheck({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clean).toBe(true);
  });

  it("detect-stage: brownfield-moderate (LOC>=5000 AND linter_present)", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = detectStage({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("brownfield-moderate");
    expect(r.signals.age_days).toBe(0);
    expect(r.signals.source_files).toBe(8);
    expect(r.signals.loc).toBe(5071);
    expect(r.signals.has_tests).toBe(false);
    expect(r.signals.todo_count).toBe(0);
    expect(r.signals.linter_present).toBe(true);
  });

  it("status: stage=brownfield-moderate, theme default, no presets", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const r = status({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.stage.detected).toBe("brownfield-moderate");
    expect(r.coverage.runner).toBe("none");
    expect(r.theme).toBe("linear-design-md");
    expect(r.presets.oxlint_fast).toBeNull();
    expect(r.presets.oxlint_deep).toBeNull();
  });
});

describe("detectors against fixtures/jest-with-coverage/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detect-stack: supported, ts=4 (3 src + 1 test), js=1 (jest.config.js)", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = detectStack({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supported).toBe(true);
    expect(r.signals.tsFiles).toBe(4);
    expect(r.signals.jsFiles).toBe(1);
    expect(r.signals.hasPackageJson).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.supportedLanguages).toEqual(["ts", "js"]);
  });

  it("detect-existing-linter: empty (jest is a test runner, not a linter)", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = detectExistingLinter({ cwd: fx.dir });
    expect(r.linters).toEqual([]);
    expect(r.formatters).toEqual([]);
  });

  it("detect-test-runner: runner='jest' with thresholds.lines=60 from jest.config.js", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = detectTestRunner({ cwd: fx.dir });
    expect(r.runner).toBe("jest");
    expect(r.candidates.jest.configs).toEqual(["jest.config.js"]);
    expect(r.candidates.jest.pkg_dep).toBe(true);
    expect(r.candidates.jest.thresholds).toEqual({
      lines: 60,
      functions: null,
      branches: null,
      statements: null,
    });
    expect(r.candidates.jest.thresholds_source).toBe("jest.config.js");
    expect(r.candidates.vitest.configs).toEqual([]);
    expect(r.candidates.vitest.pkg_dep).toBe(false);
    expect(r.coverage.configured).toBe(true);
    expect(r.coverage.current_thresholds).toEqual({
      lines: 60,
      functions: null,
      branches: null,
      statements: null,
    });
    expect(r.coverage.source).toBe("jest.config.js");
  });

  it("git-clean-check: clean", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = gitCleanCheck({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clean).toBe(true);
  });

  it("detect-stage: greenfield (age=0d, LOC=130, has_tests=true, no linter)", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = detectStage({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("greenfield");
    expect(r.signals.age_days).toBe(0);
    expect(r.signals.source_files).toBe(5);
    expect(r.signals.loc).toBe(130);
    expect(r.signals.has_tests).toBe(true);
    expect(r.signals.todo_count).toBe(0);
    expect(r.signals.linter_present).toBe(false);
  });

  it("status: jest coverage threshold surfaced via coverage.current_thresholds", () => {
    const fx = materializeFixture("jest-with-coverage");
    cleanups.push(fx.cleanup);

    const r = status({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.stage.detected).toBe("greenfield");
    expect(r.coverage.runner).toBe("jest");
    expect(r.coverage.configured).toBe(true);
    expect(r.coverage.current_thresholds).toEqual({
      lines: 60,
      functions: null,
      branches: null,
      statements: null,
    });
    expect(r.coverage.source).toBe("jest.config.js");
  });
});

describe("detectors against fixtures/legacy-monorepo/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detect-stack: supported, 13 .ts files across 3 packages", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = detectStack({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supported).toBe(true);
    expect(r.signals.tsFiles).toBe(13);
    expect(r.signals.jsFiles).toBe(0);
    expect(r.signals.hasPackageJson).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("detect-existing-linter: empty (no linter or formatter anywhere)", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = detectExistingLinter({ cwd: fx.dir });
    expect(r.linters).toEqual([]);
    expect(r.formatters).toEqual([]);
  });

  it("detect-test-runner: runner='none' (no test config anywhere)", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = detectTestRunner({ cwd: fx.dir });
    expect(r.runner).toBe("none");
    expect(r.candidates.vitest.configs).toEqual([]);
    expect(r.candidates.jest.configs).toEqual([]);
    expect(r.coverage.configured).toBe(false);
  });

  it("git-clean-check: clean", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = gitCleanCheck({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clean).toBe(true);
  });

  it("detect-stage Scenario A (now=commit): brownfield-moderate (LOC>5k, age<3y)", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = detectStage({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("brownfield-moderate");
    expect(r.signals.age_days).toBe(0);
    expect(r.signals.source_files).toBe(13);
    expect(r.signals.loc).toBe(11468);
    expect(r.signals.has_tests).toBe(false);
    expect(r.signals.todo_count).toBe(164);
    expect(r.signals.linter_present).toBe(false);
    // 164 / 11468 * 100 ≈ 1.43
    expect(r.signals.todo_density_per_100_loc).not.toBeNull();
    expect(r.signals.todo_density_per_100_loc!).toBeGreaterThan(1.0);
  });

  it("detect-stage Scenario B (now=commit+1500d): legacy via TODO density + no_tests", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = detectStage(
      { cwd: fx.dir },
      { now: () => new Date("2029-02-09T00:00:00Z") },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("legacy");
    expect(r.signals.age_days).toBe(1500);
    expect(r.signals.has_tests).toBe(false);
    expect(r.signals.todo_density_per_100_loc!).toBeGreaterThan(1.0);
    expect(r.reasoning).toMatch(/age 1500d > 1095d/);
  });

  it("status (Scenario B): aggregates legacy stage, no coverage, default theme", () => {
    const fx = materializeFixture("legacy-monorepo");
    cleanups.push(fx.cleanup);

    const r = status(
      { cwd: fx.dir },
      { now: () => new Date("2029-02-09T00:00:00Z") },
    );
    expect(r.stage.detected).toBe("legacy");
    expect(r.coverage.runner).toBe("none");
    expect(r.coverage.configured).toBe(false);
    expect(r.theme).toBe("linear-design-md");
    expect(r.presets.oxlint_fast).toBeNull();
    expect(r.presets.oxlint_deep).toBeNull();
  });
});

describe("detectors against fixtures/unsupported-python/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detect-stack: NOT supported, blockers=[python pyproject.toml], hasPackageJson=false", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = detectStack({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supported).toBe(false);
    expect(r.signals.tsFiles).toBe(0);
    expect(r.signals.tsxFiles).toBe(0);
    expect(r.signals.jsFiles).toBe(0);
    expect(r.signals.jsxFiles).toBe(0);
    expect(r.signals.hasPackageJson).toBe(false);
    expect(r.blockers).toEqual([{ kind: "python", file: "pyproject.toml" }]);
    expect(r.supportedLanguages).toEqual([]);
  });

  it("detect-existing-linter: empty (no JS/TS linter could possibly be configured)", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = detectExistingLinter({ cwd: fx.dir });
    expect(r.linters).toEqual([]);
    expect(r.formatters).toEqual([]);
  });

  it("detect-test-runner: runner='none' (catalog has no Python runners)", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = detectTestRunner({ cwd: fx.dir });
    expect(r.runner).toBe("none");
    expect(r.coverage.configured).toBe(false);
  });

  it("git-clean-check: clean", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = gitCleanCheck({ cwd: fx.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clean).toBe(true);
  });

  it("detect-stage: greenfield informational (zero TS files visible, no linter)", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = detectStage({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stage).toBe("greenfield");
    expect(r.signals.source_files).toBe(0);
    expect(r.signals.loc).toBe(0);
    expect(r.signals.todo_density_per_100_loc).toBeNull();
    expect(r.signals.linter_present).toBe(false);
  });

  it("status: stage=greenfield (informational), theme default, no presets", () => {
    const fx = materializeFixture("unsupported-python");
    cleanups.push(fx.cleanup);

    const r = status({ cwd: fx.dir }, { now: nowAtCommit });
    expect(r.stage.detected).toBe("greenfield");
    expect(r.theme).toBe("linear-design-md");
    expect(r.presets.oxlint_fast).toBeNull();
    expect(r.presets.oxlint_deep).toBeNull();
  });
});
