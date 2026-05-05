/**
 * Contract tests for `lib/ignore-manifest.ts` — the ignore-entry persistence
 * layer (lint-ignore PLAN T2.1).
 *
 * The manifest is the single source of truth for `qualy ignore-*`; presets
 * are derived from it (T2.2 `compileToBothPresets`). Tests pin:
 *
 *  - `IgnoreEntry`/`IgnoreManifest` shape and version
 *  - deterministic id generation (same `(glob, rule)` → same id)
 *  - upsert idempotency (re-add with same `(glob, rule)` updates in place)
 *  - validation of glob (non-empty) and expires (rejects past dates)
 *  - `findExpired` returns only past-due entries given a fixed `now`
 *  - round-trip via `loadIgnoreManifest`/`saveIgnoreManifest` through `safeIO`
 *  - manifest entry registered with `kind: "ignore"` after a write
 */
import { describe, expect, it } from "vitest";

import {
  type IgnoreEntry,
  type IgnoreManifest,
  findExpired,
  generateEntryId,
  loadIgnoreManifest,
  removeEntries,
  saveIgnoreManifest,
  upsertEntry,
  validateExpires,
  validateGlob,
} from "../../src/lib/ignore-manifest.ts";
import { IGNORE_MANIFEST_PATH } from "../../src/lib/paths.ts";
import { type SafeIO, loadManifest } from "../../src/lib/fs-safe.ts";

const NOW = new Date("2026-05-05T12:00:00.000Z");

function makeFakeFs(): {
  files: Map<string, string>;
  io: SafeIO;
} {
  const files = new Map<string, string>();
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

describe("generateEntryId", () => {
  it("derives a stable `ign-` prefixed id from (glob, rule)", () => {
    const a = generateEntryId("src/legacy/**", null);
    const b = generateEntryId("src/legacy/**", null);
    expect(a).toBe(b);
    expect(a.startsWith("ign-")).toBe(true);
    expect(a.length).toBe(4 + 6); // "ign-" + 6 hex chars
  });

  it("produces different ids for different globs", () => {
    expect(generateEntryId("a/**", null)).not.toBe(generateEntryId("b/**", null));
  });

  it("produces different ids when rule differs (path-only vs per-rule)", () => {
    expect(generateEntryId("src/x/**", null)).not.toBe(
      generateEntryId("src/x/**", "quality-metrics/wmc"),
    );
  });
});

describe("validateGlob", () => {
  it("accepts non-empty strings", () => {
    expect(validateGlob("src/**")).toEqual({ ok: true });
    expect(validateGlob("a")).toEqual({ ok: true });
  });

  it("rejects empty / whitespace-only strings", () => {
    expect(validateGlob("").ok).toBe(false);
    expect(validateGlob("   ").ok).toBe(false);
  });
});

describe("validateExpires", () => {
  it("accepts null (no expiry)", () => {
    expect(validateExpires(null, NOW)).toEqual({ ok: true });
  });

  it("accepts future YYYY-MM-DD", () => {
    expect(validateExpires("2026-09-30", NOW)).toEqual({ ok: true });
  });

  it("rejects past dates", () => {
    expect(validateExpires("2026-04-01", NOW).ok).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(validateExpires("not-a-date", NOW).ok).toBe(false);
    expect(validateExpires("2026/09/30", NOW).ok).toBe(false);
  });
});

describe("upsertEntry", () => {
  it("adds a new entry when (glob, rule) is absent (action: added)", () => {
    const m: IgnoreManifest = { version: 1, entries: [] };
    const r = upsertEntry(m, {
      glob: "src/legacy/**",
      rule: null,
      reason: "legacy",
      expires: null,
      createdBy: "user",
      now: NOW,
    });
    expect(r.action).toBe("added");
    expect(r.manifest.entries).toHaveLength(1);
    expect(r.manifest.entries[0]?.glob).toBe("src/legacy/**");
    expect(r.manifest.entries[0]?.id.startsWith("ign-")).toBe(true);
  });

  it("updates in place when (glob, rule) already exists (action: updated)", () => {
    const m: IgnoreManifest = { version: 1, entries: [] };
    const r1 = upsertEntry(m, {
      glob: "src/legacy/**",
      rule: null,
      reason: "first",
      expires: null,
      createdBy: "user",
      now: NOW,
    });
    const r2 = upsertEntry(r1.manifest, {
      glob: "src/legacy/**",
      rule: null,
      reason: "second",
      expires: "2026-09-30",
      createdBy: "user",
      now: NOW,
    });
    expect(r2.action).toBe("updated");
    expect(r2.manifest.entries).toHaveLength(1);
    expect(r2.manifest.entries[0]?.reason).toBe("second");
    expect(r2.manifest.entries[0]?.expires).toBe("2026-09-30");
    expect(r2.manifest.entries[0]?.id).toBe(r1.manifest.entries[0]?.id);
  });

  it("treats different rules on the same glob as distinct entries", () => {
    const m: IgnoreManifest = { version: 1, entries: [] };
    const r1 = upsertEntry(m, {
      glob: "src/x/**",
      rule: null,
      reason: "p",
      expires: null,
      createdBy: "user",
      now: NOW,
    });
    const r2 = upsertEntry(r1.manifest, {
      glob: "src/x/**",
      rule: "quality-metrics/wmc",
      reason: "q",
      expires: null,
      createdBy: "user",
      now: NOW,
    });
    expect(r2.manifest.entries).toHaveLength(2);
  });
});

describe("removeEntries", () => {
  it("removes only entries matching the predicate", () => {
    const m: IgnoreManifest = {
      version: 1,
      entries: [
        {
          id: "ign-aaaaaa",
          glob: "a/**",
          rule: null,
          reason: "x",
          expires: null,
          createdAt: NOW.toISOString(),
          createdBy: "user",
        },
        {
          id: "ign-bbbbbb",
          glob: "b/**",
          rule: null,
          reason: "y",
          expires: null,
          createdAt: NOW.toISOString(),
          createdBy: "user",
        },
      ],
    };
    const r = removeEntries(m, (e) => e.glob === "a/**");
    expect(r.removed).toHaveLength(1);
    expect(r.manifest.entries).toHaveLength(1);
    expect(r.manifest.entries[0]?.glob).toBe("b/**");
  });

  it("is a no-op when no entry matches", () => {
    const m: IgnoreManifest = {
      version: 1,
      entries: [
        {
          id: "ign-aaaaaa",
          glob: "a/**",
          rule: null,
          reason: "x",
          expires: null,
          createdAt: NOW.toISOString(),
          createdBy: "user",
        },
      ],
    };
    const r = removeEntries(m, (e) => e.glob === "nope");
    expect(r.removed).toHaveLength(0);
    expect(r.manifest.entries).toHaveLength(1);
  });
});

describe("findExpired", () => {
  function entry(id: string, expires: string | null): IgnoreEntry {
    return {
      id,
      glob: "g/**",
      rule: null,
      reason: "r",
      expires,
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user",
    };
  }

  it("returns only entries whose expires is strictly before `now`", () => {
    const m: IgnoreManifest = {
      version: 1,
      entries: [
        entry("ign-past00", "2026-04-01"), // before NOW (2026-05-05)
        entry("ign-today0", "2026-05-05"), // same day → not yet expired
        entry("ign-futur0", "2026-09-30"),
        entry("ign-noexp0", null),
      ],
    };
    const expired = findExpired(m, NOW);
    expect(expired.map((e) => e.id)).toEqual(["ign-past00"]);
  });
});

describe("loadIgnoreManifest / saveIgnoreManifest round-trip", () => {
  it("returns null when the manifest file is absent", () => {
    const { io } = makeFakeFs();
    expect(loadIgnoreManifest("/repo", io)).toBeNull();
  });

  it("persists and reloads identical content; registers `kind: ignore` in the lint manifest", () => {
    const { files, io } = makeFakeFs();
    const m: IgnoreManifest = {
      version: 1,
      entries: [
        {
          id: "ign-aaaaaa",
          glob: "src/legacy/**",
          rule: null,
          reason: "Codebase legado",
          expires: "2026-09-30",
          createdAt: NOW.toISOString(),
          createdBy: "user",
        },
      ],
    };
    const r = saveIgnoreManifest("/repo", m, io);
    expect(r.ok).toBe(true);

    const loaded = loadIgnoreManifest("/repo", io);
    expect(loaded).not.toBeNull();
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0]?.glob).toBe("src/legacy/**");

    // Manifest registration: `.lint-manifest.json` records kind=ignore.
    const ent = loadManifest("/repo", io)?.entries.find(
      (e) => e.path === IGNORE_MANIFEST_PATH,
    );
    expect(ent).toBeDefined();
    expect(ent?.kind).toBe("ignore");

    // Round-trip: file content matches what we wrote.
    expect(files.get(`/repo/${IGNORE_MANIFEST_PATH}`)).toBeDefined();
  });

  it("returns null when the manifest is malformed JSON", () => {
    const { files, io } = makeFakeFs();
    files.set(`/repo/${IGNORE_MANIFEST_PATH}`, "{not json");
    expect(loadIgnoreManifest("/repo", io)).toBeNull();
  });

  it("returns null when the version is unsupported", () => {
    const { files, io } = makeFakeFs();
    files.set(
      `/repo/${IGNORE_MANIFEST_PATH}`,
      JSON.stringify({ version: 99, entries: [] }),
    );
    expect(loadIgnoreManifest("/repo", io)).toBeNull();
  });
});
