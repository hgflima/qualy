/**
 * @legacy-monorepo/auth barrel.
 *
 * Re-exports the public surface of the auth package. Kept narrow so that
 * downstream packages don't reach into internal modules; everything that
 * leaves this package leaves through this file.
 */

export * from "./jwt.ts";
export * from "./session.ts";
export * from "./permissions.ts";
