import { describe, it, expect, vi, beforeEach } from 'vitest';
import ts from 'typescript';
import { all, callsIn, declNamed, hasAncestor, parseFile } from './helpers/ast-statements';

const loaders = vi.hoisted(() => ({ order: vi.fn(), product: vi.fn() }));
vi.mock('../../apps/api/src/services/webhook-payload', () => ({
  loadOrderParts: loaders.order,
  loadProductData: loaders.product,
}));
import {
  buildFanoutEvents,
  buildInventoryLowEvents,
  SourceNotReadyError,
} from '../../apps/api/src/services/webhook-events';

const order = (paymentStatus: string, status = 'confirmed') => ({
  row: { id: 'o1', paymentStatus, status },
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
    for (const status of ['shipped', 'delivered', 'cancelled']) {
      loaders.order.mockResolvedValue(order('paid', status));
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
  it('I1: an order that is not visible yet (event raced the commit) is NOT dropped: the build throws so the caller retries', async () => {
    loaders.order.mockResolvedValue(null);
    for (const name of ['order/created', 'order/status-changed', 'order/refunded'] as const) {
      await expect(
        buildFanoutEvents('s1', name, { orderId: 'zz', status: 'shipped' }, 'x')
      ).rejects.toBeInstanceOf(SourceNotReadyError);
    }
    expect(loaders.order).toHaveBeenCalledWith('s1', 'zz');
  });
  it('I1: a rolled-back / stale status is never announced: the row state must match the event', async () => {
    loaders.order.mockResolvedValue(order('paid', 'confirmed'));
    await expect(
      buildFanoutEvents('s1', 'order/status-changed', { orderId: 'o1', status: 'shipped' }, 'x')
    ).rejects.toBeInstanceOf(SourceNotReadyError);
    loaders.order.mockResolvedValue(order('paid', 'shipped'));
    const [e] = await buildFanoutEvents(
      's1',
      'order/status-changed',
      { orderId: 'o1', status: 'shipped' },
      'x'
    );
    expect(e.type).toBe('order.status_changed');
  });
  it('order/refunded carries partial and is keyed by the refund, not the source event', async () => {
    loaders.order.mockResolvedValue(order('refunded'));
    const [e] = await buildFanoutEvents(
      's1',
      'order/refunded',
      { orderId: 'o1', partial: { items: [], refundKey: 'r9' } },
      'ev9'
    );
    expect(e).toMatchObject({
      type: 'order.refunded',
      dedupeKey: 'order.refunded:o1:partial:r9',
      data: { refund: { partial: true } },
    });
  });
  it('I2: a plumbing re-send of the same refund (new source event id, notify:false) gets the SAME dedupe key', async () => {
    loaders.order.mockResolvedValue(order('refunded', 'refunded'));
    const first = await buildFanoutEvents(
      's1',
      'order/refunded',
      { orderId: 'o1', notify: true },
      'ev-a'
    );
    const sweep = await buildFanoutEvents(
      's1',
      'order/refunded',
      { orderId: 'o1', notify: false, restoreInventory: true },
      'ev-b'
    );
    expect(sweep[0].dedupeKey).toBe(first[0].dedupeKey);
    expect(first[0].dedupeKey).toBe('order.refunded:o1:full');
  });
  it('I2: partial refunds are keyed by their refundKey, so each distinct partial is its own event and a re-send is not', async () => {
    loaders.order.mockResolvedValue(order('paid', 'delivered'));
    const p = (refundKey: string, id: string) =>
      buildFanoutEvents(
        's1',
        'order/refunded',
        { orderId: 'o1', notify: false, partial: { items: [], refundKey } },
        id
      );
    const [a1] = await p('ret-1', 'e1');
    const [a2] = await p('ret-1', 'e2');
    const [b] = await p('ret-2', 'e3');
    expect(a1.dedupeKey).toBe(a2.dedupeKey);
    expect(b.dedupeKey).not.toBe(a1.dedupeKey);
    expect(a1.data.refund).toEqual({ partial: true });
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

describe('M8 inventory.low events are batched into ONE step per run', () => {
  const item = (id: string) => ({ productId: id, name: id, inventory: 1, lowStockThreshold: 5 });
  it('one event per store that has alerted products, none for the rest', () => {
    const evs = buildInventoryLowEvents('2026-10-21', [
      { storeId: 's1', items: [item('a')] },
      { storeId: 's2', items: [] },
      { storeId: 's3', items: [item('b'), item('c')] },
    ]);
    expect(evs.map(e => e.data.storeId)).toEqual(['s1', 's3']);
    expect(evs[1]).toMatchObject({ name: 'webhook/inventory.low', data: { day: '2026-10-21' } });
    expect(evs[1].data.items).toHaveLength(2);
  });
  it('the cron sends them with a single step.sendEvent after the per-store loop', () => {
    // Structural (AST of the cron definition): exactly one real step.sendEvent call, outside every loop and positioned
    // after the loop that accumulates `totalSkipped`. (Behaviour needs the whole Inngest step harness + store directory.)
    const cron = declNamed(
      parseFile('apps/api/src/lib/inngest/functions/stock-low-stock-alert.ts'),
      'stockLowStockAlertCron'
    );
    const sends = callsIn(cron, 'step.sendEvent');
    expect(sends).toHaveLength(1);
    const loop = all(cron, ts.isForOfStatement).find(l =>
      l.getText().includes('totalSkipped += scan.skipped')
    );
    expect(loop, 'the per-store loop').toBeTruthy();
    const isLoop = (a: ts.Node) =>
      ts.isForOfStatement(a) ||
      ts.isForStatement(a) ||
      ts.isForInStatement(a) ||
      ts.isWhileStatement(a);
    expect(hasAncestor(sends[0]!, isLoop), 'sendEvent is not inside a loop').toBe(false);
    expect(sends[0]!.getStart()).toBeGreaterThan(loop!.getEnd());
  });
});
