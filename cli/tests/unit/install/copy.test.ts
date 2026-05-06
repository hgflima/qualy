import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  copyPayload,
  mapTarget,
  sha256File,
  walkPayload,
} from "../../../src/install/copy.ts";

function makeSource(root: string): void {
  mkdirSync(join(root, "skills", "lint"), { recursive: true });
  writeFileSync(join(root, "skills", "lint", "SKILL.md"), "skill body\n");

  mkdirSync(join(root, "commands", "lint"), { recursive: true });
  writeFileSync(join(root, "commands", "lint", "audit.md"), "audit body\n");

  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", "lint-detector.md"),
    "agent body\n",
  );

  // Below this line: a `cli/` tree is intentionally placed in the source to
  // verify that walkPayload no longer descends into it (v0.3.4 ships the CLI
  // via `npm install` into `skills/lint/node_modules/`, not via copy).
  mkdirSync(join(root, "cli", "src"), { recursive: true });
  writeFileSync(join(root, "cli", "src", "index.ts"), "export {};\n");
  mkdirSync(join(root, "cli", "tests"), { recursive: true });
  writeFileSync(
    join(root, "cli", "tests", "should-skip.test.ts"),
    "skip me\n",
  );
  mkdirSync(join(root, "cli", "node_modules", "foo"), { recursive: true });
  writeFileSync(
    join(root, "cli", "node_modules", "foo", "x.js"),
    "skip me too\n",
  );
}

describe("walkPayload", () => {
  let source: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-copy-walk-"));
    makeSource(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
  });

  it("yields every file under skills/commands/agents", () => {
    const rels = [...walkPayload(source)].toSorted();
    expect(rels).toEqual([
      join("agents", "lint-detector.md"),
      join("commands", "lint", "audit.md"),
      join("skills", "lint", "SKILL.md"),
    ]);
  });

  it("does not descend into cli/ at all (no longer part of payload)", () => {
    const rels = [...walkPayload(source)];
    expect(rels.some((r) => r.startsWith(`cli${sep}`))).toBe(false);
  });

  it("does not follow symlinks under skills/", () => {
    // A symlink under a walked top-level directory must not be followed —
    // the walker yields only regular files (matters for any future symlinks
    // a user or build step might leave behind).
    mkdirSync(join(source, "external"), { recursive: true });
    writeFileSync(join(source, "external", "shadow.md"), "shadow body\n");
    symlinkSync(
      join(source, "external"),
      join(source, "skills", "lint", "linked"),
      "dir",
    );
    const rels = [...walkPayload(source)];
    expect(
      rels.some((r) => r.startsWith(join("skills", "lint", "linked"))),
    ).toBe(false);
    expect(rels).toContain(join("skills", "lint", "SKILL.md"));
  });

  it("skips top-level directories that do not exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "qualy-copy-empty-"));
    try {
      expect([...walkPayload(empty)]).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("mapTarget", () => {
  it("preserves skills|commands|agents under the target unchanged", () => {
    expect(mapTarget(join("skills", "lint", "SKILL.md"), "/T")).toBe(
      join("/T", "skills", "lint", "SKILL.md"),
    );
    expect(mapTarget(join("commands", "lint", "audit.md"), "/T")).toBe(
      join("/T", "commands", "lint", "audit.md"),
    );
    expect(mapTarget(join("agents", "lint-detector.md"), "/T")).toBe(
      join("/T", "agents", "lint-detector.md"),
    );
  });
});

describe("sha256File", () => {
  it("returns a 64-char lowercase hex digest stable across runs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "qualy-copy-sha-"));
    try {
      const f = join(tmp, "x.txt");
      writeFileSync(f, "hello world\n");
      const a = await sha256File(f);
      const b = await sha256File(f);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("copyPayload", () => {
  let source: string;
  let target: string;

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), "qualy-copy-src-"));
    target = mkdtempSync(join(tmpdir(), "qualy-copy-tgt-"));
    makeSource(source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("(a) writes byte-identical files at the mapped target paths", async () => {
    const result = await copyPayload({ source, target, dryRun: false });

    expect(result.skipped).toEqual([]);
    expect(result.copied).toHaveLength(3);

    expect(
      readFileSync(join(target, "skills", "lint", "SKILL.md"), "utf8"),
    ).toBe("skill body\n");
    expect(
      readFileSync(join(target, "commands", "lint", "audit.md"), "utf8"),
    ).toBe("audit body\n");
    expect(
      readFileSync(join(target, "agents", "lint-detector.md"), "utf8"),
    ).toBe("agent body\n");
    // cli/src/index.ts must NOT be copied — that subtree is materialized via
    // npm install in materialize-runtime.ts, not via the copy pipeline.
    expect(
      existsSync(join(target, "skills", "lint", "cli", "src", "index.ts")),
    ).toBe(false);

    for (const entry of result.copied) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(entry.abs)).toBe(true);
    }
  });

  it("(b) is idempotent: a second run reports everything as skipped", async () => {
    await copyPayload({ source, target, dryRun: false });
    const second = await copyPayload({ source, target, dryRun: false });
    expect(second.copied).toEqual([]);
    expect(second.skipped).toHaveLength(3);
  });

  it("(c) dry-run writes zero bytes to the target", async () => {
    expect(readdirSync(target)).toEqual([]);
    const result = await copyPayload({ source, target, dryRun: true });
    expect(result.copied).toHaveLength(3);
    expect(readdirSync(target)).toEqual([]);
  });

  it("(d) sha256 of each entry stays stable across two source reads", async () => {
    const first = await copyPayload({ source, target, dryRun: true });
    const target2 = mkdtempSync(join(tmpdir(), "qualy-copy-tgt2-"));
    try {
      const second = await copyPayload({
        source,
        target: target2,
        dryRun: true,
      });
      const firstByRel = new Map(first.copied.map((e) => [e.rel, e.sha256]));
      for (const e of second.copied) {
        expect(firstByRel.get(e.rel)).toBe(e.sha256);
      }
    } finally {
      rmSync(target2, { recursive: true, force: true });
    }
  });

  it("(e) preserves orphan files that exist in target but not in source", async () => {
    writeFileSync(join(target, "ORPHAN.txt"), "orphan content\n");
    await copyPayload({ source, target, dryRun: false });
    expect(readFileSync(join(target, "ORPHAN.txt"), "utf8")).toBe(
      "orphan content\n",
    );
  });

  it("rewrites existing target files when their sha256 differs", async () => {
    const targetFile = join(target, "skills", "lint", "SKILL.md");
    mkdirSync(join(target, "skills", "lint"), { recursive: true });
    writeFileSync(targetFile, "stale content\n");

    const result = await copyPayload({ source, target, dryRun: false });

    expect(readFileSync(targetFile, "utf8")).toBe("skill body\n");
    expect(result.copied.some((e) => e.rel.endsWith("SKILL.md"))).toBe(true);
  });

  it("derives kind from the source-side top-level directory", async () => {
    const result = await copyPayload({ source, target, dryRun: false });
    const byRel = new Map(result.copied.map((e) => [e.rel, e.kind]));
    expect(byRel.get(join("skills", "lint", "SKILL.md"))).toBe("skill");
    expect(byRel.get(join("commands", "lint", "audit.md"))).toBe("command");
    expect(byRel.get(join("agents", "lint-detector.md"))).toBe("agent");
  });
});
