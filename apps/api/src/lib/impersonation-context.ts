/**
 * Who is impersonating, for the rest of the request (BE:S-2, Ruling FP-3).
 *
 * `authenticate` runs the rest of the request in this scope when the access token carries `impersonatedBy` (a support session minted by
 * POST /admin/impersonate). `auditLog` reads it, so EVERY audit row written during an impersonated request names the acting
 * super_admin in `details.impersonatedBy` without each of the ~200 call sites having to pass it. A caller that already sets
 * `details.impersonatedBy` keeps its value.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ impersonatedBy: string }>();

/**
 * Run `fn` (in practice `next()`) inside an impersonated scope. `authenticate` calls it as `runWithImpersonation(by, () => next())`,
 * so the whole downstream handler chain, including its async continuations, sees the impersonator.
 *
 * `AsyncLocalStorage.run`, NEVER `enterWith`: workerd (nodejs_compat) throws "enterWith() is not implemented", which
 * `authenticate`'s catch turned into 401 TOKEN_INVALID, so every impersonated request failed on Workers. Covered by
 * apps/api/workers-test/impersonation.test.ts, which runs the built Worker.
 */
export function runWithImpersonation<T>(impersonatedBy: string, fn: () => T): T {
  return store.run({ impersonatedBy }, fn);
}

export function currentImpersonator(): string | undefined {
  return store.getStore()?.impersonatedBy;
}
