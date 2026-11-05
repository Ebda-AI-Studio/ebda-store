import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@ebda/database';
import {
  seedCoaForStore,
  listAccountsTree,
} from '../../../apps/api/src/services/accounting/account.service';
import { COA_TEMPLATE } from '../../../apps/api/src/services/accounting/coa-template';

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
  it('seeds every template account as a system account on a fresh store and is idempotent', async () => {
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
      // 31 since WALLET-GL-1 added 4100 (unused store credit) and 5950 (customer goodwill)
      expect(first).toBe(COA_TEMPLATE.length);
      expect(first).toBe(31);

      // Re-running must not duplicate
      await seedCoaForStore(store.id);
      const second = await prisma.account.count({ where: { storeId: store.id } });
      expect(second).toBe(COA_TEMPLATE.length);

      const tree = await listAccountsTree(store.id);
      expect(tree.assets.find(a => a.code === '1000')?.nameEn).toBe('Cash Online');
      expect(tree.assets.find(a => a.code === '1000')?.nameAr).toBe('كاش مدفوعات إلكترونية');
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
