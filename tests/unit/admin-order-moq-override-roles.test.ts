/**
 * Ported from tests/integration/repo-factory-orders-contract.test.ts ("admin order: minimum order quantity is refused 422,
 * overridable by a store admin with a reason (event), staff refused"; the Postgres original is deleted).
 * The engine half (BELOW_MOQ 422, the `moq_override` event) is packages/repo/test/do-order-ops.test.ts. This is the API half
 * `createAdminOrderOnDo` owns: the override is decided from the verified session role BEFORE the engine is called, so staff get
 * 403 MOQ_OVERRIDE_FORBIDDEN, a missing or blank reason is 400 MOQ_OVERRIDE_REASON_REQUIRED, neither reaches the engine, and an
 * admin with a reason passes the flag and the trimmed reason through (and writes the `order.moq_override` audit row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createAdminOrder: vi.fn(),
  audits: [] as Array<{ action: string; details?: Record<string, unknown> }>,
}));

vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeMoney: async () => ({ createAdminOrder: h.createAdminOrder }),
  storeDb: async () => ({
    order: {
      findFirst: async () => ({ id: 'o1', couponCode: null, userId: null, items: [] }),
    },
  }),
}));
vi.mock('../../apps/api/src/services/plan-limit.service', async importOriginal => ({
  ...(await importOriginal<object>()),
  assertOrderAllowed: async () => undefined,
  noteOrderCreated: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/customer-directory', async importOriginal => ({
  ...(await importOriginal<object>()),
  customerRow: async () => undefined,
  customerRows: async () => [],
}));
vi.mock('../../apps/api/src/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: async (e: { action: string; details?: Record<string, unknown> }) =>
    void h.audits.push(e),
}));
vi.mock('../../apps/api/src/services/price-resolver.service', async importOriginal => ({
  ...(await importOriginal<object>()),
  wholesaleEntitledUncached: async () => false,
}));
vi.mock('../../apps/api/src/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: () => undefined,
}));

import { OrderService } from '../../apps/api/src/services/order.service';

const STORE = '11111111-1111-4111-8111-111111111111';
const input = (extra: Record<string, unknown> = {}) =>
  ({
    shippingAddress: { firstName: 'A', lastName: 'B', phone: '+201012345678' },
    items: [{ productId: 'p1', quantity: 2 }],
    ...extra,
  }) as never;
const place = (extra: Record<string, unknown>, role = 'store_admin') =>
  OrderService.createAdminOrder(STORE, 'admin-1', input(extra), { role });

beforeEach(() => {
  h.createAdminOrder.mockReset();
  h.createAdminOrder.mockResolvedValue({
    orderId: 'o1',
    orderNumber: 'ORD-1',
    subtotal: 20_000,
    discount: 0,
    shipping: 0,
    tax: 0,
    total: 20_000,
  });
  h.audits.length = 0;
});

describe('admin order: who may override the minimum order quantity', () => {
  it('staff are refused 403 and the engine is never called', async () => {
    await expect(
      place({ overrideMoq: true, moqOverrideReason: 'phone deal' }, 'staff')
    ).rejects.toMatchObject({ statusCode: 403, code: 'MOQ_OVERRIDE_FORBIDDEN' });
    expect(h.createAdminOrder).not.toHaveBeenCalled();
  });

  it('an admin without a reason (missing or blank) is refused 400 and the engine is never called', async () => {
    for (const extra of [{ overrideMoq: true }, { overrideMoq: true, moqOverrideReason: '   ' }])
      await expect(place(extra)).rejects.toMatchObject({
        statusCode: 400,
        code: 'MOQ_OVERRIDE_REASON_REQUIRED',
      });
    expect(h.createAdminOrder).not.toHaveBeenCalled();
  });

  it('an admin with a reason passes the flag and the trimmed reason on, and the order.moq_override audit row names it', async () => {
    await place({ overrideMoq: true, moqOverrideReason: ' phone deal ' });
    expect(h.createAdminOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        overrideMoq: true,
        moqOverrideReason: 'phone deal',
        actorRole: 'store_admin',
      })
    );
    expect(h.audits.find(a => a.action === 'order.moq_override')?.details).toMatchObject({
      description: 'phone deal',
    });
  });

  it('without the flag staff place the order normally and the engine enforces the minimum itself', async () => {
    await place({}, 'staff');
    expect(h.createAdminOrder).toHaveBeenCalledWith(
      expect.objectContaining({ overrideMoq: false })
    );
    expect(h.audits.find(a => a.action === 'order.moq_override')).toBeUndefined();
  });
});
