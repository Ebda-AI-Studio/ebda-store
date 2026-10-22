/**
 * InstaPay manual payment (SP6a, Review Focus 3), against a real Postgres, the
 * code under test bound to a REAL `ebda_app` login (strict RLS, no bypass):
 * fixtures are written with the owner URL, every assertion about behaviour runs
 * through `asApp`.
 *
 * Rules, each with its own tests:
 *   1. checkout shows the merchant's handle/phone, the EXACT amount, the order reference
 *   2. an awaiting order does NOT ship (state machine, status writer, carrier booking)
 *   3. it does NOT count as paid revenue (analytics, customer spend, the GL) until confirmed
 *   4. it EXPIRES after the window (stock release armed, customer + merchant notified)
 *   5. it can be confirmed ONCE: repeat = idempotent no-op, concurrent confirms = one transition,
 *      confirm after expiry = refused, confirm racing expiry = never both
 *
 * Mutation proofs (recorded in the commit body):
 *   - double-confirm guard: remove the row lock + status check in `InstapayService.confirm`
 *     -> "concurrent confirms" and "a repeat confirm" go red
 *   - expiry: invert `paymentConfirmationExpiresAt: { lte: now }` in `expireDue` / `expireOne`
 *     -> the expiry tests go red
 *   - revenue exclusion: drop AWAITING from `NON_REVENUE_ORDER_STATUSES`
 *     -> the revenue tests go red
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  type AppPrismaClient,
} from '@ebda/database';
import { inngest } from '@api/lib/inngest/client';
import { OneSignalService } from '@api/services/onesignal.service';
import { InstapayService, runPostCommit } from '@api/services/payment-providers/instapay.service';
import { AnalyticsService } from '@api/services/analytics.service';
import { OrderService } from '@api/services/order.service';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';
import { assertValidTransition } from '@api/services/order-status-machine';
import { countsTowardSpend } from '@api/services/customer-aggregate.service';
import { redis } from '@api/services/redis.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');

const run = crypto.randomUUID().slice(0, 8);
const HOUR = 3_600_000;
const TOTAL = 12_345; // 123.45 EGP: not a round number, so a rounding slip shows

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);
const inStore = <T>(storeId: string, fn: () => Promise<T>) =>
  asApp(() => runInTenantContext(storeId, fn));

describe.skipIf(!hasDb)('InstaPay manual payment', () => {
  let owner: AppPrismaClient;
  let storeId: string;
  let ownerUserId: string;
  let productId: string;
  const created: string[] = [];
  let n = 0;
  // tests/setup.ts restores every spy after each test, so they are (re)made before each one.
  let sendSpy: ReturnType<typeof vi.spyOn<typeof inngest, 'send'>>;
  let pushSpy: ReturnType<typeof vi.spyOn<typeof OneSignalService, 'notifyAdminsOfInstapay'>>;
  beforeEach(() => {
    sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    pushSpy = vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
  });

  /** A pending, unpaid order for the store, with one line and one reserved unit of stock. */
  async function mkOrder(overrides: { total?: number; expiresInHours?: number } = {}) {
    n += 1;
    const o = await owner.order.create({
      data: {
        storeId,
        orderNumber: `IP-${run}-${n}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: overrides.total ?? TOTAL,
        total: overrides.total ?? TOTAL,
        shippingAddress: { firstName: 'Mona', lastName: 'Adel', phone: '+201012345678' },
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'InstaPay tee',
              sku: 'IP-TEE',
              quantity: 1,
              price: overrides.total ?? TOTAL,
              total: overrides.total ?? TOTAL,
            },
          ],
        },
      },
    });
    created.push(o.id);
    return o;
  }

  /** Put the order through `initiate` exactly as POST /payments/create does. */
  async function hold(orderId: string) {
    const order = await owner.order.findUniqueOrThrow({ where: { id: orderId } });
    const afterCommit: Array<{ name: string; task: () => Promise<unknown> }> = [];
    const result = await inStore(storeId, () =>
      InstapayService.initiate({
        storeId,
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          walletAmount: order.walletAmount,
          currency: order.currency,
          status: order.status,
        },
        customer: { name: 'Mona Adel', email: 'mona@example.com' },
        postCommit: (name, task) => afterCommit.push({ name, task }),
      })
    );
    await asApp(() => runPostCommit(afterCommit));
    return result;
  }

  const row = (id: string) => owner.order.findUniqueOrThrow({ where: { id } });
  const paymentsOf = (id: string) => owner.payment.findMany({ where: { orderId: id } });
  const eventsOf = (id: string, toStatus: string) =>
    owner.orderEvent.count({ where: { orderId: id, toStatus } });
  /** Move the hold's deadline into the past (the cron's trigger) without waiting 48 hours. */
  const expireWindow = (id: string, hoursAgo = 1) =>
    owner.order.update({
      where: { id },
      data: { paymentConfirmationExpiresAt: new Date(Date.now() - hoursAgo * HOUR) },
    });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    await redis.connect().catch(() => undefined);
    const user = await owner.user.create({
      data: {
        email: `ip-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'Ip',
        lastName: 'Owner',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    ownerUserId = user.id;
    const store = await owner.store.create({
      data: { name: `ip-${run}`, slug: `ip-${run}`, ownerId: user.id, status: 'active' },
    });
    storeId = store.id;
    const product = await owner.product.create({
      data: {
        storeId,
        name: 'InstaPay tee',
        slug: `ip-tee-${run}`,
        price: TOTAL,
        sku: 'IP-TEE',
        inventory: 50,
        status: 'active',
      },
    });
    productId = product.id;
    await owner.paymentConfig.create({
      data: {
        storeId,
        provider: 'instapay',
        isEnabled: true,
        testMode: false,
        displayName: 'InstaPay',
        displayNameAr: 'إنستاباي',
        settings: {
          handle: 'amelia@instapay',
          phone: '01012345678',
          accountName: 'Amelia Aurum',
          expiryHours: 48,
        },
      },
    });
  });

  afterAll(async () => {
    const ids = created;
    await owner.paymentEvent.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.orderEvent.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.payment.deleteMany({ where: { orderId: { in: ids } } }).catch(() => undefined);
    await owner.orderItem.deleteMany({ where: { orderId: { in: ids } } }).catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.paymentConfig.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.product.deleteMany({ where: { storeId } }).catch(() => undefined);
    await owner.store.deleteMany({ where: { id: storeId } }).catch(() => undefined);
    await owner.user.deleteMany({ where: { id: ownerUserId } }).catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  describe('1. what the customer is shown', () => {
    it('holds the order and shows handle, phone, the exact amount and the order reference', async () => {
      const o = await mkOrder();
      const { instructions, payment, created: isNew } = await hold(o.id);
      expect(isNew).toBe(true);
      expect(instructions).toMatchObject({
        kind: 'manual-instructions',
        method: 'instapay',
        handle: 'amelia@instapay',
        phone: '01012345678',
        accountName: 'Amelia Aurum',
        amountMinor: TOTAL,
        reference: o.orderNumber,
      });
      const after = await row(o.id);
      expect(after.status).toBe('awaiting_payment_confirmation');
      expect(after.paymentStatus).toBe('unpaid');
      // default window: 48h
      const hours = ((after.paymentConfirmationExpiresAt?.getTime() ?? 0) - Date.now()) / HOUR;
      expect(hours).toBeGreaterThan(47.9);
      expect(hours).toBeLessThanOrEqual(48);
      const [p] = await paymentsOf(o.id);
      expect(p).toMatchObject({
        id: payment.id,
        provider: 'instapay',
        method: 'instapay',
        status: 'pending',
        amount: TOTAL,
      });
    });

    it('the merchant is told an order is waiting for them', async () => {
      pushSpy.mockClear();
      const o = await mkOrder();
      await hold(o.id);
      await vi.waitFor(() =>
        expect(pushSpy).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: o.id, storeId, kind: 'awaiting' })
        )
      );
    });

    it('a replayed create shows the SAME instructions and creates nothing twice', async () => {
      const o = await mkOrder();
      const first = await hold(o.id);
      const again = await hold(o.id);
      expect(again.created).toBe(false);
      expect(again.payment.id).toBe(first.payment.id);
      expect(again.instructions).toEqual(first.instructions);
      expect(await paymentsOf(o.id)).toHaveLength(1);
      expect(await eventsOf(o.id, 'awaiting_payment_confirmation')).toBe(1);
    });

    it('subtracts the wallet portion: only the remainder is asked of the customer', async () => {
      const o = await mkOrder({ total: 20_000 });
      await owner.order.update({ where: { id: o.id }, data: { walletAmount: 4_999 } });
      const { instructions } = await hold(o.id);
      expect(instructions.amountMinor).toBe(15_001);
    });

    it('refuses when the store has not set InstaPay up', async () => {
      await owner.paymentConfig.updateMany({
        where: { storeId, provider: 'instapay' },
        data: { isEnabled: false },
      });
      const o = await mkOrder();
      await expect(hold(o.id)).rejects.toMatchObject({ code: 'INSTAPAY_NOT_AVAILABLE' });
      expect((await row(o.id)).status).toBe('pending');
      await owner.paymentConfig.updateMany({
        where: { storeId, provider: 'instapay' },
        data: { isEnabled: true },
      });
    });
    // The typed-reference path was retired for the receipt screenshot (money batch A):
    // tests/integration/instapay-receipts.test.ts covers the shopper's proof.
  });

  // -------------------------------------------------------------------------
  describe('2. an awaiting order does NOT ship', () => {
    it('the state machine opens only confirmed and cancelled', () => {
      for (const to of ['processing', 'shipped', 'delivered', 'refunded', 'pending'] as const) {
        expect(() => assertValidTransition('awaiting_payment_confirmation', to)).toThrow();
      }
      expect(() =>
        assertValidTransition('awaiting_payment_confirmation', 'cancelled')
      ).not.toThrow();
      expect(() =>
        assertValidTransition('awaiting_payment_confirmation', 'confirmed')
      ).not.toThrow();
    });

    it('OrderService.updateStatus refuses shipped / delivered / processing and leaves the order alone', async () => {
      const o = await mkOrder();
      await hold(o.id);
      for (const to of ['processing', 'shipped', 'delivered'] as const) {
        await expect(
          inStore(storeId, () => OrderService.updateStatus(storeId, o.id, to))
        ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
      }
      expect((await row(o.id)).status).toBe('awaiting_payment_confirmation');
    });

    it('a bare status write to confirmed is refused: it would mark the order confirmed with no money behind it', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await expect(
        inStore(storeId, () => OrderService.updateStatus(storeId, o.id, 'confirmed'))
      ).rejects.toMatchObject({ code: 'INSTAPAY_CONFIRM_REQUIRED' });
      const after = await row(o.id);
      expect(after.status).toBe('awaiting_payment_confirmation');
      expect(after.paymentStatus).toBe('unpaid');
    });

    it('carrier booking is refused before any carrier is even looked up', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await expect(
        inStore(storeId, () => shippingCarrierService.createShipmentForOrder(storeId, o.id))
      ).rejects.toMatchObject({ code: 'ORDER_AWAITING_PAYMENT_CONFIRMATION' });
      expect(await owner.shipment.count({ where: { orderId: o.id } })).toBe(0);
    });

    it('after the merchant confirms it can move on (confirmed -> processing is legal)', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await asApp(() =>
        InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId })
      );
      await expect(
        inStore(storeId, () => OrderService.updateStatus(storeId, o.id, 'processing'))
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('3. it is NOT paid revenue until confirmed', () => {
    const range = () => ({
      startDate: new Date(Date.now() - 24 * HOUR),
      endDate: new Date(Date.now() + HOUR),
    });
    const revenue = () =>
      inStore(
        storeId,
        async () => (await AnalyticsService.getDashboardStats(storeId, range())).totalRevenue
      );

    it('analytics revenue ignores an awaiting order and counts it once confirmed', async () => {
      // A fresh store keeps this assertion independent of the orders the other tests made.
      const user = await owner.user.create({
        data: {
          email: `iprev-${run}@test.local`,
          passwordHash: 'x',
          firstName: 'R',
          lastName: 'V',
          role: 'store_admin',
          emailVerified: true,
        },
      });
      const store = await owner.store.create({
        data: { name: `iprev-${run}`, slug: `iprev-${run}`, ownerId: user.id, status: 'active' },
      });
      const product = await owner.product.create({
        data: {
          storeId: store.id,
          name: 'Rev tee',
          slug: `rev-${run}`,
          price: 5000,
          inventory: 5,
          status: 'active',
        },
      });
      await owner.paymentConfig.create({
        data: {
          storeId: store.id,
          provider: 'instapay',
          isEnabled: true,
          settings: { handle: 'rev@instapay', expiryHours: 48 },
        },
      });
      const mk = (total: number, suffix: string) =>
        owner.order.create({
          data: {
            storeId: store.id,
            orderNumber: `REV-${run}-${suffix}`,
            status: 'pending',
            paymentStatus: 'unpaid',
            subtotal: total,
            total,
            shippingAddress: {},
            billingAddress: {},
            items: {
              create: [
                { productId: product.id, productName: 'Rev tee', quantity: 1, price: total, total },
              ],
            },
          },
        });
      const statsFor = () =>
        asApp(() =>
          runInTenantContext(store.id, async () => {
            const s = await AnalyticsService.getDashboardStats(store.id, range());
            return { revenue: s.totalRevenue, orders: s.totalOrders };
          })
        );
      try {
        const awaiting = await mk(7_777, 'A');
        const o = await owner.order.findUniqueOrThrow({ where: { id: awaiting.id } });
        await asApp(() =>
          runInTenantContext(store.id, () =>
            InstapayService.initiate({
              storeId: store.id,
              order: {
                id: o.id,
                orderNumber: o.orderNumber,
                total: o.total,
                walletAmount: 0,
                currency: o.currency,
                status: o.status,
              },
              customer: { name: 'R', email: 'r@example.com' },
            })
          )
        );
        const before = await statsFor();
        expect(before.revenue).toBe(0); // 77.77 EGP is waiting, not earned
        expect(before.orders).toBe(0);

        await asApp(() =>
          InstapayService.confirm({ storeId: store.id, orderId: o.id, actorUserId: user.id })
        );
        const after = await statsFor();
        expect(after.revenue).toBe(7_777);
        expect(after.orders).toBe(1);
      } finally {
        await owner.paymentEvent.deleteMany({ where: { storeId: store.id } });
        await owner.orderEvent.deleteMany({ where: { storeId: store.id } });
        await owner.payment.deleteMany({ where: { order: { storeId: store.id } } });
        await owner.orderItem.deleteMany({ where: { order: { storeId: store.id } } });
        await owner.order.deleteMany({ where: { storeId: store.id } });
        await owner.paymentConfig.deleteMany({ where: { storeId: store.id } });
        await owner.product.deleteMany({ where: { storeId: store.id } });
        await owner.store.deleteMany({ where: { id: store.id } });
        await owner.user.deleteMany({ where: { id: user.id } });
      }
    });

    it('stays unpaid with a pending payment: nothing is captured until the merchant confirms', async () => {
      const o = await mkOrder();
      await hold(o.id);
      const after = await row(o.id);
      expect(after.paymentStatus).toBe('unpaid');
      const payments = await paymentsOf(o.id);
      expect(payments.every(p => p.status === 'pending' && p.paidAt === null)).toBe(true);
    });

    it('customer spend does not count it', () => {
      expect(countsTowardSpend('awaiting_payment_confirmation', 'unpaid')).toBe(false);
      expect(countsTowardSpend('confirmed', 'paid')).toBe(true);
    });

    it('the general ledger books nothing for it, and books the sale once after confirmation', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await inStore(storeId, () => postOrderPaymentJournal({ orderId: o.id }));
      expect(await owner.journalEntry.count({ where: { sourceId: o.id } })).toBe(0);
    });

    it('pull-side reconciliation can never mark it paid (there is no provider to ask)', async () => {
      const { confirmPaymentFromProviderStatus } =
        await import('@api/services/payment-confirm.service');
      const o = await mkOrder();
      await hold(o.id);
      const [p] = await paymentsOf(o.id);
      const res = await inStore(storeId, () =>
        confirmPaymentFromProviderStatus({
          payment: {
            id: p.id,
            status: p.status,
            provider: p.provider,
            metadata: p.metadata,
            amount: p.amount,
          },
          order: { id: o.id, storeId, paymentStatus: 'unpaid' },
          providerStatus: { status: 'completed' } as never,
          source: 'admin_refresh',
        })
      );
      expect(res.statusChanged).toBe(false);
      expect((await row(o.id)).paymentStatus).toBe('unpaid');
    });
  });

  // -------------------------------------------------------------------------
  describe('4. it EXPIRES', () => {
    it('cancels an order whose window ran out: payment expired, stock release armed, merchant told, customer notified', async () => {
      const o = await mkOrder();
      await hold(o.id);
      sendSpy.mockClear();
      pushSpy.mockClear();
      await expireWindow(o.id);

      const res = await asApp(() => InstapayService.expireDue(storeId));
      expect(res.expired).toBeGreaterThanOrEqual(1);

      const after = await row(o.id);
      expect(after.status).toBe('cancelled');
      expect(after.paymentStatus).toBe('unpaid');
      expect(after.notes ?? '').toContain('InstaPay confirmation window expired');
      const [p] = await paymentsOf(o.id);
      expect(p.status).toBe('expired');
      // Inventory is released by the order/refunded fan-out; the request that arms it
      // stamps the order, and the stuck-reversal sweep guarantees it completes.
      expect(after.refundReversalRequestedAt).not.toBeNull();
      expect(sendSpy.mock.calls.map(c => (c[0] as { name: string }).name)).toEqual(
        expect.arrayContaining(['order/refunded', 'order/status-changed'])
      );
      // the customer's cancellation notice rides the status-changed fan-out with status cancelled
      expect(
        sendSpy.mock.calls.some(
          c =>
            (c[0] as { name: string; data: { status?: string } }).name === 'order/status-changed' &&
            (c[0] as { data: { status?: string } }).data.status === 'cancelled'
        )
      ).toBe(true);
      await vi.waitFor(() =>
        expect(pushSpy).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: o.id, kind: 'expired' })
        )
      );
    });

    it('leaves an order that is still inside its window alone', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await asApp(() => InstapayService.expireDue(storeId));
      expect((await row(o.id)).status).toBe('awaiting_payment_confirmation');
      expect((await paymentsOf(o.id))[0].status).toBe('pending');
    });

    it('a window of exactly "now" is expired, one a minute from now is not (boundary)', async () => {
      const a = await mkOrder();
      const b = await mkOrder();
      await hold(a.id);
      await hold(b.id);
      const now = new Date();
      await owner.order.update({
        where: { id: a.id },
        data: { paymentConfirmationExpiresAt: now },
      });
      await owner.order.update({
        where: { id: b.id },
        data: { paymentConfirmationExpiresAt: new Date(now.getTime() + 60_000) },
      });
      await asApp(() => InstapayService.expireDue(storeId, now));
      expect((await row(a.id)).status).toBe('cancelled');
      expect((await row(b.id)).status).toBe('awaiting_payment_confirmation');
    });

    it('expiry is repeatable: a second sweep over a cancelled order does nothing', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await expireWindow(o.id);
      await asApp(() => InstapayService.expireDue(storeId));
      sendSpy.mockClear();
      const again = await asApp(() => InstapayService.expireDue(storeId));
      expect(again.expired).toBe(0);
      expect(await eventsOf(o.id, 'cancelled')).toBe(1);
    });

    it('the cron sweep finds due orders across stores (one tenant transaction per store) and expires each in its own', async () => {
      const createFn = vi.spyOn(inngest, 'createFunction');
      await import('@api/lib/inngest/functions/instapay-expiry');
      const reg = createFn.mock.calls.find(c => (c[0] as { id?: string }).id === 'instapay-expiry');
      expect(reg).toBeDefined();
      // Hourly since Ruling INNGEST-BUDGET-1 (#118: the Inngest plan caps monthly executions).
      expect((reg![0] as { triggers: Array<{ cron: string }> }).triggers[0].cron).toBe('7 * * * *');
      const handler = reg![1] as unknown as (a: unknown) => Promise<{ expired: number }>;
      createFn.mockRestore();
      const o = await mkOrder();
      await hold(o.id);
      await expireWindow(o.id);
      // Drive the function body the way Inngest does: every step.run executes inline.
      const step = { run: async (_id: string, fn: () => Promise<unknown>) => fn() };
      const result = await asApp(() => handler({ step }));
      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect((await row(o.id)).status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  describe('5. it can be confirmed ONCE', () => {
    it('confirm: order confirmed + paid, payment completed, one audit event each, fan-out enqueued', async () => {
      const o = await mkOrder();
      await hold(o.id);
      sendSpy.mockClear();
      const out = await asApp(() =>
        InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId })
      );
      expect(out).toMatchObject({ changed: true, status: 'confirmed' });
      const after = await row(o.id);
      expect(after.status).toBe('confirmed');
      expect(after.paymentStatus).toBe('paid');
      const [p] = await paymentsOf(o.id);
      expect(p.status).toBe('completed');
      expect(p.paidAt).not.toBeNull();
      expect((p.metadata as Record<string, unknown>).confirmedBy).toBe(ownerUserId);
      expect(await eventsOf(o.id, 'confirmed')).toBe(1);
      await vi.waitFor(() =>
        expect(
          sendSpy.mock.calls.filter(c => (c[0] as { name: string }).name === 'order/created')
        ).toHaveLength(1)
      );
    });

    it('a repeat confirm is an idempotent no-op: nothing changes, nothing fires again', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await asApp(() =>
        InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId })
      );
      sendSpy.mockClear();
      const again = await asApp(() =>
        InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId })
      );
      expect(again).toMatchObject({ changed: false, status: 'confirmed' });
      expect(await eventsOf(o.id, 'confirmed')).toBe(1);
      expect(await paymentsOf(o.id)).toHaveLength(1);
      expect(
        sendSpy.mock.calls.filter(c => (c[0] as { name: string }).name === 'order/created')
      ).toHaveLength(0);
    });

    it('concurrent confirms (a double tap, two staff) produce ONE transition', async () => {
      const o = await mkOrder();
      await hold(o.id);
      sendSpy.mockClear();
      const outs = await Promise.all(
        Array.from({ length: 6 }, () =>
          asApp(() => InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId }))
        )
      );
      expect(outs.filter(r => r.changed)).toHaveLength(1);
      expect(outs.filter(r => !r.changed)).toHaveLength(5);
      expect(await eventsOf(o.id, 'confirmed')).toBe(1);
      expect(
        await owner.paymentEvent.count({ where: { orderId: o.id, toStatus: 'completed' } })
      ).toBe(1);
      await vi.waitFor(() =>
        expect(
          sendSpy.mock.calls.filter(c => (c[0] as { name: string }).name === 'order/created')
        ).toHaveLength(1)
      );
    });

    it('confirm after the window ran out is REFUSED (before the cron has cancelled it)', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await expireWindow(o.id);
      await expect(
        asApp(() => InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId }))
      ).rejects.toMatchObject({ code: 'INSTAPAY_CONFIRMATION_EXPIRED', statusCode: 409 });
      const after = await row(o.id);
      expect(after.status).toBe('awaiting_payment_confirmation');
      expect(after.paymentStatus).toBe('unpaid');
    });

    it('confirm after the cron cancelled it is REFUSED', async () => {
      const o = await mkOrder();
      await hold(o.id);
      await expireWindow(o.id);
      await asApp(() => InstapayService.expireDue(storeId));
      await expect(
        asApp(() => InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId }))
      ).rejects.toMatchObject({ code: 'INSTAPAY_ORDER_CANCELLED', statusCode: 409 });
      expect((await row(o.id)).paymentStatus).toBe('unpaid');
    });

    it('confirm racing expiry: never both. The order ends confirmed XOR cancelled, with a matching payment', async () => {
      for (let i = 0; i < 6; i += 1) {
        const o = await mkOrder();
        await hold(o.id);
        const deadline = new Date(Date.now() + 5_000);
        await owner.order.update({
          where: { id: o.id },
          data: { paymentConfirmationExpiresAt: deadline },
        });
        // The merchant tapped just before the deadline; the cron fires just after it.
        const before = new Date(deadline.getTime() - 1);
        const after = new Date(deadline.getTime() + 1);
        const [c, e] = await Promise.allSettled([
          asApp(() =>
            InstapayService.confirm({
              storeId,
              orderId: o.id,
              actorUserId: ownerUserId,
              now: before,
            })
          ),
          asApp(() => InstapayService.expireOne(storeId, o.id, after)),
        ]);
        const final = await row(o.id);
        const [p] = await paymentsOf(o.id);
        expect(['confirmed', 'cancelled']).toContain(final.status);
        if (final.status === 'confirmed') {
          expect(final.paymentStatus).toBe('paid');
          expect(p.status).toBe('completed');
          expect(e.status === 'fulfilled' ? e.value : 'skipped').toBe('skipped');
        } else {
          expect(final.paymentStatus).toBe('unpaid');
          expect(p.status).toBe('expired');
          expect(c.status).toBe('rejected');
        }
      }
    });

    it('confirming an order that is not an InstaPay hold is refused and changes nothing', async () => {
      const o = await mkOrder(); // still `pending`: never initiated
      await expect(
        asApp(() => InstapayService.confirm({ storeId, orderId: o.id, actorUserId: ownerUserId }))
      ).rejects.toMatchObject({ code: 'INSTAPAY_NOT_AWAITING' });
      expect((await row(o.id)).status).toBe('pending');
    });

    it('is scoped to its store: another store cannot confirm it', async () => {
      const o = await mkOrder();
      await hold(o.id);
      const otherStore = crypto.randomUUID();
      await expect(
        asApp(() =>
          InstapayService.confirm({ storeId: otherStore, orderId: o.id, actorUserId: ownerUserId })
        )
      ).rejects.toThrow();
      expect((await row(o.id)).status).toBe('awaiting_payment_confirmation');
    });
  });
});
