/** INSTAPAY-AUTO-1 S5: the trigger fails fast, never orphans a claim, and the stuck sweep re-sends only undecided claims. */
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
  enqueueAutoConfirm,
  sweepStuckAutoConfirmations,
} from '../../apps/api/src/services/billing/instapay-auto-confirm.service';
import { setAutoMode } from '../../apps/api/src/services/billing/instapay-auto-settings';
import { A, HANDLE, buildWorld, seedClaim, type World } from '../helpers/instapay-auto-world';

let w: World;
beforeEach(async () => {
  process.env.EBDA_INSTAPAY_HANDLE = HANDLE;
  Object.values(h).forEach(f => f.mockClear());
  registerPlatformRouter();
  w = buildWorld();
  await setAutoMode('shadow', 'ahmad', 'shadow for the test');
});
const rows = () => w.db.prepare('SELECT state, reasons FROM instapay_auto_confirmations').all();

describe('S5 trigger', () => {
  it('enqueues exactly one event for a claim', async () => {
    const c = seedClaim(w);
    expect(await enqueueAutoConfirm(A, c.claimId)).toBe('queued');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      name: 'instapay/auto-confirm.requested',
      data: { storeId: A, claimId: c.claimId },
    });
  });
  it('mode off enqueues nothing (the human review is untouched)', async () => {
    await setAutoMode('off', 'ahmad', 'kill switch drill');
    const c = seedClaim(w);
    expect(await enqueueAutoConfirm(A, c.claimId)).toBe('skipped');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('an enqueue that throws is failed fast: a needs_human row, the claim still pending, never an orphan', async () => {
    h.send.mockRejectedValueOnce(new Error('queue down'));
    const c = seedClaim(w);
    expect(await enqueueAutoConfirm(A, c.claimId)).toBe('failed');
    expect(rows()).toEqual([{ state: 'needs_human', reasons: '["EXTRACT_INCOMPLETE"]' }]);
    expect(
      w.db.prepare('SELECT status FROM manual_payment_claims WHERE id = ?').get(c.claimId)
    ).toEqual({ status: 'pending' });
    // and a later decision run is a no-op replay (the row exists)
    expect((await decideAndActivate({ storeId: A, claimId: c.claimId })).state).toBe('needs_human');
    expect(rows()).toHaveLength(1);
  });
});

describe('S5 stuck sweep', () => {
  it('re-sends only stale, undecided pending claims and is a no-op for decided ones', async () => {
    const old = Date.now() - 20 * 60_000;
    const stale = seedClaim(w, { claimedAt: old, reference: '100000000001' });
    const decided = seedClaim(w, { claimedAt: old, reference: '100000000002' });
    const fresh = seedClaim(w, { claimedAt: Date.now() - 60_000, reference: '100000000003' });
    await decideAndActivate({ storeId: A, claimId: decided.claimId });
    expect(await sweepStuckAutoConfirmations()).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith({
      name: 'instapay/auto-confirm.requested',
      data: { storeId: A, claimId: stale.claimId },
    });
    void fresh;
    h.send.mockClear();
    await decideAndActivate({ storeId: A, claimId: stale.claimId });
    expect(await sweepStuckAutoConfirmations()).toBe(0);
  });
  it('is off while the global mode is off', async () => {
    await setAutoMode('off', 'ahmad', 'kill switch drill');
    seedClaim(w, { claimedAt: Date.now() - 20 * 60_000 });
    expect(await sweepStuckAutoConfirmations()).toBe(0);
  });
  it('the job replays safely: the second run of the same event changes nothing', async () => {
    await setAutoMode('live', 'ahmad', 'live for the test');
    const c = seedClaim(w);
    const a = await decideAndActivate({ storeId: A, claimId: c.claimId });
    const b = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(a.state).toBe('auto_confirmed');
    expect(b).toEqual(a);
    expect(
      w.db.prepare("SELECT COUNT(*) n FROM billing_events WHERE type = 'manual_payment'").get()
    ).toEqual({ n: 1 });
  });
});
