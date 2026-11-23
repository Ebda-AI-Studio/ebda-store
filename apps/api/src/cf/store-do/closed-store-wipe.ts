/**
 * The ONE physical wipe of a Durable Object's storage in the code base (Ruling NZ-D15B, plan N-24). Kept in its own file so the
 * guard in tests/unit/merchant-erasure.test.ts can prove that the StoreDO class body, the anonymiser and the erasure surfaces
 * contain no `deleteAll` and that nothing under erasure imports this module. Only `StoreDO.purgeClosedStore` calls it, after it has
 * checked the store is closed and that its fiscal row count equals the verified export.
 */
export async function wipeClosedStoreStorage(storage: {
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}): Promise<void> {
  await storage.deleteAlarm();
  await storage.deleteAll();
}
