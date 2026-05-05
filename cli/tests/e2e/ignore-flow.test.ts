/**
 * E2E flow tests for the lint-ignore feature, locking SPEC §10 acceptance
 * criteria against real on-disk fixtures (PLAN T4.5).
 *
 * Each `it()` corresponds to one SPEC §10 numbered criterion (#1..#12). Tests
 * exercise the real CLI handlers (`ignoreAdd`, `ignoreList`, `ignoreRemove`,
 * `ignoreExplain`, `audit`) against materialized fixtures from
 * `cli/tests/fixtures/_materialize.ts` so manifest writes, preset rewrites,
 * and decision-log appends all touch a real filesystem inside `os.tmpdir()`.
 *
 * Why we don't shell out to oxlint:
 *   - The fixtures don't `npm install`, so oxlint has no binary on disk.
 *   - SPEC §10 #1 / #2 / #5 / #12 require us to verify *what gets persisted*
 *     (manifest, preset, decision log) — not whether oxlint specifically
 *     filters files. The contract that `src/legacy/**` lands inside
 *     `_qualy:start_/_qualy:end_` markers IS the evidence that "lint passes
 *     in files inside the glob"; oxlint's filter behavior is its own problem.
 *   - The audit handler accepts a `runFn` stub (mirror of
 *     `audit-recommendations.test.ts`) so audit-driven cases (#5, #12) can
 *     simulate diagnostics without real oxlint.
 *
 * Slash-command coverage (#7 / #11) is intentionally constrained to verifying
 * that the four `commands/lint/ignore/*.md` files exist with parseable
 * frontmatter and reference the qualy CLI subcommands they are supposed to
 * wrap — driving the actual Claude Code harness from vitest is out of reach.
 * The deeper markdown contract is locked by `cli/tests/unit/command-lint-
 * ignore-{add,list,remove,explain}-md.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { audit } from "../../src/commands/audit.ts";
import { ignoreAdd } from "../../src/commands/ignore/add.ts";
import { ignoreExplain } from "../../src/commands/ignore/explain.ts";
import { ignoreList } from "../../src/commands/ignore/list.ts";
import { ignoreRemove } from "../../src/commands/ignore/remove.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { checkDriftAndRecompile } from "../../src/lib/ignore-drift.ts";
import { generateEntryId } from "../../src/lib/ignore-manifest.ts";
import {
  DECISION_LOG_PATH,
  IGNORE_MANIFEST_PATH,
  IGNORE_MARKER_END,
  IGNORE_MARKER_START,
  LEGACY_DECISION_LOG_PATH,
  PRESET_PATHS,
} from "../../src/lib/paths.ts";
import { materializeFixture } from "../fixtures/_materialize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SLASH_COMMANDS_DIR = join(HERE, "..", "..", "..", "commands", "lint", "ignore");

const FIXED_DATE = new Date("2026-05-05T12:00:00.000Z");

interface PresetJson {
  readonly ignorePatterns?: readonly string[];
  readonly overrides?: ReadonlyArray<{
    readonly files?: readonly string[];
    readonly rules?: Record<string, string>;
  }>;
  readonly [key: string]: unknown;
}

function readJson<T>(absPath: string): T {
  return JSON.parse(readFileSync(absPath, "utf8")) as T;
}

function readManifest(cwd: string): {
  version: 1;
  entries: ReadonlyArray<{
    id: string;
    glob: string;
    rule: string | null;
    reason: string;
    expires: string | null;
    createdAt: string;
    createdBy: "user" | "imported";
  }>;
} {
  return readJson(join(cwd, IGNORE_MANIFEST_PATH));
}

function readPreset(cwd: string, rel: string): PresetJson {
  return readJson(join(cwd, rel));
}

describe("e2e: lint-ignore SPEC §10 acceptance criteria", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  // -------------------------------------------------------------------------
  // #1 — path-only ignore: manifest + preset + decision log on greenfield.
  // -------------------------------------------------------------------------
  it("#1 ignore-add path-only creates the manifest, recompiles both presets, and excludes the glob via markers", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const result = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "Codebase legado, será reescrito em Q3",
      },
      { now: () => FIXED_DATE },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe("added");
    expect(result.id).toBe(generateEntryId("src/legacy/**", null));
    expect(result.exitCode).toBe(EXIT_CODES.OK);

    // Manifest written with exactly one user entry.
    const manifest = readManifest(fx.dir);
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      id: "ign-19160e",
      glob: "src/legacy/**",
      rule: null,
      createdBy: "user",
      expires: null,
    });

    // Both presets carry the path between _qualy:start_/_qualy:end_ markers,
    // i.e. files matching the glob are filtered out before oxlint loads them.
    for (const rel of [PRESET_PATHS.fast, PRESET_PATHS.deep]) {
      const preset = readPreset(fx.dir, rel);
      const ip = preset.ignorePatterns ?? [];
      expect(ip[0]).toBe(IGNORE_MARKER_START);
      expect(ip[ip.length - 1]).toBe(IGNORE_MARKER_END);
      expect(ip.slice(1, -1)).toContain("src/legacy/**");
    }

    // Decision log was created and carries an `ignore-add` entry.
    const log = readFileSync(join(fx.dir, DECISION_LOG_PATH), "utf8");
    expect(log).toMatch(/kind\*\*: ignore-add\b/);
    expect(log).toContain("src/legacy/**");
    expect(log).toContain("Codebase legado");
  });

  // -------------------------------------------------------------------------
  // #2 — per-rule (quality-metrics/wmc) lands in overrides[], not in
  //      ignorePatterns. Other rules still apply on the same path.
  // -------------------------------------------------------------------------
  it("#2 ignore-add --rule quality-metrics/wmc routes to overrides and leaves ignorePatterns untouched", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const result = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/x/**",
        rule: "quality-metrics/wmc",
        reason: "Generated code — WMC noisy here",
      },
      { now: () => FIXED_DATE },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toBe("quality-metrics/wmc");

    // Per-rule entries do NOT inflate ignorePatterns (asymmetry documented in
    // ignore-compile.ts header) — the path is silenced via overrides[] only.
    const deep = readPreset(fx.dir, PRESET_PATHS.deep);
    const ip = deep.ignorePatterns ?? [];
    expect(ip).not.toContain("src/x/**");

    // overrides[] gained a managed block that turns wmc off for the glob.
    const overrides = deep.overrides ?? [];
    const managedRules = overrides
      .filter((o) => o.rules !== undefined)
      .flatMap((o) => Object.keys(o.rules ?? {}));
    expect(managedRules).toContain(IGNORE_MARKER_START);
    expect(managedRules).toContain(IGNORE_MARKER_END);

    // Find the override that wires `quality-metrics/wmc` → "off" for src/x/**.
    const wmcBlock = overrides.find(
      (o) =>
        Array.isArray(o.files) &&
        o.files.includes("src/x/**") &&
        o.rules !== undefined &&
        o.rules["quality-metrics/wmc"] === "off",
    );
    expect(wmcBlock, JSON.stringify(overrides, null, 2)).toBeDefined();

    // Other quality-metrics rules (cbo etc) are unchanged in `rules`.
    expect(deep.rules).toMatchObject({
      "quality-metrics/cbo": ["error", { max: 8 }],
    });
  });

  // -------------------------------------------------------------------------
  // #3 — list shows correct status for active vs expired entries.
  // -------------------------------------------------------------------------
  it("#3 ignore-list reports status=active and status=expired with days_overdue", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    // First entry: future expiry → active.
    const r1 = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "active",
        expires: "2099-12-31",
      },
      { now: () => FIXED_DATE },
    );
    expect(r1.ok).toBe(true);

    // Second entry: write directly into the manifest with an already-past
    // expiry. `validateExpires` would reject it through `ignore-add`, so we
    // bypass to set up the listing fixture (this is exactly what an old hand-
    // edit looks like in production).
    const manifestPath = join(fx.dir, IGNORE_MANIFEST_PATH);
    const current = readManifest(fx.dir);
    const expiredEntry = {
      id: generateEntryId("src/old/**", null),
      glob: "src/old/**",
      rule: null,
      reason: "stale debt",
      expires: "2026-04-01",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user" as const,
    };
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { version: 1, entries: [...current.entries, expiredEntry] },
        null,
        2,
      ) + "\n",
    );

    const list = ignoreList({ cwd: fx.dir }, { now: () => FIXED_DATE });
    expect(list.ok, JSON.stringify(list)).toBe(true);
    if (!list.ok) return;
    expect(list.entries).toHaveLength(2);

    const byId = new Map(list.entries.map((e) => [e.id, e]));
    const active = byId.get(generateEntryId("src/legacy/**", null));
    const expired = byId.get(generateEntryId("src/old/**", null));
    expect(active?.status).toBe("active");
    expect(active?.days_overdue).toBeUndefined();
    expect(expired?.status).toBe("expired");
    expect(expired?.days_overdue).toBeGreaterThan(0);
    // FIXED_DATE = 2026-05-05; expires 2026-04-01 → 34 days overdue.
    expect(expired?.days_overdue).toBe(34);
  });

  // -------------------------------------------------------------------------
  // #4 — --expired exits 1 when present, 0 when none.
  // -------------------------------------------------------------------------
  it("#4 ignore-list --expired exits 1 when expired entries exist and 0 when they don't", () => {
    const fx = materializeFixture("ignore-expired");
    cleanups.push(fx.cleanup);

    const expired = ignoreList(
      { cwd: fx.dir, expired: true },
      { now: () => FIXED_DATE },
    );
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    expect(expired.expired_count).toBeGreaterThan(0);
    expect(expired.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);

    // Same fixture, but query with `now` BEFORE the fixture's expires
    // (2025-06-01) → entry shows as still active → exit 0.
    const before = ignoreList(
      { cwd: fx.dir, expired: true },
      { now: () => new Date("2025-01-01T00:00:00.000Z") },
    );
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.expired_count).toBe(0);
    expect(before.exitCode).toBe(EXIT_CODES.OK);
  });

  // -------------------------------------------------------------------------
  // #5 — audit emits an `ignore_expired` warning and ignore_warnings[] but
  //      never blocks (result.ok stays true).
  // -------------------------------------------------------------------------
  it("#5 audit surfaces ignore_warnings for expired entries without flipping result.ok", () => {
    const fx = materializeFixture("ignore-expired");
    cleanups.push(fx.cleanup);

    const result = audit(
      { cwd: fx.dir },
      {
        now: () => FIXED_DATE,
        runFn: () => ({ ok: true, stdout: "[]", stderr: "", exitCode: 0 }),
        // Use the absent dirty check (audit only consults it under --strict).
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.ignore_warnings.length).toBeGreaterThanOrEqual(1);
    const warn = result.ignore_warnings[0];
    expect(warn.id).toBe("ign-19160e");
    expect(warn.glob).toBe("src/legacy/**");
    expect(warn.expires).toBe("2025-06-01");
    expect(warn.days_overdue).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // #6 — Brownfield import: first mutation pulls user-authored ignorePatterns
  //      into the manifest with createdBy: "imported".
  // -------------------------------------------------------------------------
  it("#6 first ignore-add on a brownfield project imports legacy ignorePatterns with createdBy=imported", () => {
    const fx = materializeFixture("ignore-brownfield");
    cleanups.push(fx.cleanup);

    const result = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "first qualy mutation on a brownfield project",
      },
      { now: () => FIXED_DATE },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // Brownfield fixture had `src/old/**` outside markers in both presets.
    // The dedup is fast-first / then-deep, so the import surfaces it once.
    expect(result.imported.map((p) => p.glob)).toEqual(["src/old/**"]);

    const manifest = readManifest(fx.dir);
    const byCreator = new Map<string, string[]>();
    for (const e of manifest.entries) {
      const arr = byCreator.get(e.createdBy) ?? [];
      arr.push(e.glob);
      byCreator.set(e.createdBy, arr);
    }
    expect(byCreator.get("imported")).toEqual(["src/old/**"]);
    expect(byCreator.get("user")).toEqual(["src/legacy/**"]);

    // After the import + compile, both patterns sit INSIDE the marker block;
    // nothing remains outside (the original `src/old/**` was stripped before
    // recompile re-emitted it inside the managed slice).
    const fast = readPreset(fx.dir, PRESET_PATHS.fast);
    const ip = fast.ignorePatterns ?? [];
    expect(ip[0]).toBe(IGNORE_MARKER_START);
    expect(ip[ip.length - 1]).toBe(IGNORE_MARKER_END);
    expect(new Set(ip.slice(1, -1))).toEqual(
      new Set(["src/legacy/**", "src/old/**"]),
    );

    // Decision log records the import BEFORE the user's add.
    const log = readFileSync(join(fx.dir, DECISION_LOG_PATH), "utf8");
    expect(log).toMatch(/kind\*\*: ignore-import/);
    expect(log).toMatch(/kind\*\*: ignore-add/);
    expect(log.indexOf("ignore-import")).toBeLessThan(
      log.indexOf("ignore-add:"),
    );
  });

  // -------------------------------------------------------------------------
  // #7 — Slash command surfaces exist for the four ignore verbs and reference
  //      the qualy CLI subcommands they wrap. End-to-end harness invocation
  //      is out of vitest's reach; this is the structural surrogate.
  // -------------------------------------------------------------------------
  it("#7 slash commands /lint:ignore:{add,list,remove,explain} exist with frontmatter and CLI references", () => {
    // Slash commands invoke the CLI through `$QUALY_CLI ignore-<verb>`, so
    // assert on the bare subcommand name — that's the contract surface.
    const fixtures: Array<{
      name: string;
      mustReference: readonly string[];
    }> = [
      { name: "add", mustReference: ["ignore-add"] },
      { name: "list", mustReference: ["ignore-list"] },
      { name: "remove", mustReference: ["ignore-remove"] },
      { name: "explain", mustReference: ["ignore-explain"] },
    ];

    for (const { name, mustReference } of fixtures) {
      const path = join(SLASH_COMMANDS_DIR, `${name}.md`);
      expect(existsSync(path), `missing slash command: ${path}`).toBe(true);
      const content = readFileSync(path, "utf8");
      // Frontmatter delimiters present + parses out an `allowed-tools` line so
      // the harness has a guarded execution surface.
      expect(content.startsWith("---\n")).toBe(true);
      const fmEnd = content.indexOf("\n---\n", 4);
      expect(fmEnd, `frontmatter not closed in ${name}.md`).toBeGreaterThan(0);
      const fm = content.slice(4, fmEnd);
      expect(fm).toMatch(/^allowed-tools:/m);
      expect(fm).toMatch(/^description:/m);
      for (const ref of mustReference) {
        expect(content, `${name}.md missing ${ref}`).toContain(ref);
      }
    }
  });

  // -------------------------------------------------------------------------
  // #8 — --strict + dirty working tree → exit 3 (DIRTY_TREE) with a `git
  //      stash` cure in the reason. Canonical to qualy's exit-codes.ts (SPEC
  //      §3.1 lists "2"; project canonical is 3, mirrors rules-add/-remove).
  // -------------------------------------------------------------------------
  it("#8 ignore-add --strict on a dirty tree refuses with DIRTY_TREE and surfaces a git-stash cure", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    // Dirty the working tree by editing a tracked file post-commit.
    writeFileSync(join(fx.dir, "src/index.ts"), "export const x = 2;\n");

    const result = ignoreAdd({
      cwd: fx.dir,
      glob: "src/legacy/**",
      reason: "test",
      strict: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("dirty_tree");
    expect(result.exitCode).toBe(EXIT_CODES.DIRTY_TREE);
    expect(result.exitCode).not.toBe(EXIT_CODES.OK);
    expect(result.reason).toMatch(/git stash/);

    // The refusal must not have written the manifest.
    expect(existsSync(join(fx.dir, IGNORE_MANIFEST_PATH))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // #9 — Re-add of the same (glob, rule) updates in place; manifest stays at
  //      one entry, decision log accumulates ignore-add then ignore-update.
  // -------------------------------------------------------------------------
  it("#9 re-adding the same (glob, rule) yields action=updated and the manifest stays at one entry", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const first = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "first reason",
        expires: null,
      },
      { now: () => FIXED_DATE },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toBe("added");

    const second = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "second reason — sharper",
        expires: "2099-12-31",
      },
      { now: () => FIXED_DATE },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe("updated");
    expect(second.id).toBe(first.id);

    const manifest = readManifest(fx.dir);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].reason).toBe("second reason — sharper");
    expect(manifest.entries[0].expires).toBe("2099-12-31");

    const log = readFileSync(join(fx.dir, DECISION_LOG_PATH), "utf8");
    expect((log.match(/kind\*\*: ignore-add\b/g) ?? []).length).toBe(1);
    expect((log.match(/kind\*\*: ignore-update\b/g) ?? []).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // #10 — `category:*` without `--i-know-this-disables-many` exits 1 and
  //       surfaces the category size in the reason (SPEC §3.1.1).
  // -------------------------------------------------------------------------
  it("#10 ignore-add --rule category:* without acknowledgement exits 1 and includes the category size", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const result = ignoreAdd({
      cwd: fx.dir,
      glob: "src/y/**",
      rule: "category:correctness",
      reason: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("category_requires_ack");
    expect(result.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    // Reason cites both the count of rules silenced and the cure flag.
    expect(result.reason).toMatch(/silences \d+ rules/);
    expect(result.reason).toContain("--i-know-this-disables-many");

    // No manifest, no preset rewrite, no decision log.
    expect(existsSync(join(fx.dir, IGNORE_MANIFEST_PATH))).toBe(false);
    expect(existsSync(join(fx.dir, DECISION_LOG_PATH))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // #11 — Slash command `/lint:ignore:add` documents the category gate flow
  //       (lists N rules, surfaces AskUserQuestion, injects the ack flag).
  // -------------------------------------------------------------------------
  it("#11 commands/lint/ignore/add.md documents the category:* AskUserQuestion + --i-know-this-disables-many flow", () => {
    const md = readFileSync(join(SLASH_COMMANDS_DIR, "add.md"), "utf8");
    // Driver invokes `qualy category-info` to enumerate the rules in the
    // category before asking the user for confirmation.
    expect(md).toContain("category-info");
    expect(md).toContain("AskUserQuestion");
    // Acknowledgement flag is the contract surface the CLI requires.
    expect(md).toContain("--i-know-this-disables-many");
    // Category prefix coverage so the driver knows when to enter the flow.
    expect(md).toMatch(/category:/);
  });

  // -------------------------------------------------------------------------
  // #12 — Drift detection: hand-editing the manifest forces a recompile on
  //       the next audit; running audit again with no edits skips the
  //       recompile (cheap path).
  // -------------------------------------------------------------------------
  it("#12 audit recompiles after a manual ignore.json edit and skips when presets are already in sync", () => {
    const fx = materializeFixture("ignore-expired");
    cleanups.push(fx.cleanup);

    // Hand-edit the manifest to add a NEW entry that the preset doesn't have.
    // This guarantees the first compile actually writes the preset (instead
    // of being a no-op when content already matches); the write bumps preset
    // mtime and lets the second drift check report `presets_fresh`.
    const manifestPath = join(fx.dir, IGNORE_MANIFEST_PATH);
    const seeded = readManifest(fx.dir);
    const newEntry = {
      id: generateEntryId("src/added/**", null),
      glob: "src/added/**",
      rule: null,
      reason: "added by hand-edit to simulate drift",
      expires: null,
      createdAt: "2026-05-05T12:00:00.000Z",
      createdBy: "user" as const,
    };
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { version: 1, entries: [...seeded.entries, newEntry] },
        null,
        2,
      ) + "\n",
    );

    // Force the manifest to be NEWER than both presets so the drift check
    // recompiles on the next audit. cp/git materialization doesn't guarantee
    // a specific mtime order — we tweak mtimes explicitly.
    const past = new Date("2025-01-01T00:00:00.000Z");
    const future = new Date("2026-05-05T12:00:00.000Z");
    utimesSync(join(fx.dir, PRESET_PATHS.fast), past, past);
    utimesSync(join(fx.dir, PRESET_PATHS.deep), past, past);
    utimesSync(manifestPath, future, future);

    const events: Array<{ event: string; payload: unknown }> = [];
    const r1 = audit(
      { cwd: fx.dir },
      {
        now: () => FIXED_DATE,
        runFn: () => ({ ok: true, stdout: "[]", stderr: "", exitCode: 0 }),
        checkDriftFn: (cwd, deps) => {
          const r = checkDriftAndRecompile(cwd, deps);
          events.push({ event: "drift", payload: r });
          return r;
        },
      },
    );
    expect(r1.ok, JSON.stringify(r1)).toBe(true);

    const drift1 = events[0].payload as { ok: boolean; recompiled?: boolean };
    expect(drift1.ok).toBe(true);
    expect(drift1.recompiled).toBe(true);

    // After the recompile, presets are touched and become as fresh as the
    // manifest. A second audit with no further edits hits the cheap path.
    const r2 = audit(
      { cwd: fx.dir },
      {
        now: () => FIXED_DATE,
        runFn: () => ({ ok: true, stdout: "[]", stderr: "", exitCode: 0 }),
        checkDriftFn: (cwd, deps) => {
          const r = checkDriftAndRecompile(cwd, deps);
          events.push({ event: "drift2", payload: r });
          return r;
        },
      },
    );
    expect(r2.ok).toBe(true);

    const drift2 = events[1].payload as {
      ok: boolean;
      recompiled?: boolean;
      reason?: string;
    };
    expect(drift2.ok).toBe(true);
    expect(drift2.recompiled).toBe(false);
    expect(drift2.reason).toBe("presets_fresh");
  });

  // -------------------------------------------------------------------------
  // Integrated remove + explain smoke (closes the four-verb loop the slash
  // commands wrap; complements #7's structural check with handler exercise).
  // -------------------------------------------------------------------------
  it("ignore-remove + ignore-explain round-trip on a manifest authored via ignore-add", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const added = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "scaffolding",
      },
      { now: () => FIXED_DATE },
    );
    expect(added.ok).toBe(true);

    const explained = ignoreExplain(
      { cwd: fx.dir, glob: "src/legacy/**", rule: null },
      { now: () => FIXED_DATE },
    );
    expect(explained.ok, JSON.stringify(explained)).toBe(true);
    if (!explained.ok) return;
    expect(explained.entry.id).toBe("ign-19160e");
    // history must include the just-recorded ignore-add block.
    expect(explained.history.length).toBeGreaterThanOrEqual(1);
    expect(explained.history[0].kind).toBe("ignore-add");

    const removed = ignoreRemove(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        rule: null,
        reason: "no longer legacy",
      },
      { now: () => FIXED_DATE },
    );
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    if (!removed.ok) return;
    expect(removed.id).toBe("ign-19160e");

    const manifestAfter = readManifest(fx.dir);
    expect(manifestAfter.entries).toHaveLength(0);

    // After removal the marker block is preserved (with no entries) — never
    // delete `ignore.json` automatically (SPEC §6 Never).
    expect(existsSync(join(fx.dir, IGNORE_MANIFEST_PATH))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Extra — one-time migration of `docs/lint-decisions.md` into the qualy
  // namespace on the first mutation post-upgrade. Conflict (both files exist)
  // surfaces decision_log_conflict and refuses.
  // -------------------------------------------------------------------------
  it("migrates legacy docs/lint-decisions.md into .harn/qualy/docs/ on first mutation; conflict refuses", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    // Seed a legacy decision log at the pre-namespace path, simulating an
    // upgrade from a project that already used /lint:rules:* before this SPEC.
    const legacy = join(fx.dir, LEGACY_DECISION_LOG_PATH);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      "# Lint decisions\n\n## Entries\n\n<!-- qualy:entries-start -->\n<!-- qualy:entries-end -->\n",
    );
    expect(existsSync(legacy)).toBe(true);

    const result = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "first post-upgrade mutation",
      },
      { now: () => FIXED_DATE },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Legacy gone, new path populated, meta entry recorded.
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(fx.dir, DECISION_LOG_PATH))).toBe(true);
    const log = readFileSync(join(fx.dir, DECISION_LOG_PATH), "utf8");
    expect(log).toContain("meta:migrate-decision-log");

    // Now simulate the conflict state: a second project where BOTH files
    // exist. Migration must refuse with decision_log_conflict.
    const fx2 = materializeFixture("ignore-greenfield");
    cleanups.push(fx2.cleanup);
    mkdirSync(dirname(join(fx2.dir, LEGACY_DECISION_LOG_PATH)), {
      recursive: true,
    });
    writeFileSync(
      join(fx2.dir, LEGACY_DECISION_LOG_PATH),
      "legacy content\n",
    );
    // Pre-create the new path so the migration helper sees both.
    mkdirSync(join(fx2.dir, ".harn", "qualy", "docs"), {
      recursive: true,
    });
    writeFileSync(
      join(fx2.dir, DECISION_LOG_PATH),
      "new content\n",
    );

    const conflicted = ignoreAdd(
      { cwd: fx2.dir, glob: "src/legacy/**", reason: "conflict run" },
      { now: () => FIXED_DATE },
    );
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) return;
    expect(conflicted.error).toBe("decision_log_conflict");
    expect(conflicted.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  // -------------------------------------------------------------------------
  // Extra — corrupt manifest → exit 70 INTERNAL_ERROR, mirroring SPEC §3.1
  // fatal-state path. Project canonical is INTERNAL_ERROR=70 since
  // MISSING_DEPENDENCY=5 is not the right semantic match.
  // -------------------------------------------------------------------------
  it("corrupt ignore.json surfaces manifest_corrupt with INTERNAL_ERROR and never writes anything", () => {
    const fx = materializeFixture("ignore-greenfield");
    cleanups.push(fx.cleanup);

    const manifestPath = join(fx.dir, IGNORE_MANIFEST_PATH);
    // mkdir + write a non-JSON blob.
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{not valid json — corrupted by hand]\n");

    const result = ignoreAdd(
      {
        cwd: fx.dir,
        glob: "src/legacy/**",
        reason: "won't get this far",
      },
      { now: () => FIXED_DATE },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("manifest_corrupt");
    expect(result.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);

    // The corrupt manifest must remain untouched on refusal — the user has to
    // fix it by hand. No half-written compiled preset either.
    expect(readFileSync(manifestPath, "utf8")).toBe(
      "{not valid json — corrupted by hand]\n",
    );
  });
});
