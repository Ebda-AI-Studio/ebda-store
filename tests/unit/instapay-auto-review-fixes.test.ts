/**
 * INSTAPAY-AUTO-1 money-review fixes (findings 1, 2, 3, 5, 7, 9 of the Chat review, checked on the Store). Each test failed before its fix. The REAL recordManualPayment / platform router / dedupe SQL on a D1-shaped world
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
  backfillDedupeFromHistory,
  decideAndActivate,
  revertAutoConfirmed,
  runAutoDigest,
  sweepStuckAutoConfirmations,
} from '../../apps/api/src/services/billing/instapay-auto-confirm.service';
import {
  recordManualPayment,
  rejectClaim,
} from '../../apps/api/src/services/billing/account.service';
import {
  isStoreAutoEnabled,
  setAutoMode,
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
  h.storeUpdate.mockResolvedValue({});
  registerPlatformRouter();
  w = buildWorld();
  await setAutoMode('live', 'ahmad', 'live for the test');
});
const dedupeRows = () =>
  w.dd.prepare('SELECT kind, owner_id, state FROM instapay_dedupe ORDER BY kind').all();
const row = (id: string) =>
  w.db.prepare('SELECT * FROM instapay_auto_confirmations WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;

describe('finding 1: a person-confirmed payment claims the global index; history backfill', () => {
  it('a manual (human) confirmation claims the receipt, so the same transfer cannot auto-confirm on another merchant', async () => {
    await setAutoMode('off', 'ahmad', 'human-only for this case');
    const c = seedClaim(w, { reference: '123456789012', sha: 'a'.repeat(64) });
    await recordManualPayment({
      storeId: A,
      planCode: 'growth',
      interval: 'monthly',
      amountMinor: 5000,
      method: 'instapay',
      reference: '123456789012',
      paidAt: new Date(),
      actorId: 'ahmad',
      claimId: c.claimId,
    });
    expect(dedupeRows()).toEqual([
      { kind: 'img', owner_id: A, state: 'held' },
      { kind: 'ref', owner_id: A, state: 'held' },
    ]);
    await setAutoMode('live', 'ahmad', 'live again for B');
    const b = seedClaim(w, {
      storeId: B,
      reference: '555000555000',
      read: goodRead({ reference: '123456789012' }),
      sha: 'b'.repeat(64),
    });
    expect((await decideAndActivate({ storeId: B, claimId: b.claimId })).reasons).toContain(
      'DUPLICATE_REFERENCE'
    );
  });
  it('backfill burns every approved receipt, is idempotent, and a dry run writes nothing', async () => {
    const c = seedClaim(w, { reference: '777000777000', sha: 'c'.repeat(64) });
    w.db.prepare("UPDATE instapay_receipts SET status = 'approved' WHERE id = ?").run(c.receiptId);
    expect(await backfillDedupeFromHistory({ dryRun: true })).toEqual({
      scanned: 1,
      burned: 1,
      skipped: 0,
    });
    expect(dedupeRows()).toEqual([]);
    expect(await backfillDedupeFromHistory({ dryRun: false })).toMatchObject({ burned: 1 });
    expect(await backfillDedupeFromHistory({ dryRun: false })).toMatchObject({ burned: 1 });
    expect(dedupeRows()).toEqual([
      { kind: 'img', owner_id: A, state: 'burned' },
      { kind: 'ref', owner_id: A, state: 'burned' },
    ]);
  });
});

describe('finding 2: a lost race keeps the claim when the claim ended confirmed', () => {
  it('activation fails but a person confirmed the claim meanwhile: the dedupe claim is kept', async () => {
    const c = seedClaim(w);
    const spy = vi.spyOn(
      await import('../../apps/api/src/services/platform/billing-d1'),
      'commitManualPaymentD1'
    );
    spy.mockImplementation(async () => {
      w.db
        .prepare("UPDATE manual_payment_claims SET status = 'confirmed' WHERE id = ?")
        .run(c.claimId);
      return 'conflict';
    });
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    spy.mockRestore();
    expect(out.state).toBe('failed');
    expect(dedupeRows()).toHaveLength(2);
  });
});

describe('finding 3: system-decided money always reaches the digest; stuck rows are swept', () => {
  it('ledger recorded + activation failed: the row is in the next digest and revertable', async () => {
    const c = seedClaim(w);
    h.storeUpdate.mockRejectedValue(new Error('store write down'));
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    h.storeUpdate.mockResolvedValue({});
    expect(out.state).toBe('auto_confirmed');
    expect((await runAutoDigest()).stamped).toBe(1);
    expect(
      (
        await revertAutoConfirmed({
          id: out.id!,
          actor: 'telegram-owner',
          reason: 'not received',
          now: Date.now() + 60_000,
        })
      ).result
    ).toBe('reverted');
  });
  it('a pending_decision row older than 10 minutes is settled by the sweep: confirmed claim -> auto_confirmed, else needs_human', async () => {
    const paid = seedClaim(w, { reference: '100000000001' });
    const unpaid = seedClaim(w, { reference: '100000000002' });
    const old = Date.now() - 20 * 60_000;
    const ins = (id: string, c: { claimId: string; receiptId: string }) =>
      w.db
        .prepare(
          `INSERT INTO instapay_auto_confirmations (id, store_id, claim_id, receipt_id, state, reasons, expected_amount_minor, is_first_payment, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'pending_decision', '[]', 5000, 1, ?, ?)`
        )
        .run(id, A, c.claimId, c.receiptId, `k-${id}`, old);
    ins('11111111-0000-4000-8000-000000000001', paid);
    ins('11111111-0000-4000-8000-000000000002', unpaid);
    w.db
      .prepare(
        "UPDATE manual_payment_claims SET status = 'confirmed', billing_event_id = 'ev-1' WHERE id = ?"
      )
      .run(paid.claimId);
    await sweepStuckAutoConfirmations();
    expect(row('11111111-0000-4000-8000-000000000001')).toMatchObject({
      state: 'auto_confirmed',
      billing_event_id: 'ev-1',
    });
    expect(row('11111111-0000-4000-8000-000000000002')).toMatchObject({ state: 'needs_human' });
  });
});

describe('finding 5 (Ruling INSTAPAY-CAP-1): the first-payment cap is cumulative over not-yet-clean auto payments', () => {
  it('two monthly payments before the digest: the second waits; after the digest is sent it is automatic', async () => {
    const one = seedClaim(w, { reference: '200000000001' });
    expect((await decideAndActivate({ storeId: A, claimId: one.claimId })).state).toBe(
      'auto_confirmed'
    );
    const two = seedClaim(w, { reference: '200000000002' });
    expect(await decideAndActivate({ storeId: A, claimId: two.claimId })).toMatchObject({
      state: 'needs_human',
      reasons: ['FIRST_PAYMENT_OVER_CAP'],
    });
    await runAutoDigest();
    const three = seedClaim(w, { reference: '200000000003' });
    expect((await decideAndActivate({ storeId: A, claimId: three.claimId })).state).toBe(
      'auto_confirmed'
    );
  });
});

describe('finding 7: a rejected waiting claim releases its dedupe claim', () => {
  it('needs_human then rejected by a person: the reference and image are free again', async () => {
    const c = seedClaim(w, { read: goodRead({ amountMinor: 5001 }) });
    expect((await decideAndActivate({ storeId: A, claimId: c.claimId })).state).toBe('needs_human');
    expect(dedupeRows()).toHaveLength(2);
    await rejectClaim({
      storeId: A,
      claimId: c.claimId,
      note: 'wrong amount on the receipt',
      actorId: 'ahmad',
    });
    expect(dedupeRows()).toEqual([]);
  });
});

describe('finding 9: a revert that crashed after its state claim is finished by a replay, once', () => {
  it('row already reverted but nothing done: the replay voids, burns, disables and notifies exactly once', async () => {
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    const at = Date.now() + 60_000;
    // the crash: the state claim landed, the effects did not
    w.db
      .prepare(
        "UPDATE instapay_auto_confirmations SET state = 'reverted', reverted_at = ?, reverted_by = 'telegram-owner', revert_reason = 'not received', grace_until = ? WHERE id = ?"
      )
      .run(at, at + 48 * 3600_000, out.id);
    const first = await revertAutoConfirmed({
      id: out.id!,
      actor: 'telegram-owner',
      reason: 'not received',
      now: at,
    });
    expect(first.result).toBe('already_reverted');
    expect(
      w.db.prepare('SELECT status FROM billing_events WHERE id = ?').get(out.billingEventId)
    ).toEqual({ status: 'refunded' });
    expect(
      w.dd.prepare("SELECT COUNT(*) n FROM instapay_dedupe WHERE state = 'burned'").get()
    ).toEqual({ n: 2 });
    expect(await isStoreAutoEnabled(A)).toBe(false);
    await revertAutoConfirmed({
      id: out.id!,
      actor: 'telegram-owner',
      reason: 'not received',
      now: at,
    });
    expect(
      w.db.prepare("SELECT COUNT(*) n FROM billing_events WHERE type = 'refund'").get()
    ).toEqual({ n: 1 });
    const notices = h.effects.mock.calls.filter(x =>
      (x[0] as Array<{ kind: string }>).some(e => e.kind === 'instapay_not_received')
    );
    expect(notices).toHaveLength(1);
  });
});

describe('N2: the cumulative cap holds under concurrency (per-store serialisation)', () => {
  it('5 concurrent first payments of one store: at most one month is auto-confirmed, the rest wait or are retried', async () => {
    const claims = Array.from({ length: 5 }, (_, i) =>
      seedClaim(w, { reference: `30000000000${i}` })
    );
    const outs = await Promise.allSettled(
      claims.map(c => decideAndActivate({ storeId: A, claimId: c.claimId }))
    );
    const confirmed = outs.filter(
      o => o.status === 'fulfilled' && o.value.state === 'auto_confirmed'
    );
    expect(confirmed.length).toBeLessThanOrEqual(1);
    // a busy store is a retryable refusal, never a decision taken on a stale sum
    for (const o of outs)
      if (o.status === 'rejected') expect((o.reason as { code?: string }).code).toBe('AUTO_BUSY');
    // the retries (sequential, as the job retries them) never exceed the cap either
    for (const c of claims)
      await decideAndActivate({ storeId: A, claimId: c.claimId }).catch(() => undefined);
    const total = (
      w.db
        .prepare(
          "SELECT COUNT(*) n FROM instapay_auto_confirmations WHERE state = 'auto_confirmed'"
        )
        .get() as { n: number }
    ).n;
    expect(total).toBe(1);
  });
  it('a stale lock (a crashed run) does not block the store forever', async () => {
    w.db
      .prepare(
        `INSERT INTO system_settings (id, key, value, category, created_at) VALUES (?, ?, '{}', 'billing', ?)`
      )
      .run(
        `instapay.auto_confirm.lock.${A}`,
        `instapay.auto_confirm.lock.${A}`,
        Date.now() - 10 * 60_000
      );
    const c = seedClaim(w, { reference: '400000000001' });
    expect((await decideAndActivate({ storeId: A, claimId: c.claimId })).state).toBe(
      'auto_confirmed'
    );
  });
});

describe('backfill is paged', () => {
  it('more than one page of approved receipts: every one is burned', async () => {
    const ins = w.db.prepare(
      `INSERT INTO instapay_receipts (id, store_id, kind, storage_key, mime_type, size_bytes, sha256, status, reference_key) VALUES (?, ?, 'subscription', 'k', 'image/png', 1, ?, 'approved', ?)`
    );
    for (let i = 0; i < 501; i++) {
      const n = String(i).padStart(4, '0');
      ins.run(`rcpt-${n}`, A, n.padStart(64, 'a'), `5000000${n.padStart(5, '0')}`);
    }
    expect(await backfillDedupeFromHistory({ dryRun: false })).toEqual({
      scanned: 501,
      burned: 501,
      skipped: 0,
    });
    expect(w.dd.prepare("SELECT COUNT(*) n FROM instapay_dedupe WHERE kind = 'ref'").get()).toEqual(
      { n: 501 }
    );
  });
});

describe('Ruling INSTAPAY-REVERT-2 on the Store (no credits: a revert reverses what was NOT already refunded)', () => {
  it('a partial refund recorded before the revert is not reversed twice: the void takes only the remainder, the store still gets the grace', async () => {
    const c = seedClaim(w);
    const out = await decideAndActivate({ storeId: A, claimId: c.claimId });
    const { recordManualRefund } =
      await import('../../apps/api/src/services/billing/account.service');
    await recordManualRefund({
      eventId: out.billingEventId!,
      kind: 'refund',
      reference: '880000000001',
      recipientName: 'payer',
      refundedAt: new Date(),
      amountMinor: 2000,
      note: 'part returned',
      actorId: 'ahmad',
    });
    const at = Date.now() + 60_000;
    expect(
      (
        await revertAutoConfirmed({
          id: out.id!,
          actor: 'telegram-owner',
          reason: 'not received',
          now: at,
        })
      ).result
    ).toBe('reverted');
    const refunds = w.db
      .prepare(
        "SELECT amount_minor a FROM billing_events WHERE type = 'refund' ORDER BY amount_minor"
      )
      .all();
    expect(refunds).toEqual([{ a: 2000 }, { a: 3000 }]); // 2000 refunded by a person + the 3000 remainder voided: never more than paid
    expect(
      w.db.prepare('SELECT status FROM billing_events WHERE id = ?').get(out.billingEventId)
    ).toEqual({ status: 'refunded' });
  });
});
