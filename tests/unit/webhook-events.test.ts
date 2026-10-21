import { describe, it, expect, vi, beforeEach } from 'vitest';

const loaders = vi.hoisted(() => ({ order: vi.fn(), product: vi.fn() }));
vi.mock('../../apps/api/src/services/webhook-payload', () => ({
  loadOrderParts: loaders.order,
  loadProductData: loaders.product,
}));
import { buildFanoutEvents } from '../../apps/api/src/services/webhook-events';

const order = (paymentStatus: string) => ({
  row: { id: 'o1', paymentStatus },
  data: { order: { id: 'o1' } },
  customer: { name: 'A', email: null, phone: null },
});
beforeEach(() => {
  loaders.order.mockReset();
  loaders.product.mockReset();
});

describe('source event -> webhook events', () => {
  it('order/created -> order.created only for an unpaid (COD) order', async () => {
    loaders.order.mockResolvedValue(order('unpaid'));
    const evs = await buildFanoutEvents('s1', 'order/created', { orderId: 'o1' }, 'x');
    expect(evs.map(e => e.type)).toEqual(['order.created']);
  });
  it('order/created -> order.created + order.paid for a paid order, stable dedupe keys', async () => {
    loaders.order.mockResolvedValue(order('paid'));
    const a = await buildFanoutEvents('s1', 'order/created', { orderId: 'o1' }, 'ev-1');
    const b = await buildFanoutEvents('s1', 'order/created', { orderId: 'o1' }, 'ev-2');
    expect(a.map(e => e.type)).toEqual(['order.created', 'order.paid']);
    expect(a.map(e => e.dedupeKey)).toEqual(b.map(e => e.dedupeKey));
  });
  it('status_changed only for shipped / delivered / cancelled', async () => {
    loaders.order.mockResolvedValue(order('paid'));
    for (const status of ['shipped', 'delivered', 'cancelled']) {
      const [e] = await buildFanoutEvents(
        's1',
        'order/status-changed',
        { orderId: 'o1', status },
        'x'
      );
      expect(e).toMatchObject({ type: 'order.status_changed', data: { status } });
    }
    expect(
      await buildFanoutEvents(
        's1',
        'order/status-changed',
        { orderId: 'o1', status: 'processing' },
        'x'
      )
    ).toEqual([]);
  });
  it('a vanished or foreign order maps to nothing', async () => {
    loaders.order.mockResolvedValue(null);
    expect(await buildFanoutEvents('s1', 'order/created', { orderId: 'zz' }, 'x')).toEqual([]);
    expect(await buildFanoutEvents('s1', 'order/refunded', { orderId: 'zz' }, 'x')).toEqual([]);
    expect(loaders.order).toHaveBeenCalledWith('s1', 'zz');
  });
  it('order/refunded carries partial and is keyed by the source event', async () => {
    loaders.order.mockResolvedValue(order('refunded'));
    const [e] = await buildFanoutEvents(
      's1',
      'order/refunded',
      { orderId: 'o1', partial: true },
      'ev9'
    );
    expect(e).toMatchObject({
      type: 'order.refunded',
      dedupeKey: 'order.refunded:o1:ev9',
      data: { refund: { partial: true } },
    });
  });
  it('product.upserted create/update and product.deleted', async () => {
    loaders.product.mockResolvedValue({ product: { id: 'p1' } });
    const [c] = await buildFanoutEvents(
      's1',
      'product.upserted',
      { productId: 'p1', op: 'create' },
      'e1'
    );
    const [u] = await buildFanoutEvents(
      's1',
      'product.upserted',
      { productId: 'p1', op: 'update', changedFields: ['price'] },
      'e2'
    );
    const [d] = await buildFanoutEvents('s1', 'product.deleted', { productId: 'p1' }, 'e3');
    expect([c.type, u.type, d.type]).toEqual([
      'product.created',
      'product.updated',
      'product.deleted',
    ]);
    expect(u.data.changedFields).toEqual(['price']);
    expect(d.data).toEqual({ product: { id: 'p1' } });
  });
  it('inventory.low: one event per product, deduped per UTC day', async () => {
    const evs = await buildFanoutEvents(
      's1',
      'webhook/inventory.low',
      {
        day: '2026-10-21',
        items: [
          { productId: 'p1', name: 'A', inventory: 2, lowStockThreshold: 5 },
          { productId: 'p2', name: 'B', inventory: 1, lowStockThreshold: 5 },
        ],
      },
      'x'
    );
    expect(evs.map(e => e.dedupeKey)).toEqual([
      'inventory.low:p1:2026-10-21',
      'inventory.low:p2:2026-10-21',
    ]);
  });
});
