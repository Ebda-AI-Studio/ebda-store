/**
 * FOUNDING-1 (M-082) against REAL Postgres: the founding-20 and referral free months. Concurrent first
 * payments must not take the 21st founding slot or a referrer's 4th reward, a replayed payment must not
 * grant twice, and a grant moves the paid period by exactly one month. No mocks: the advisory locks and the
 * UNIQUE idempotency key are what is under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma, runInStoreScope } from '@ebda/database';
import {
  awardGrantsAfterPayment,
  grantedPaidThrough,
  shiftedByGrants,
  sweepFreeMonthGrants,
  recordReferral,
  listGrants,
  FOUNDING_SLOTS,
  REFERRER_MAX_GRANTS,
} from '@api/services/billing/grants.service';
import { hasDb } from '../helpers/bundle-fixtures';

const TAG = `grant-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const uid = (l: string) => `${TAG}-${l}-${++seq}`;
const PERIOD_END = new Date(Date.UTC(2027, 0, 15, 12));
const PLUS_ONE_MONTH = new Date(Date.UTC(2027, 1, 15, 12));

async function mkStore(
  opts: { ownerId?: string; periodEnd?: Date | null; paid?: boolean; plan?: string } = {}
) {
  const ownerId =
    opts.ownerId ??
    (
      await prisma.user.create({
        data: {
          email: `${uid('o')}@example.test`,
          passwordHash: 'x'.repeat(60),
          firstName: 'O',
          lastName: 'G',
          role: 'store_admin',
          status: 'active',
          emailVerified: true,
        },
      })
    ).id;
  const store = await prisma.store.create({
    data: { name: 'Grant Store', slug: uid('s'), ownerId, status: 'active' },
  });
  const plan = opts.plan ?? 'growth';
  await prisma.storeSubscription.create({
    data: {
      storeId: store.id,
      planCode: plan,
      status: 'active',
      currentPeriodStart: new Date(Date.UTC(2026, 11, 15, 12)),
      currentPeriodEnd: opts.periodEnd === undefined ? PERIOD_END : opts.periodEnd,
    },
  });
  if (opts.paid !== false) await pay(store.id);
  return { storeId: store.id, ownerId };
}
async function pay(storeId: string, amountMinor = 349_000) {
  await prisma.billingEvent.create({
    data: {
      storeId,
      type: 'renewal',
      planCode: 'growth',
      amountMinor,
      provider: 'instapay',
      idempotencyKey: uid('ev'),
      status: 'succeeded',
    },
  });
}
const periodEnd = async (storeId: string) =>
  (await prisma.storeSubscription.findUnique({ where: { storeId } }))!.currentPeriodEnd;
const grantsOf = (kind: string, beneficiaryId?: string) =>
  prisma.billingGrant.findMany({ where: { kind, ...(beneficiaryId ? { beneficiaryId } : {}) } });
const reset = () => prisma.$executeRawUnsafe('TRUNCATE billing_grants, billing_referrals');

describe.skipIf(!hasDb)('FOUNDING-1 free-month grants (real Postgres)', () => {
  beforeEach(async () => {
    await reset();
  });

  it('a first paid payment earns one founding month, applied once, replays grant nothing', async () => {
    const a = await mkStore();
    await Promise.all(Array.from({ length: 6 }, () => awardGrantsAfterPayment(a.storeId)));
    await awardGrantsAfterPayment(a.storeId);
    const g = await grantsOf('founding', a.storeId);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ months: 1, status: 'applied' });
    expect(g[0].valueMinor).toBeGreaterThanOrEqual(0);
    expect(await periodEnd(a.storeId)).toEqual(PLUS_ONE_MONTH);
  });

  it('no paid payment, no grant (a zero-amount event is not a paid month)', async () => {
    const a = await mkStore({ paid: false });
    await pay(a.storeId, 0);
    await awardGrantsAfterPayment(a.storeId);
    expect(await grantsOf('founding')).toHaveLength(0);
    expect(await periodEnd(a.storeId)).toEqual(PERIOD_END);
  });

  it('the cap holds under concurrency: 19 taken, 6 concurrent first payers, exactly one takes slot 20', async () => {
    for (let i = 0; i < FOUNDING_SLOTS - 1; i++)
      await prisma.$executeRaw`INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
        VALUES (${crypto.randomUUID()}, 'founding', ${`filler-${i}`}, 1, 'applied', ${`founding:filler-${i}`})`;
    const stores = await Promise.all(Array.from({ length: 6 }, () => mkStore()));
    await Promise.all(stores.map(s => awardGrantsAfterPayment(s.storeId)));
    expect(await grantsOf('founding')).toHaveLength(FOUNDING_SLOTS);
    const extended = (
      await Promise.all(stores.map(async s => (await periodEnd(s.storeId))?.getTime()))
    ).filter(t => t === PLUS_ONE_MONTH.getTime());
    expect(extended).toHaveLength(1);
  });

  it('referral: both sides get a month after the referred store first PAYS, not before', async () => {
    const referrer = await mkStore();
    const referred = await mkStore({ paid: false });
    const slug = (await prisma.store.findUnique({ where: { id: referrer.storeId } }))!.slug;
    expect(await recordReferral(referred.storeId, slug)).toBe(true);
    await awardGrantsAfterPayment(referred.storeId); // no paid payment yet
    expect(await grantsOf('referral_referred')).toHaveLength(0);
    expect(await grantsOf('referral_referrer')).toHaveLength(0);
    await pay(referred.storeId);
    await Promise.all([
      awardGrantsAfterPayment(referred.storeId),
      awardGrantsAfterPayment(referred.storeId),
    ]);
    expect(await grantsOf('referral_referred', referred.storeId)).toHaveLength(1);
    expect(await grantsOf('referral_referrer', referrer.storeId)).toHaveLength(1);
    // referrer: referral month only (it never had a founding payment event processed here)
    expect(await periodEnd(referrer.storeId)).toEqual(PLUS_ONE_MONTH);
    // referred: founding month + referral month = two months
    expect((await periodEnd(referred.storeId))!.toISOString()).toBe(
      new Date(Date.UTC(2027, 2, 15, 12)).toISOString()
    );
  });

  it('a referrer is rewarded for at most 3 referrals even when 10 referred stores pay at once', async () => {
    const referrer = await mkStore();
    const slug = (await prisma.store.findUnique({ where: { id: referrer.storeId } }))!.slug;
    const referred = await Promise.all(Array.from({ length: 10 }, () => mkStore()));
    for (const r of referred) expect(await recordReferral(r.storeId, slug)).toBe(true);
    // Give each referred store its founding month up front so the global founding lock does not serialise
    // these payers: only the per-referrer lock is left to hold the cap.
    for (const r of referred)
      await prisma.$executeRaw`INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
        VALUES (${crypto.randomUUID()}, 'founding', ${r.storeId}, 1, 'applied', ${`founding:${r.storeId}`})`;
    await Promise.all(referred.map(r => awardGrantsAfterPayment(r.storeId)));
    expect(await grantsOf('referral_referrer', referrer.storeId)).toHaveLength(REFERRER_MAX_GRANTS);
    expect(await grantsOf('referral_referred')).toHaveLength(10); // the referred side is not capped
    const end = (await periodEnd(referrer.storeId))!;
    expect(end).toEqual(new Date(Date.UTC(2027, 3, 15, 12))); // +3 months
  });

  it('self-referral (same owner), unknown slug and repeat links are ignored', async () => {
    const a = await mkStore();
    const sameOwner = await mkStore({ ownerId: a.ownerId });
    const slugA = (await prisma.store.findUnique({ where: { id: a.storeId } }))!.slug;
    expect(await recordReferral(sameOwner.storeId, slugA)).toBe(false);
    expect(await recordReferral(a.storeId, 'no-such-store-slug')).toBe(false);
    const other = await mkStore();
    expect(await recordReferral(other.storeId, slugA)).toBe(true);
    const third = await mkStore();
    const slugThird = (await prisma.store.findUnique({ where: { id: third.storeId } }))!.slug;
    expect(await recordReferral(other.storeId, slugThird)).toBe(false); // first link wins
    expect(await prisma.billingReferral.count()).toBe(1);
  });

  it('a grant waits (pending) while the store has no period or a charge is in flight, then applies', async () => {
    const noPeriod = await mkStore({ periodEnd: null });
    await awardGrantsAfterPayment(noPeriod.storeId);
    expect((await grantsOf('founding', noPeriod.storeId))[0].status).toBe('pending');
    await prisma.storeSubscription.update({
      where: { storeId: noPeriod.storeId },
      data: { currentPeriodEnd: PERIOD_END },
    });
    await prisma.billingEvent.create({
      data: {
        storeId: noPeriod.storeId,
        type: 'renewal',
        amountMinor: 349_000,
        provider: 'instapay',
        idempotencyKey: uid('inflight'),
        status: 'pending',
      },
    });
    await awardGrantsAfterPayment(noPeriod.storeId);
    expect((await grantsOf('founding', noPeriod.storeId))[0].status).toBe('pending');
    expect(await periodEnd(noPeriod.storeId)).toEqual(PERIOD_END);
    await prisma.billingEvent.updateMany({
      where: { storeId: noPeriod.storeId, status: 'pending' },
      data: { status: 'failed' },
    });
    await awardGrantsAfterPayment(noPeriod.storeId);
    expect((await grantsOf('founding', noPeriod.storeId))[0].status).toBe('applied');
    expect(await periodEnd(noPeriod.storeId)).toEqual(PLUS_ONE_MONTH);
  });

  it('inside runInStoreScope (the billing routes: no ambient transaction) the founding cap still holds', async () => {
    for (let i = 0; i < FOUNDING_SLOTS - 1; i++)
      await prisma.$executeRaw`INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
        VALUES (${crypto.randomUUID()}, 'founding', ${`filler-${i}`}, 1, 'applied', ${`founding:filler-${i}`})`;
    const stores = await Promise.all(Array.from({ length: 6 }, () => mkStore()));
    await Promise.all(
      stores.map(s => runInStoreScope(s.storeId, () => awardGrantsAfterPayment(s.storeId)))
    );
    expect(await grantsOf('founding')).toHaveLength(FOUNDING_SLOTS);
  });

  it('a payment smaller than one month of its plan does not earn or farm a grant', async () => {
    const referrer = await mkStore();
    const slug = (await prisma.store.findUnique({ where: { id: referrer.storeId } }))!.slug;
    const farm = await mkStore({ paid: false });
    expect(await recordReferral(farm.storeId, slug)).toBe(true);
    await pay(farm.storeId, 100); // 1 EGP on a 3,490 EGP plan
    await awardGrantsAfterPayment(farm.storeId);
    expect(await grantsOf('referral_referrer', referrer.storeId)).toHaveLength(0);
    expect(await grantsOf('founding', farm.storeId)).toHaveLength(0);
  });

  it('the sweep applies a pending grant and awards a qualifying store that never got one, oldest payment first', async () => {
    for (let i = 0; i < FOUNDING_SLOTS - 1; i++)
      await prisma.$executeRaw`INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
        VALUES (${crypto.randomUUID()}, 'founding', ${`filler-${i}`}, 1, 'applied', ${`founding:filler-${i}`})`;
    const older = await mkStore();
    await new Promise(r => setTimeout(r, 20));
    const newer = await mkStore();
    await sweepFreeMonthGrants(new Date(), { storeIds: [older.storeId, newer.storeId] });
    expect(await grantsOf('founding', older.storeId)).toHaveLength(1);
    expect(await grantsOf('founding', newer.storeId)).toHaveLength(0); // slot 20 went to the earlier payer
    expect(await periodEnd(older.storeId)).toEqual(PLUS_ONE_MONTH);
    // a pending grant (no period yet) is applied by the next sweep
    const late = await mkStore({ periodEnd: null });
    await prisma.$executeRaw`INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key)
      VALUES (${crypto.randomUUID()}, 'referral_referrer', ${late.storeId}, 1, 'pending', ${`referral:x-${late.storeId}:referrer`})`;
    await prisma.storeSubscription.update({
      where: { storeId: late.storeId },
      data: { currentPeriodEnd: PERIOD_END },
    });
    await sweepFreeMonthGrants();
    expect(await periodEnd(late.storeId)).toEqual(PLUS_ONE_MONTH);
  });

  it('a charge claimed before a grant landed is recognised as the same period (chain), and the floor survives an upgrade', async () => {
    const a = await mkStore();
    await awardGrantsAfterPayment(a.storeId);
    const tx = prisma as never;
    expect(await shiftedByGrants(tx, a.storeId, PERIOD_END, PLUS_ONE_MONTH)).toBe(true);
    expect(
      await shiftedByGrants(tx, a.storeId, new Date(PERIOD_END.getTime() + 1), PLUS_ONE_MONTH)
    ).toBe(false);
    expect(await grantedPaidThrough(tx, a.storeId)).toEqual(PLUS_ONE_MONTH);
  });

  it('the ledger is append-only and the admin view reports the caps', async () => {
    const a = await mkStore();
    await awardGrantsAfterPayment(a.storeId);
    await expect(prisma.$executeRawUnsafe('DELETE FROM billing_grants')).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE billing_grants SET months = 1, value_minor = 999999`)
    ).rejects.toThrow();
    const view = await listGrants();
    expect(view.foundingUsed).toBe(1);
    expect(view.foundingSlots).toBe(FOUNDING_SLOTS);
    expect(view.grants[0]).toMatchObject({
      kind: 'founding',
      status: 'applied',
      beneficiaryId: a.storeId,
    });
  });
});
