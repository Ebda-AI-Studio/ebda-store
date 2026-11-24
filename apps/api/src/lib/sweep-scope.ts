/**
 * Invocation scope for store-looping work (Sentry N+1 class: `SELECT storage_backend FROM stores WHERE id = ?`,
 * `store_features` / `store_subscriptions` per store, `system_settings WHERE key IN (...)` repeated, in the 15-min, 30-min and
 * hourly crons, the `ebda-jobs` consumer and the admin list-stores path).
 *
 * One scope = ONE cron job run or ONE queue message (never shared between invocations or isolates). Inside it:
 *   - `backendFor` reads the whole store directory once as soon as a SECOND distinct store is asked about (a sweep), instead of
 *     one D1 read per store (lib/store-backend.ts);
 *   - `sweepMemo` answers a repeated read from the first result.
 *
 * STALENESS CLASS: BOUNDED-stale, window = the invocation (a cron job run / one queue message, seconds to a few minutes) or the
 * entry's own `ttlMs` when the caller passes one. A flip of a store's backend, a plan change or a freeze marker that lands mid-run
 * takes effect on the NEXT invocation. Only a successful load is kept (a failed load is dropped so the next caller asks again).
 * Request paths never open a scope (they keep the live per-request memo, lib/request-memo.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { runWithRequestMemo } from './request-memo';

export interface SweepScope {
  memo: Map<string, { p: Promise<unknown>; at: number }>;
  /** First store `backendFor` was asked about in this scope; a second DISTINCT one means the run is a sweep. */
  firstStore?: string;
  /** storeId -> raw `storage_backend` of the whole directory; `null` = the read failed (run unbatched). */
  directory?: Promise<Map<string, unknown> | null>;
}

const als = new AsyncLocalStorage<SweepScope>();

/** Run `fn` inside a sweep scope (re-entrant: an outer scope wins). */
export function withSweepScope<T>(fn: () => T): T {
  if (als.getStore()) return fn();
  // The per-request memo opens too, so a repeated per-store `backendFor` in one run is one read (same staleness window).
  return als.run({ memo: new Map() }, () => runWithRequestMemo(fn));
}

export const currentSweepScope = (): SweepScope | undefined => als.getStore();

/** `load()` once per scope per `key` (optionally re-read after `ttlMs`); outside a scope it just calls `load()`. */
export function sweepMemo<T>(key: string, load: () => Promise<T>, ttlMs = Infinity): Promise<T> {
  const scope = als.getStore();
  if (!scope) return load();
  const hit = scope.memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const entry = { p: load(), at: Date.now() };
  scope.memo.set(key, entry);
  entry.p.catch(() => {
    if (scope.memo.get(key) === entry) scope.memo.delete(key);
  });
  return entry.p;
}

/** Forget a memoised key (a write in the same scope changed what it answers). */
export function forgetSweepMemo(key: string): void {
  als.getStore()?.memo.delete(key);
}

/** Put an already-read value in the scope's memo (a batched read that answers many later per-store calls). No-op outside a scope. */
export function seedSweepMemo<T>(key: string, value: T): void {
  const scope = als.getStore();
  if (scope && !scope.memo.has(key))
    scope.memo.set(key, { p: Promise.resolve(value), at: Date.now() });
}
