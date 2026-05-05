/**
 * E2E test for `/lint:setup` against `cli/tests/fixtures/greenfield-ts/`
 * (IMPLEMENTATION_PLAN.md Priority 3 / Phase 2 verification).
 *
 * Mirrors the harness orchestration documented in `commands/lint/setup.md` by
 * calling each `install-*` library function in the same canonical order
 * (deps → oxlint → hook → husky → coverage → scripts) against a real on-disk
 * materialization of the fixture (cp + `git init` + commit).
 *
 * SPEC §7.1 acceptance items validated here:
 *   - oxlint.fast.json + oxlint.deep.json written from the greenfield preset.
 *   - .claude/hooks/post-edit.sh exists and is executable; .claude/settings.json
 *     carries a PostToolUse hook entry that references it.
 *   - .husky/pre-commit + .lintstagedrc.js (greenfield-ts has type=module).
 *   - vitest.config.ts populated with greenfield coverage thresholds.
 *   - package.json#scripts contains `lint`, `lint:deep`, `format`, `coverage`.
 *   - .lint-manifest.json indexes every artifact with the right `kind`.
 *
 * Why we stub `install-deps` rather than letting it run a real package
 * manager: the SPEC §7.1 artifact list is about FILES, and a real
 * `npm install` requires network and deterministic registry access we can't
 * guarantee in CI. The stubbed `runFn` is a faithful no-side-effect proxy: it
 * returns success without spawning a subprocess, and the test still validates
 * that the manifest records one `kind:"dep"` entry per default package.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
const TEMPLATE_LINTSTAGED = join(HERE, "..", "..", "src", "templates", "lintstagedrc.example.js");

// Fixture is a fresh tmp dir without `node_modules/`, so `installDeps` is
// stubbed and the bare-specifier resolution that `installOxlint` performs to
// patch `jsPlugins[]` (ADR 0012) cannot reach a real `quality-metrics`. Inject
// a deterministic absolute path that mirrors what an actual install would
// expose — same shape as the unit-test stub in `install-oxlint.test.ts`.
const resolveModuleStub = (id: string, paths: readonly string[]): string =>
  join(paths[0]!, "node_modules", id, "dist", "index.js");

interface SettingsHookEntry {
  readonly matcher?: string;
  readonly hooks?: readonly { readonly type?: string; readonly command?: string }[];
}

interface SettingsRoot {
  readonly hooks?: { readonly PostToolUse?: readonly SettingsHookEntry[] };
}

interface PackageJsonRoot {
  readonly scripts?: Record<string, string>;
  readonly type?: string;
}

describe("e2e: /lint:setup on fixtures/greenfield-ts/", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("installs the full greenfield stack and records every artifact in the manifest", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    // ── Layer 1: install-deps (stubbed runFn — no real subprocess) ────────
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
    expect(depsRes.skipped).toEqual([]);
    expect(depsRes.recorded).toBe(DEFAULT_DEPS.length);

    // ── Layer 2: install-oxlint --stage greenfield ────────────────────────
    const oxlintRes = installOxlint(
      { cwd: fx.dir, stage: "greenfield" },
      { resolveModule: resolveModuleStub },
    );
    expect(oxlintRes.ok, JSON.stringify(oxlintRes)).toBe(true);
    if (!oxlintRes.ok) return;
    expect(oxlintRes.stage).toBe("greenfield");
    expect(oxlintRes.stageSource).toBe("explicit");
    expect(oxlintRes.written).toHaveLength(2);

    // Fast preset has no `jsPlugins` → bytes are byte-for-byte from the bundle.
    const fastWritten = readFileSync(join(fx.dir, "oxlint.fast.json"), "utf8");
    const fastSource = readFileSync(join(PRESETS_OXLINT_DIR, "greenfield.fast.json"), "utf8");
    expect(fastWritten).toBe(fastSource);

    // Deep preset is patched at write-time (ADR 0012): `jsPlugins[0]` becomes
    // the absolute resolved path. Compare the rest of the structure against
    // the bundled source, then assert the patched path explicitly.
    const deepWritten = readFileSync(join(fx.dir, "oxlint.deep.json"), "utf8");
    const deepSource = readFileSync(join(PRESETS_OXLINT_DIR, "greenfield.deep.json"), "utf8");
    const deepWrittenParsed = JSON.parse(deepWritten) as { jsPlugins?: unknown };
    const deepSourceParsed = JSON.parse(deepSource) as { jsPlugins?: unknown };
    expect(deepWrittenParsed.jsPlugins).toEqual([
      resolveModuleStub("quality-metrics", [fx.dir]),
    ]);
    delete deepWrittenParsed.jsPlugins;
    delete deepSourceParsed.jsPlugins;
    expect(deepWrittenParsed).toEqual(deepSourceParsed);

    // ── Layer 3: install-hook ─────────────────────────────────────────────
    const hookRes = installHook({ cwd: fx.dir });
    expect(hookRes.ok, JSON.stringify(hookRes)).toBe(true);
    if (!hookRes.ok) return;
    expect(hookRes.script.path).toBe(".claude/hooks/post-edit.sh");
    expect(hookRes.settings.action).toBe("created");

    const hookScriptAbs = join(fx.dir, ".claude/hooks/post-edit.sh");
    const hookScript = readFileSync(hookScriptAbs, "utf8");
    expect(hookScript).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(hookScript).toContain("oxlint.fast.json");
    expect(hookScript).toContain("set -euo pipefail");
    // mode 0o755 — owner exec bit must be set; we check the exec triplet.
    const scriptStat = statSync(hookScriptAbs);
    expect((scriptStat.mode & 0o100) !== 0).toBe(true);

    const settingsRaw = readFileSync(join(fx.dir, ".claude/settings.json"), "utf8");
    const settings = parseDefensive<SettingsRoot>(settingsRaw);
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    const postEntries = settings.value.hooks?.PostToolUse ?? [];
    expect(postEntries.length).toBeGreaterThanOrEqual(1);
    const ourEntry = postEntries.find((e) => e.matcher === "Write|Edit|MultiEdit");
    expect(ourEntry, "PostToolUse must contain an entry matching Write|Edit|MultiEdit").toBeDefined();
    expect(ourEntry?.hooks?.[0]?.command).toContain(".claude/hooks/post-edit.sh");

    // ── Layer 4: install-husky ────────────────────────────────────────────
    const huskyRes = installHusky({ cwd: fx.dir });
    expect(huskyRes.ok, JSON.stringify(huskyRes)).toBe(true);
    if (!huskyRes.ok) return;
    expect(huskyRes.husky.action).toBe("created");
    expect(huskyRes.husky.path).toBe(".husky/pre-commit");
    // greenfield-ts/package.json declares "type": "module" → .lintstagedrc.js
    expect(huskyRes.lintstaged.action).toBe("created");
    expect(huskyRes.lintstaged.path).toBe(".lintstagedrc.js");

    const preCommit = readFileSync(join(fx.dir, ".husky/pre-commit"), "utf8");
    expect(preCommit).toContain("lint-staged");

    const lintstagedWritten = readFileSync(join(fx.dir, ".lintstagedrc.js"), "utf8");
    const lintstagedSource = readFileSync(TEMPLATE_LINTSTAGED, "utf8");
    expect(lintstagedWritten).toBe(lintstagedSource);

    // ── Layer 5: install-coverage --runner vitest --stage greenfield ─────
    const covRes = installCoverage({
      cwd: fx.dir,
      runner: "vitest",
      stage: "greenfield",
    });
    expect(covRes.ok, JSON.stringify(covRes)).toBe(true);
    if (!covRes.ok) return;
    expect(covRes.runner).toBe("vitest");
    expect(covRes.stage).toBe("greenfield");
    expect(covRes.action).toBe("created");
    expect(covRes.thresholds).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });
    expect(covRes.warnOnly).toBe(false);

    const vitestConfig = readFileSync(join(fx.dir, "vitest.config.ts"), "utf8");
    // greenfield thresholds appear inline; ts-morph keeps the literal numbers.
    expect(vitestConfig).toMatch(/lines:\s*90/);
    expect(vitestConfig).toMatch(/functions:\s*90/);
    expect(vitestConfig).toMatch(/branches:\s*80/);
    expect(vitestConfig).toMatch(/statements:\s*90/);
    expect(vitestConfig).toContain('provider: "v8"');

    // ── Layer 6: install-scripts --runner vitest ──────────────────────────
    const scriptsRes = installScripts({ cwd: fx.dir, runner: "vitest" });
    expect(scriptsRes.ok, JSON.stringify(scriptsRes)).toBe(true);
    if (!scriptsRes.ok) return;
    expect(scriptsRes.action).toBe("updated");
    expect([...scriptsRes.added].sort()).toEqual(
      ["coverage", "format", "lint", "lint:deep"].sort(),
    );
    expect(scriptsRes.conflicts).toEqual([]);

    const pkgRaw = readFileSync(join(fx.dir, "package.json"), "utf8");
    const pkg = parseDefensive<PackageJsonRoot>(pkgRaw);
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const scripts = pkg.value.scripts ?? {};
    expect(scripts["lint"]).toBe("oxlint --config oxlint.fast.json .");
    expect(scripts["lint:deep"]).toBe("oxlint --config oxlint.deep.json .");
    expect(scripts["format"]).toBe("oxfmt --write .");
    expect(scripts["coverage"]).toBe("vitest run --coverage");
    // Pre-existing scripts must survive the merge.
    expect(scripts["start"]).toBe("node --experimental-strip-types src/index.ts");
    // Top-level type field unchanged (sanity-check that the merge does not
    // clobber unrelated keys).
    expect(pkg.value.type).toBe("module");

    // ── Manifest sanity: every artifact qualy authored is indexed ─────────
    const manifest = loadManifest(fx.dir);
    expect(manifest, "manifest must exist after setup").not.toBeNull();
    const m = manifest as Manifest;
    expect(m.version).toBe("1");

    const byPath = new Map(m.entries.map((e) => [e.path, e]));

    // owned-by-qualy artifacts (kind=preset/hook/husky/lintstaged/coverage)
    expect(byPath.get("oxlint.fast.json")?.kind).toBe("preset");
    expect(byPath.get("oxlint.fast.json")?.merged ?? false).toBe(false);
    expect(byPath.get("oxlint.deep.json")?.kind).toBe("preset");
    expect(byPath.get(".claude/hooks/post-edit.sh")?.kind).toBe("hook");
    expect(byPath.get(".husky/pre-commit")?.kind).toBe("husky");
    expect(byPath.get(".lintstagedrc.js")?.kind).toBe("lintstaged");
    // install-coverage authored vitest.config.ts from a skeleton (no
    // pre-existing config), so the entry is owned-by-qualy: kind="coverage"
    // with `merged` absent (loadManifest only sets the field when true).
    expect(byPath.get("vitest.config.ts")?.kind).toBe("coverage");
    expect(byPath.get("vitest.config.ts")?.merged ?? false).toBe(false);

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

    // ── Idempotency: re-running every layer is a no-op ────────────────────
    const oxlintAgain = installOxlint(
      { cwd: fx.dir, stage: "greenfield" },
      { resolveModule: resolveModuleStub },
    );
    expect(oxlintAgain.ok).toBe(true);
    if (oxlintAgain.ok) {
      // bytes are unchanged; the writer still records, but the file content
      // is byte-identical to the first pass.
      expect(readFileSync(join(fx.dir, "oxlint.fast.json"), "utf8")).toBe(fastSource);
    }

    const hookAgain = installHook({ cwd: fx.dir });
    expect(hookAgain.ok).toBe(true);
    if (hookAgain.ok) {
      expect(hookAgain.settings.action).toBe("unchanged");
    }

    const huskyAgain = installHusky({ cwd: fx.dir });
    expect(huskyAgain.ok).toBe(true);
    if (huskyAgain.ok) {
      expect(huskyAgain.husky.action).toBe("unchanged");
      expect(huskyAgain.lintstaged.action).toBe("kept");
    }

    const scriptsAgain = installScripts({ cwd: fx.dir, runner: "vitest" });
    expect(scriptsAgain.ok).toBe(true);
    if (scriptsAgain.ok) {
      expect(scriptsAgain.action).toBe("noop");
      expect(scriptsAgain.added).toEqual([]);
    }
  });

  it("refuses to overwrite oxlint.fast.json under --strict on a dirty tree", () => {
    const fx = materializeFixture("greenfield-ts");
    cleanups.push(fx.cleanup);

    // Dirty the working tree so --strict triggers DIRTY_TREE on the very first
    // write. The file we create is unrelated to qualy's targets — its sole job
    // is to make `git status` non-empty.
    writeFileSync(join(fx.dir, "untracked-file.txt"), "scratch\n");

    const r = installOxlint({ cwd: fx.dir, stage: "greenfield", strict: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");

    // No artifact made it to disk.
    expect(existsSync(join(fx.dir, "oxlint.fast.json"))).toBe(false);
    expect(existsSync(join(fx.dir, "oxlint.deep.json"))).toBe(false);
    // Manifest still untouched.
    expect(existsSync(join(fx.dir, MANIFEST_FILENAME))).toBe(false);
  });
});
