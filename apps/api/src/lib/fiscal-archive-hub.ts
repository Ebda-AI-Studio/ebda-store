/**
 * NEON-ZERO (Ruling NZ-C-4): the super-admin fiscal archive without Postgres. A store's fiscal documents are rows of that
 * store (its DO, or Postgres for a store not yet moved), so the archive view reads them through `storeDb`; the store list is D1.
 * A DELETED DO store has no D1 directory row nor reachable DO any more, so this view lists live stores only; the routes add
 * deleted DO stores from the platform archive (lib/fiscal-archive-store.ts, Ruling FISCAL-ARCHIVE-1).
 */
import { storeDb } from './repo-factory';
import { hubFanout, hubFanoutStoreIds, hubStoresById } from './platform-hub';
import type { FiscalArchiveRow, FiscalArchiveStoreRow } from './definer';

export async function fiscalArchiveStoresHub(): Promise<FiscalArchiveStoreRow[]> {
  const { ids } = await hubFanoutStoreIds();
  const names = new Map((await hubStoresById(ids)).map(s => [s.id, s.name]));
  const parts = await hubFanout(
    ids,
    async storeId => {
      const db = await storeDb(storeId);
      const [documentCount, last] = await Promise.all([
        db.fiscalDocument.count({ where: { storeId } }),
        db.fiscalDocument.findFirst({
          where: { storeId },
          orderBy: { issuedAt: 'desc' },
          select: { issuedAt: true },
        }),
      ]);
      return { documentCount, lastIssuedAt: last?.issuedAt ?? null };
    },
    () => undefined
  );
  return parts
    .filter(p => p.value.documentCount > 0)
    .map(p => ({
      storeId: p.storeId,
      storeName: names.get(p.storeId) ?? null,
      documentCount: p.value.documentCount,
      lastIssuedAt: p.value.lastIssuedAt,
      storeExists: true,
    }));
}

export async function fiscalArchiveHub(storeId: string): Promise<FiscalArchiveRow[]> {
  const rows = await (
    await storeDb(storeId)
  ).fiscalDocument.findMany({
    where: { storeId },
    orderBy: { issuedAt: 'desc' },
    take: 5000,
  });
  return rows.map(r => ({
    id: r.id,
    storeId: r.storeId,
    orderId: r.orderId,
    docType: r.docType,
    number: r.number,
    status: r.status,
    issuedAt: r.issuedAt,
    cancelledAt: r.cancelledAt,
    originalNumber: r.originalNumber,
    currency: r.currency,
    netAmount: r.netAmount,
    vatAmount: r.vatAmount,
    totalAmount: r.totalAmount,
    vatRateBps: r.vatRateBps,
    sellerTrn: r.sellerTrn,
    payload: r.payload,
    retainUntil: r.retainUntil,
  }));
}
