import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@force/database';
import {
  seedCoaForStore,
  listAccountsTree,
} from '../../../apps/api/src/services/accounting/account.service';

const OWNER_ID = '00000000-0000-0000-0000-0000000000aa';

beforeAll(async () => {
  // Ensure the stable fixture user exists (Store FK → User).
  // Reuses the same id as the sequence-service sister test — safe to share.
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: 'seq-test-owner@force-test.internal',
      passwordHash: 'not-a-real-hash',
      firstName: 'Seq',
      lastName: 'Test',
      role: 'store_admin',
    },
  });
});

describe('account.service', () => {
  it('seeds 29 system accounts on a fresh store and is idempotent', async () => {
    const ts = Date.now();
    const store = await prisma.store.create({
      data: {
        name: `coa-test-${ts}`,
        slug: `coa-test-${ts}`,
        ownerId: OWNER_ID,
      },
    });

    try {
      await seedCoaForStore(store.id);
      const first = await prisma.account.count({ where: { storeId: store.id } });
      expect(first).toBe(29);

      // Re-running must not duplicate
      await seedCoaForStore(store.id);
      const second = await prisma.account.count({ where: { storeId: store.id } });
      expect(second).toBe(29);

      const tree = await listAccountsTree(store.id);
      expect(tree.assets.find(a => a.code === '1000')?.nameEn).toBe('Cash KNET');
      expect(tree.assets.find(a => a.code === '1000')?.nameAr).toBe('كاش كي نت');
      expect(tree.expenses.length).toBeGreaterThan(10);
      // Confirm every returned node carries isSystem=true (whole template is system)
      const allSystem = [
        ...tree.assets,
        ...tree.liabilities,
        ...tree.equity,
        ...tree.revenue,
        ...tree.expenses,
      ].every(n => n.isSystem);
      expect(allSystem).toBe(true);
    } finally {
      await prisma.account.deleteMany({ where: { storeId: store.id } });
      await prisma.store.delete({ where: { id: store.id } });
    }
  });
});
