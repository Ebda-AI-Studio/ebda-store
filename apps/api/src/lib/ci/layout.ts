/** R2 `ebda-ci` key layout (docs/plans/2026-10-28-customer-intelligence.md 1.6). Dependency-free. */
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
