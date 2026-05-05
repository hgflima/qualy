/**
 * File under the expired ignore glob `src/legacy/**`. The exclusion is still
 * load-bearing (`debugger;` would otherwise trip `correctness/no-debugger`)
 * but its `expires` is in the past — `qualy audit` must surface a warning
 * via stderr (`logger.warn("ignore_expired", …)`) and `AuditOk.ignore_warnings[]`.
 */
export function legacyEntry(value: number): number {
  debugger;
  return value;
}
