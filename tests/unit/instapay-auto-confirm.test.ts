/**
 * INSTAPAY-AUTO-1 S4: decide and activate. The REAL recordManualPayment / platform router / dedupe SQL on a D1-shaped world
 * (tests/helpers/instapay-auto-world.ts); only the edges that need Postgres, storage, email or Telegram are doubles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  alert: vi.fn(async () => undefined),
  effects: vi.fn(async () => undefined),
  brain: vi.fn(async () => true),
  audit: vi.fn(async () => undefined),
  storeUpdate: vi.fn(async () => ({})),
  deleteImages: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: h.alert }));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: h.effects,
}));
vi.mock('../../apps/api/src/services/billing/instapay-notify-brain', () => ({
  notifyBrain: h.brain,
}));
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
        deleteImages: h.deleteImages,
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
import { decideAndActivate } from '../../apps/api/src/services/billing/instapay-auto-confirm.service';
import {
  setAutoMode,
  setStoreAuto,
} from '../../apps/api/src/services/billing/instapay-auto-settings';
import {
  A,
  B,
  HANDLE,
  buildWorld,
  goodRead,
  seedClaim,
  type World,
} from '../helpers/instapay-auto-world';

let w: World;
beforeEach(async () => {
  process.env.EBDA_INSTAPAY_HANDLE = HANDLE;
  Object.values(h).forEach(f => f.mockClear());
  h.brain.mockResolvedValue(true);
  registerPlatformRouter();
  w = buildWorld();
  await setAutoMode('live', 'ahmad', 'live for the test');
});

const rows = () =>
  w.db.prepare('SELECT * FROM instapay_auto_confirmations').all() as Array<Record<string, unknown>>;
const events = () =>
  w.db.prepare("SELECT * FROM billing_events WHERE type = 'manual_payment'").all();

describe('S4 decide and activate', () => {
  it('a full match in live mode activates the subscription, confirms the claim and writes one ledger row', async () => {
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(out).toMatchObject({ state: 'auto_confirmed', reasons: [] });
    expect(events()).toHaveLength(1);
    expect(
      w.db.prepare('SELECT status FROM store_subscriptions WHERE store_id = ?').get(A)
    ).toEqual({ status: 'active' });
    expect(
      w.db.prepare('SELECT status FROM manual_payment_claims WHERE id = ?').get(c.claimId)
    ).toEqual({ status: 'confirmed' });
    expect(rows()[0]).toMatchObject({
      state: 'auto_confirmed',
      billing_event_id: out.billingEventId,
    });
  });

  it('a replay returns the same row and writes no second ledger row', async () => {
    const c = seedClaim(w);
    const a = await decideAndActivate({ storeId: A, claimId: c.claimId });
    const b = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(b.billingEventId).toBe(a.billingEventId);
    expect(events()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('shadow mode decides but activates nothing: needs_human with SHADOW_MODE and the would-be verdict kept', async () => {
    await setAutoMode('shadow', 'ahmad', 'shadow for the test');
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(out).toMatchObject({ state: 'needs_human', reasons: ['SHADOW_MODE'] });
    expect(events()).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ state: 'needs_human', verdict: 'auto_confirm' });
    expect(
      w.db.prepare('SELECT status FROM manual_payment_claims WHERE id = ?').get(c.claimId)
    ).toEqual({ status: 'pending' });
    expect(h.brain).not.toHaveBeenCalled(); // a pure switch outcome is the normal manual flow, not "waiting on you"
  });

  it('mode off (the default) and a store switched off both wait for a human', async () => {
    await setAutoMode('off', 'ahmad', 'kill switch drill');
    const c1 = seedClaim(w);
    expect(await decideAndActivate({ storeId: A, claimId: c1.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['KILL_GLOBAL'],
    });
    await setAutoMode('live', 'ahmad', 'back on after drill');
    await setStoreAuto(B, false, 'ahmad', 'dispute on this store');
    const c2 = seedClaim(w, { storeId: B, reference: '999888777666' });
    expect(await decideAndActivate({ storeId: B, claimId: c2.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['KILL_STORE'],
    });
    expect(events()).toHaveLength(0);
  });

  it('the dedupe binding missing fails closed: needs_human, nothing activated', async () => {
    w = buildWorld({ dedupe: false });
    await setAutoMode('live', 'ahmad', 'live for the test');
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(out.state).toBe('needs_human');
    expect(out.reasons).toContain('DUPLICATE_REFERENCE');
    expect(events()).toHaveLength(0);
  });

  it('a yearly first payment is over the cap and waits; after a clean human-confirmed payment a yearly one is automatic', async () => {
    const y1 = seedClaim(w, {
      interval: 'yearly',
      read: goodRead({ amountMinor: 50000, reference: '555444333222' }),
      reference: '555444333222',
    });
    expect(await decideAndActivate({ storeId: A, claimId: y1.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['FIRST_PAYMENT_OVER_CAP'],
    });
    // a human-confirmed payment of this store makes it "clean"
    w.db
      .prepare(
        `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, status) VALUES ('h1', ?, 'manual_payment', 5000, 'manual', 'manual:instapay:111222333444', 'succeeded')`
      )
      .run(A);
    const y2 = seedClaim(w, {
      interval: 'yearly',
      read: goodRead({ amountMinor: 50000, reference: '777666555444' }),
      reference: '777666555444',
    });
    expect(await decideAndActivate({ storeId: A, claimId: y2.claimId })).toMatchObject({
      state: 'auto_confirmed',
      reasons: [],
    });
  });

  it('a one-piastre amount mismatch waits for a human and Ahmad is told at once', async () => {
    const c = seedClaim(w, { read: goodRead({ amountMinor: 5001 }) });
    expect(await decideAndActivate({ storeId: A, claimId: c.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['AMOUNT_MISMATCH'],
    });
    expect(h.brain).toHaveBeenCalledWith('waiting', [
      expect.objectContaining({ reasons: ['AMOUNT_MISMATCH'] }),
    ]);
  });

  it('when recordManualPayment fails: the dedupe claim is released, the row is failed, the claim stays pending, a P1 is raised', async () => {
    const c = seedClaim(w);
    // the subscription changes under the payment: the D1 compare-and-set loses every time
    const spy = vi.spyOn(
      await import('../../apps/api/src/services/platform/billing-d1'),
      'commitManualPaymentD1'
    );
    spy.mockResolvedValue('conflict');
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    spy.mockRestore();
    expect(out.state).toBe('failed');
    expect(rows()[0]).toMatchObject({ state: 'failed' });
    expect(
      w.db.prepare('SELECT status FROM manual_payment_claims WHERE id = ?').get(c.claimId)
    ).toEqual({ status: 'pending' });
    expect(w.dd.prepare('SELECT COUNT(*) n FROM instapay_dedupe').get()).toEqual({ n: 0 });
    expect(h.alert).toHaveBeenCalled();
  });
});
