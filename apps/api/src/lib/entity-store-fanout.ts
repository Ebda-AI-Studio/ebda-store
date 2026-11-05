/**
 * NEON-ZERO (Ruling NZ-PG-2): which store owns an entity id when the platform D1 has no index row for it. The D1
 * `entity_index` covers order, payment, customer, ...; a product, a journal entry and a bulk-import job are not indexed
 * (the id alone never named a store). With Postgres gone the answer is a primary-key probe of each store's own DO, over the
 * WHOLE D1 directory (paged, never capped), a few stores at a time. A rare, human- or replay-driven lookup: never a hot path.
 */
import { listDirectoryStores } from '../services/platform/directory-d1';
import { storeDb } from './repo-factory';

export type FanoutKind = 'product' | 'journal_entry' | 'bulk_import_job' | 'payment_event';
const CONCURRENCY = 8;

/** The one store whose DO holds `id` of `kind`, or null. A store that cannot be read is skipped (never a guess). */
export async function entityStoreByFanout(kind: FanoutKind, id: string): Promise<string | null> {
  const stores = (await listDirectoryStores()).filter(s => s.storageBackend === 'do');
  let found: string | null = null;
  let next = 0;
  const probe = async (storeId: string): Promise<boolean> => {
    const db = await storeDb(storeId);
    const where = { id, storeId };
    const select = { id: true };
    if (kind === 'product') return !!(await db.product.findUnique({ where, select }));
    if (kind === 'journal_entry') return !!(await db.journalEntry.findUnique({ where, select }));
    if (kind === 'payment_event') return !!(await db.paymentEvent.findUnique({ where, select }));
    return !!(await db.bulkImportJob.findUnique({ where, select }));
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, stores.length || 1) }, async () => {
      while (found === null && next < stores.length) {
        const s = stores[next++];
        try {
          if (await probe(s.id)) found = s.id;
        } catch {
          // an unreadable store is skipped: the id is not claimed for it
        }
      }
    })
  );
  return found;
}
