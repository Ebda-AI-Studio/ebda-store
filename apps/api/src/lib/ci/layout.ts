/** R2 `ebda-ci` key layout (docs/plans/2026-10-28-customer-intelligence.md 1.6). Dependency-free. */
export const ciBuyerIndexKey = (buyerKey: string) =>
  `index/buyer/${buyerKey.slice(0, 2)}/${buyerKey}.json`;
export const ciPartitionPrefix = (storeId: string, day: string) =>
  `outcomes/v1/store=${storeId}/dt=${day}/`;
/** Erasure tombstones (expire after CI_TOMBSTONE_DAYS): an in-flight event for these is dropped/de-keyed. */
export const ciOrderTombstoneKey = (orderId: string) => `tombstone/order/${orderId}`;
export const ciBuyerTombstoneKey = (buyerKey: string) => `tombstone/buyer/${buyerKey}`;
/** Retry (<1 h) + a manual DLQ replay window, with margin. */
export const CI_TOMBSTONE_DAYS = 30;
