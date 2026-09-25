import { prisma } from '@force/database';
import type { LocationInput } from '@force/shared';
import { bustStoreCaches } from './store.service';

export class LocationsService {
  static list(storeId: string) {
    return prisma.storeLocation.findMany({
      where: { storeId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  static listPublished(storeId: string) {
    return prisma.storeLocation.findMany({
      where: { storeId, isPublished: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  static async create(storeId: string, data: LocationInput) {
    const location = await prisma.storeLocation.create({ data: { ...data, storeId } });
    await LocationsService.bustFooterCache(storeId);
    return location;
  }

  static async update(storeId: string, id: string, data: Partial<LocationInput>) {
    // store-scope the update so a tenant can't touch another store's row by id
    const res = await prisma.storeLocation.updateMany({ where: { id, storeId }, data });
    if (res.count === 0) return null;
    const location = await prisma.storeLocation.findUnique({ where: { id } });
    await LocationsService.bustFooterCache(storeId);
    return location;
  }

  static async remove(storeId: string, id: string) {
    const res = await prisma.storeLocation.deleteMany({ where: { id, storeId } });
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
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { slug: true, domain: true },
    });
    if (!store) return;
    await bustStoreCaches(storeId, store.slug, store.domain);
  }
}
