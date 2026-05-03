/**
 * @legacy-monorepo/api barrel.
 *
 * Re-exports the public surface of the api package. Kept narrow so that
 * downstream packages don't reach into internal modules; everything that
 * leaves this package leaves through this file.
 */

export * from "./router.ts";
export * from "./handlers.ts";
export * from "./middleware.ts";
