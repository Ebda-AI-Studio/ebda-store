/** Orders assistant tools (plan 4 C2): confirm-class cards, apply through runAsMerchant as the assistant, role gates, flags, the money amount and the phone-order undo. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  effectivePolicy,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  order: {} as Record<string, unknown>,
  products: [] as Array<Record<string, unknown>>,
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  svc: {
    getById: vi.fn(),
    updateStatus: vi.fn(),
    markCodPaid: vi.fn(),
    createAdminOrder: vi.fn(),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    product: { findMany: async () => m.products },
  }),
}));
vi.mock('@api/services/order.service', async () => ({
  OrderService: m.svc,
  assertValidTransition: (await import('@api/services/order-status-machine')).assertValidTransition,
}));

import { ordersTools } from '@api/smart-layer/tools/orders.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => ordersTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;
const baseOrder = (o: Record<string, unknown> = {}) => ({
  id: 'O1',
  orderNumber: 'ORD-1',
  status: 'pending',
  paymentStatus: 'unpaid',
  total: 25050,
  updatedAt: '2026-11-14T10:00:00.000Z',
  payments: [{ provider: 'cod' }],
  ...o,
});
const cases = [
  { name: 'order_set_status', args: { orderId: 'O1', status: 'confirmed' }, svc: 'updateStatus' },
  { name: 'order_cancel', args: { orderId: 'O1', restoreInventory: true }, svc: 'updateStatus' },
  { name: 'order_mark_paid', args: { orderId: 'O1' }, svc: 'markCodPaid' },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  m.order = baseOrder();
  m.svc.getById.mockImplementation(async () => m.order);
  m.svc.updateStatus.mockResolvedValue({ id: 'O1', orderNumber: 'ORD-1', status: 'x' });
  m.svc.markCodPaid.mockResolvedValue({ orderNumber: 'ORD-1', amount: 25050 });
  m.svc.createAdminOrder.mockResolvedValue({ id: 'O9', orderNumber: 'ORD-9' });
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.products = [
    { id: 'P1', name: 'Mug', price: 15000 },
    { id: 'P2', name: 'Plate', price: 5000 },
  ];
});

describe('order confirm tools', () => {
  it('are confirm class, irreversible, with no inverse and no store id argument', () => {
    for (const c of cases) {
      const t = tool(c.name);
      expect(t.policy).toBe('confirm');
      expect(t.undo).toBe('irreversible');
      expect(t.inverse).toBeUndefined();
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
    expect(tool('order_set_status').messagesCustomers).toBe(true);
    expect(tool('order_mark_paid').money).toBe(true);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('preview lists before/after rows and an etag; a hand edit moves the etag', async () => {
        const a = await tool(c.name).preview!(ctx(), parse(c.name, c.args));
        expect(a.rows.length).toBeGreaterThan(0);
        expect(a.etag).toMatch(/^[0-9a-f]{32}$/);
        expect(a.affectedCount).toBe(1);
        m.order = baseOrder({ updatedAt: '2026-11-14T11:00:00.000Z' });
        const b = await tool(c.name).preview!(ctx(), parse(c.name, c.args));
        expect(b.etag).not.toBe(a.etag);
      });

      it('apply goes through runAsMerchant as the assistant and calls the route service', async () => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const r = await t.apply!(ctx(), args, await t.preview!(ctx(), args));
        expect(r.ok).toBe(true);
        expect(m.svc[c.svc]).toHaveBeenCalledTimes(1);
        expect(m.svc[c.svc].mock.calls[0][0]).toBe('S1');
        expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
          actor: 'assistant',
          phase: 'intent',
          tool: c.name,
        });
      });

      it('a super admin is refused and nothing runs', async () => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        const d = await t.preview!(ctx(), args);
        await expect(t.apply!(ctx('super_admin'), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(m.svc[c.svc]).not.toHaveBeenCalled();
      });

      it('reports the confirm reasons the engine will show', async () => {
        const t = tool(c.name);
        const d = await t.preview!(ctx(), parse(c.name, c.args));
        const { policy, reasons } = effectivePolicy(t, d);
        expect(policy).toBe('confirm');
        expect(reasons).toContain('irreversible');
        if (c.name === 'order_mark_paid') expect(reasons).toContain('money');
        if (c.name !== 'order_mark_paid') expect(reasons).toContain('customer_message');
      });

      it('names the order as a ref so a foreign order id is "not found" before any run', () => {
        expect(tool(c.name).refs!(parse(c.name, c.args) as never)).toEqual([
          { kind: 'order', id: 'O1' },
        ]);
      });
    });
  }

  it('a foreign order id never reaches run (the store-scoped read 404s)', async () => {
    m.svc.getById.mockRejectedValue(new Error('Order not found'));
    const t = tool('order_cancel');
    const args = parse('order_cancel', { orderId: 'X', restoreInventory: true });
    await expect(t.preview!(ctx(), args)).rejects.toThrow('not found');
    await expect(t.apply!(ctx(), args, {} as never)).rejects.toThrow('not found');
    expect(m.svc.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a status move the order state machine forbids at preview', async () => {
    m.order = baseOrder({ status: 'delivered' });
    await expect(
      tool('order_set_status').preview!(
        ctx(),
        parse('order_set_status', { orderId: 'O1', status: 'processing' })
      )
    ).rejects.toThrow(/transition/i);
  });

  it('cancel and refund statuses are not offered by the status tool', () => {
    for (const bad of ['cancelled', 'refunded', 'pending'])
      expect(tool('order_set_status').args.safeParse({ orderId: 'O1', status: bad }).success).toBe(
        false
      );
  });

  it('cancel passes restoreInventory to the service and shows the total from state', async () => {
    const t = tool('order_cancel');
    const args = parse('order_cancel', { orderId: 'O1', restoreInventory: false });
    const d = await t.preview!(ctx(), args);
    expect(d.rows.some(r => r.after === '250.5')).toBe(true);
    await t.apply!(ctx(), args, d);
    expect(m.svc.updateStatus).toHaveBeenCalledWith('S1', 'O1', 'cancelled', {
      restoreInventory: false,
    });
  });

  it('mark paid: the amount shown comes from state(), a model-typed amount is rejected', async () => {
    const t = tool('order_mark_paid');
    expect(t.args.safeParse({ orderId: 'O1', amount: 1 }).success).toBe(false);
    const d = await t.preview!(ctx(), parse('order_mark_paid', { orderId: 'O1' }));
    expect(d.rows.some(r => r.after === '250.5')).toBe(true);
  });

  it('mark paid is refused at preview for a non-COD, already paid or cancelled order', async () => {
    const t = tool('order_mark_paid');
    const args = parse('order_mark_paid', { orderId: 'O1' });
    m.order = baseOrder({ payments: [{ provider: 'paymob' }] });
    await expect(t.preview!(ctx(), args)).rejects.toThrow(/Cash on Delivery/);
    m.order = baseOrder({ paymentStatus: 'paid' });
    await expect(t.preview!(ctx(), args)).rejects.toThrow(/already/);
    m.order = baseOrder({ status: 'cancelled' });
    await expect(t.preview!(ctx(), args)).rejects.toThrow(/cancelled/);
  });
});

describe('order_create_phone', () => {
  const args = {
    customerName: 'منى أحمد',
    phone: '01012345678',
    address: '5 شارع النصر',
    city: 'القاهرة',
    items: [
      { productId: 'P1', quantity: 2 },
      { productId: 'P2', quantity: 1 },
    ],
  };

  it('is a preview, compensating, with a product ref per item and no store id', () => {
    const t = tool('order_create_phone');
    expect(t.policy).toBe('preview');
    expect(t.undo).toBe('compensating');
    expect(t.refs!(parse('order_create_phone', args) as never)).toEqual([
      { kind: 'product', id: 'P1' },
      { kind: 'product', id: 'P2' },
    ]);
    expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
  });

  it('preview shows each line, the items total from the catalog and an etag that follows a price edit', async () => {
    const t = tool('order_create_phone');
    const a = await t.preview!(ctx(), parse('order_create_phone', args));
    expect(a.rows.some(r => r.after === '350')).toBe(true); // 2*150 + 50
    expect(a.etag).toMatch(/^[0-9a-f]{32}$/);
    m.products = [
      { id: 'P1', name: 'Mug', price: 16000 },
      { id: 'P2', name: 'Plate', price: 5000 },
    ];
    expect((await t.preview!(ctx(), parse('order_create_phone', args))).etag).not.toBe(a.etag);
  });

  it('a product that is not in this store is refused before run', async () => {
    m.products = [{ id: 'P1', name: 'Mug', price: 15000 }];
    await expect(
      tool('order_create_phone').preview!(ctx(), parse('order_create_phone', args))
    ).rejects.toThrow(/not found/i);
  });

  it('apply creates a COD guest order through the service as the assistant, and the inverse cancels it', async () => {
    const t = tool('order_create_phone');
    const a = parse('order_create_phone', args);
    const d = await t.preview!(ctx(), a);
    const r = await t.apply!(ctx(), a, d);
    expect(r.ok).toBe(true);
    const call = m.svc.createAdminOrder.mock.calls[0];
    expect(call[0]).toBe('S1');
    expect(call[2]).toMatchObject({
      paymentMethod: 'cod',
      paymentProvider: 'cod',
      items: args.items,
    });
    expect(call[2].shippingAddress).toMatchObject({ firstName: 'منى', lastName: 'أحمد' });
    expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({ actor: 'assistant' });
    expect(t.inverse!(ctx(), a, d, r)).toEqual({
      tool: 'order_cancel',
      args: { orderId: 'O9', restoreInventory: true },
    });
  });

  it('a user without the route role gets ToolForbidden', async () => {
    const t = tool('order_create_phone');
    const a = parse('order_create_phone', args);
    const d = await t.preview!(ctx(), a);
    await expect(t.apply!(ctx('customer'), a, d)).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.svc.createAdminOrder).not.toHaveBeenCalled();
  });

  it('the cancel it escalates to is itself confirm class', () => {
    expect(tool('order_cancel').policy).toBe('confirm');
  });

  it('a 25-line order is rejected by the schema (max 25) and 26 lines too', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ productId: `P${i}`, quantity: 1 }));
    expect(tool('order_create_phone').args.safeParse({ ...args, items: many(25) }).success).toBe(
      true
    );
    expect(tool('order_create_phone').args.safeParse({ ...args, items: many(26) }).success).toBe(
      false
    );
  });
});
