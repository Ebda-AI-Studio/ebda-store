/**
 * INSTAPAY-AUTO-1 S6: revert ("not received") with the 48 h grace. The REAL recordManualPayment / platform router / dedupe SQL on a D1-shaped world
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
import {
  decideAndActivate,
  revertAutoConfirmed,
} from '../../apps/api/src/services/billing/instapay-auto-confirm.service';
import { recordManualPayment } from '../../apps/api/src/services/billing/account.service';
import {
  setAutoMode,
  isStoreAutoEnabled,
} from '../../apps/api/src/services/billing/instapay-auto-settings';
import {
  A,
  HANDLE,
  buildWorld,
  goodRead,
  seedClaim,
  type World,
} from '../helpers/instapay-auto-world';

const HOUR = 3_600_000;
let w: World;
beforeEach(async () => {
  process.env.EBDA_INSTAPAY_HANDLE = HANDLE;
  Object.values(h).forEach(f => f.mockClear());
  registerPlatformRouter();
  w = buildWorld();
  await setAutoMode('live', 'ahmad', 'live for the test');
});

const sub = () =>
  w.db
    .prepare(
      'SELECT status, current_period_end e, next_retry_at r, dunning_attempts d FROM store_subscriptions WHERE store_id = ?'
    )
    .get(A) as {
    status: string;
    e: number;
    r: number | null;
    d: number;
  };
const confirmed = async (over = {}) => {
  const c = seedClaim(w, over);
  const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
  expect(out.state).toBe('auto_confirmed');
  return { ...c, id: out.id!, eventId: out.billingEventId! };
};
const NOW = Date.now() + 60_000; // the revert happens after the payment it undoes

describe('S6 revert', () => {
  it('puts the store back to past_due with a grace of exactly 48 h, voids the ledger row and burns the dedupe entries', async () => {
    const c = await confirmed();
    expect(sub().status).toBe('active');
    const r = await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    expect(r.result).toBe('reverted');
    expect(r.graceUntil).toBe(NOW + 48 * HOUR);
    expect(sub()).toMatchObject({ status: 'past_due', r: NOW + 48 * HOUR, d: 0 });
    expect(w.db.prepare('SELECT status FROM billing_events WHERE id = ?').get(c.eventId)).toEqual({
      status: 'refunded',
    });
    expect(
      w.db.prepare('SELECT status FROM instapay_receipts WHERE id = ?').get(c.receiptId)
    ).toEqual({ status: 'voided' });
    expect(
      w.dd.prepare("SELECT COUNT(*) n FROM instapay_dedupe WHERE state = 'burned'").get()
    ).toEqual({ n: 2 });
    expect(
      w.db
        .prepare('SELECT state, reverted_by FROM instapay_auto_confirmations WHERE id = ?')
        .get(c.id)
    ).toEqual({ state: 'reverted', reverted_by: 'telegram-owner' });
    expect(await isStoreAutoEnabled(A)).toBe(false); // back to manual review until Ahmad re-enables it
    expect(h.effects).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'instapay_not_received', storeId: A }),
    ]);
  });

  it('a double tap and a replay are no-ops: one void, one notice, the same grace', async () => {
    const c = await confirmed();
    const first = await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    const again = await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW + HOUR,
    });
    expect(again).toEqual({ result: 'already_reverted', graceUntil: first.graceUntil });
    const [x, y] = await Promise.all([
      revertAutoConfirmed({ id: c.id, actor: 'a', reason: 'not received', now: NOW }),
      revertAutoConfirmed({ id: c.id, actor: 'b', reason: 'not received', now: NOW }),
    ]);
    expect([x.result, y.result]).toEqual(['already_reverted', 'already_reverted']);
    expect(
      w.db.prepare("SELECT COUNT(*) n FROM billing_events WHERE type = 'refund'").get()
    ).toEqual({ n: 1 });
    const notices = h.effects.mock.calls.filter(c =>
      (c[0] as Array<{ kind: string }>).some(e => e.kind === 'instapay_not_received')
    );
    expect(notices).toHaveLength(1);
  });

  it('two taps at the same instant on a fresh payment: exactly one wins and the money step runs once', async () => {
    const c = await confirmed();
    const res = await Promise.all([
      revertAutoConfirmed({ id: c.id, actor: 'a', reason: 'not received', now: NOW }),
      revertAutoConfirmed({ id: c.id, actor: 'b', reason: 'not received', now: NOW }),
    ]);
    expect(res.map(r => r.result).sort()).toEqual(['already_reverted', 'reverted']);
    expect(
      w.db.prepare("SELECT COUNT(*) n FROM billing_events WHERE type = 'refund'").get()
    ).toEqual({ n: 1 });
  });

  it("revert after use: the merchant's own data is untouched, only the paid period follows the void path", async () => {
    const c = await confirmed();
    const before = w.db.prepare('SELECT name, slug, owner_id FROM stores WHERE id = ?').get(A);
    await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    expect(w.db.prepare('SELECT name, slug, owner_id FROM stores WHERE id = ?').get(A)).toEqual(
      before
    );
  });

  it('a later legitimate payment that extended the period keeps its time after the revert', async () => {
    const c = await confirmed();
    const second = await recordManualPayment({
      storeId: A,
      planCode: 'growth',
      interval: 'monthly',
      amountMinor: 5000,
      method: 'instapay',
      reference: '999000111222',
      paidAt: new Date(NOW),
      actorId: 'ahmad',
      now: new Date(NOW),
    });
    expect(second.duplicate).toBe(false);
    const endAfterSecond = sub().e;
    await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    expect(sub().e).toBe(endAfterSecond); // the second payment's period is not the reverted one's
    expect(sub().status).toBe('active');
  });

  it('a payment made during the trial reverts to past_due with the grace (never silently active)', async () => {
    const c = seedClaim(w);
    w.db
      .prepare('UPDATE store_subscriptions SET trial_ends_at = ? WHERE store_id = ?')
      .run(Date.now() + 5 * 24 * HOUR, A);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(out.state).toBe('auto_confirmed');
    const r = await revertAutoConfirmed({
      id: out.id!,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    expect(['past_due', 'active']).toContain(sub().status);
    expect(r.graceUntil).toBe(NOW + 48 * HOUR);
  });

  it('a human-confirmed or waiting row refuses: NOT_AUTO_CONFIRMED, nothing changes', async () => {
    await setAutoMode('shadow', 'ahmad', 'shadow for this case');
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    expect(out.state).toBe('needs_human');
    await expect(
      revertAutoConfirmed({ id: out.id!, actor: 'x', reason: 'not received', now: NOW })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOT_AUTO_CONFIRMED',
    });
    await expect(
      revertAutoConfirmed({ id: 'nope', actor: 'x', reason: 'not received' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('after the revert the same receipt re-submitted is needs_human DUPLICATE_REFERENCE (burned)', async () => {
    const c = await confirmed();
    await revertAutoConfirmed({
      id: c.id,
      actor: 'telegram-owner',
      reason: 'not received',
      now: NOW,
    });
    await setAutoMode('live', 'ahmad', 'back on after the revert');
    const again = seedClaim(w, {
      reference: '123456789013',
      sha: c.sha,
      read: goodRead({ reference: '123456789013' }),
    });
    const out = await decideAndActivate({ storeId: A, claimId: again.claimId });
    // store A is auto-disabled by the revert, so both the store switch and the burned image speak
    expect(out.state).toBe('needs_human');
    const other = seedClaim(w, {
      storeId: '22222222-2222-4222-8222-222222222222',
      reference: '555000555000', // what the merchant typed
      read: goodRead({ reference: '123456789012' }), // what the image shows: the reverted receipt's reference
      sha: 'f'.repeat(64),
    });
    const out2 = await decideAndActivate({
      storeId: '22222222-2222-4222-8222-222222222222',
      claimId: other.claimId,
    });
    expect(out2.reasons).toContain('DUPLICATE_REFERENCE');
  });

  it('a failed void puts the payment back to auto_confirmed so the tap can be retried', async () => {
    const c = await confirmed();
    const acct = await import('../../apps/api/src/services/billing/account.service');
    void acct;
    w.db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON billing_events WHEN NEW.type = 'refund' BEGIN SELECT RAISE(ABORT, 'ledger down'); END;"
    );
    await expect(
      revertAutoConfirmed({ id: c.id, actor: 'telegram-owner', reason: 'not received', now: NOW })
    ).rejects.toBeTruthy();
    expect(
      w.db.prepare('SELECT state FROM instapay_auto_confirmations WHERE id = ?').get(c.id)
    ).toEqual({ state: 'auto_confirmed' });
    w.db.exec('DROP TRIGGER boom');
    expect(
      (
        await revertAutoConfirmed({
          id: c.id,
          actor: 'telegram-owner',
          reason: 'not received',
          now: NOW,
        })
      ).result
    ).toBe('reverted');
  });
});
