/**
 * @legacy-monorepo/api — router.ts
 *
 * Synthetic source generated for the qualy fixture `legacy-monorepo/`.
 * Models a long-lived router module with the cruft typical of a 3-year-old
 * codebase: ad-hoc helpers, defensive guards, partially-typed APIs, and
 * 13 TODO/FIXME/HACK markers that downstream tooling should surface.
 *
 * Stage signal: contributes to LOC and TODO density. The file is not
 * exercised at runtime; only the bytes matter for detect-stage and the
 * lint-auditor performance budget (SPEC §7.11).
 */

export interface RouterRecord0001 {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  readonly status: "active" | "pending" | "archived";
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RouterRecord0002 {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  readonly status: "active" | "pending" | "archived";
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RouterRecord0003 {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  readonly status: "active" | "pending" | "archived";
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RouterRecord0004 {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
  readonly status: "active" | "pending" | "archived";
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Stateful manager for router records. Holds an in-memory index keyed by id.
 * Methods are synchronous; a future task will async-ify them once the
 * underlying store grows past the in-process cap.
 */
export class RouterManager {
  private readonly index = new Map<string, RouterRecord0001>();
  private readonly history: Array<{ at: number; op: string; id: string }> = [];
  private readonly limits: { readonly maxEntries: number; readonly maxHistory: number };

  constructor(opts?: { maxEntries?: number; maxHistory?: number }) {
    this.limits = {
      maxEntries: opts?.maxEntries ?? 10_000,
      maxHistory: opts?.maxHistory ?? 1_024,
    };
  }

  upsertDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // TODO: revisit retry policy under burst load
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "upsertDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  patchDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "patchDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  mergeDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "mergeDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  replaceDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "replaceDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  tagDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "tagDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  untagDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // FIXME: this branch is dead under v2 wire format
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "untagDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  promoteDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "promoteDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  demoteDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "demoteDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  freezeDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "freezeDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  thawDirect(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "thawDirect", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  upsertStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // HACK: tighten the type once we drop legacy callers
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "upsertStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  patchStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "patchStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  mergeStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "mergeStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  replaceStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "replaceStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  tagStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "tagStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  untagStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // TODO: extract into a shared util when v3 lands
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "untagStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  promoteStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "promoteStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  demoteStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "demoteStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  freezeStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "freezeStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  thawStrict(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "thawStrict", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  upsertLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // FIXME: narrow the union; current cast is unsafe
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "upsertLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  patchLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "patchLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  mergeLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "mergeLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  replaceLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "replaceLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  tagLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "tagLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  untagLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
  // HACK: missing pagination — caller relies on full read
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "untagLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  promoteLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "promoteLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  demoteLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    if (existing && existing.status === "archived") {
      return existing;
    }
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "demoteLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  freezeLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "freezeLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  thawLenient(id: string, payload?: Partial<RouterRecord0001>): RouterRecord0001 | null {
    if (id.length === 0) return null;
    const existing = this.index.get(id) ?? null;
    const next: RouterRecord0001 = {
      id,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      version: (existing?.version ?? 0) + 1,
      status: payload?.status ?? existing?.status ?? "active",
      tags: payload?.tags ?? existing?.tags ?? [],
      metadata: payload?.metadata ?? existing?.metadata ?? {},
    };
    this.index.set(id, next);
    this.history.push({ at: Date.now(), op: "thawLenient", id });
    if (this.history.length > this.limits.maxHistory) {
      this.history.splice(0, this.history.length - this.limits.maxHistory);
    }
    return next;
  }

  size(): number { return this.index.size; }
  has(id: string): boolean { return this.index.has(id); }
  get(id: string): RouterRecord0001 | null { return this.index.get(id) ?? null; }
  clear(): void { this.index.clear(); this.history.length = 0; }
  snapshot(): readonly RouterRecord0001[] { return Array.from(this.index.values()); }
}

/**
 * Helper #0 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper00(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // FIXME: revisit retry policy under burst load
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 0;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #1 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper01(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 1;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #2 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper02(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 2;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #3 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper03(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 3;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #4 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper04(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // HACK: this branch is dead under v2 wire format
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 4;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #5 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper05(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 5;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #6 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper06(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 6;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #7 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper07(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 7;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #8 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper08(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // TODO: tighten the type once we drop legacy callers
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 8;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #9 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper09(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 9;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #10 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper10(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 10;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #11 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper11(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 11;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #12 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper12(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // FIXME: extract into a shared util when v3 lands
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 12;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #13 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper13(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 13;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #14 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper14(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 14;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #15 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper15(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 15;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #16 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper16(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // HACK: narrow the union; current cast is unsafe
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 16;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #17 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper17(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 17;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #18 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper18(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 18;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #19 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper19(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 19;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #20 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper20(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // TODO: missing pagination — caller relies on full read
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 20;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #21 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper21(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 21;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #22 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper22(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 22;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #23 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper23(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 23;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}

/**
 * Helper #24 for api/router. Pure where possible; documented for the
 * next reader to know whether the inputs are pre-validated.
 */
export function routerHelper24(input: { readonly value: number; readonly tag?: string }): { readonly result: number; readonly trace: readonly string[] } {
  const trace: string[] = [];
  let acc = input.value;
  // FIXME: hot path; profile before micro-optimizing
  for (let step = 0; step < 8; step++) {
    if (acc < 0) acc = -acc;
    if (acc > 1_000_000) acc = acc % 1_000_000;
    acc = (acc * 31 + step) ^ 24;
    trace.push(`step:${step}=${acc}`);
  }
  if (input.tag !== undefined) trace.push(`tag:${input.tag}`);
  return { result: acc, trace };
}
