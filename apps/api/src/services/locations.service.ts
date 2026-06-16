import { prisma } from '@force/database';
import type { LocationInput } from '@force/shared';

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

  static create(storeId: string, data: LocationInput) {
    return prisma.storeLocation.create({ data: { ...data, storeId } });
  }

  static async update(storeId: string, id: string, data: Partial<LocationInput>) {
    // store-scope the update so a tenant can't touch another store's row by id
    const res = await prisma.storeLocation.updateMany({ where: { id, storeId }, data });
    if (res.count === 0) return null;
    return prisma.storeLocation.findUnique({ where: { id } });
  }

  static async remove(storeId: string, id: string) {
    const res = await prisma.storeLocation.deleteMany({ where: { id, storeId } });
    return res.count > 0;
  }
}
