/**
 * WhatsApp -> Store consumer (contract section 8): COD outcomes and the erasure race, applied once,
 * tenant-scoped, the Store staying the only writer of order state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: vi.fn(),
  updateStatus: vi.fn(),
  audit: vi.fn(),
  exists: vi.fn(),
  set: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: { order: { findUnique: h.order } },
  runInTenantContext: (s: string, fn: () => unknown) => {
    h.scope(s);
    return fn();
  },
}));
vi.mock('@api/services/order.service', () => ({ OrderService: { updateStatus: h.updateStatus } }));
vi.mock('@api/middleware/security', () => ({ auditLog: h.audit }));
vi.mock('@api/services/redis.service', () => ({ redis: { exists: h.exists, set: h.set } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleStoreEvent } from '@api/lib/wa/store-events-consumer';
import { handleQueueBatch } from '@api/cf/queues';

const STORE = '11111111-1111-4111-8111-111111111111';
const BUYER = 'a'.repeat(64);
let n = 0;
const cod = (outcome: string, extra: object = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  type: 'whatsapp.cod_outcome',
  v: 1,
  storeId: STORE,
  occurredAt: '2026-10-25T10:00:00.000Z',
  data: { orderId: 'o1', outcome, source: 'whatsapp' },
  ...extra,
});

beforeEach(() => {
  h.order.mockReset().mockResolvedValue({ id: 'o1', status: 'pending', paymentStatus: 'unpaid' });
  h.updateStatus.mockReset().mockResolvedValue(undefined);
  h.audit.mockReset().mockResolvedValue(undefined);
  h.exists.mockReset().mockResolvedValue(false);
  h.set.mockReset().mockResolvedValue(undefined);
  h.scope.mockReset();
});

describe('whatsapp.cod_outcome', () => {
  it('confirmed: a pending COD order becomes confirmed, tagged source whatsapp, in the store scope', async () => {
    expect(await handleStoreEvent(cod('confirmed'))).toBe('applied');
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, 'o1', 'confirmed');
    expect(h.scope).toHaveBeenCalledWith(STORE);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.cod_outcome',
        storeId: STORE,
        details: expect.objectContaining({ outcome: 'confirmed', source: 'whatsapp', acted: true }),
      })
    );
  });

  it('refused: a pending or confirmed order is cancelled', async () => {
    await handleStoreEvent(cod('refused'));
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, 'o1', 'cancelled');
    h.updateStatus.mockClear();
    h.order.mockResolvedValue({ id: 'o1', status: 'confirmed', paymentStatus: 'unpaid' });
    await handleStoreEvent(cod('refused'));
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, 'o1', 'cancelled');
  });

  it('no_reply: recorded, nothing changes', async () => {
    expect(await handleStoreEvent(cod('no_reply'))).toBe('applied');
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['shipped', 'unpaid'],
    ['delivered', 'unpaid'],
    ['cancelled', 'unpaid'],
    ['pending', 'paid'], // an online-paid order is not a COD order awaiting an answer
  ])('a late answer for a %s/%s order changes nothing', async (status, paymentStatus) => {
    h.order.mockResolvedValue({ id: 'o1', status, paymentStatus });
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(await handleStoreEvent(cod('refused'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('an already-confirmed order answered "confirmed" again is a no-op', async () => {
    h.order.mockResolvedValue({ id: 'o1', status: 'confirmed', paymentStatus: 'unpaid' });
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('an unknown order is acknowledged, not retried forever', async () => {
    h.order.mockResolvedValue(null);
    expect(await handleStoreEvent(cod('confirmed'))).toBe('unknown_order');
  });
});

describe('idempotency and validation', () => {
  it('a redelivered envelope id is skipped without touching the order', async () => {
    const e = cod('confirmed');
    expect(await handleStoreEvent(e)).toBe('applied');
    expect(h.set).toHaveBeenCalledWith(`wa-in:${e.id}`, '1', 7 * 24 * 3600);
    h.exists.mockResolvedValue(true);
    h.order.mockClear();
    h.updateStatus.mockClear();
    expect(await handleStoreEvent(e)).toBe('duplicate');
    expect(h.order).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('the seen marker is written AFTER the action: a failed action is replayed, not lost', async () => {
    h.updateStatus.mockRejectedValueOnce(new Error('db blip'));
    const e = cod('confirmed');
    await expect(handleStoreEvent(e)).rejects.toThrow('db blip');
    expect(h.set).not.toHaveBeenCalled();
    expect(await handleStoreEvent(e)).toBe('applied');
  });

  it.each([
    ['not an object', 'x'],
    ['unknown type', cod('confirmed', { type: 'whatsapp.nope' })],
    ['bad outcome', cod('maybe')],
    ['wrong version', cod('confirmed', { v: 2 })],
    ['no store', cod('confirmed', { storeId: '' })],
  ])('%s: dropped as invalid, nothing touched', async (_n, body) => {
    expect(await handleStoreEvent(body)).toBe('invalid');
    expect(h.order).not.toHaveBeenCalled();
  });
});

describe('whatsapp.order_after_erasure', () => {
  const erasure = () => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    type: 'whatsapp.order_after_erasure',
    v: 1,
    storeId: STORE,
    occurredAt: '2026-10-25T10:00:00.000Z',
    data: { orderId: 'o1', buyerKey: BUYER },
  });
  it('cancels an order that is still open and leaves a fulfilled one', async () => {
    expect(await handleStoreEvent(erasure())).toBe('applied');
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, 'o1', 'cancelled');
    h.updateStatus.mockClear();
    h.order.mockResolvedValue({ status: 'shipped' });
    expect(await handleStoreEvent(erasure())).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });
});

describe('queue wiring (cf/queues.ts)', () => {
  const msg = (body: unknown, attempts = 1) => ({
    id: 'm1',
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it('acks an applied message, retries a transient failure with backoff, acks the DLQ', async () => {
    const ok = msg(cod('confirmed'));
    await handleQueueBatch({ queue: 'ebda-store-events', messages: [ok] });
    expect(ok.ack).toHaveBeenCalled();

    h.updateStatus.mockRejectedValueOnce(new Error('db'));
    const bad = msg(cod('confirmed'), 2);
    await handleQueueBatch({ queue: 'ebda-store-events', messages: [bad] });
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(bad.ack).not.toHaveBeenCalled();

    const dead = msg(cod('confirmed'));
    await handleQueueBatch({ queue: 'ebda-store-events-dlq', messages: [dead] });
    expect(dead.ack).toHaveBeenCalled();
  });

  it('an unreadable message is acked, never retried', async () => {
    const m = msg({ junk: true });
    await handleQueueBatch({ queue: 'ebda-store-events', messages: [m] });
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});
