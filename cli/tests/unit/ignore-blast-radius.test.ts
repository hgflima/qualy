/**
 * Contract tests for `commands/ignore/blast-radius.ts` — read-only blast
 * radius preview consumed by `/lint:ignore:add` and `/lint:ignore:remove`
 * (lint-ignore PLAN T4.3).
 *
 * Pinned guarantees:
 *  - Empty / whitespace glob → exit `1` `invalid_glob`.
 *  - Result shape: `{ ok, cwd, glob, files_in_glob, sample }`. Sample order
 *    follows whatever fast-glob produces (we don't sort here; tests inject a
 *    deterministic fake to keep output predictable).
 *  - Sample size capped at `BLAST_RADIUS_SAMPLE_LIMIT` (10) by default;
 *    `--limit <N>` overrides; non-positive overrides fall back to the default.
 *  - Hardcoded exclusion list is forwarded to fast-glob's `ignore` option —
 *    the slash command's blast-radius preview should never list files from
 *    `node_modules`, `.git`, `dist`, `.harn`, `.lint-audit`, `.lint-backup`.
 *  - Glob args via positional and `--glob` are equivalent (slash command
 *    forwards whatever the user typed).
 *  - The CLI is read-only: no manifest, preset, or decision log mutation.
 */
import { describe, expect, it } from "vitest";

import {
  BLAST_RADIUS_EXCLUDES,
  BLAST_RADIUS_SAMPLE_LIMIT,
  ignoreBlastRadius,
  parseIgnoreBlastRadiusArgs,
} from "../../src/commands/ignore/blast-radius.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";

// ---------------------------------------------------------------------------
// Fake glob driver: deterministic, no FS access
// ---------------------------------------------------------------------------

interface CapturedCall {
  glob: string;
  cwd: string;
  ignore: readonly string[];
}

function makeFakeGlob(returns: readonly string[]): {
  fn: (
    glob: string,
    opts: { cwd: string; ignore: readonly string[] },
  ) => readonly string[];
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn = (
    glob: string,
    opts: { cwd: string; ignore: readonly string[] },
  ): readonly string[] => {
    calls.push({ glob, cwd: opts.cwd, ignore: opts.ignore });
    return returns;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// parseIgnoreBlastRadiusArgs
// ---------------------------------------------------------------------------

describe("parseIgnoreBlastRadiusArgs", () => {
  it("accepts the glob as a positional argument", () => {
    const r = parseIgnoreBlastRadiusArgs(["src/legacy/**"], "/repo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("src/legacy/**");
    expect(r.value.cwd).toBe("/repo");
  });

  it("accepts --glob <pattern>", () => {
    const r = parseIgnoreBlastRadiusArgs(["--glob", "src/old/**"], "/repo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("src/old/**");
  });

  it("accepts --cwd <path>", () => {
    const r = parseIgnoreBlastRadiusArgs(
      ["src/**", "--cwd", "/elsewhere"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/elsewhere");
  });

  it("accepts --limit <N> as a positive integer", () => {
    const r = parseIgnoreBlastRadiusArgs(
      ["src/**", "--limit", "5"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sampleLimit).toBe(5);
  });

  it("rejects --limit 0", () => {
    const r = parseIgnoreBlastRadiusArgs(
      ["src/**", "--limit", "0"],
      "/repo",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects --limit non-numeric", () => {
    const r = parseIgnoreBlastRadiusArgs(
      ["src/**", "--limit", "abc"],
      "/repo",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreBlastRadiusArgs(["--bogus"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("returns error: 'help' for --help", () => {
    const r = parseIgnoreBlastRadiusArgs(["--help"], "/repo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });

  it("requires a glob (positional or --glob)", () => {
    const r = parseIgnoreBlastRadiusArgs([], "/repo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing glob/);
  });

  it("--glob wins over positional when both are given", () => {
    const r = parseIgnoreBlastRadiusArgs(
      ["positional/**", "--glob", "flag/**"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Parser preserves the first positional but --glob takes precedence.
    expect(r.value.glob).toBe("flag/**");
  });
});

// ---------------------------------------------------------------------------
// ignoreBlastRadius — happy path
// ---------------------------------------------------------------------------

describe("ignoreBlastRadius — happy path", () => {
  it("returns count + sample (count > 0)", () => {
    const matches = [
      "src/legacy/a.ts",
      "src/legacy/b.ts",
      "src/legacy/c.ts",
    ];
    const { fn, calls } = makeFakeGlob(matches);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "src/legacy/**" },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cwd).toBe("/repo");
    expect(r.glob).toBe("src/legacy/**");
    expect(r.files_in_glob).toBe(3);
    expect(r.sample).toEqual(matches);
    expect(r.exitCode).toBe(EXIT_CODES.OK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.glob).toBe("src/legacy/**");
    expect(calls[0]?.cwd).toBe("/repo");
  });

  it("returns count 0 + empty sample when nothing matches", () => {
    const { fn } = makeFakeGlob([]);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "src/none/**" },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_in_glob).toBe(0);
    expect(r.sample).toEqual([]);
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });

  it("trims surrounding whitespace from the glob", () => {
    const { fn, calls } = makeFakeGlob(["src/x.ts"]);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "  src/**  " },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.glob).toBe("src/**");
    expect(calls[0]?.glob).toBe("src/**");
  });
});

// ---------------------------------------------------------------------------
// Sample limit
// ---------------------------------------------------------------------------

describe("ignoreBlastRadius — sample limit", () => {
  function buildMany(n: number): readonly string[] {
    return Array.from({ length: n }, (_, i) => `src/f${String(i)}.ts`);
  }

  it("caps the sample at BLAST_RADIUS_SAMPLE_LIMIT (default 10)", () => {
    const matches = buildMany(25);
    const { fn } = makeFakeGlob(matches);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "src/**" },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(BLAST_RADIUS_SAMPLE_LIMIT).toBe(10);
    expect(r.files_in_glob).toBe(25);
    expect(r.sample).toHaveLength(10);
    expect(r.sample).toEqual(matches.slice(0, 10));
  });

  it("respects an explicit sampleLimit override", () => {
    const matches = buildMany(25);
    const { fn } = makeFakeGlob(matches);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "src/**", sampleLimit: 3 },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample).toEqual(matches.slice(0, 3));
  });

  it("falls back to the default for non-positive limits", () => {
    const matches = buildMany(25);
    const { fn } = makeFakeGlob(matches);
    for (const bad of [0, -1, Number.NaN]) {
      const r = ignoreBlastRadius(
        { cwd: "/repo", glob: "src/**", sampleLimit: bad },
        { globFn: fn },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.sample).toHaveLength(BLAST_RADIUS_SAMPLE_LIMIT);
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusion contract
// ---------------------------------------------------------------------------

describe("ignoreBlastRadius — exclusion contract", () => {
  it("forwards the hardcoded exclusion list to the glob driver", () => {
    const { fn, calls } = makeFakeGlob([]);
    ignoreBlastRadius({ cwd: "/repo", glob: "**/*" }, { globFn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ignore).toEqual(BLAST_RADIUS_EXCLUDES);
  });

  it("excludes node_modules, .git, dist, .harn, .lint-audit, .lint-backup", () => {
    // Snapshot the contract so future drift is loud.
    expect(BLAST_RADIUS_EXCLUDES).toEqual([
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/.harn/**",
      "**/.lint-audit/**",
      "**/.lint-backup/**",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("ignoreBlastRadius — validation", () => {
  it("rejects an empty glob with invalid_glob (exit 1)", () => {
    const { fn, calls } = makeFakeGlob(["should-not-be-called"]);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "" },
      { globFn: fn },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_glob");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
    // Glob driver must NOT have been called when validation fails — keeps
    // the read-only contract cheap (no syscalls).
    expect(calls).toHaveLength(0);
  });

  it("rejects a whitespace-only glob with invalid_glob", () => {
    const { fn } = makeFakeGlob([]);
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "   \t  " },
      { globFn: fn },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_glob");
  });
});

// ---------------------------------------------------------------------------
// Defensive shape
// ---------------------------------------------------------------------------

describe("ignoreBlastRadius — defensive shape", () => {
  it("coerces a non-array glob result into files_in_glob 0", () => {
    const fn = (() => {
      // Lying glob driver — fast-glob would never do this in real life, but
      // the pure handler should not crash if a future fake/test injects junk.
      return null as unknown as readonly string[];
    }) as Parameters<typeof ignoreBlastRadius>[1] extends { globFn?: infer G }
      ? G
      : never;
    const r = ignoreBlastRadius(
      { cwd: "/repo", glob: "src/**" },
      { globFn: fn },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files_in_glob).toBe(0);
    expect(r.sample).toEqual([]);
  });
});
