/**
 * Contract tests for `lib/decision-log-migration.ts` (lint-ignore PLAN T1.3).
 *
 * `migrateDecisionLogIfNeeded` covers 5 mutually exclusive states:
 *   - legacy + new (conflict, refuse)
 *   - legacy only, tracked    → git mv + meta entry
 *   - legacy only, untracked  → fs rename + meta entry
 *   - new only                → no-op (already migrated)
 *   - neither                 → no-op (no-legacy)
 *
 * The helper is fully DI'd so unit tests stub the FS and git layers without
 * touching disk or the working tree. Real-world behaviour is covered by the
 * Phase 1 smoke run noted in PLAN §Checkpoint Phase 1.
 */
import { describe, expect, it } from "vitest";

import {
  ENTRIES_END,
  ENTRIES_START,
} from "../../src/lib/decision-log.ts";
import {
  migrateDecisionLogIfNeeded,
  type DecisionLogMigrationDeps,
} from "../../src/lib/decision-log-migration.ts";
import {
  DECISION_LOG_PATH,
  LEGACY_DECISION_LOG_PATH,
} from "../../src/lib/paths.ts";

const ROOT = "/proj";
const LEGACY_ABS = `${ROOT}/${LEGACY_DECISION_LOG_PATH}`;
const NEW_ABS = `${ROOT}/${DECISION_LOG_PATH}`;
const TPL_ABS = "/tpl/lint-decisions.md.tpl";

const TEMPLATE_BODY = `# Lint decisions

## Entries

${ENTRIES_START}
${ENTRIES_END}
`;

const LEGACY_BODY_WITH_ENTRY = `# Lint decisions

## Entries

${ENTRIES_START}

### 2026-04-01T00:00:00Z — rule-add: x

- **kind**: rule-add
- **rule**: x
- **author**: alice
- **reason**: r

${ENTRIES_END}
`;

interface FakeFS {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly tracked: Set<string>;
  readonly mkdirCalls: string[];
  readonly mvCalls: Array<{ from: string; to: string }>;
  readonly gitMvCalls: Array<{ from: string; to: string }>;
  readonly writeCalls: Array<{ path: string; content: string }>;
}

function makeFS(init: { files?: Record<string, string>; tracked?: readonly string[] }): FakeFS {
  const fs: FakeFS = {
    files: new Map(Object.entries(init.files ?? {})),
    dirs: new Set(),
    tracked: new Set(init.tracked ?? []),
    mkdirCalls: [],
    mvCalls: [],
    gitMvCalls: [],
    writeCalls: [],
  };
  return fs;
}

function depsFor(
  fs: FakeFS,
  overrides: Partial<DecisionLogMigrationDeps> = {},
): DecisionLogMigrationDeps {
  return {
    existsFn: (p) => fs.files.has(p),
    readFileFn: (p) => fs.files.get(p) ?? null,
    writeFileFn: (p, c) => {
      fs.writeCalls.push({ path: p, content: c });
      fs.files.set(p, c);
    },
    mkdirFn: (d) => {
      fs.mkdirCalls.push(d);
      fs.dirs.add(d);
    },
    mvFn: (from, to) => {
      fs.mvCalls.push({ from, to });
      const content = fs.files.get(from);
      if (content === undefined) throw new Error(`mv: source missing ${from}`);
      fs.files.set(to, content);
      fs.files.delete(from);
    },
    gitTracksFn: (_cwd, p) => fs.tracked.has(p),
    gitMvFn: (_cwd, from, to) => {
      fs.gitMvCalls.push({ from, to });
      const fromAbs = `${ROOT}/${from}`;
      const toAbs = `${ROOT}/${to}`;
      const content = fs.files.get(fromAbs);
      if (content === undefined) return false;
      fs.files.set(toAbs, content);
      fs.files.delete(fromAbs);
      return true;
    },
    now: () => new Date("2026-05-05T12:00:00Z"),
    templatePath: TPL_ABS,
    ...overrides,
  };
}

describe("migrateDecisionLogIfNeeded — happy paths", () => {
  it("git-tracked legacy: invokes gitMvFn and appends meta:migrate-decision-log entry", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
      tracked: [LEGACY_DECISION_LOG_PATH],
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(true);
    if (!r.migrated) return;
    expect(r.method).toBe("git-mv");
    expect(r.from).toBe(LEGACY_DECISION_LOG_PATH);
    expect(r.to).toBe(DECISION_LOG_PATH);

    expect(fs.gitMvCalls).toEqual([
      { from: LEGACY_DECISION_LOG_PATH, to: DECISION_LOG_PATH },
    ]);
    expect(fs.mvCalls).toEqual([]);
    expect(fs.files.has(LEGACY_ABS)).toBe(false);
    expect(fs.files.has(NEW_ABS)).toBe(true);

    const newContent = fs.files.get(NEW_ABS) ?? "";
    expect(newContent).toContain("meta:migrate-decision-log");
    expect(newContent).toContain("- **from**: docs/lint-decisions.md");
    expect(newContent).toContain("- **to**: .harn/qualy/docs/lint-decisions.md");
    // Pre-existing entry preserved.
    expect(newContent).toContain("rule-add: x");
  });

  it("untracked legacy: falls back to fs mv and still appends meta entry", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
      // tracked: [] — file is untracked
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(true);
    if (!r.migrated) return;
    expect(r.method).toBe("mv");

    expect(fs.gitMvCalls).toEqual([]);
    expect(fs.mvCalls).toEqual([{ from: LEGACY_ABS, to: NEW_ABS }]);
    expect(fs.files.get(NEW_ABS)).toContain("meta:migrate-decision-log");
    expect(fs.files.get(NEW_ABS)).toContain("rule-add: x");
  });

  it("creates the .harn/qualy/docs directory before moving", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
    });

    migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(fs.mkdirCalls.length).toBeGreaterThan(0);
    expect(fs.mkdirCalls[0]).toBe(`${ROOT}/.harn/qualy/docs`);
  });
});

describe("migrateDecisionLogIfNeeded — no-op paths", () => {
  it("returns no-op when only the new path exists (already migrated)", () => {
    const fs = makeFS({ files: { [NEW_ABS]: TEMPLATE_BODY } });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(false);
    if (r.migrated) return;
    expect(r.reason).toBe("already-migrated");
    expect(fs.gitMvCalls).toEqual([]);
    expect(fs.mvCalls).toEqual([]);
    expect(fs.writeCalls).toEqual([]);
  });

  it("returns no-op when neither path exists (no legacy to migrate)", () => {
    const fs = makeFS({ files: {} });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(false);
    if (r.migrated) return;
    expect(r.reason).toBe("no-legacy");
  });
});

describe("migrateDecisionLogIfNeeded — error paths", () => {
  it("refuses when both legacy and new paths exist (decision_log_conflict)", () => {
    const fs = makeFS({
      files: {
        [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY,
        [NEW_ABS]: TEMPLATE_BODY,
      },
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("decision_log_conflict");
    expect(r.reason).toContain("docs/lint-decisions.md");
    expect(r.reason).toContain(".harn/qualy/docs/lint-decisions.md");
    expect(fs.gitMvCalls).toEqual([]);
    expect(fs.mvCalls).toEqual([]);
  });

  it("returns migration_io_failed when fs.mv throws", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs, {
      mvFn: () => {
        throw new Error("permission denied");
      },
    }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("migration_io_failed");
    expect(r.reason).toContain("permission denied");
  });

  it("returns migration_io_failed when gitMv reports failure on a tracked file", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
      tracked: [LEGACY_DECISION_LOG_PATH],
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs, {
      gitMvFn: () => false,
    }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("migration_io_failed");
  });
});

describe("migrateDecisionLogIfNeeded — meta entry shape", () => {
  it("appends meta entry with timestamp from now()", () => {
    const fs = makeFS({
      files: { [LEGACY_ABS]: LEGACY_BODY_WITH_ENTRY },
    });

    const r = migrateDecisionLogIfNeeded(ROOT, depsFor(fs, {
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    }));

    expect(r.ok).toBe(true);
    const newContent = fs.files.get(NEW_ABS) ?? "";
    expect(newContent).toContain(
      "### 2026-06-01T00:00:00Z — meta:migrate-decision-log",
    );
  });
});
