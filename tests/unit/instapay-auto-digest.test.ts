/** INSTAPAY-AUTO-1 S8: the daily digest stamps `digestSentAt` only when the brain says sent:true, retries instead of losing, paginates and reminds. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  alert: vi.fn(async () => undefined),
  effects: vi.fn(async () => undefined),
  brain: vi.fn(async () => true),
  audit: vi.fn(async () => undefined),
  storeUpdate: vi.fn(async () => ({})),
  send: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: h.effects,
}));
vi.mock('../../apps/api/src/services/billing/instapay-notify-brain', () => ({
  notifyBrain: h.brain,
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: h.send } }));
vi.mock('../../apps/api/src/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: h.audit,
}));
vi.mock('../../apps/api/src/services/billing/charge-amount', async importOriginal => ({
  ...(await importOriginal<object>()),
  resolvePlatformVat: async () => ({ enabled: false, rateBps: 0, mode: 'inclusive' }),
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: h.storeUpdate,
}));
vi.mock(
  '../../apps/api/src/services/payment-providers/instapay-receipt.service',
  async importOriginal => {
    const real = await importOriginal<{ InstapayReceiptService: object }>();
    return {
      ...real,
      InstapayReceiptService: Object.assign(Object.create(real.InstapayReceiptService), {
        deleteImages: async () => undefined,
      }),
    };
  }
);
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const fake: Record<string, unknown> = {
    store: {
      findUnique: async () => ({ ownerId: null, billingSuspendedReason: null, name: 'Demo' }),
    },
  };
  const prisma = new Proxy(real.prisma, {
    get: (t, p) => (typeof p === 'string' && p in fake ? fake[p] : Reflect.get(t, p)),
  });
  return { ...real, prisma, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma) };
});

import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import {
  decideAndActivate,
  runAutoDigest,
} from '../../apps/api/src/services/billing/instapay-auto-confirm.service';
import { setAutoMode } from '../../apps/api/src/services/billing/instapay-auto-settings';
import {
  A,
  HANDLE,
  buildWorld,
  goodRead,
  seedClaim,
  type World,
} from '../helpers/instapay-auto-world';

let w: World;
let n = 0;
beforeEach(async () => {
  process.env.EBDA_INSTAPAY_HANDLE = HANDLE;
  Object.values(h).forEach(f => f.mockClear());
  h.brain.mockResolvedValue(true);
  registerPlatformRouter();
  w = buildWorld();
  await setAutoMode('live', 'ahmad', 'live for the test');
});
const autoRow = (state = 'auto_confirmed', createdAt = Date.now() - 1000) => {
  const id = `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`;
  w.db
    .prepare(
      `INSERT INTO instapay_auto_confirmations (id, store_id, claim_id, receipt_id, state, reasons, amount_minor, expected_amount_minor, is_first_payment, idempotency_key, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, '[]', 5000, 5000, 1, ?, ?, ?)`
    )
    .run(id, A, `c${id}`, `r${id}`, state, `k${id}`, createdAt, createdAt);
  return id;
};
const stamped = () =>
  w.db
    .prepare('SELECT COUNT(*) n FROM instapay_auto_confirmations WHERE digest_sent_at IS NOT NULL')
    .get() as { n: number };

describe('S8 digest', () => {
  it('3 undelivered rows: ONE digest call with 3 items and all 3 stamped', async () => {
    autoRow();
    autoRow();
    autoRow();
    const out = await runAutoDigest();
    expect(out).toMatchObject({ listed: 3, stamped: 3 });
    const digests = h.brain.mock.calls.filter(c => c[0] === 'digest');
    expect(digests).toHaveLength(1);
    expect(digests[0][1]).toHaveLength(3);
    expect(digests[0][1][0]).toMatchObject({
      product: 'store',
      kind: 'subscription',
      amountMinor: 5000,
    });
    expect(stamped().n).toBe(3);
  });
  it('the brain down: nothing is stamped, the next run resends the same rows', async () => {
    autoRow();
    autoRow();
    h.brain.mockResolvedValue(false);
    expect(await runAutoDigest()).toMatchObject({ listed: 2, stamped: 0 });
    expect(stamped().n).toBe(0);
    h.brain.mockResolvedValue(true);
    expect(await runAutoDigest()).toMatchObject({ listed: 2, stamped: 2 });
  });
  it('digestSentAt is stamped only from sent:true: a send that answers false (e.g. an empty or capped digest) stamps nothing', async () => {
    autoRow();
    h.brain.mockResolvedValueOnce(false);
    await runAutoDigest();
    expect(stamped().n).toBe(0);
  });
  it('no rows: no call at all', async () => {
    expect(await runAutoDigest()).toEqual({ listed: 0, stamped: 0, reminded: 0 });
    expect(h.brain).not.toHaveBeenCalled();
  });
  it('a reverted row and an already-stamped row are not listed', async () => {
    autoRow('reverted');
    const done = autoRow();
    w.db
      .prepare('UPDATE instapay_auto_confirmations SET digest_sent_at = 1 WHERE id = ?')
      .run(done);
    expect((await runAutoDigest()).listed).toBe(0);
  });
  it('250 rows paginate without dropping any (200 + 50)', async () => {
    for (let i = 0; i < 250; i++) autoRow();
    const out = await runAutoDigest();
    expect(out).toMatchObject({ listed: 250, stamped: 250 });
    const sizes = h.brain.mock.calls.filter(c => c[0] === 'digest').map(c => c[1].length);
    expect(sizes).toEqual([200, 50]);
  });
  it('the second page refused (the daily cap): page one stays stamped, page two waits for the next run, nothing lost', async () => {
    for (let i = 0; i < 250; i++) autoRow();
    h.brain.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await runAutoDigest();
    expect(stamped().n).toBe(200);
    h.brain.mockResolvedValue(true);
    await runAutoDigest();
    expect(stamped().n).toBe(250);
  });
  it('undelivered for over 26 hours raises a P1', async () => {
    autoRow('auto_confirmed', Date.now() - 27 * 3600_000);
    h.brain.mockResolvedValue(false);
    await runAutoDigest();
    expect(h.alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
    h.alert.mockClear();
    const w2 = Date.now();
    void w2;
  });
  it('a waiting claim gets one reminder and is stamped; a pure switch outcome is not reminded', async () => {
    await setAutoMode('live', 'ahmad', 'live for the test');
    const bad = seedClaim(w, { read: goodRead({ amountMinor: 5001 }) });
    await decideAndActivate({ storeId: A, claimId: bad.claimId });
    h.brain.mockClear();
    const out = await runAutoDigest();
    expect(out.reminded).toBe(1);
    expect(h.brain.mock.calls.find(c => c[0] === 'waiting')?.[1][0]).toMatchObject({
      reasons: ['AMOUNT_MISMATCH'],
    });
    h.brain.mockClear();
    expect((await runAutoDigest()).reminded).toBe(0); // stamped: not reminded twice
  });
  it('INSTAPAY-CLEAN-1: a payment becomes clean only after its digest was SENT, so a second payment over the cap waits until then', async () => {
    const first = seedClaim(w, { reference: '100000000001' });
    expect((await decideAndActivate({ storeId: A, claimId: first.claimId })).state).toBe(
      'auto_confirmed'
    );
    const yearly1 = seedClaim(w, {
      interval: 'yearly',
      reference: '100000000002',
      read: goodRead({ amountMinor: 50000, reference: '100000000002' }),
    });
    expect(await decideAndActivate({ storeId: A, claimId: yearly1.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['FIRST_PAYMENT_OVER_CAP'],
    });
    await runAutoDigest(); // the digest reaches Ahmad
    const yearly2 = seedClaim(w, {
      interval: 'yearly',
      reference: '100000000003',
      read: goodRead({ amountMinor: 50000, reference: '100000000003' }),
    });
    expect((await decideAndActivate({ storeId: A, claimId: yearly2.claimId })).state).toBe(
      'auto_confirmed'
    );
  });
});
