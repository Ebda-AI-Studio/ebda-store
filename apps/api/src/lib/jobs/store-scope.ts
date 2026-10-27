/**
 * A per-store alarm run (cf/store-schedule.ts) starts the same function a cron would, with
 * `event.data = { alarm: true, storeId }`. The function then sweeps ONLY that store. Any other
 * event (the cron, a manual send) is unscoped, even if it happens to carry a `storeId`.
 */

export function alarmStoreId(event: { data?: unknown } | undefined): string | undefined {
  const d = event?.data as { alarm?: unknown; storeId?: unknown } | undefined;
  return d?.alarm === true && typeof d.storeId === 'string' && d.storeId ? d.storeId : undefined;
}

/** A `storeDirectory` predicate that also keeps only the alarm's store. */
export function storeFilter<S extends { id: string }>(
  event: { data?: unknown } | undefined,
  pred?: (s: S) => boolean
): (s: S) => boolean {
  const only = alarmStoreId(event);
  return s => (only === undefined || s.id === only) && (pred ? pred(s) : true);
}

/** `acrossStores` options that restrict the sweep to the alarm's store (empty for a cron run). */
export function acrossOpts(event: { data?: unknown } | undefined): { storeIds?: string[] } {
  const only = alarmStoreId(event);
  return only === undefined ? {} : { storeIds: [only] };
}
