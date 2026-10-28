/**
 * Parent / child store billing (R-EBDA-PRICING-6, Ruling EBDA-FUNNEL-13/-18).
 *
 * One owner, several stores. The OLDEST live store is the billing PARENT: its plan decides
 * how many stores the owner may run, and it is the ONLY store that is ever charged. Every
 * other store is a CHILD: it is included in the parent's plan, so nothing is billed on it
 * (a child keeps its own subscription row only to carry entitlements).
 *
 * This file is PURE (rows in, verdict out) on purpose. It reads only platform data - the
 * `stores` directory columns (owner, created order, status) and `store_subscriptions` - so it
 * behaves the same on Postgres and on the Cloudflare path where those tables live in D1
 * (store-on-cloudflare plan 2.6; no StoreDO row is needed).
 *
 * Fail closed: a missing parent, an unreadable subscription, or an unknown child answers
 * "not covered" / "not billable here" - never "covered" by default.
 */
export interface OwnerStoreRow {
  id: string;
  createdAt: Date;
}

/** Owner's stores, oldest first; ties broken by id so the order is total and stable. */
export function sortOwnerStores<T extends OwnerStoreRow>(stores: readonly T[]): T[] {
  return [...stores].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The billing parent: the oldest store, or null when the owner has none. */
export function billingParentOf(stores: readonly OwnerStoreRow[]): string | null {
  return sortOwnerStores(stores)[0]?.id ?? null;
}

/**
 * Is `storeId` billed on its own? True ONLY for the parent. A store that is not in the
 * owner's list (deleted, foreign, unknown) is NOT billable here: fail closed.
 */
export function isBillableStore(storeId: string, stores: readonly OwnerStoreRow[]): boolean {
  return billingParentOf(stores) === storeId;
}

export type ChildCoverage =
  | { covered: true; parentId: string }
  | {
      covered: false;
      reason: 'not_a_child' | 'no_parent' | 'over_allowance' | 'parent_not_in_good_standing';
    };

/**
 * Is this child store paid for by its parent right now? All of:
 *  - it really is a child (not the parent);
 *  - it is within the owner's allowance (the parent's plan `maxStores`; Infinity = unlimited);
 *  - the parent's own subscription is in good standing (`parentInGoodStanding`).
 */
export function childCoverage(args: {
  storeId: string;
  stores: readonly OwnerStoreRow[];
  allowance: number;
  /**
   * The parent's own go-live verdict (`goLiveVerdict(parentSub, ...).ok`: granted, an
   * unexpired trial with a payment route, or paid-active). Passed in rather than computed
   * here so this file stays dependency-free (go-live-gate imports the account service).
   */
  parentInGoodStanding: boolean;
}): ChildCoverage {
  const ordered = sortOwnerStores(args.stores);
  const parentId = ordered[0]?.id ?? null;
  if (!parentId) return { covered: false, reason: 'no_parent' };
  if (parentId === args.storeId) return { covered: false, reason: 'not_a_child' };
  const rank = ordered.findIndex(s => s.id === args.storeId);
  if (rank < 0 || !(rank < args.allowance)) return { covered: false, reason: 'over_allowance' };
  if (!args.parentInGoodStanding) {
    return { covered: false, reason: 'parent_not_in_good_standing' };
  }
  return { covered: true, parentId };
}
