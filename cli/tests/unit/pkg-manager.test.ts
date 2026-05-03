import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectPackageManager,
  type ExistsFn,
  setExistsFn,
} from "../../src/lib/pkg-manager.ts";

function makeExists(present: readonly string[]): { fn: ExistsFn; calls: string[] } {
  const calls: string[] = [];
  const set = new Set(present);
  const fn: ExistsFn = (p) => {
    calls.push(p);
    return set.has(p);
  };
  return { fn, calls };
}

describe("detectPackageManager", () => {
  afterEach(() => {
    setExistsFn(null);
  });

  it("detecta bun via bun.lock (textual)", () => {
    const { fn } = makeExists([join("/repo", "bun.lock")]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "bun",
      source: "bun.lock",
    });
  });

  it("detecta bun via bun.lockb (binário)", () => {
    const { fn } = makeExists([join("/repo", "bun.lockb")]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "bun",
      source: "bun.lockb",
    });
  });

  it("prioriza bun.lock sobre bun.lockb quando ambos coexistem", () => {
    const { fn } = makeExists([
      join("/repo", "bun.lock"),
      join("/repo", "bun.lockb"),
    ]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo").source).toBe("bun.lock");
  });

  it("detecta pnpm via pnpm-lock.yaml", () => {
    const { fn } = makeExists([join("/repo", "pnpm-lock.yaml")]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "pnpm",
      source: "pnpm-lock.yaml",
    });
  });

  it("detecta yarn via yarn.lock", () => {
    const { fn } = makeExists([join("/repo", "yarn.lock")]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "yarn",
      source: "yarn.lock",
    });
  });

  it("detecta npm via package-lock.json", () => {
    const { fn } = makeExists([join("/repo", "package-lock.json")]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "npm",
      source: "package-lock.json",
    });
  });

  it("default = npm com source 'default' quando nenhum lockfile é encontrado", () => {
    const { fn } = makeExists([]);
    setExistsFn(fn);
    expect(detectPackageManager("/repo")).toEqual({
      manager: "npm",
      source: "default",
    });
  });

  it("prioriza bun > pnpm > yarn > npm quando múltiplos lockfiles coexistem", () => {
    const all = [
      join("/repo", "bun.lockb"),
      join("/repo", "pnpm-lock.yaml"),
      join("/repo", "yarn.lock"),
      join("/repo", "package-lock.json"),
    ];
    setExistsFn(makeExists(all).fn);
    expect(detectPackageManager("/repo").manager).toBe("bun");

    setExistsFn(makeExists(all.slice(1)).fn);
    expect(detectPackageManager("/repo").manager).toBe("pnpm");

    setExistsFn(makeExists(all.slice(2)).fn);
    expect(detectPackageManager("/repo").manager).toBe("yarn");

    setExistsFn(makeExists(all.slice(3)).fn);
    expect(detectPackageManager("/repo").manager).toBe("npm");
  });

  it("para ao primeiro hit (curto-circuito)", () => {
    const { fn, calls } = makeExists([join("/repo", "bun.lock")]);
    setExistsFn(fn);
    detectPackageManager("/repo");
    expect(calls).toEqual([join("/repo", "bun.lock")]);
  });

  it("checa lockfiles relativos ao cwd passado", () => {
    const { fn, calls } = makeExists([]);
    setExistsFn(fn);
    detectPackageManager("/some/other/dir");
    expect(calls.every((c) => c.startsWith("/some/other/dir/"))).toBe(true);
  });

  it("setExistsFn(null) restaura o runner real (smoke: este repo tem package-lock.json)", () => {
    setExistsFn(null);
    const res = detectPackageManager(process.cwd());
    expect(res.manager).toBe("npm");
    expect(res.source).toBe("package-lock.json");
  });
});
