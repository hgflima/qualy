/**
 * E2E parity for `install.sh --dev` vs `qualy install --scope user`
 * (TASKS.md 4.2 + SPEC.md §6 "Manter paridade de comportamento entre
 * install.sh e npx qualy install quando ambos atuam em --scope user").
 *
 * Both invocations target a synthetic HOME under os.tmpdir() so the real
 * `~/.claude` is never touched. The comparison filters paths that are
 * divergent by design:
 *   - install.sh --dev symlinks entire directories (cli/ in particular),
 *     so a symlink-following walk reaches dev-only artifacts (tests/,
 *     node_modules/, coverage/, dist/) that `qualy install` excludes via
 *     walkPayload(). The exclusion list captures exactly that delta.
 *   - `.lint-manifest.json` is written only by qualy install — install.sh
 *     predates the manifest contract.
 *
 * The two smaller tests around the deprecation note guard the soft-deprecation
 * itself (TASKS 4.2 — "deprecation soft, não bloqueante"): default `install.sh`
 * must surface the note pointing users at `npx qualy install`, while
 * `install.sh --dev` (the dev path) must remain silent so existing dev
 * loops are not noisy.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "cli", "src", "index.ts");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

/**
 * Directory names skipped while walking. install.sh follows the skills/lint
 * → source/cli symlink chain into directories that the npx installer's
 * `walkPayload` filters out by name.
 */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "tests",
  "coverage",
  "dist",
  ".harn",
]);

const EXCLUDE_FILES = new Set<string>([".lint-manifest.json"]);

/**
 * Recursive walker that follows symlinks (statSync, not lstatSync) and
 * skips the SKIP_DIR_NAMES at every level. Returns paths relative to `root`.
 */
function walkFollowingSymlinks(root: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? root : join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const childRel = rel === "" ? ent.name : join(rel, ent.name);
      const childAbs = join(root, childRel);
      let st;
      try {
        st = statSync(childAbs); // follows symlinks
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(childRel);
      } else if (st.isFile()) {
        if (!EXCLUDE_FILES.has(childRel)) out.add(childRel);
      }
    }
  }
  return out;
}

function symmetricDiff(a: Set<string>, b: Set<string>): {
  onlyInA: string[];
  onlyInB: string[];
} {
  const onlyInA = [...a].filter((p) => !b.has(p)).toSorted();
  const onlyInB = [...b].filter((p) => !a.has(p)).toSorted();
  return { onlyInA, onlyInB };
}

describe("e2e: install.sh ↔ qualy install --scope user parity", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("install.sh --dev and qualy install yield the same artifact paths", () => {
    const homeSh = mkdtempSync(join(tmpdir(), "qualy-parity-sh-"));
    cleanups.push(() => rmSync(homeSh, { recursive: true, force: true }));
    const homeNpx = mkdtempSync(join(tmpdir(), "qualy-parity-npx-"));
    cleanups.push(() => rmSync(homeNpx, { recursive: true, force: true }));

    execFileSync("bash", [INSTALL_SH, "--dev"], {
      env: { ...process.env, HOME: homeSh },
      stdio: "ignore",
    });
    execFileSync(
      "node",
      ["--experimental-strip-types", CLI_ENTRY, "install", "--scope", "user"],
      {
        env: { ...process.env, HOME: homeNpx },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );

    const sh = walkFollowingSymlinks(join(homeSh, ".claude"));
    const npx = walkFollowingSymlinks(join(homeNpx, ".claude"));

    expect(sh.size, "install.sh produced no files").toBeGreaterThan(0);
    expect(npx.size, "qualy install produced no files").toBeGreaterThan(0);

    const diff = symmetricDiff(sh, npx);
    expect(diff).toEqual({ onlyInA: [], onlyInB: [] });
  });

  it("install.sh without --dev prints the deprecation note pointing at npx", () => {
    const homeSh = mkdtempSync(join(tmpdir(), "qualy-parity-deprecation-"));
    cleanups.push(() => rmSync(homeSh, { recursive: true, force: true }));

    const out = execFileSync("bash", [INSTALL_SH, "--dry-run"], {
      env: { ...process.env, HOME: homeSh },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/npx qualy install/);
    expect(out).toMatch(/--dev/);
  });

  it("install.sh --dev does NOT print the deprecation note", () => {
    const homeSh = mkdtempSync(join(tmpdir(), "qualy-parity-nodeprecation-"));
    cleanups.push(() => rmSync(homeSh, { recursive: true, force: true }));

    const out = execFileSync("bash", [INSTALL_SH, "--dev", "--dry-run"], {
      env: { ...process.env, HOME: homeSh },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).not.toMatch(/o caminho recomendado/);
    expect(out).not.toMatch(/npx qualy install/);
  });
});
