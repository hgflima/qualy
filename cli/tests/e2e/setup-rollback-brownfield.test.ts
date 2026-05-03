/**
 * E2E test for `/lint:setup` + `/lint:rollback` against
 * `cli/tests/fixtures/brownfield-eslint-prettier/`
 * (IMPLEMENTATION_PLAN.md Priority 4 / Phase 3 verification).
 *
 * SPEC §7.2 acceptance:
 *   - `/lint:setup` em brownfield-eslint-prettier:
 *     - Cria `.lint-backup/<timestamp>/` com `.eslintrc*`, `.prettierrc*`, e o
 *       `package.json` original.
 *     - Após confirmação, instala oxc + presets de brownfield moderado.
 *     - `/lint:rollback` em seguida restaura tudo idêntico ao estado pré-setup.
 *
 * What this exercises end-to-end:
 *   1. Capture pre-state byte hashes for `.eslintrc.json`, `.prettierrc.json`,
 *      and `package.json` immediately after fixture materialization.
 *   2. Drive the brownfield migration flow in the same canonical order the
 *      harness in `commands/lint/setup.md` documents:
 *        - `backup-create --files <eslint+prettier+package.json>` first (SPEC
 *          §6 Always — backup before any destructive change).
 *        - `install-deps` (stubbed runFn, no real subprocess).
 *        - `install-oxlint --stage brownfield-moderate` writes the brownfield
 *          presets byte-for-byte (NOT the greenfield ones).
 *        - `install-hook` + `install-husky`.
 *        - `install-coverage --runner none` (fixture has no test runner) is a
 *          noop.
 *        - `install-scripts --runner none` merges lint/lint:deep/format
 *          (no `coverage` script — runner=none).
 *   3. Validate manifest tracks every artifact with the correct `kind`,
 *      including `kind: "backup"` entries pointing at `.lint-backup/<ts>/...`.
 *   4. Run `backup-restore --ts <ts>` and assert the three originally backed-up
 *      files are byte-identical to the captured pre-state.
 *
 * The deterministic timestamp passed to `backup-create --ts` lets us reason
 * about manifest paths without coupling the test to clock state.
 *
 * Why we stub `install-deps`: a real `npm install` requires a network and a
 * deterministic registry; SPEC §7.2 is about FILES, not real installs. The
 * stubbed `runFn` returns success without spawning a subprocess, and the test
 * still validates that the manifest records one `kind:"dep"` entry per default
 * package.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { backupCreate } from "../../src/commands/backup/create.ts";
import { backupRestore } from "../../src/commands/backup/restore.ts";
import { installCoverage } from "../../src/commands/install/coverage.ts";
import { DEFAULT_DEPS, installDeps } from "../../src/commands/install/deps.ts";
import { installHook } from "../../src/commands/install/hook.ts";
import { installHusky } from "../../src/commands/install/husky.ts";
import { installOxlint } from "../../src/commands/install/oxlint.ts";
import { installScripts } from "../../src/commands/install/scripts.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  loadManifest,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";
import { materializeFixture } from "../fixtures/_materialize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESETS_OXLINT_DIR = join(HERE, "..", "..", "src", "presets", "oxlint");

interface PackageJsonRoot {
  readonly scripts?: Record<string, string>;
  readonly type?: string;
  readonly name?: string;
}

const FIXED_TS = "2026-05-03T12-00-00-000Z";
const BACKED_UP_FILES = [".eslintrc.json", ".prettierrc.json", "package.json"] as const;

describe("e2e: /lint:setup + /lint:rollback on fixtures/brownfield-eslint-prettier/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("backs up legacy configs, installs brownfield-moderate presets, and rollback restores them byte-for-byte", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    // ── Pre-state snapshot ────────────────────────────────────────────────
    // Captured BEFORE any qualy write. After backup-restore at the end, every
    // entry in this map must compare byte-for-byte against the on-disk file.
    const preState = new Map<string, string>();
    for (const rel of BACKED_UP_FILES) {
      const abs = join(fx.dir, rel);
      expect(existsSync(abs), `pre-state: ${rel} must exist in materialized fixture`).toBe(true);
      preState.set(rel, readFileSync(abs, "utf8"));
    }
    // Sanity: the fixture really declares ESLint+Prettier in package.json.
    expect(preState.get("package.json")!).toContain('"eslint"');
    expect(preState.get("package.json")!).toContain('"prettier"');

    // ── Step 1: backup-create — SPEC §6 Always BEFORE any destructive write ─
    const backupRes = backupCreate({
      cwd: fx.dir,
      files: [...BACKED_UP_FILES],
      timestamp: FIXED_TS,
    });
    expect(backupRes.ok, JSON.stringify(backupRes)).toBe(true);
    if (!backupRes.ok) return;
    expect(backupRes.timestamp).toBe(FIXED_TS);
    expect(backupRes.dir).toBe(`.lint-backup/${FIXED_TS}`);
    expect(backupRes.backed_up).toHaveLength(BACKED_UP_FILES.length);

    // Backup directory now holds byte-for-byte copies, preserving the original
    // tree under `<src-rel>` so backup-restore can replay them in place.
    for (const rel of BACKED_UP_FILES) {
      const backupAbs = join(fx.dir, ".lint-backup", FIXED_TS, rel);
      expect(existsSync(backupAbs), `backup must contain ${rel}`).toBe(true);
      expect(readFileSync(backupAbs, "utf8")).toBe(preState.get(rel));
    }

    // The originals are NOT deleted by backup-create (the lint-installer does
    // that when it overwrites). For this fixture the only file install-* will
    // overwrite is `package.json` (scripts merge); the .eslintrc/.prettierrc
    // files remain untouched on disk through the install pass — only rollback
    // exercises a true byte-level restore for them.
    for (const rel of BACKED_UP_FILES) {
      expect(existsSync(join(fx.dir, rel))).toBe(true);
    }

    // ── Step 2: install-deps (stubbed runFn) ──────────────────────────────
    let runFnCalls = 0;
    const depsRes = installDeps(
      { cwd: fx.dir },
      {
        runFn: (_bin, _args, _cwd) => {
          runFnCalls += 1;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    expect(depsRes.ok, JSON.stringify(depsRes)).toBe(true);
    if (!depsRes.ok) return;
    expect(runFnCalls).toBe(1);
    expect(depsRes.action).toBe("installed");
    expect([...depsRes.installed].sort()).toEqual([...DEFAULT_DEPS].sort());

    // ── Step 3: install-oxlint --stage brownfield-moderate ────────────────
    const oxlintRes = installOxlint({ cwd: fx.dir, stage: "brownfield-moderate" });
    expect(oxlintRes.ok, JSON.stringify(oxlintRes)).toBe(true);
    if (!oxlintRes.ok) return;
    expect(oxlintRes.stage).toBe("brownfield-moderate");
    expect(oxlintRes.stageSource).toBe("explicit");
    expect(oxlintRes.written).toHaveLength(2);

    // Both presets land byte-for-byte from the BROWNFIELD source — drift here
    // (e.g. install-oxlint accidentally picking the greenfield preset) breaks
    // SPEC §7.2 acceptance.
    const fastWritten = readFileSync(join(fx.dir, "oxlint.fast.json"), "utf8");
    const fastSource = readFileSync(
      join(PRESETS_OXLINT_DIR, "brownfield-moderate.fast.json"),
      "utf8",
    );
    expect(fastWritten).toBe(fastSource);
    expect(fastWritten).toContain("stage=brownfield-moderate");
    // Sanity: we did NOT install the greenfield preset.
    const greenfieldFastSource = readFileSync(
      join(PRESETS_OXLINT_DIR, "greenfield.fast.json"),
      "utf8",
    );
    expect(fastWritten).not.toBe(greenfieldFastSource);

    const deepWritten = readFileSync(join(fx.dir, "oxlint.deep.json"), "utf8");
    const deepSource = readFileSync(
      join(PRESETS_OXLINT_DIR, "brownfield-moderate.deep.json"),
      "utf8",
    );
    expect(deepWritten).toBe(deepSource);
    expect(deepWritten).toContain("stage=brownfield-moderate");

    // ── Step 4: install-hook ──────────────────────────────────────────────
    const hookRes = installHook({ cwd: fx.dir });
    expect(hookRes.ok, JSON.stringify(hookRes)).toBe(true);
    if (!hookRes.ok) return;
    expect(hookRes.script.path).toBe(".claude/hooks/post-edit.sh");
    expect(hookRes.settings.action).toBe("created");

    // ── Step 5: install-husky ─────────────────────────────────────────────
    const huskyRes = installHusky({ cwd: fx.dir });
    expect(huskyRes.ok, JSON.stringify(huskyRes)).toBe(true);
    if (!huskyRes.ok) return;
    expect(huskyRes.husky.action).toBe("created");
    // brownfield-eslint-prettier/package.json declares "type": "module" → .lintstagedrc.js
    expect(huskyRes.lintstaged.action).toBe("created");
    expect(huskyRes.lintstaged.path).toBe(".lintstagedrc.js");

    // ── Step 6: install-coverage --runner none — noop on this fixture ─────
    const covRes = installCoverage({ cwd: fx.dir, runner: "none", stage: "brownfield-moderate" });
    expect(covRes.ok, JSON.stringify(covRes)).toBe(true);
    if (!covRes.ok) return;
    expect(covRes.runner).toBe("none");
    expect(covRes.action).toBe("noop");
    expect(covRes.written).toBeNull();

    // ── Step 7: install-scripts --runner none ─────────────────────────────
    // runner=none → desired is the trio (lint, lint:deep, format); no
    // `coverage` key. The fixture pre-declares `lint` and `format` with
    // ESLint/Prettier values, so merging surfaces those as `conflicts`
    // (NEVER overwrites) and only `lint:deep` is added net-new.
    const scriptsRes = installScripts({ cwd: fx.dir, runner: "none" });
    expect(scriptsRes.ok, JSON.stringify(scriptsRes)).toBe(true);
    if (!scriptsRes.ok) return;
    expect(scriptsRes.action).toBe("updated");
    expect([...scriptsRes.added]).toEqual(["lint:deep"]);
    const conflictNames = scriptsRes.conflicts.map((c) => c.name).sort();
    expect(conflictNames).toEqual(["format", "lint"]);

    // ── Manifest sanity: every artifact qualy authored is indexed ─────────
    const manifest = loadManifest(fx.dir);
    expect(manifest, "manifest must exist after setup").not.toBeNull();
    const m = manifest as Manifest;
    expect(m.version).toBe("1");

    const byPath = new Map(m.entries.map((e) => [e.path, e]));

    // Backup snapshots — one entry per file, all kind:"backup" with a path
    // anchored under `.lint-backup/<ts>/`.
    for (const rel of BACKED_UP_FILES) {
      const backupKey = `.lint-backup/${FIXED_TS}/${rel}`;
      const entry = byPath.get(backupKey);
      expect(entry, `manifest must index backup entry ${backupKey}`).toBeDefined();
      expect(entry?.kind).toBe("backup");
      expect(entry?.merged ?? false).toBe(false);
    }

    // owned-by-qualy artifacts (kind=preset/hook/husky/lintstaged)
    expect(byPath.get("oxlint.fast.json")?.kind).toBe("preset");
    expect(byPath.get("oxlint.deep.json")?.kind).toBe("preset");
    expect(byPath.get(".claude/hooks/post-edit.sh")?.kind).toBe("hook");
    expect(byPath.get(".husky/pre-commit")?.kind).toBe("husky");
    expect(byPath.get(".lintstagedrc.js")?.kind).toBe("lintstaged");

    // merged-into-user-files (kind=settings/scripts)
    expect(byPath.get(".claude/settings.json")?.kind).toBe("settings");
    expect(byPath.get(".claude/settings.json")?.merged).toBe(true);
    expect(byPath.get("package.json")?.kind).toBe("scripts");
    expect(byPath.get("package.json")?.merged).toBe(true);

    // virtual deps recorded by install-deps (one per package).
    for (const dep of DEFAULT_DEPS) {
      const virtual = `package.json#devDependencies/${dep}`;
      const entry = byPath.get(virtual);
      expect(entry?.kind, `expected dep entry for ${dep}`).toBe("dep");
      expect(entry?.merged).toBe(true);
    }

    // The manifest itself is NOT indexed (would create a recursion loop).
    expect(byPath.has(MANIFEST_FILENAME)).toBe(false);

    // ── Sanity check: package.json was mutated by install-scripts ─────────
    // (The merge added `lint:deep` net-new and may have touched `coverage`
    // depending on conflict semantics; either way the bytes differ from
    // pre-state, which is exactly why we backed it up.)
    const pkgAfterInstall = readFileSync(join(fx.dir, "package.json"), "utf8");
    expect(pkgAfterInstall).not.toBe(preState.get("package.json"));
    const pkgAfter = parseDefensive<PackageJsonRoot>(pkgAfterInstall);
    expect(pkgAfter.ok).toBe(true);
    if (!pkgAfter.ok) return;
    const scriptsAfter = pkgAfter.value.scripts ?? {};
    expect(scriptsAfter["lint:deep"]).toBe("oxlint --config oxlint.deep.json .");
    // runner=none means no `coverage` script was added.
    expect(scriptsAfter["coverage"]).toBeUndefined();
    // Pre-existing `start`, `lint`, and `format` scripts MUST survive the
    // merge — install-scripts never overwrites; conflicts surface for the
    // harness to ask the user.
    expect(scriptsAfter["start"]).toBe("node --experimental-strip-types src/index.ts");
    expect(scriptsAfter["lint"]).toBe("eslint src/");
    expect(scriptsAfter["format"]).toBe("prettier --write src/");

    // ── Step 8: backup-restore — SPEC §7.2 byte-a-byte rollback ───────────
    const restoreRes = backupRestore({ cwd: fx.dir, timestamp: FIXED_TS });
    expect(restoreRes.ok, JSON.stringify(restoreRes)).toBe(true);
    if (!restoreRes.ok) return;
    expect(restoreRes.restored).toHaveLength(BACKED_UP_FILES.length);

    // Every backed-up file is byte-identical to the captured pre-state.
    // This is the SPEC §7.2 invariant: "/lint:rollback restaura tudo idêntico
    // ao estado pré-setup."
    for (const rel of BACKED_UP_FILES) {
      const restored = readFileSync(join(fx.dir, rel), "utf8");
      expect(restored, `${rel} must be byte-identical to pre-setup state`).toBe(
        preState.get(rel),
      );
    }

    // The manifest still indexes the backup entries (skipManifest:true on
    // restore — backup-restore does NOT claim ownership of user files), so
    // running `/lint:rollback` again is idempotent and `/lint:uninstall
    // --keep-backup` continues to work.
    const manifestAfterRestore = loadManifest(fx.dir) as Manifest;
    const backupCount = manifestAfterRestore.entries.filter(
      (e) => e.kind === "backup",
    ).length;
    expect(backupCount).toBe(BACKED_UP_FILES.length);

    // qualy artifacts authored during install are NOT removed by rollback —
    // /lint:rollback explicitly does not uninstall oxc (rollback.md trade-off).
    expect(existsSync(join(fx.dir, "oxlint.fast.json"))).toBe(true);
    expect(existsSync(join(fx.dir, "oxlint.deep.json"))).toBe(true);
    expect(existsSync(join(fx.dir, ".claude/hooks/post-edit.sh"))).toBe(true);
    expect(existsSync(join(fx.dir, ".husky/pre-commit"))).toBe(true);
    expect(existsSync(join(fx.dir, ".lintstagedrc.js"))).toBe(true);
  });

  it("backup-restore is idempotent: a second call against the same timestamp re-applies the same bytes", () => {
    const fx = materializeFixture("brownfield-eslint-prettier");
    cleanups.push(fx.cleanup);

    const eslintPre = readFileSync(join(fx.dir, ".eslintrc.json"), "utf8");

    const created = backupCreate({
      cwd: fx.dir,
      files: [".eslintrc.json"],
      timestamp: FIXED_TS,
    });
    expect(created.ok).toBe(true);

    // Mutate the file as if a setup pass overwrote it.
    writeFileSync(join(fx.dir, ".eslintrc.json"), "/* tampered */\n", "utf8");
    expect(readFileSync(join(fx.dir, ".eslintrc.json"), "utf8")).not.toBe(eslintPre);

    const r1 = backupRestore({ cwd: fx.dir, timestamp: FIXED_TS });
    expect(r1.ok).toBe(true);
    expect(readFileSync(join(fx.dir, ".eslintrc.json"), "utf8")).toBe(eslintPre);

    // Second call: same bytes, no manifest churn (backup entries preserved).
    const r2 = backupRestore({ cwd: fx.dir, timestamp: FIXED_TS });
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(fx.dir, ".eslintrc.json"), "utf8")).toBe(eslintPre);

    const manifest = loadManifest(fx.dir) as Manifest;
    const backupEntries = manifest.entries.filter((e) => e.kind === "backup");
    expect(backupEntries).toHaveLength(1);
    expect(backupEntries[0].path).toBe(`.lint-backup/${FIXED_TS}/.eslintrc.json`);
  });
});
