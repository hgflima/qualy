/**
 * User-facing recoverable failure from the harness installer.
 *
 * Subcommand handlers (`runHarnessInstall`, `runHarnessUninstall`,
 * `runHarnessUpdate`) catch this and exit with `RECOVERABLE_ERROR` (1),
 * printing only `error.message` to stderr — no stack trace. Anything else
 * thrown is treated as `INTERNAL_ERROR` (70).
 */
export class RecoverableError extends Error {
  readonly recoverable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "RecoverableError";
  }
}
