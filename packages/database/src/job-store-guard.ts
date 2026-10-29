// Sweeps must not walk the stores that live on their Durable Object (INFRA-CF-1 PR E, Ruling CF-JOBS-1).
//
// A background job runs inside `withHiddenStores({ hidden, onExcluded }, fn)` when at least one store is served by its
// StoreDO. Inside it `storeDirectory` and `acrossStores` DROP the hidden stores, so a sweep over "every store" cannot
// reach a store's Postgres rows (sealed, stale after the cutover) and write to them. The runner is told which stores
// were dropped, so it can alert. Outside the scope (every request, and every job while no store is on the DO) this
// module does nothing.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface HiddenStoresScope {
  /** Stores a sweep must not list. */
  hidden: ReadonlySet<string>;
  /** A sweep dropped these stores from its list (`via` = which helper). */
  onExcluded?: (storeIds: string[], via: string) => void;
}

const hiddenStorage = new AsyncLocalStorage<HiddenStoresScope>();

export function withHiddenStores<T>(scope: HiddenStoresScope, fn: () => T): T {
  if (scope.hidden.size === 0) return fn();
  return hiddenStorage.run(scope, fn);
}

/** Drops hidden stores from a list of store ids / directory entries, reporting what it dropped. */
export function dropHiddenStores<T>(items: T[], idOf: (t: T) => string, via: string): T[] {
  const g = hiddenStorage.getStore();
  if (!g) return items;
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const it of items) {
    if (g.hidden.has(idOf(it))) dropped.push(idOf(it));
    else kept.push(it);
  }
  if (dropped.length) g.onExcluded?.(dropped, via);
  return kept;
}
