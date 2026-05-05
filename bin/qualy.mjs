#!/usr/bin/env node
/**
 * `qualy` shim — published as the npm package's `bin` entry.
 *
 * The runtime payload is plain TypeScript. We invoke it via the `tsx` loader
 * because Node refuses to strip types from files inside `node_modules/` by
 * design — once the package is installed, our entry point lives there. The
 * shim resolves `tsx/cli` through `createRequire` so it survives npm/pnpm/yarn
 * hoisting, and spawns it as a child so the loader stays scoped to that
 * process instead of leaking into the user's shell.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "src", "index.ts");
const tsxBin = createRequire(import.meta.url).resolve("tsx/cli");

const child = spawn(
  process.execPath,
  [tsxBin, entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
