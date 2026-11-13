/** R2 `ebda-ci` key layout (docs/plans/done/2026-10-28-customer-intelligence.md 1.6). Dependency-free. */
export const ciBuyerIndexKey = (buyerKey: string) =>
  `index/buyer/${buyerKey.slice(0, 2)}/${buyerKey}.json`;
export const ciPartitionPrefix = (storeId: string, day: string) =>
  `outcomes/v1/store=${storeId}/dt=${day}/`;
/** Erasure tombstones (expire after CI_TOMBSTONE_DAYS): an in-flight event for these is dropped/de-keyed. */
export const ciOrderTombstoneKey = (orderId: string) => `tombstone/order/${orderId}`;
/** Per STORE and buyer: a proof of a phone holds for one store only (WA-CONSENT-1), never across stores. */
export const ciBuyerTombstoneKey = (storeId: string, buyerKey: string) =>
  `tombstone/buyer/${storeId}/${buyerKey}`;
export const ciDlqKey = (messageId: string) => `dlq/${messageId}.json`;
/** Parked dead letters expire after this (R2 lifecycle); strictly shorter than the tombstone TTL. */
export const CI_DLQ_DAYS = 14;
/** Retry (<1 h) + a manual DLQ replay window, with margin. */
export const CI_TOMBSTONE_DAYS = 30;
export const ciStorePartitionsPrefix = (storeId: string) => `outcomes/v1/store=${storeId}/`;

/** Days of margin below the first order's date for the prefix pass (clock skew, late events, Cairo vs UTC dates). */
export const CI_SINCE_MARGIN_DAYS = 2;

/**
 * Lower bound (UTC `YYYY-MM-DD`, the same clock and zone the sink partitions by: `utcDay(recordedAt)`) for
 * the erase's prefix pass: the earliest order date minus a safety margin. Undefined = no bound.
 */
export function ciSinceDay(orderDates: Date[]): string | undefined {
  if (orderDates.length === 0) return undefined;
  const min = Math.min(...orderDates.map(d => d.getTime()));
  return new Date(min - CI_SINCE_MARGIN_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// ---- CI-2 aggregates (Ruling CI-9): derived counters, never a buyer key or order id.
/** Days a window / cross-store cohort looks back. */
export const CI_AGG_WINDOW_DAYS = 90;
export const ciStoreAggPrefix = (storeId: string) => `aggregates/v1/store=${storeId}/`;
export const ciStoreDayAggKey = (storeId: string, day: string) =>
  `${ciStoreAggPrefix(storeId)}dt=${day}.json`;
export const ciStoreWindowKey = (storeId: string) => `${ciStoreAggPrefix(storeId)}window.json`;
export const ciMetricAggKey = (metric: string, day: string) =>
  `aggregates/v1/${metric}/dt=${day}.json`;
/** The cross-store cohort as of the last run (what the merchant features read). */
export const ciCohortLatestKey = 'aggregates/v1/xstore/latest.json';
