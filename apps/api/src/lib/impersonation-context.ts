/**
 * Who is impersonating, for the rest of the request (BE:S-2, Ruling FP-3).
 *
 * `authenticate` enters this scope when the access token carries `impersonatedBy` (a support session minted by
 * POST /admin/impersonate). `auditLog` reads it, so EVERY audit row written during an impersonated request names the acting
 * super_admin in `details.impersonatedBy` without each of the ~200 call sites having to pass it. A caller that already sets
 * `details.impersonatedBy` keeps its value.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ impersonatedBy: string }>();

/** Called by `authenticate` after the token is accepted. Applies to the remainder of the request's async chain. */
export function enterImpersonation(impersonatedBy: string): void {
  store.enterWith({ impersonatedBy });
}

export function currentImpersonator(): string | undefined {
  return store.getStore()?.impersonatedBy;
}

/** Test seam: run `fn` inside an impersonated scope. */
export function runAsImpersonator<T>(impersonatedBy: string, fn: () => T): T {
  return store.run({ impersonatedBy }, fn);
}
