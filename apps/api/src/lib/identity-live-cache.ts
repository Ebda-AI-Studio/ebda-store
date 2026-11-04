/**
 * Short-lived cache + single-flight for the account-state half of the LIVE identity check.
 *
 * Why it exists (BE:E-1, the admin stall): a dashboard fires 4-6 parallel writes/sensitive reads, each one used to ask the
 * identity service for the same account's state while holding a pooled DB client. One answer per account is enough for all of them.
 *
 * STALENESS CLASS: NEVER-stale (account suspension, role change). A TTL alone is NOT sufficient, so:
 *  - only a POSITIVE answer (account exists and is `active`) is cached; a suspended, inactive, unknown or failed answer is never
 *    stored, so the next request asks again;
 *  - every Store path that changes that state (`setAccountStatus`, `setAccountRole`, `revokeIdentityUser` in
 *    lib/identity-client.ts) calls {@link invalidateAccountState} on this isolate, in `finally`;
 *  - session REVOCATION is deliberately NOT cached here: `isRevoked` is asked on every live request (it is the logout path,
 *    and a logout made at the identity service never reaches this isolate);
 *  - RESIDUAL (Ruling FP-4, accepted): a suspension, role change or deletion made through another Worker isolate, or directly at
 *    the identity service, is seen after at most {@link LIVE_IDENTITY_TTL_MS} (30 s). Cost if wrong: a just-suspended merchant
 *    keeps acting for up to 30 s on an isolate that cached them as active.
 */
export const LIVE_IDENTITY_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

const cache = new Map<string, { exp: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * The cached positive account state for `userId`, else `load()` (one in-flight load per account, shared by every concurrent
 * caller). `isCacheable` decides whether the fresh answer may be stored.
 */
export async function accountStateCached<T>(
  userId: string,
  load: () => Promise<T>,
  isCacheable: (value: T) => boolean
): Promise<T> {
  const hit = cache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.value as T;
  if (hit) cache.delete(userId);
  const pending = inflight.get(userId);
  if (pending) return pending as Promise<T>;
  const self: { p?: Promise<T> } = {};
  const p = (self.p = (async () => {
    try {
      const value = await load();
      // Not cached when the account changed while the load was in flight (invalidateAccountState dropped this promise).
      if (isCacheable(value) && inflight.get(userId) === self.p) {
        if (cache.size >= MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(userId, { exp: Date.now() + LIVE_IDENTITY_TTL_MS, value });
      }
      return value;
    } finally {
      if (inflight.get(userId) === self.p) inflight.delete(userId);
    }
  })());
  inflight.set(userId, p);
  return p;
}

/** Drop the cached state of an account (call on suspend, role change, delete). */
export function invalidateAccountState(userId: string): void {
  cache.delete(userId);
  inflight.delete(userId);
}

/** Test seam: forget everything (called by the identity test seams). */
export function resetLiveIdentityCache(): void {
  cache.clear();
  inflight.clear();
}
