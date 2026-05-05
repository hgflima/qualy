/**
 * Contract tests for `commands/ignore/list.ts` (lint-ignore PLAN T2.5 list slot).
 *
 * Pins SPEC §3.3 + §10 #3, #4:
 *   - empty manifest → entries: [], expired_count: 0, exit 0.
 *   - status decoration (active vs expired with days_overdue).
 *   - `--expired` filter + exit 1 when any expired present, 0 otherwise.
 *   - `--path` filters by literal glob equality.
 *   - manifest corrupt → exit 70.
 *   - argv parser shape parity with `ignore-add` / `ignore-remove`.
 */
import { describe, expect, it } from "vitest";

import {
  ignoreList,
  parseIgnoreListArgs,
} from "../../src/commands/ignore/list.ts";
import { EXIT_CODES } from "../../src/lib/exit-codes.ts";
import { type SafeIO } from "../../src/lib/fs-safe.ts";
import { IGNORE_MANIFEST_PATH } from "../../src/lib/paths.ts";

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

describe("parseIgnoreListArgs", () => {
  it("parses --expired, --path, --json, --cwd", () => {
    const r = parseIgnoreListArgs(
      ["--expired", "--path", "src/**", "--json", "--cwd", "/x"],
      "/repo",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expired).toBe(true);
    expect(r.value.path).toBe("src/**");
    expect(r.value.json).toBe(true);
    expect(r.value.cwd).toBe("/x");
  });

  it("rejects unknown flags", () => {
    const r = parseIgnoreListArgs(["--bogus"], "/repo");
    expect(r.ok).toBe(false);
  });

  it("returns help sentinel on --help", () => {
    const r = parseIgnoreListArgs(["--help"], "/repo");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("help");
  });
});

describe("ignoreList — empty manifest", () => {
  it("returns entries=[], expired_count=0, exit 0 when manifest absent", () => {
    const fs = makeFs();
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
    expect(r.expired_count).toBe(0);
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });

  it("returns entries=[] when manifest exists with no entries", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([]),
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
  });
});

describe("ignoreList — status decoration", () => {
  it("marks past-expires entries as expired with days_overdue", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-aaaa01",
          glob: "src/legacy/**",
          rule: null,
          reason: "x",
          expires: "2026-04-01",
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
        {
          id: "ign-bbbb02",
          glob: "src/active/**",
          rule: null,
          reason: "y",
          expires: "2026-12-31",
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
        {
          id: "ign-cccc03",
          glob: "src/forever/**",
          rule: null,
          reason: "z",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.length).toBe(3);
    expect(r.expired_count).toBe(1);
    const expired = r.entries.find((e) => e.id === "ign-aaaa01")!;
    expect(expired.status).toBe("expired");
    // 2026-04-01 → 2026-05-05 = 34 days
    expect(expired.days_overdue).toBe(34);
    const active = r.entries.find((e) => e.id === "ign-bbbb02")!;
    expect(active.status).toBe("active");
    const forever = r.entries.find((e) => e.id === "ign-cccc03")!;
    expect(forever.status).toBe("active");
  });

  it("treats same-day expires as still active", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-d11111",
          glob: "src/edge/**",
          rule: null,
          reason: "x",
          expires: "2026-05-05",
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]!.status).toBe("active");
  });
});

describe("ignoreList — --expired", () => {
  it("filters and exits 1 when any expired present", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-aaaa01",
          glob: "src/legacy/**",
          rule: null,
          reason: "x",
          expires: "2026-04-01",
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
        {
          id: "ign-bbbb02",
          glob: "src/active/**",
          rule: null,
          reason: "y",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList(
      { cwd: "/repo", expired: true },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.status).toBe("expired");
    expect(r.exitCode).toBe(EXIT_CODES.RECOVERABLE_ERROR);
  });

  it("exits 0 with --expired when no entries are expired", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-bbbb02",
          glob: "src/active/**",
          rule: null,
          reason: "y",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList(
      { cwd: "/repo", expired: true },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
    expect(r.exitCode).toBe(EXIT_CODES.OK);
  });
});

describe("ignoreList — --path", () => {
  it("filters by literal glob equality", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-aaaa01",
          glob: "src/legacy/**",
          rule: null,
          reason: "x",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
        {
          id: "ign-bbbb02",
          glob: "src/other/**",
          rule: null,
          reason: "y",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList(
      { cwd: "/repo", path: "src/legacy/**" },
      { safeIO: fs.io, now: () => NOW },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.glob).toBe("src/legacy/**");
  });
});

describe("ignoreList — manifest corrupt", () => {
  it("returns INTERNAL_ERROR when manifest is malformed JSON", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: "{not json",
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_corrupt");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });

  it("returns INTERNAL_ERROR when manifest version is unsupported", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: JSON.stringify({
        version: 99,
        entries: [],
      }),
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("manifest_unsupported_version");
    expect(r.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
  });
});

describe("ignoreList — ordering", () => {
  it("sorts entries by id ascending", () => {
    const fs = makeFs({
      [`/repo/${IGNORE_MANIFEST_PATH}`]: manifest([
        {
          id: "ign-zzzz99",
          glob: "z/**",
          rule: null,
          reason: "z",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
        {
          id: "ign-aaaa01",
          glob: "a/**",
          rule: null,
          reason: "a",
          expires: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          createdBy: "user",
        },
      ]),
    });
    const r = ignoreList({ cwd: "/repo" }, { safeIO: fs.io, now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.id)).toEqual(["ign-aaaa01", "ign-zzzz99"]);
  });
});
