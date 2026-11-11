/**
 * WhatsApp -> Store consumer (contract section 8): COD outcomes and the erasure race, applied once,
 * tenant-scoped, the Store staying the only writer of order state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inScope: { v: false },
  alert: vi.fn(),
  applyEntitlement: vi.fn(),
  linked: vi.fn(),
  lock: vi.fn(),
  order: vi.fn(),
  updateStatus: vi.fn(),
  audit: vi.fn(),
  exists: vi.fn(),
  set: vi.fn(),
  scope: vi.fn(),
  optOut: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    // tagged template: SELECT ... FOR UPDATE
    $queryRaw: (...a: unknown[]) => {
      expect(h.inScope.v, 'row lock taken outside the tenant context').toBe(true);
      return h.lock(...a);
    },
    order: {
      findUnique: (...a: unknown[]) => {
        expect(h.inScope.v, 'order read outside the tenant context').toBe(true);
        return h.order(...a);
      },
    },
  },
  runInTenantContext: async (s: string, fn: () => unknown) => {
    h.scope(s);
    h.inScope.v = true;
    try {
      return await fn();
    } finally {
      h.inScope.v = false;
    }
  },
}));
vi.mock('@api/lib/wa/consent', () => ({ applyOptOutChanged: h.optOut }));
vi.mock('@api/lib/wa/link', () => ({
  isWhatsAppLinked: h.linked,
  WhatsAppLinkService: { applyEntitlement: h.applyEntitlement },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    updateStatus: (...a: unknown[]) => {
      expect(h.inScope.v, 'status written outside the tenant context').toBe(true);
      return h.updateStatus(...a);
    },
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: h.audit }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('@api/services/redis.service', () => ({ redis: { exists: h.exists, set: h.set } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleStoreEvent } from '@api/lib/wa/store-events-consumer';
import { handleStoreEventsBatch } from '@api/lib/wa/store-events-queue';

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

const COD_PAY = [{ provider: 'cod', status: 'cod_pending' }];
const order = (extra: object = {}) => ({
  id: 'o1',
  status: 'pending',
  paymentStatus: 'unpaid',
  createdAt: new Date('2026-10-25T09:00:00Z'),
  payments: COD_PAY,
  ...extra,
});

beforeEach(() => {
  h.linked.mockReset().mockResolvedValue(true);
  h.lock.mockReset().mockResolvedValue([{ id: 'o1' }]);
  h.order.mockReset().mockResolvedValue(order());
  h.updateStatus.mockReset().mockResolvedValue(undefined);
  h.audit.mockReset().mockResolvedValue(undefined);
  h.exists.mockReset().mockResolvedValue(false);
  h.set.mockReset().mockResolvedValue(undefined);
  h.scope.mockReset();
  h.alert.mockReset().mockResolvedValue(undefined);
  h.applyEntitlement.mockReset().mockResolvedValue(true);
  h.optOut.mockReset().mockResolvedValue('applied');
});

describe('whatsapp.cod_outcome', () => {
  it('confirmed: a pending COD order becomes confirmed, tagged source whatsapp, in the store scope', async () => {
    expect(await handleStoreEvent(cod('confirmed'))).toBe('applied');
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, 'o1', 'confirmed', {});
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
    expect(h.updateStatus).toHaveBeenCalledWith(
      STORE,
      'o1',
      'cancelled',
      expect.objectContaining({
        onlyFrom: ['pending', 'confirmed'],
        exceptionNote: expect.stringContaining('Delivery exception'),
      })
    );
    h.updateStatus.mockClear();
    h.order.mockResolvedValue(order({ status: 'confirmed' }));
    await handleStoreEvent(cod('refused'));
    expect(h.updateStatus).toHaveBeenCalledWith(
      STORE,
      'o1',
      'cancelled',
      expect.objectContaining({
        onlyFrom: ['pending', 'confirmed'],
        exceptionNote: expect.stringContaining('Delivery exception'),
      })
    );
  });

  it('the order moved on between the read and the change (a refused transition): not acted, audited, never a retry', async () => {
    const { AppError } = await import('@api/middleware/error-handler');
    h.updateStatus.mockRejectedValueOnce(new AppError(400, 'INVALID_STATUS_TRANSITION', 'shipped'));
    await expect(handleStoreEvent(cod('refused'))).resolves.toBe('ignored');
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.cod_outcome',
        details: expect.objectContaining({ acted: false, refused: 'INVALID_STATUS_TRANSITION' }),
      })
    );
  });

  it('any other failure of the change still throws (the queue retries it)', async () => {
    h.updateStatus.mockRejectedValueOnce(new Error('DO unreachable'));
    await expect(handleStoreEvent(cod('refused'))).rejects.toThrow('DO unreachable');
  });

  it('no_reply: recorded, nothing changes', async () => {
    expect(await handleStoreEvent(cod('no_reply'))).toBe('applied');
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['shipped', 'unpaid'],
    ['delivered', 'unpaid'],
  ])(
    'a "refused" for a %s/%s order: the DO refuses the cancel (status moved) and notes it; never a cancel (#614)',
    async (status, paymentStatus) => {
      const { AppError } = await import('@api/middleware/error-handler');
      h.order.mockResolvedValue(order({ status, paymentStatus }));
      expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
      h.updateStatus.mockRejectedValueOnce(new AppError(409, 'ORDER_STATUS_MOVED', status));
      expect(await handleStoreEvent(cod('refused'))).toBe('ignored');
      expect(h.updateStatus).toHaveBeenCalledTimes(1);
      expect(h.updateStatus).toHaveBeenCalledWith(
        STORE,
        'o1',
        'cancelled',
        expect.objectContaining({ onlyFrom: ['pending', 'confirmed'] })
      );
    }
  );

  it.each([
    ['cancelled', 'unpaid'],
    ['pending', 'paid'], // an online-paid order is not a COD order awaiting an answer
  ])('a late answer for a %s/%s order changes nothing', async (status, paymentStatus) => {
    h.order.mockResolvedValue(order({ status, paymentStatus }));
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(await handleStoreEvent(cod('refused'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('an already-confirmed order answered "confirmed" again is a no-op', async () => {
    h.order.mockResolvedValue(order({ status: 'confirmed' }));
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('the order row is locked before it is read, and the write happens in the same tenant context', async () => {
    await handleStoreEvent(cod('refused'));
    expect(h.lock).toHaveBeenCalledTimes(1);
    expect(h.lock.mock.invocationCallOrder[0]).toBeLessThan(h.order.mock.invocationCallOrder[0]!);
    expect(h.order.mock.invocationCallOrder[0]).toBeLessThan(
      h.updateStatus.mock.invocationCallOrder[0]!
    );
  });

  it('an unpaid CARD order (no COD payment) is never moved by a COD answer', async () => {
    h.order.mockResolvedValue(order({ payments: [{ provider: 'paymob', status: 'pending' }] }));
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(await handleStoreEvent(cod('refused'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('an answer older than the order itself is ignored (stale / replayed)', async () => {
    h.order.mockResolvedValue(order({ createdAt: new Date('2026-10-26T00:00:00Z') }));
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('a store that is not linked / entitled changes nothing', async () => {
    h.linked.mockResolvedValue(false);
    expect(await handleStoreEvent(cod('confirmed'))).toBe('ignored');
    expect(h.order).not.toHaveBeenCalled();
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('an order that vanished (404 from the status writer) is acknowledged, not retried forever', async () => {
    const { AppError } = await import('@api/middleware/error-handler');
    h.updateStatus.mockRejectedValueOnce(new AppError(404, 'NOT_FOUND', 'gone'));
    expect(await handleStoreEvent(cod('confirmed'))).toBe('unknown_order');
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
    ['store id that is not a uuid', cod('confirmed', { storeId: 'not-a-uuid' })],
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
    expect(h.updateStatus).toHaveBeenCalledWith(
      STORE,
      'o1',
      'cancelled',
      expect.objectContaining({ onlyFrom: ['pending', 'confirmed'] })
    );
    h.updateStatus.mockClear();
    h.order.mockResolvedValue(order({ status: 'shipped' }));
    expect(await handleStoreEvent(erasure())).toBe('ignored');
    expect(h.updateStatus).not.toHaveBeenCalled();
  });
});

describe('queue wiring (lib/wa/store-events-queue.ts, routed by worker.ts)', () => {
  const msg = (body: unknown, attempts = 1) => ({
    id: 'm1',
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it('acks an applied message, retries a transient failure with backoff, acks the DLQ', async () => {
    const ok = msg(cod('confirmed'));
    await handleStoreEventsBatch({ queue: 'ebda-store-events', messages: [ok] });
    expect(ok.ack).toHaveBeenCalled();

    h.updateStatus.mockRejectedValueOnce(new Error('db'));
    const bad = msg(cod('confirmed'), 2);
    await handleStoreEventsBatch({ queue: 'ebda-store-events', messages: [bad] });
    expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(bad.ack).not.toHaveBeenCalled();

    const dead = msg(cod('confirmed'));
    await handleStoreEventsBatch({ queue: 'ebda-store-events-dlq', messages: [dead] });
    expect(dead.ack).toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'wa.store_events.dead_letter' })
    );
  });

  it('an unreadable message is acked, never retried', async () => {
    const m = msg({ junk: true });
    await handleStoreEventsBatch({ queue: 'ebda-store-events', messages: [m] });
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe('whatsapp.entitlement_changed', () => {
  const ent = (version: number, extra: object = {}) => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    type: 'whatsapp.entitlement_changed',
    v: 1,
    storeId: STORE,
    occurredAt: '2026-10-25T10:00:00.000Z',
    data: {
      packageId: 'pkg-1',
      automation: true,
      status: 'active',
      validUntil: '2027-01-01T00:00:00.000Z',
      version,
      ...extra,
    },
  });

  it('is stored server-side, monotonic by version, even for a store that has not linked yet', async () => {
    h.linked.mockResolvedValue(false);
    expect(await handleStoreEvent(ent(4))).toBe('applied');
    expect(h.applyEntitlement).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({
        version: 4,
        status: 'active',
        validUntil: new Date('2027-01-01T00:00:00.000Z'),
      })
    );
    expect(h.linked).not.toHaveBeenCalled();
    expect(h.order).not.toHaveBeenCalled(); // never touches an order
  });

  it('an older or equal version is reported ignored (the writer says so)', async () => {
    h.applyEntitlement.mockResolvedValue(false);
    expect(await handleStoreEvent(ent(2))).toBe('ignored');
  });

  it.each([
    ['version 0', { version: 0 }],
    ['unknown status', { status: 'paused' }],
    ['no validUntil', { validUntil: 'soon' }],
  ])('%s is dropped as invalid', async (_n, extra) => {
    expect(await handleStoreEvent(ent(1, extra))).toBe('invalid');
    expect(h.applyEntitlement).not.toHaveBeenCalled();
  });
});

describe('whatsapp.opt_out_changed (envelope v1.1)', () => {
  const stop = (extra: object = {}) => ({
    id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    type: 'whatsapp.opt_out_changed',
    v: 1,
    storeId: STORE,
    occurredAt: '2026-10-25T10:00:00.000Z',
    data: { buyerKey: BUYER, optedOut: true, at: '2026-10-25T10:00:00.000Z', version: 4, ...extra },
  });

  it('applies a STOP even for a store that is not linked, passing buyer key and version through', async () => {
    h.linked.mockResolvedValue(false);
    expect(await handleStoreEvent(stop())).toBe('applied');
    expect(h.optOut).toHaveBeenCalledWith(STORE, BUYER, true, 4);
    expect(h.order).not.toHaveBeenCalled();
  });
  it('a failure THROWS so the queue redelivers: a STOP is never dropped', async () => {
    h.optOut.mockRejectedValue(new Error('db down'));
    await expect(handleStoreEvent(stop())).rejects.toThrow('db down');
    expect(h.set).not.toHaveBeenCalled(); // not marked seen
  });
  it('version 0 or a bad buyer key is dropped as invalid', async () => {
    expect(await handleStoreEvent(stop({ version: 0 }))).toBe('invalid');
    expect(await handleStoreEvent(stop({ buyerKey: 'short' }))).toBe('invalid');
    expect(h.optOut).not.toHaveBeenCalled();
  });
});
