import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  softDeleteSupplier,
} from '../../../apps/api/src/services/accounting/supplier.service';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `sup-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'S',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `sup-test-${Date.now()}`, slug: `sup-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
});

afterAll(async () => {
  await prisma.supplier.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('supplier.service', () => {
  it('creates + lists + soft-deletes', async () => {
    const a = await createSupplier({
      storeId,
      name: 'Acme Pkg',
      nameAr: 'أكمي للتغليف',
      email: 'sales@acme.test',
    });
    expect(a.isActive).toBe(true);

    const list = await listSuppliers(storeId);
    expect(list.find(s => s.id === a.id)).toBeDefined();

    const got = await getSupplier(storeId, a.id);
    expect(got?.name).toBe('Acme Pkg');

    await softDeleteSupplier(storeId, a.id);
    const afterDelete = await listSuppliers(storeId);
    expect(afterDelete.find(s => s.id === a.id)).toBeUndefined();
  });
});
