/**
 * Contract tests for `commands/ignore/explain.ts` (lint-ignore PLAN T2.5
 * explain slot).
 *
 * Pins SPEC §3.4:
 *   - empty / absent manifest → exit 1 entry_not_found.
 *   - glob/rule mismatch → exit 1 entry_not_found.
 *   - ambiguous glob (multiple matches, no --rule) → exit 1 entry_ambiguous.
 *   - manifest corrupt → exit 70 INTERNAL_ERROR.
 *   - happy path: returns decorated entry + decision-log blocks filtered by
 *     the entry's id.
 *   - decision log absent → history: [] (no error — read-only).
 */
import { describe, expect, it } from "vitest";

import {
  extractHistoryForEntry,
  ignoreExplain,
  parseIgnoreExplainArgs,
} from "../../src/commands/ignore/explain.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";
import {
  DECISION_LOG_PATH,
  IGNORE_MANIFEST_PATH,
} from "../../src/lib/paths.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");

function makeFs(seed: Record<string, string> = {}): {
  files: Map<string, string>;
  io: SafeIO;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const io: SafeIO = {
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, content) => {
      files.set(p, content);
    },
    mkdirFn: () => {},
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => NOW,
  };
  return { files, io };
}

function manifest(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, entries }, null, 2) + "\n";
}

const ENTRY_PATH = {
  id: "ign-aaaa01",
  glob: "src/legacy/**",
  rule: null,
  reason: "legacy",
  expires: "2026-04-01",
  createdAt: "2026-03-01T00:00:00.000Z",
  createdBy: "user",
};
const ENTRY_RULE = {
  id: "ign-bbbb02",
  glob: "src/legacy/**",
  rule: "quality-metrics/wmc",
  reason: "wmc",
  expires: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  createdBy: "user",
};

const DECISIONS_LOG = `# Lint decisions

## Entries

<!-- qualy:entries-start -->

### 2026-03-01T00:00:00Z — ignore-add: src/legacy/** (path-only)

- **kind**: ignore-add
- **glob**: src/legacy/**
- **rule**: (path-only)
- **id**: ign-aaaa01
- **expires**: 2026-04-01
- **author**: alice@example.com
- **reason**: legacy code

### 2026-04-01T00:00:00Z — ignore-update: src/legacy/** (path-only)

- **kind**: ignore-update
- **glob**: src/legacy/**
- **rule**: (path-only)
- **id**: ign-aaaa01
- **expires**: 2026-04-01
- **author**: alice@example.com
- **reason**: bumped reason

### 2026-04-15T00:00:00Z — ignore-add: src/legacy/** (quality-metrics/wmc)

- **kind**: ignore-add
- **glob**: src/legacy/**
- **rule**: quality-metrics/wmc
- **id**: ign-bbbb02
- **expires**: (never)
- **author**: alice@example.com
- **reason**: wmc

<!-- qualy:entries-end -->
`;

// ---------------------------------------------------------------------------
// parseIgnoreExplainArgs
// ---------------------------------------------------------------------------

describe("parseIgnoreExplainArgs", () => {
  it("accepts glob positional", () => {
    const r = parseIgnoreExplainArgs(["src/legacy/**"], "/repo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.glob).toBe("src/legacy/**");
    expect(r.value.rule).toBeUndefined();
  });

  it("accepts --rule and --cwd", () => {
    const r = parseIgnoreExplainArgs(
      ["src/legacy/**", "--rule", "path", "--cwd", "/x"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rule).toBe("path");
    expect(r.value.cwd).toBe("/x");
  });

  it("rejects when glob is missing", () => {
    const r = parseIgnoreExplainArgs([], "/repo");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractHistoryForEntry
// ---------------------------------------------------------------------------

describe("extractHistoryForEntry", () => {
  it("returns blocks whose id bullet matches", () => {
    const out = extractHistoryForEntry(DECISIONS_LOG, "ign-aaaa01");
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("ignore-add");
    expect(out[0]!.timestamp).toBe("2026-03-01T00:00:00Z");
    expect(out[1]!.kind).toBe("ignore-update");
    expect(out[1]!.raw).toContain("- **id**: ign-aaaa01");
  });

  it("filters out blocks with a different id", () => {
    const out = extractHistoryForEntry(DECISIONS_LOG, "ign-bbbb02");
    expect(out).toHaveLength(1);
    expect(out[0]!.subject).toContain("quality-metrics/wmc");
  });

  it("returns [] when markers are absent", () => {
    const out = extractHistoryForEntry(
      "# decision log\n\nno markers here\n",
      "ign-aaaa01",
    );
    expect(out).toEqual([]);
  });

  it("returns [] when no block carries the requested id", () => {
    const out = extractHistoryForEntry(DECISIONS_LOG, "ign-zzzz99");
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ignoreExplain — happy path
// ---------------------------------------------------------------------------

describe("ignoreExplain — happy path", () => {
  it("returns the decorated entry + filtered history", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH, ENTRY_RULE]),
      [`/repo/${DECISION_LOG_PATH}`]: DECISIONS_LOG,
    });
    const r = ignoreExplain(
      { cwd: "/repo", glob: "src/legacy/**", rule: "path" },
      {
        safeIO: fs.io,
        readFileFn: (p) => fs.files.get(p) ?? null,
        now: () => NOW,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.id).toBe("ign-aaaa01");
    expect(r.entry.status).toBe("expired");
    expect(r.entry.days_overdue).toBe(34);
    expect(r.history).toHaveLength(2);
    expect(r.history.map((h) => h.kind)).toEqual([
      "ignore-add",
      "ignore-update",
    ]);
  });

  it("history is empty when decision log is absent", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH]),
    });
    const r = ignoreExplain(
      { cwd: "/repo", glob: "src/legacy/**" },
      {
        safeIO: fs.io,
        readFileFn: (p) => fs.files.get(p) ?? null,
        now: () => NOW,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ignoreExplain — errors
// ---------------------------------------------------------------------------

describe("ignoreExplain — errors", () => {
  it("returns entry_not_found when manifest is empty/absent", () => {
    const fs = makeFs();
    const r = ignoreExplain(
      { cwd: "/repo", glob: "src/legacy/**" },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_not_found");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("returns entry_not_found when the glob is unknown", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH]),
    });
    const r = ignoreExplain(
      { cwd: "/repo", glob: "nonexistent/**" },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_not_found");
  });

  it("returns entry_ambiguous when glob matches multiple without --rule", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([ENTRY_PATH, ENTRY_RULE]),
    });
    const r = ignoreExplain(
      { cwd: "/repo", glob: "src/legacy/**" },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("entry_ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  it("returns INTERNAL_ERROR when manifest is malformed JSON", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
    });
    const r = ignoreExplain(
      { cwd: "/repo", glob: "src/legacy/**" },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});
