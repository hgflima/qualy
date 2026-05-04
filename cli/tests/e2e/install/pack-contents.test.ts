/**
 * E2E for `npm pack` payload (TASKS.md 3.1 — "roda `npm pack --dry-run --json`,
 * parseia, asserta lista exata de paths (snapshot). Garante que `cli/tests/`,
 * `cli/node_modules/`, `.harn/` ficam fora").
 *
 * The actual file list is asserted via a stored snapshot — the snapshot file
 * is intentional: when the package gains/loses a runtime asset, the diff
 * forces a deliberate review of the published surface (SPEC §4 + D3). The
 * sibling explicit assertions document the must-include and must-exclude
 * invariants in code so the safety guarantees survive a careless `--update`.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

type PackEntry = { path: string; size: number; mode: number };
type PackResult = {
  name: string;
  version: string;
  files: PackEntry[];
  bin?: Record<string, string>;
};

function npmPackDryRun(): PackResult {
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const parsed = JSON.parse(out) as PackResult[];
  if (parsed.length !== 1) {
    throw new Error(`expected 1 tarball entry, got ${parsed.length}`);
  }
  return parsed[0]!;
}

const MUST_INCLUDE: readonly string[] = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "bin/qualy.mjs",
  "cli/src/index.ts",
  "cli/src/install/install.ts",
  "cli/src/install/uninstall.ts",
  "cli/src/install/update.ts",
  "skills/lint/SKILL.md",
  "commands/lint/setup.md",
  "agents/lint-detector.md",
];

const FORBIDDEN_PREFIXES: readonly string[] = [
  "cli/tests/",
  "cli/node_modules/",
  "node_modules/",
  ".harn/",
  ".lint-audit/",
  ".lint-backup/",
  ".lint-manifest.json",
  ".git/",
  "ralph/",
  "docs/",
  "skills/lint/cli/",
  ".github/",
];

const FORBIDDEN_EXACT: readonly string[] = [
  "install.sh",
  "oxlint.fast.json",
  "oxlint.deep.json",
  "vitest.config.ts",
];

describe("e2e: npm pack contents", () => {
  it("publishes the bin shim as executable", () => {
    const pack = npmPackDryRun();
    const shim = pack.files.find((f) => f.path === "bin/qualy.mjs");
    expect(shim, "bin/qualy.mjs missing from tarball").toBeDefined();
    // 0o755 == 493 decimal (npm exposes the mode as a base-10 number).
    expect(shim!.mode).toBe(493);
  });

  it("includes every required runtime path", () => {
    const paths = new Set(npmPackDryRun().files.map((f) => f.path));
    for (const required of MUST_INCLUDE) {
      expect(
        paths.has(required),
        `missing required path: ${required}`,
      ).toBe(true);
    }
  });

  it("excludes test, build, and developer-only artifacts", () => {
    const paths = npmPackDryRun().files.map((f) => f.path);
    for (const prefix of FORBIDDEN_PREFIXES) {
      const leaks = paths.filter((p) => p.startsWith(prefix));
      expect(leaks, `forbidden prefix ${prefix} leaked: ${leaks.join(", ")}`)
        .toEqual([]);
    }
    for (const exact of FORBIDDEN_EXACT) {
      expect(paths.includes(exact), `forbidden exact path: ${exact}`)
        .toBe(false);
    }
  });

  it("snapshot of the full sorted file list", () => {
    const sorted = npmPackDryRun()
      .files
      .map((f) => f.path)
      .toSorted((a, b) => a.localeCompare(b));
    expect(sorted).toMatchSnapshot();
  });
});
