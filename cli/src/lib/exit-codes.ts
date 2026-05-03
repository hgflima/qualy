/**
 * Semantic exit codes for the qualy CLI.
 *
 * Documented contract (PLAN.md §Princípios + §Contratos CLI). The harness
 * `.md` files map these codes to user-facing messages; tests assert specific
 * codes per scenario (SPEC §7). Numbers are stable — never reuse a retired
 * value.
 */

export const EXIT_CODES = {
  /** Success. */
  OK: 0,
  /** Recoverable error: invalid input, expected failure (e.g. audit found error-level violations). */
  RECOVERABLE_ERROR: 1,
  /** Target stack is not supported by oxc (Python, Go, Rust, …). */
  UNSUPPORTED_STACK: 2,
  /** Git working tree is dirty and the command requires a clean tree. */
  DIRTY_TREE: 3,
  /** CLI invoked with unknown subcommand or malformed flags. */
  USAGE_ERROR: 4,
  /** Required external tool (oxlint, oxfmt, quality-metrics, git) is missing. */
  MISSING_DEPENDENCY: 5,
  /** Unexpected internal failure (bug). */
  INTERNAL_ERROR: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ExitCodeName = keyof typeof EXIT_CODES;

export function exitCodeName(code: number): ExitCodeName | "UNKNOWN" {
  for (const [name, value] of Object.entries(EXIT_CODES)) {
    if (value === code) return name as ExitCodeName;
  }
  return "UNKNOWN";
}
