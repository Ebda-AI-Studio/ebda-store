import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { LocationsService } from '../../apps/api/src/services/locations.service';

const S = `loc-${Date.now()}`;
let userId: string, storeId: string;

beforeAll(async () => {
  const u = await prisma.user.create({
    data: {
      email: `${S}@test.local`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'T',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  userId = u.id;
  const s = await prisma.store.create({
    data: {
      name: 'Loc Test',
      slug: `store-${S}`,
      ownerId: userId,
      plan: 'enterprise',
      status: 'active',
      locationsEnabled: true,
    },
  });
  storeId = s.id;
});
afterAll(async () => {
  await prisma.storeLocation.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('LocationsService', () => {
  it('creates, lists ordered, updates store-scoped, filters published, deletes', async () => {
    const a = await LocationsService.create(storeId, {
      name: 'Avenues F-152',
      country: 'Kuwait',
      address: 'Al-Rai',
      position: 1,
      isPublished: true,
    } as any);
    const b = await LocationsService.create(storeId, {
      name: 'Hidden',
      country: 'Kuwait',
      address: 'x',
      position: 0,
      isPublished: false,
    } as any);
    const all = await LocationsService.list(storeId);
    expect(all.map(l => l.name)).toEqual(['Hidden', 'Avenues F-152']); // by position asc
    const pub = await LocationsService.listPublished(storeId);
    expect(pub.map(l => l.name)).toEqual(['Avenues F-152']);
    const upd = await LocationsService.update(storeId, a.id, { address: 'Al-Rai, Ghazali St' });
    expect(upd?.address).toBe('Al-Rai, Ghazali St');
    expect(
      await LocationsService.update('00000000-0000-0000-0000-000000000000', a.id, {
        address: 'hack',
      })
    ).toBeNull(); // cross-store blocked
    expect(await LocationsService.remove(storeId, b.id)).toBe(true);
    expect((await LocationsService.list(storeId)).length).toBe(1);
  });
});
