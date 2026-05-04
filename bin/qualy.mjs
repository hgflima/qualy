#!/usr/bin/env node
/**
 * `qualy` shim — published as the npm package's `bin` entry.
 *
 * The runtime payload is plain TypeScript executed by Node 22.6+ via the
 * `--experimental-strip-types` flag. We keep the shim a `.mjs` so npm/npx
 * can run it without ceremony and so the flag stays scoped to the spawned
 * child instead of leaking into the user's shell.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "src", "index.ts");

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
