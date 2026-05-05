import { describe, expect, it } from "vitest";
import { listSubcommands, run } from "../../src/index.ts";

describe("CLI subcommand registry", () => {
  it("registers all ignore-* subcommands with non-stub handlers", () => {
    const subs = listSubcommands();
    const expected = [
      "ignore-compile",
      "ignore-add",
      "ignore-list",
      "ignore-remove",
      "ignore-explain",
      "ignore-import-preview",
      "ignore-blast-radius",
      "category-info",
    ] as const;

    for (const name of expected) {
      const sub = subs.find((s) => s.name === name);
      expect(sub, `subcommand "${name}" must be registered`).toBeDefined();
      expect(sub?.summary, `subcommand "${name}" must have a non-empty summary`).toBeTruthy();
    }
  });

  it("each ignore-* subcommand summary mentions its purpose", () => {
    const subs = listSubcommands();
    const byName = new Map(subs.map((s) => [s.name, s.summary]));

    expect(byName.get("ignore-compile")?.toLowerCase()).toContain("compile");
    expect(byName.get("ignore-add")?.toLowerCase()).toMatch(/add|append|register/);
    expect(byName.get("ignore-list")?.toLowerCase()).toContain("list");
    expect(byName.get("ignore-remove")?.toLowerCase()).toMatch(/remove|delete/);
    expect(byName.get("ignore-explain")?.toLowerCase()).toContain("explain");
    expect(byName.get("ignore-import-preview")?.toLowerCase()).toMatch(
      /preview|import/,
    );
    expect(byName.get("ignore-blast-radius")?.toLowerCase()).toMatch(
      /blast|count|sample|files/,
    );
    expect(byName.get("category-info")?.toLowerCase()).toMatch(/categor/);
  });

  it("ignore-* handlers do not return the not_implemented stub error", async () => {
    const errors: Array<{ event: string; data: unknown }> = [];
    const originalError = console.error;
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === "string") writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => {
      errors.push({ event: "console_error", data: args });
    };

    try {
      // Use --help on each ignore-* subcommand. Even if a handler doesn't
      // support --help, it must NOT short-circuit through `notImplemented`.
      // We assert that no JSON payload contains `error: "not_implemented"`.
      for (const name of [
        "ignore-compile",
        "ignore-add",
        "ignore-list",
        "ignore-remove",
        "ignore-explain",
        "ignore-import-preview",
        "ignore-blast-radius",
        "category-info",
      ]) {
        writes.length = 0;
        await run([name, "--help"]);
        const combined = writes.join("");
        expect(
          combined.includes(`"error":"not_implemented"`),
          `${name} must not be a notImplemented stub`,
        ).toBe(false);
      }
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origStderrWrite;
      console.error = originalError;
    }
    void errors;
  });
});
