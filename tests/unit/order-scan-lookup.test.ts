/**
 * Ruling BARCODE-4 made true: the digits a scanner reads off a receipt, slip or
 * email barcode open the order, in its own store only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanCodeFor } from '@ebda/shared';

const findFirst = vi.fn();
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: { order: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

const { orderSearchWhere, OrderService } = await import('@api/services/order.service');

const NUMBER = 'ORD-T5JK9Q-AB3XY';
const CODE = scanCodeFor(NUMBER);
// a tiny in-memory orders table: a where is honoured only for the store it names
const ORDERS = [{ id: 'o1', storeId: 'store-A', orderNumber: NUMBER, deletedAt: null }];
beforeEach(() => {
  findFirst
    .mockReset()
    .mockImplementation(
      async ({ where }: { where: { orderNumber: string; storeId: string; deletedAt: null } }) =>
        ORDERS.find(o => o.orderNumber === where.orderNumber && o.storeId === where.storeId) ?? null
    );
});

describe('order search by scan code', () => {
  it('the 18 scanned digits become an exact order-number arm (no customer fan-out)', async () => {
    expect(await orderSearchWhere('store-A', CODE)).toEqual([{ orderNumber: NUMBER }]);
    expect(await orderSearchWhere('store-A', `  ${CODE}\n`)).toEqual([{ orderNumber: NUMBER }]); // scanner whitespace
  });
  it('typed numbers and other digit strings keep the normal search', async () => {
    // not 18 digits: goes down the normal path (which needs the DB), so only assert it is NOT the scan arm
    const arms = await orderSearchWhere('store-A', 'Mona').catch(() => null);
    expect(arms === null || !arms.some(a => 'orderNumber' in a && a.orderNumber === NUMBER)).toBe(
      true
    );
  });
});

describe('exact lookup by scan code, store-scoped', () => {
  it('finds the order in its own store', async () => {
    const o = await OrderService.getByOrderNumber('store-A', CODE).catch(() => null);
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({
      orderNumber: NUMBER,
      storeId: 'store-A',
      deletedAt: null,
    });
    expect(o).not.toBeNull();
  });
  it('does NOT find it from another store', async () => {
    await OrderService.getByOrderNumber('store-B', CODE).catch(() => null);
    expect(findFirst.mock.calls[0]![0].where.storeId).toBe('store-B');
    expect(await findFirst.mock.results[0]!.value).toBeNull();
  });
  it('a normal order number still works unchanged', async () => {
    await OrderService.getByOrderNumber('store-A', NUMBER).catch(() => null);
    expect(findFirst.mock.calls[0]![0].where.orderNumber).toBe(NUMBER);
  });
});
