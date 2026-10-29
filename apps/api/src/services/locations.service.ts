import { withStore } from '@ebda/database';
import type { LocationInput } from '@ebda/shared';
import { bustStoreCaches } from './store.service';
import { storeDb, storeWriter } from '../lib/repo-factory';

export class LocationsService {
  static async list(storeId: string) {
    const db = await storeDb(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-REPO-1)
    return db.storeLocation.findMany({
      where: { storeId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  static async listPublished(storeId: string) {
    const db = await storeDb(storeId);
    return db.storeLocation.findMany({
      where: { storeId, isPublished: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  static async create(storeId: string, data: LocationInput) {
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
    const location = await w.storeLocation.create({ data: { ...data, storeId } });
    await LocationsService.bustFooterCache(storeId);
    return location;
  }

  static async update(storeId: string, id: string, data: Partial<LocationInput>) {
    // store-scope the update so a tenant can't touch another store's row by id
    const w = await storeWriter(storeId);
    const res = await w.storeLocation.updateMany({ where: { id, storeId }, data });
    if (res.count === 0) return null;
    const location = await w.storeLocation.findUnique({ where: { id, storeId } });
    await LocationsService.bustFooterCache(storeId);
    return location;
  }

  static async remove(storeId: string, id: string) {
    const res = await (
      await storeWriter(storeId)
    ).storeLocation.deleteMany({ where: { id, storeId } });
    if (res.count > 0) await LocationsService.bustFooterCache(storeId);
    return res.count > 0;
  }

  /**
   * Any Location write can change the storefront footer's opt-in "Branches"
   * column (when `showBranchesInFooter` is on), which rides the SAME cached
   * store-resolve payload as everything else in `bustStoreCaches`. Without
   * this, a merchant editing a branch would see the storefront footer stay
   * stale for up to the 120s TTL even though `PUT /theme` itself already
   * busts on every save.
   */
  private static async bustFooterCache(storeId: string): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { slug: true, domain: true },
      })
    );
    if (!store) return;
    await bustStoreCaches(storeId, store.slug, store.domain);
  }
}
