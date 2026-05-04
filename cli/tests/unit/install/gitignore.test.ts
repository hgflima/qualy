import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendIgnoreLine } from "../../../src/install/gitignore.ts";

describe("appendIgnoreLine", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "qualy-gitignore-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates .gitignore when absent and returns 'created'", () => {
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(appendIgnoreLine(repo, ".claude/")).toBe("created");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".claude/\n");
  });

  it("returns 'already-present' when the line is the only entry", () => {
    writeFileSync(join(repo, ".gitignore"), ".claude/\n", "utf8");
    expect(appendIgnoreLine(repo, ".claude/")).toBe("already-present");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(".claude/\n");
  });

  it("returns 'already-present' even with trailing whitespace / CRLF noise", () => {
    writeFileSync(
      join(repo, ".gitignore"),
      "node_modules\n.claude/  \r\n*.log\n",
      "utf8",
    );
    expect(appendIgnoreLine(repo, ".claude/")).toBe("already-present");
  });

  it("appends with a newline when existing content ends in one", () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules\n*.log\n", "utf8");
    expect(appendIgnoreLine(repo, ".claude/")).toBe("added");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules\n*.log\n.claude/\n",
    );
  });

  it("inserts a newline first when existing content lacks a trailing newline", () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules", "utf8");
    expect(appendIgnoreLine(repo, ".claude/")).toBe("added");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules\n.claude/\n",
    );
  });

  it("does not match a related-but-different pattern (.claude vs .claude/)", () => {
    writeFileSync(join(repo, ".gitignore"), ".claude\n", "utf8");
    expect(appendIgnoreLine(repo, ".claude/")).toBe("added");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe(
      ".claude\n.claude/\n",
    );
  });

  it("rejects an empty (or whitespace-only) line", () => {
    expect(() => appendIgnoreLine(repo, "   ")).toThrow(
      /must not be empty after trim/,
    );
  });
});
