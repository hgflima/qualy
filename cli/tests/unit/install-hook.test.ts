/**
 * Contract tests for `install-hook` (IMPLEMENTATION_PLAN.md Phase 2).
 *
 * What is locked:
 *   - `post-edit.sh` is copied byte-for-byte from the bundled template to
 *     `<cwd>/.claude/hooks/post-edit.sh` and recorded with kind="hook".
 *   - `.claude/settings.json` is merged in three modes: created (no prior
 *     file), updated (preserves user content + appends our entry), unchanged
 *     (entry already references post-edit.sh — no rewrite).
 *   - Manifest entry for settings.json carries `merged: true` so uninstall
 *     does not delete a file the user owns.
 *   - Malformed settings.json aborts with `settings_malformed` (no overwrite).
 *   - `--strict` propagates to safeWriteFile.
 *   - Argument parser rejects malformed input with USAGE_ERROR.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installHook,
  mergeSettings,
  parseInstallHookArgs,
} from "../../src/commands/install/hook.ts";
import {
  type Manifest,
  MANIFEST_FILENAME,
  type SafeIO,
} from "../../src/lib/fs-safe.ts";
import { parseDefensive } from "../../src/lib/json.ts";

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "templates",
  "post-edit.sh",
);

const ROOT = sep === "/" ? "/proj" : "C:\\proj";

function memoryIO(initial: Record<string, string> = {}): SafeIO & {
  files: Map<string, string>;
  fixedNow: Date;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const fixedNow = new Date("2026-05-03T12:00:00.000Z");
  return {
    files,
    fixedNow,
    existsFn: (p) => files.has(p),
    readFileFn: (p) => files.get(p) ?? null,
    writeFileFn: (p, c) => {
      files.set(p, c);
    },
    mkdirFn: () => {
      /* in-memory */
    },
    removeFn: (p) => {
      files.delete(p);
    },
    dirtyFilesFn: () => ({ ok: true, value: [] }),
    now: () => fixedNow,
  };
}

function loadManifestFromMemory(io: { files: Map<string, string> }): Manifest | null {
  const path = join(ROOT, MANIFEST_FILENAME);
  const raw = io.files.get(path);
  if (raw === undefined) return null;
  const parsed = parseDefensive<Manifest>(raw);
  return parsed.ok ? parsed.value : null;
}

const SCRIPT_ABS = join(ROOT, ".claude", "hooks", "post-edit.sh");
const SETTINGS_ABS = join(ROOT, ".claude", "settings.json");

describe("installHook — fresh project", () => {
  it("copies post-edit.sh byte-for-byte from the bundled template", () => {
    const io = memoryIO();
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const templateBytes = readFileSync(TEMPLATE_PATH, "utf8");
    expect(io.files.get(SCRIPT_ABS)).toBe(templateBytes);
    expect(r.script.bytes).toBe(Buffer.byteLength(templateBytes, "utf8"));
    expect(r.script.recorded).toBe(true);
  });

  it("creates a fresh settings.json with the PostToolUse entry", () => {
    const io = memoryIO();
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.action).toBe("created");
    const written = io.files.get(SETTINGS_ABS);
    expect(written).toBeDefined();
    if (!written) return;
    const parsed = parseDefensive<Record<string, unknown>>(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const hooks = (parsed.value["hooks"] ?? null) as { PostToolUse?: unknown[] } | null;
    expect(Array.isArray(hooks?.PostToolUse)).toBe(true);
    expect(hooks?.PostToolUse).toHaveLength(1);
    const entry = (hooks?.PostToolUse?.[0] ?? {}) as {
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    };
    expect(entry.matcher).toBe("Write|Edit|MultiEdit");
    expect(entry.hooks?.[0]?.type).toBe("command");
    expect(entry.hooks?.[0]?.command).toBe(".claude/hooks/post-edit.sh");
  });

  it("records script with kind=hook and settings with kind=settings, merged=true", () => {
    const io = memoryIO();
    installHook({ cwd: ROOT }, { safeIO: io });
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const byPath = new Map(m.entries.map((e) => [e.path, e]));
    const script = byPath.get(".claude/hooks/post-edit.sh");
    const settings = byPath.get(".claude/settings.json");
    expect(script?.kind).toBe("hook");
    expect(script?.merged).toBeUndefined();
    expect(settings?.kind).toBe("settings");
    expect(settings?.merged).toBe(true);
  });
});

describe("installHook — merge into existing settings.json", () => {
  it("appends our entry while preserving unrelated user content", () => {
    const existing = JSON.stringify({
      env: { FOO: "bar" },
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user-script.sh" }] },
        ],
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "init.sh" }] }],
      },
    });
    const io = memoryIO({ [SETTINGS_ABS]: existing });
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.action).toBe("updated");
    const written = io.files.get(SETTINGS_ABS);
    if (!written) return;
    const parsed = parseDefensive<{
      env?: Record<string, string>;
      hooks?: {
        PostToolUse?: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
        SessionStart?: unknown;
      };
    }>(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.env?.FOO).toBe("bar");
    expect(parsed.value.hooks?.SessionStart).toBeDefined();
    const post = parsed.value.hooks?.PostToolUse ?? [];
    expect(post).toHaveLength(2);
    expect(post[0]?.matcher).toBe("Bash");
    expect(post[0]?.hooks?.[0]?.command).toBe("user-script.sh");
    expect(post[1]?.matcher).toBe("Write|Edit|MultiEdit");
    expect(post[1]?.hooks?.[0]?.command).toBe(".claude/hooks/post-edit.sh");
  });

  it("is a no-op (action=unchanged) when the hook is already wired", () => {
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit|MultiEdit",
            hooks: [{ type: "command", command: ".claude/hooks/post-edit.sh" }],
          },
        ],
      },
    });
    const io = memoryIO({ [SETTINGS_ABS]: existing });
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.action).toBe("unchanged");
    expect(r.settings.recorded).toBe(false);
    // File bytes must not have been rewritten.
    expect(io.files.get(SETTINGS_ABS)).toBe(existing);
  });

  it("recognizes a different matcher that still references our script", () => {
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "./.claude/hooks/post-edit.sh" }],
          },
        ],
      },
    });
    const io = memoryIO({ [SETTINGS_ABS]: existing });
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.action).toBe("unchanged");
  });

  it("rejects malformed settings.json without overwriting", () => {
    const io = memoryIO({ [SETTINGS_ABS]: "{ this is not json" });
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("settings_malformed");
    // settings file untouched.
    expect(io.files.get(SETTINGS_ABS)).toBe("{ this is not json");
    // Script is written before the merge, so it lands; fine — uninstall cleans it up.
    // What we care about: no clobber of the existing settings.json.
  });

  it("rejects when settings.json holds a non-object root", () => {
    const io = memoryIO({ [SETTINGS_ABS]: "[]" });
    const r = installHook({ cwd: ROOT }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("settings_malformed");
  });
});

describe("installHook — error paths", () => {
  it("reports template_read_failed when the bundled template is missing", () => {
    const io = memoryIO();
    const r = installHook(
      { cwd: ROOT },
      {
        safeIO: io,
        readFileFn: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("template_read_failed");
    // No script and no settings should have been written.
    expect(io.files.has(SCRIPT_ABS)).toBe(false);
    expect(io.files.has(SETTINGS_ABS)).toBe(false);
  });

  it("reports write_failed with DIRTY_TREE-friendly reason on --strict + dirty", () => {
    const io: SafeIO & { files: Map<string, string> } = {
      ...memoryIO(),
      dirtyFilesFn: () => ({ ok: true, value: ["src/a.ts"] }),
    };
    const r = installHook({ cwd: ROOT, strict: true }, { safeIO: io });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("write_failed");
    expect(r.reason).toContain("working tree is dirty");
  });
});

describe("installHook — idempotency", () => {
  it("re-running yields a single manifest entry per path", () => {
    const io = memoryIO();
    installHook({ cwd: ROOT }, { safeIO: io });
    installHook({ cwd: ROOT }, { safeIO: io });
    const m = loadManifestFromMemory(io);
    expect(m).not.toBeNull();
    if (!m) return;
    const paths = m.entries.map((e) => e.path).sort();
    expect(paths).toEqual([".claude/hooks/post-edit.sh", ".claude/settings.json"]);
  });
});

describe("mergeSettings — pure function", () => {
  it("returns action=created when existing is null", () => {
    const r = mergeSettings(null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("created");
    expect(r.content).toContain("Write|Edit|MultiEdit");
    expect(r.content).toContain(".claude/hooks/post-edit.sh");
  });

  it("returns action=updated when other entries exist", () => {
    const r = mergeSettings(
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] }] },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");
  });

  it("returns action=unchanged when our script is already referenced", () => {
    const r = mergeSettings(
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit|MultiEdit",
              hooks: [{ type: "command", command: ".claude/hooks/post-edit.sh" }],
            },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("unchanged");
  });

  it("creates hooks.PostToolUse when hooks key is missing", () => {
    const r = mergeSettings(JSON.stringify({ env: { FOO: "bar" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("updated");
    const parsed = parseDefensive<{
      env?: Record<string, string>;
      hooks?: { PostToolUse?: unknown };
    }>(r.content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.env?.FOO).toBe("bar");
    expect(Array.isArray(parsed.value.hooks?.PostToolUse)).toBe(true);
  });

  it("returns ok:false on parse error", () => {
    const r = mergeSettings("not json");
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on array root", () => {
    const r = mergeSettings("[1,2,3]");
    expect(r.ok).toBe(false);
  });
});

describe("parseInstallHookArgs", () => {
  it("defaults to cwd=defaultCwd and strict=false", () => {
    const r = parseInstallHookArgs([], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/wd");
    expect(r.value.strict).toBe(false);
  });

  it("parses --cwd and --strict", () => {
    const r = parseInstallHookArgs(["--cwd", "/proj", "--strict"], "/wd");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/proj");
    expect(r.value.strict).toBe(true);
  });

  it("rejects missing --cwd value", () => {
    expect(parseInstallHookArgs(["--cwd"], "/wd").ok).toBe(false);
  });

  it("rejects unknown flag", () => {
    const r = parseInstallHookArgs(["--zonk"], "/wd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unknown flag");
  });

  it("returns help sentinel for --help / -h", () => {
    expect(parseInstallHookArgs(["--help"], "/wd")).toEqual({ ok: false, error: "help" });
    expect(parseInstallHookArgs(["-h"], "/wd")).toEqual({ ok: false, error: "help" });
  });
});
