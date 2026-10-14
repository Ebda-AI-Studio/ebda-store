/**
 * WarehouseService.resolveDefaultWarehouse — selection-order unit tests.
 *
 * Pure selection logic over a mocked `prisma.warehouse.findMany` result — no
 * DB required. Verifies the selection order:
 *   1. Warehouse.isDefault === true wins outright, regardless of priority/active.
 *   2. Else: the HIGHEST-`priority` warehouse among isActive===true ones.
 *   3. Else (no active warehouses at all): the first warehouse returned.
 *   4. Store with zero warehouses → null.
 *
 * Fix wave 1 (2026-07): the Task 2 brief's "lowest priority" fallback was
 * wrong — flipped to HIGHEST priority to match the schema
 * (`priority Int // Higher = preferred`, `@@index([storeId, priority(sort:
 * Desc)])`) and `WarehouseService.routeOrder`, which already sorts
 * `priority: 'desc'` for the same reason (higher = preferred for order
 * fulfillment routing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: {
    warehouse: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn({}),
  withMoneyTx: (
    client: { $transaction?: (fn: unknown) => unknown },
    fn: (tx: unknown) => unknown
  ) => (client?.$transaction ? client.$transaction(fn) : fn(client)),
}));

import { WarehouseService } from '../warehouse.service';

describe('WarehouseService.resolveDefaultWarehouse', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('returns null when the store has no warehouses', async () => {
    findManyMock.mockResolvedValue([]);
    const result = await WarehouseService.resolveDefaultWarehouse('store-1');
    expect(result).toBeNull();
  });

  it('picks the isDefault warehouse even when its priority is not the highest', async () => {
    findManyMock.mockResolvedValue([
      { id: 'w-low-priority', isDefault: false, priority: 1, isActive: true },
      { id: 'w-default', isDefault: true, priority: 5, isActive: true },
      { id: 'w-other', isDefault: false, priority: 99, isActive: true },
    ]);
    const result = await WarehouseService.resolveDefaultWarehouse('store-1');
    expect(result?.id).toBe('w-default');
  });

  it('falls back to the highest-priority ACTIVE warehouse when none is isDefault', async () => {
    findManyMock.mockResolvedValue([
      { id: 'w-low', isDefault: false, priority: 10, isActive: true },
      { id: 'w-inactive-highest', isDefault: false, priority: 999, isActive: false },
      { id: 'w-highest-active', isDefault: false, priority: 50, isActive: true },
    ]);
    const result = await WarehouseService.resolveDefaultWarehouse('store-1');
    expect(result?.id).toBe('w-highest-active');
  });

  it('falls back to the first warehouse when none is isDefault and none is active', async () => {
    findManyMock.mockResolvedValue([
      { id: 'w-first', isDefault: false, priority: 0, isActive: false },
      { id: 'w-second', isDefault: false, priority: 0, isActive: false },
    ]);
    const result = await WarehouseService.resolveDefaultWarehouse('store-1');
    expect(result?.id).toBe('w-first');
  });
});
