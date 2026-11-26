/**
 * OneSignal player ids of a shopper, read from the store's own DB for the `account/erased` propagation. A StoreDO
 * database has NO `oneSignalSubscription` delegate (push devices are platform-owned, family `ops`), so the model is
 * absent there: the read is best-effort and an absent delegate or a failed read yields [] - it must never fail the erase.
 * (`delegate?.findMany(...).catch(...)` crashed with a TypeError once the delegate was undefined: 500 on every closure.)
 */
export async function shopperOneSignalPlayerIds(db: unknown, userId: string): Promise<string[]> {
  try {
    const rows =
      (await (
        db as {
          oneSignalSubscription?: {
            findMany?: (q: unknown) => Promise<Array<{ playerId: string }>>;
          };
        }
      ).oneSignalSubscription?.findMany?.({ where: { userId }, select: { playerId: true } })) ?? [];
    return rows.map(r => r.playerId);
  } catch {
    return [];
  }
}
