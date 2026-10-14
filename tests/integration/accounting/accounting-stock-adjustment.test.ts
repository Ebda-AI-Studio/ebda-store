import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import {
  createAdjustment,
  postAdjustment,
} from '../../../apps/api/src/services/accounting/stock-adjustment.service';
import { postStockAdjustmentJournal } from '../../../apps/api/src/services/accounting/posting/stock-adjustment-posting';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let productId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `adj-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `adj-test-${Date.now()}`, slug: `adj-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Adj Test Product',
      slug: `adj-${Date.now()}`,
      price: 5000,
      costPrice: 2000,
      inventory: 100,
      status: 'active',
    },
  });
  productId = p.id;
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId } });
  await prisma.stockAdjustmentItem.deleteMany({ where: { adjustment: { storeId } } });
  await prisma.stockAdjustment.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('stock adjustment posting per type', () => {
  // Each test: create adjustment of type T, post it, verify journal counterpart.
  // We use deltaQty = -10 (loss of 10 units @ 2000 cost = 20000 piastres impact, signed negative)
  // except for 'found' which is positive.

  async function runAdjustmentAndVerify(
    type: any,
    deltaSign: 1 | -1,
    expectedCounterpartCode: string
  ) {
    const startInv = (await prisma.product.findUnique({ where: { id: productId } }))!.inventory;
    const newQty = startInv + deltaSign * 10;
    const adj = await createAdjustment({
      storeId,
      type,
      reason: `Test ${type}`,
      items: [{ productId, newQty }],
    });
    expect(adj.status).toBe('draft');
    expect(adj.totalValueImpact).toBe(deltaSign * 10 * 2000);

    await postAdjustment(storeId, adj.id);

    // Direct posting helper (Inngest async)
    await postStockAdjustmentJournal({ storeId, adjustmentId: adj.id });

    const entry = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'stock_adjustment', sourceId: adj.id },
      include: { lines: { include: { account: true } } },
    });
    expect(entry).not.toBeNull();
    const dr = entry!.lines.reduce((s, l) => s + l.debit, 0);
    const cr = entry!.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(20000); // |10 × 2000|

    // Verify counterpart account is hit
    const counterpartLine = entry!.lines.find(l => l.account.code === expectedCounterpartCode);
    expect(counterpartLine).toBeDefined();

    // Cleanup for next test: reset inventory + delete entry/lines
    await prisma.product.update({ where: { id: productId }, data: { inventory: 100 } });
  }

  it('damage → DR 5900 (Damage/Loss) / CR 1200 (Inventory)', async () => {
    await runAdjustmentAndVerify('damage', -1, '5900');
  });

  it('theft → DR 5910 (Theft) / CR 1200', async () => {
    await runAdjustmentAndVerify('theft', -1, '5910');
  });

  it('write_off → DR 5920 (Write-off) / CR 1200', async () => {
    await runAdjustmentAndVerify('write_off', -1, '5920');
  });

  it('found → DR 1200 (Inventory) / CR 3000 (Owner equity)', async () => {
    await runAdjustmentAndVerify('found', 1, '3000');
  });

  it('return_to_supplier → DR 2000 (AP) / CR 1200', async () => {
    await runAdjustmentAndVerify('return_to_supplier', -1, '2000');
  });
});
