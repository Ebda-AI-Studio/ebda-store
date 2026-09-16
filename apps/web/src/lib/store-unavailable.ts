/**
 * The "I could not reach the API" signal, kept in its own module so BOTH the
 * server resolver and the CLIENT error boundary can read it.
 *
 * `app/error.tsx` is a `'use client'` component. Importing this constant from
 * `store-resolver.ts` instead would drag `next/headers` into the client bundle
 * and fail the build, so the shared half lives here and the resolver
 * re-exports it for server callers.
 */

/**
 * Marker copied onto `error.digest`.
 *
 * Next respects a digest that is already set on a thrown server error
 * (`next/dist/server/app-render/create-error-handler.js`: "If the error
 * already has a digest, respect the original digest") and forwards it to the
 * client error boundary — while replacing the error MESSAGE with a generic
 * string in production. So this is the one channel that can tell `error.tsx`
 * "show retry copy" without leaking anything internal to a shopper.
 */
export const STORE_UNAVAILABLE_DIGEST = 'STORE_TEMPORARILY_UNAVAILABLE';

/**
 * Thrown when the store could not be resolved for a reason that is NOT
 * "this store does not exist": a 429 from `storeResolveLimiter`, a 5xx, a
 * dropped connection, or a body that would not parse.
 *
 * It must never be converted into `notFound()`. A 404 tells the shopper the
 * shop is gone and tells Google to drop the URL; neither is true of a
 * request that simply has to be retried.
 */
export class StoreTemporarilyUnavailableError extends Error {
  readonly digest = STORE_UNAVAILABLE_DIGEST;

  constructor(reason: string) {
    super(`store resolution temporarily unavailable: ${reason}`);
    this.name = 'StoreTemporarilyUnavailableError';
  }
}
