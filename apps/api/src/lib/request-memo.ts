/**
 * Request-scoped memo (PERF-LATENCY, 2026-11-09). One HTTP request asked D1 for the same store's `storage_backend` up to three
 * times (tenant context, repo factory, store access) and read the same entitlement rows twice; on the deployed Worker each of
 * those is a serial round trip to the D1 primary.
 *
 * STALENESS CLASS: the memo lives for ONE request (an AsyncLocalStorage scope opened by the `serverTiming` middleware) and is
 * never shared between requests or isolates. A value is stored only when its load SUCCEEDED; a failed or refused load (a 404,
 * a 503) is dropped so the next caller in the same request asks again. Callers must only memoise reads whose answer the request
 * itself cannot change (each call site says why). Outside a request (queues, crons, DO alarms) `requestMemo` just calls `load`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export function runWithRequestMemo<T>(fn: () => T): T {
  return als.run(new Map(), fn);
}

/** The memoised answer for `key` in this request, else `load()` (concurrent callers share one in-flight load). */
export function requestMemo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = als.getStore();
  if (!memo) return load();
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const p = load();
  memo.set(key, p);
  p.catch(() => {
    if (memo.get(key) === p) memo.delete(key);
  });
  return p;
}

/** Seed `key` with a value this request already read (e.g. a directory row that also carried the backend flag). */
export function seedRequestMemo<T>(key: string, value: T): void {
  const memo = als.getStore();
  if (memo && !memo.has(key)) memo.set(key, Promise.resolve(value));
}

/** Forget `key` in this request (a write in the same request changed what it answers). */
export function forgetRequestMemo(key: string): void {
  als.getStore()?.delete(key);
}

/** Request-memo key of a store's raw `storage_backend` (`backendFor`, seeded by the directory lookup that read the same row). */
export const backendMemoKey = (storeId: string): string => `store-backend:${storeId}`;
