/**
 * Smoke test: full /lint:setup pipeline against a DYNAMICALLY synthesized
 * "real-like" TS repo (IMPLEMENTATION_PLAN.md Priority 8 / Phase 7 closing
 * item: "Validação final … contra repo TS real fora dos fixtures").
 *
 * What makes this different from `setup-greenfield.test.ts`:
 *   - The project tree is generated *in this file* (not copied from
 *     `cli/tests/fixtures/`). The CLI sees content it has never been
 *     exercised against by any other test.
 *   - The shape mimics a small real-world CLI tool: ~10 source files spread
 *     across `src/api/`, `src/lib/`, `src/types/`, plus a top-level entry
 *     and a tests/ directory — closer to what users actually run setup on.
 *   - Pre-existing `package.json#scripts` includes `dev`, `start`, `test`
 *     (typical for a hobby project), so the merge-vs-clobber behavior of
 *     install-scripts gets exercised on a non-fixture surface.
 *
 * The fully-manual checkpoint (`./install.sh` + Claude Code in a real repo
 * the maintainer picks) remains a release-checklist item documented in
 * CHANGELOG/README — that part needs a human in front of Claude Code and
 * cannot run in CI. This test is the closest automatable proxy: it proves
 * the deterministic CLI half of the system handles novel input cleanly.
 *
 * SPEC §7.1 artifacts validated end-to-end:
 *   - oxlint.fast.json + oxlint.deep.json (greenfield preset, byte-for-byte)
 *   - .claude/hooks/post-edit.sh (executable) + .claude/settings.json
 *     (PostToolUse merged, pre-existing keys preserved)
 *   - .husky/pre-commit + .lintstagedrc.js
 *   - vitest.config.ts authored from skeleton with greenfield thresholds
 *   - package.json#scripts gains lint/lint:deep/format/coverage; pre-existing
 *     dev/start/test survive
 *   - .lint-manifest.json indexes every artifact and dep
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { detectStack } from "../../src/commands/detect-stack.ts";
import { detectStage } from "../../src/commands/detect-stage.ts";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESETS_OXLINT_DIR = join(HERE, "..", "..", "src", "presets", "oxlint");
const TEMPLATE_LINTSTAGED = join(HERE, "..", "..", "src", "templates", "lintstagedrc.example.js");

const COMMIT_DATE = "2026-04-15T12:00:00Z";
const AUTHOR = "smoke";
const EMAIL = "smoke@qualy.local";

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
  readonly description?: string;
}

/**
 * Synthesize a small real-world-shaped TS CLI project under a fresh temp dir
 * and `git init` + commit it deterministically. Returns absolute path + a
 * tmp-prefix-guarded cleanup callback (same safety pattern as
 * `_materialize.ts`).
 */
function synthesizeRealLikeRepo(): { dir: string; cleanup: () => void } {
  const tmpRoot = tmpdir();
  const dir = mkdtempSync(join(tmpRoot, "qualy-smoke-real-"));

  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "linkly",
        version: "0.3.1",
        private: true,
        type: "module",
        description: "Tiny URL shortener CLI — synthesized repo for qualy smoke test.",
        engines: { node: ">=22.6.0" },
        bin: { linkly: "./src/index.ts" },
        scripts: {
          dev: "node --experimental-strip-types src/index.ts",
          start: "node --experimental-strip-types src/index.ts",
          test: "node --experimental-strip-types --test tests/**/*.test.ts",
        },
      },
      null,
      2,
    ) + "\n",

    "src/index.ts": [
      "import { parseArgs } from \"./lib/args.ts\";",
      "import { ShortenCommand } from \"./api/shorten.ts\";",
      "import { ResolveCommand } from \"./api/resolve.ts\";",
      "",
      "const cmd = parseArgs(process.argv.slice(2));",
      "if (cmd.name === \"shorten\") await new ShortenCommand().run(cmd.args);",
      "else if (cmd.name === \"resolve\") await new ResolveCommand().run(cmd.args);",
      "else { console.error(\"unknown command\"); process.exit(2); }",
      "",
    ].join("\n"),

    "src/api/shorten.ts": [
      "import type { Link } from \"../types/link.ts\";",
      "import { Store } from \"../lib/store.ts\";",
      "import { hash } from \"../lib/hash.ts\";",
      "",
      "export class ShortenCommand {",
      "  private readonly store = new Store();",
      "  async run(args: readonly string[]): Promise<void> {",
      "    const url = args[0];",
      "    if (!url) throw new Error(\"shorten: missing url\");",
      "    const slug = hash(url).slice(0, 7);",
      "    const link: Link = { slug, url, created_at: new Date().toISOString() };",
      "    await this.store.put(link);",
      "    console.log(slug);",
      "  }",
      "}",
      "",
    ].join("\n"),

    "src/api/resolve.ts": [
      "import { Store } from \"../lib/store.ts\";",
      "",
      "export class ResolveCommand {",
      "  private readonly store = new Store();",
      "  async run(args: readonly string[]): Promise<void> {",
      "    const slug = args[0];",
      "    if (!slug) throw new Error(\"resolve: missing slug\");",
      "    const link = await this.store.get(slug);",
      "    if (!link) { process.exit(1); }",
      "    console.log(link.url);",
      "  }",
      "}",
      "",
    ].join("\n"),

    "src/lib/args.ts": [
      "export interface ParsedCommand {",
      "  readonly name: string;",
      "  readonly args: readonly string[];",
      "}",
      "export function parseArgs(argv: readonly string[]): ParsedCommand {",
      "  const [name, ...rest] = argv;",
      "  return { name: name ?? \"\", args: rest };",
      "}",
      "",
    ].join("\n"),

    "src/lib/hash.ts": [
      "import { createHash } from \"node:crypto\";",
      "export function hash(input: string): string {",
      "  return createHash(\"sha256\").update(input).digest(\"hex\");",
      "}",
      "",
    ].join("\n"),

    "src/lib/store.ts": [
      "import { readFile, writeFile } from \"node:fs/promises\";",
      "import type { Link } from \"../types/link.ts\";",
      "",
      "export class Store {",
      "  private readonly path = \".linkly.json\";",
      "  async get(slug: string): Promise<Link | undefined> {",
      "    const all = await this.readAll();",
      "    return all.find((l) => l.slug === slug);",
      "  }",
      "  async put(link: Link): Promise<void> {",
      "    const all = await this.readAll();",
      "    all.push(link);",
      "    await writeFile(this.path, JSON.stringify(all, null, 2));",
      "  }",
      "  private async readAll(): Promise<Link[]> {",
      "    try { return JSON.parse(await readFile(this.path, \"utf8\")); }",
      "    catch { return []; }",
      "  }",
      "}",
      "",
    ].join("\n"),

    "src/types/link.ts": [
      "export interface Link {",
      "  readonly slug: string;",
      "  readonly url: string;",
      "  readonly created_at: string;",
      "}",
      "",
    ].join("\n"),

    "tests/args.test.ts": [
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "import { parseArgs } from \"../src/lib/args.ts\";",
      "",
      "test(\"parseArgs: empty argv yields empty name\", () => {",
      "  const r = parseArgs([]);",
      "  assert.equal(r.name, \"\");",
      "  assert.deepEqual(r.args, []);",
      "});",
      "",
      "test(\"parseArgs: first token is name, rest are args\", () => {",
      "  const r = parseArgs([\"shorten\", \"https://x.test\"]);",
      "  assert.equal(r.name, \"shorten\");",
      "  assert.deepEqual(r.args, [\"https://x.test\"]);",
      "});",
      "",
    ].join("\n"),

    "tests/hash.test.ts": [
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "import { hash } from \"../src/lib/hash.ts\";",
      "",
      "test(\"hash: stable for same input\", () => {",
      "  assert.equal(hash(\"x\"), hash(\"x\"));",
      "});",
      "",
      "test(\"hash: differs across inputs\", () => {",
      "  assert.notEqual(hash(\"a\"), hash(\"b\"));",
      "});",
      "",
    ].join("\n"),

    "README.md": "# linkly\n\nTiny URL shortener CLI (synthesized for qualy smoke test).\n",
  };

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: COMMIT_DATE,
    GIT_COMMITTER_DATE: COMMIT_DATE,
    GIT_AUTHOR_NAME: AUTHOR,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: AUTHOR,
    GIT_COMMITTER_EMAIL: EMAIL,
  };
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir, env });
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync(
    "git",
    [
      "-c",
      `user.email=${EMAIL}`,
      "-c",
      `user.name=${AUTHOR}`,
      "commit",
      "-q",
      "-m",
      "smoke: synthesize linkly",
    ],
    { cwd: dir, env },
  );

  return {
    dir,
    cleanup: () => {
      const resolved = resolve(dir);
      const resolvedTmp = resolve(tmpRoot);
      if (!resolved.startsWith(resolvedTmp + "/")) return;
      rmSync(resolved, { recursive: true, force: true });
    },
  };
}

describe("smoke: /lint:setup against a dynamically synthesized real-like TS repo", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("detects, installs, and produces every SPEC §7.1 artifact on a freshly minted repo the CLI has never seen", () => {
    const repo = synthesizeRealLikeRepo();
    cleanups.push(repo.cleanup);

    // ── Detection: stack must accept this TS-only repo ────────────────────
    const stack = detectStack({ cwd: repo.dir });
    expect(stack.ok, JSON.stringify(stack)).toBe(true);
    if (!stack.ok) return;
    expect(stack.supported).toBe(true);
    expect(stack.blockers).toEqual([]);
    expect(stack.signals.hasPackageJson).toBe(true);
    expect(stack.signals.tsFiles).toBeGreaterThan(0);

    // Stage detection runs deterministically; we don't pin it to a specific
    // stage because the synthesized repo is intentionally close to the
    // greenfield/brownfield boundary — what we care about is that detection
    // returns one of the three valid stages without throwing.
    const stage = detectStage({ cwd: repo.dir });
    expect(["greenfield", "brownfield-moderate", "legacy"]).toContain(stage.stage);

    // ── Layer 1: install-deps (stubbed runFn — no network in CI) ──────────
    let depsCalls = 0;
    const depsRes = installDeps(
      { cwd: repo.dir },
      {
        runFn: () => {
          depsCalls += 1;
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );
    expect(depsRes.ok, JSON.stringify(depsRes)).toBe(true);
    if (!depsRes.ok) return;
    expect(depsCalls).toBe(1);
    expect(depsRes.action).toBe("installed");
    expect([...depsRes.installed].sort()).toEqual([...DEFAULT_DEPS].sort());

    // ── Layer 2: install-oxlint (use greenfield preset for determinism) ───
    const oxlintRes = installOxlint({ cwd: repo.dir, stage: "greenfield" });
    expect(oxlintRes.ok, JSON.stringify(oxlintRes)).toBe(true);
    if (!oxlintRes.ok) return;
    expect(oxlintRes.written).toHaveLength(2);

    const fastWritten = readFileSync(join(repo.dir, "oxlint.fast.json"), "utf8");
    const fastSource = readFileSync(join(PRESETS_OXLINT_DIR, "greenfield.fast.json"), "utf8");
    expect(fastWritten).toBe(fastSource);

    // ── Layer 3: install-hook ─────────────────────────────────────────────
    const hookRes = installHook({ cwd: repo.dir });
    expect(hookRes.ok, JSON.stringify(hookRes)).toBe(true);
    if (!hookRes.ok) return;

    const hookScriptAbs = join(repo.dir, ".claude/hooks/post-edit.sh");
    const hookScript = readFileSync(hookScriptAbs, "utf8");
    expect(hookScript).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(hookScript).toContain("set -euo pipefail");
    expect((statSync(hookScriptAbs).mode & 0o100) !== 0).toBe(true);

    const settingsRaw = readFileSync(join(repo.dir, ".claude/settings.json"), "utf8");
    const settings = parseDefensive<SettingsRoot>(settingsRaw);
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    const ourEntry = (settings.value.hooks?.PostToolUse ?? []).find(
      (e) => e.matcher === "Write|Edit|MultiEdit",
    );
    expect(ourEntry, "PostToolUse must contain Write|Edit|MultiEdit entry").toBeDefined();
    expect(ourEntry?.hooks?.[0]?.command).toContain(".claude/hooks/post-edit.sh");

    // ── Layer 4: install-husky (type=module → .lintstagedrc.js) ───────────
    const huskyRes = installHusky({ cwd: repo.dir });
    expect(huskyRes.ok, JSON.stringify(huskyRes)).toBe(true);
    if (!huskyRes.ok) return;
    expect(huskyRes.husky.path).toBe(".husky/pre-commit");
    expect(huskyRes.lintstaged.path).toBe(".lintstagedrc.js");

    const lintstagedWritten = readFileSync(join(repo.dir, ".lintstagedrc.js"), "utf8");
    const lintstagedSource = readFileSync(TEMPLATE_LINTSTAGED, "utf8");
    expect(lintstagedWritten).toBe(lintstagedSource);

    // ── Layer 5: install-coverage (vitest skeleton at greenfield) ─────────
    const covRes = installCoverage({
      cwd: repo.dir,
      runner: "vitest",
      stage: "greenfield",
    });
    expect(covRes.ok, JSON.stringify(covRes)).toBe(true);
    if (!covRes.ok) return;
    expect(covRes.thresholds).toEqual({
      lines: 90,
      functions: 90,
      branches: 80,
      statements: 90,
    });

    const vitestConfig = readFileSync(join(repo.dir, "vitest.config.ts"), "utf8");
    expect(vitestConfig).toMatch(/lines:\s*90/);
    expect(vitestConfig).toMatch(/branches:\s*80/);
    expect(vitestConfig).toContain('provider: "v8"');

    // ── Layer 6: install-scripts (merge into pre-existing dev/start/test) ─
    const scriptsRes = installScripts({ cwd: repo.dir, runner: "vitest" });
    expect(scriptsRes.ok, JSON.stringify(scriptsRes)).toBe(true);
    if (!scriptsRes.ok) return;
    expect(scriptsRes.action).toBe("updated");
    expect([...scriptsRes.added].sort()).toEqual(
      ["coverage", "format", "lint", "lint:deep"].sort(),
    );

    const pkg = parseDefensive<PackageJsonRoot>(
      readFileSync(join(repo.dir, "package.json"), "utf8"),
    );
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const scripts = pkg.value.scripts ?? {};
    // qualy-authored scripts present.
    expect(scripts["lint"]).toBe("oxlint --config oxlint.fast.json .");
    expect(scripts["lint:deep"]).toBe("oxlint --config oxlint.deep.json .");
    expect(scripts["format"]).toBe("oxfmt --write .");
    expect(scripts["coverage"]).toBe("vitest run --coverage");
    // Pre-existing scripts SURVIVE the merge — this is the regression we
    // care about most for "real" repos: no clobber of dev/start/test.
    expect(scripts["dev"]).toBe("node --experimental-strip-types src/index.ts");
    expect(scripts["start"]).toBe("node --experimental-strip-types src/index.ts");
    expect(scripts["test"]).toBe("node --experimental-strip-types --test tests/**/*.test.ts");
    // Top-level keys preserved.
    expect(pkg.value.type).toBe("module");
    expect(pkg.value.description).toContain("synthesized");

    // ── Manifest indexes everything qualy authored or merged ──────────────
    const manifest = loadManifest(repo.dir) as Manifest;
    expect(manifest).not.toBeNull();
    const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
    expect(byPath.get("oxlint.fast.json")?.kind).toBe("preset");
    expect(byPath.get("oxlint.deep.json")?.kind).toBe("preset");
    expect(byPath.get(".claude/hooks/post-edit.sh")?.kind).toBe("hook");
    expect(byPath.get(".claude/settings.json")?.kind).toBe("settings");
    expect(byPath.get(".claude/settings.json")?.merged).toBe(true);
    expect(byPath.get(".husky/pre-commit")?.kind).toBe("husky");
    expect(byPath.get(".lintstagedrc.js")?.kind).toBe("lintstaged");
    expect(byPath.get("vitest.config.ts")?.kind).toBe("coverage");
    expect(byPath.get("package.json")?.kind).toBe("scripts");
    expect(byPath.get("package.json")?.merged).toBe(true);
    for (const dep of DEFAULT_DEPS) {
      const v = `package.json#devDependencies/${dep}`;
      expect(byPath.get(v)?.kind, `dep entry for ${dep}`).toBe("dep");
    }
    expect(byPath.has(MANIFEST_FILENAME)).toBe(false);

    // Re-running install-scripts on a now-complete package.json is a no-op:
    // the boring guarantee that lets users re-trigger /lint:setup safely.
    const scriptsAgain = installScripts({ cwd: repo.dir, runner: "vitest" });
    expect(scriptsAgain.ok).toBe(true);
    if (scriptsAgain.ok) {
      expect(scriptsAgain.action).toBe("noop");
      expect(scriptsAgain.added).toEqual([]);
    }
  });
});
