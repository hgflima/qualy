/**
 * Coverage preset contract tests (IMPLEMENTATION_PLAN.md §Fase 2 + SPEC §3).
 *
 * Locks the canonical coverage thresholds table from SPEC §3 ("Estratégia de
 * coverage") against the in-source preset files at
 * `cli/src/presets/coverage/<runner>.<stage>.<ext>`. These files are read by
 * `install-coverage` and merged into the target project's runner config, so
 * any drift between the SPEC table and the presets ships immediately to
 * users — this suite is the gate.
 *
 * What is asserted:
 *   - All 6 files exist (2 runners × 3 stages) and parse.
 *   - Vitest .ts presets export a default with shape `test.coverage.thresholds`,
 *     declare `provider: "v8"`, and carry a stage tag in the file header.
 *   - Jest .json presets carry `coverageThreshold.global` with the same numbers,
 *     declare `coverageProvider: "v8"`, and carry stage metadata in `_comment`.
 *   - Legacy presets carry the `_warnOnly: true` opt-in flag (both runners).
 *   - All 4 threshold dimensions (lines / functions / branches / statements)
 *     match the SPEC §3 table exactly — drift here is a contract break.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PRESETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "presets",
  "coverage",
);

const STAGES = ["greenfield", "brownfield", "legacy"] as const;
type Stage = (typeof STAGES)[number];

interface Thresholds {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

/**
 * SPEC §3 coverage thresholds table — single source of truth this suite locks.
 * Any change MUST land in the table, the preset files, and this constant
 * together.
 */
const EXPECTED: Record<Stage, Thresholds> = {
  greenfield: { lines: 90, functions: 90, branches: 80, statements: 90 },
  brownfield: { lines: 70, functions: 70, branches: 60, statements: 70 },
  legacy: { lines: 40, functions: 40, branches: 30, statements: 40 },
};

// ----- vitest .ts presets -----

interface VitestPresetShape {
  _warnOnly?: boolean;
  test: {
    coverage: {
      provider: string;
      reporter?: readonly string[];
      thresholds: Thresholds;
    };
  };
}

async function loadVitestPreset(stage: Stage): Promise<VitestPresetShape> {
  const path = join(PRESETS_DIR, `vitest.${stage}.ts`);
  const mod = (await import(path)) as { default: VitestPresetShape };
  return mod.default;
}

function readVitestSource(stage: Stage): string {
  return readFileSync(join(PRESETS_DIR, `vitest.${stage}.ts`), "utf8");
}

describe("vitest coverage presets — file presence and header metadata", () => {
  for (const stage of STAGES) {
    it(`vitest.${stage}.ts has stage tag in the file header`, () => {
      const src = readVitestSource(stage);
      expect(src).toContain(`stage=${stage}`);
      expect(src).toContain("runner=vitest");
    });

    it(`vitest.${stage}.ts default export carries a coverage block`, async () => {
      const preset = await loadVitestPreset(stage);
      expect(preset).toBeDefined();
      expect(preset.test).toBeDefined();
      expect(preset.test.coverage).toBeDefined();
      expect(preset.test.coverage.thresholds).toBeDefined();
    });

    it(`vitest.${stage}.ts declares provider 'v8' (matches @vitest/coverage-v8)`, async () => {
      const preset = await loadVitestPreset(stage);
      expect(preset.test.coverage.provider).toBe("v8");
    });
  }
});

describe("vitest coverage presets — SPEC §3 thresholds", () => {
  for (const stage of STAGES) {
    const expected = EXPECTED[stage];
    for (const dim of ["lines", "functions", "branches", "statements"] as const) {
      it(`vitest.${stage} · thresholds.${dim} = ${expected[dim]}`, async () => {
        const preset = await loadVitestPreset(stage);
        expect(preset.test.coverage.thresholds[dim]).toBe(expected[dim]);
      });
    }
  }
});

describe("vitest coverage presets — warn-only flag", () => {
  it("vitest.legacy carries _warnOnly: true (SPEC §3 'warn-only' marker)", async () => {
    const preset = await loadVitestPreset("legacy");
    expect(preset._warnOnly).toBe(true);
  });

  for (const stage of ["greenfield", "brownfield"] as const) {
    it(`vitest.${stage} does NOT carry _warnOnly (enforced threshold)`, async () => {
      const preset = await loadVitestPreset(stage);
      expect(preset._warnOnly).toBeUndefined();
    });
  }
});

// ----- jest .json presets -----

interface JestPresetShape {
  _comment: string;
  _warnOnly?: boolean;
  collectCoverage: boolean;
  coverageProvider: string;
  coverageReporters?: string[];
  coverageThreshold: {
    global: Thresholds;
  };
}

function loadJestPreset(stage: Stage): JestPresetShape {
  const path = join(PRESETS_DIR, `jest.${stage}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as JestPresetShape;
}

describe("jest coverage presets — file presence and metadata", () => {
  for (const stage of STAGES) {
    it(`jest.${stage}.json parses and carries SPEC stage metadata`, () => {
      const preset = loadJestPreset(stage);
      expect(typeof preset._comment).toBe("string");
      expect(preset._comment).toContain(`stage=${stage}`);
      expect(preset._comment).toContain("runner=jest");
    });

    it(`jest.${stage}.json declares coverageProvider 'v8'`, () => {
      const preset = loadJestPreset(stage);
      expect(preset.coverageProvider).toBe("v8");
    });

    it(`jest.${stage}.json enables collectCoverage`, () => {
      const preset = loadJestPreset(stage);
      expect(preset.collectCoverage).toBe(true);
    });
  }
});

describe("jest coverage presets — SPEC §3 thresholds", () => {
  for (const stage of STAGES) {
    const expected = EXPECTED[stage];
    for (const dim of ["lines", "functions", "branches", "statements"] as const) {
      it(`jest.${stage} · coverageThreshold.global.${dim} = ${expected[dim]}`, () => {
        const preset = loadJestPreset(stage);
        expect(preset.coverageThreshold.global[dim]).toBe(expected[dim]);
      });
    }
  }
});

describe("jest coverage presets — warn-only flag", () => {
  it("jest.legacy carries _warnOnly: true (SPEC §3 'warn-only' marker)", () => {
    const preset = loadJestPreset("legacy");
    expect(preset._warnOnly).toBe(true);
  });

  for (const stage of ["greenfield", "brownfield"] as const) {
    it(`jest.${stage} does NOT carry _warnOnly (enforced threshold)`, () => {
      const preset = loadJestPreset(stage);
      expect(preset._warnOnly).toBeUndefined();
    });
  }
});

// ----- cross-runner consistency -----

describe("coverage presets — vitest and jest agree on thresholds", () => {
  for (const stage of STAGES) {
    it(`${stage}: vitest thresholds == jest coverageThreshold.global`, async () => {
      const v = await loadVitestPreset(stage);
      const j = loadJestPreset(stage);
      expect(v.test.coverage.thresholds).toEqual(j.coverageThreshold.global);
    });
  }
});
