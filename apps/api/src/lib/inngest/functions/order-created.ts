import type { JobDef } from '../../jobs/types';
import { customerRow, isLiveCustomer } from '../../customer-directory';

/** The customer to mail: a DO-served store's customer comes from its DO and only when still active (N-9); else Postgres. */
async function customerOf(storeId: string, id: string) {
  const doRow = await customerRow(storeId, id);
  if (doRow !== undefined) return doRow && isLiveCustomer(doRow) ? doRow : null;
  return withStore(storeId, tx => tx.user.findFirst({ where: { id } }));
}
import { prisma, runInTenantContext, withStore } from '@ebda/database';
import { storeDb, storeMoney } from '../../repo-factory';
import { groupOrderLinesForDisplay, deliveryLineFromNotes } from '@ebda/shared';
import { EmailService, type OrderEmailData } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { OneSignalService } from '../../../services/onesignal.service';
import logger from '../../logger';
import { inngest } from '../client';
import { resolveOrderInvoiceRecipient } from '../../order-notification-address';

/**
 * Fans out the post-checkout side effects for a freshly-committed order.
 * Each side effect is wrapped in `step.run` so Inngest retries them
 * independently — a flaky SMTP server doesn't cancel the OneSignal push.
 *
 * Why this is async: at peak (Black Friday-style bursts) the inline
 * version blocked the checkout response on three external HTTP calls
 * (SMTP, OneSignal REST, dispatcher fan-out). Moving them onto Inngest
 * cuts checkout p95 by ~600ms in production and lets us retry on
 * provider hiccups without losing notifications.
 */
// Re-exported for its existing unit test; the rule lives with the refund path's (FU46-1a).
export { resolveOrderInvoiceRecipient };

export const orderCreated: JobDef = inngest.createFunction(
  {
    id: 'order-created-fanout',
    name: 'Order created — email + push + dispatcher fan-out',
    // Cap concurrent runs per store so a single tenant's burst can't
    // monopolize Inngest workers / hammer external providers. Limit
    // is 5 because Inngest's free plan caps per-function concurrency
    // at 5; bump alongside the plan if we ever upgrade.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, paymentMethod, locale } = event.data;

    // Guard against empty test payloads from Inngest's sync UI — they
    // arrive with `data: {}` and would crash Prisma with an
    // `id: undefined` validation error.
    if (!orderId || !storeId) {
      logger.warn({ event: event.name }, 'order/created fired without ids — skipping');
      return;
    }

    // FORCE RLS (migration complete_force_rls_coverage) filters orders to 0 rows
    // unless the tenant GUC is set. Inngest jobs run OUTSIDE the HTTP request, so
    // there is no tenant-context middleware here — set it explicitly from the
    // event's storeId, or this findUnique returns null and the fanout dies.
    // Fire-once-per-order guard. order/created can be enqueued for the SAME
    // paid order by both the customer-return confirm path AND the payment
    // webhook consumer (and Inngest delivers at-least-once). Atomically CLAIM
    // the order_created_notified_at stamp — only the first claimant proceeds;
    // any later enqueue (or a duplicate delivery) matches 0 rows and skips the
    // whole fanout, so the new-order email + admin OneSignal push fire exactly
    // once. Memoized as its own step, so a retry of a LATER step re-uses the
    // claim (count=1) and still re-runs only the failed sends.
    // PORTED (Ruling CF-JOBS-4): a store on its Durable Object claims in one section there and reads its order from the DO;
    // its customer is an identity row, read from the platform.
    const money = await storeMoney(storeId);
    const claim = await step.run('claim-order-created', async () =>
      money
        ? { count: (await money.orderNotifyClaim({ orderId })).claimed ? 1 : 0 }
        : runInTenantContext(storeId, () =>
            prisma.order.updateMany({
              where: { id: orderId, storeId, orderCreatedNotifiedAt: null },
              data: { orderCreatedNotifiedAt: new Date() },
            })
          )
    );
    if (claim.count === 0) {
      logger.info(
        { orderId, storeId },
        '[order-created] already notified — skipping duplicate fanout'
      );
      return;
    }

    const order = await step.run('load-order', async () => {
      if (money) {
        const row = await (
          await storeDb(storeId)
        ).order.findUnique({
          where: { id: orderId, storeId },
          include: {
            items: { include: { product: { select: { nameAr: true } } } },
            appliedPromotion: { select: { name: true, nameAr: true } },
          },
        });
        if (!row) throw new Error(`Order ${orderId} not found`);
        const customer = row.customerId ? await customerOf(storeId, row.customerId!) : null;
        return { ...row, customer };
      }
      return runInTenantContext(storeId, async () => {
        const row = await prisma.order.findUnique({
          where: { id: orderId, storeId },
          include: {
            customer: true,
            items: { include: { product: { select: { nameAr: true } } } },
            appliedPromotion: { select: { name: true, nameAr: true } },
          },
        });
        if (!row) throw new Error(`Order ${orderId} not found`);
        return row;
      });
    });

    const emailLocale = (locale ?? order.locale ?? undefined) as 'en' | 'ar' | undefined;

    const shippingAddress = order.shippingAddress as Record<string, unknown>;
    const guestFirstName =
      typeof shippingAddress?.firstName === 'string' ? shippingAddress.firstName : '';
    const guestLastName =
      typeof shippingAddress?.lastName === 'string' ? shippingAddress.lastName : '';
    const guestEmail = typeof shippingAddress?.email === 'string' ? shippingAddress.email : '';
    const guestPhone = typeof shippingAddress?.phone === 'string' ? shippingAddress.phone : '';

    const customerName =
      `${order.customer?.firstName || guestFirstName} ${order.customer?.lastName || guestLastName}`.trim() ||
      order.customer?.email ||
      guestEmail ||
      'Customer';

    const emailData: OrderEmailData = {
      orderNumber: order.orderNumber,
      customerName,
      customerEmail: order.customer?.email || guestEmail,
      // Bundle boxes collapse to ONE row each (see groupOrderLinesForDisplay)
      // — the emailed confirmation must show "Ramadan Box · 12.000 EGP",
      // never the per-component allocated shares that fund that one price.
      items: groupOrderLinesForDisplay(
        order.items as Array<{
          id: string;
          productName: string;
          variantName?: string | null;
          variantNameAr?: string | null;
          personalisation?: string | null;
          quantity: number;
          price: number;
          product?: { nameAr?: string | null } | null;
          bundleGroupId?: string | null;
          bundleName?: string | null;
          bundleNameAr?: string | null;
        }>
      ).map(row =>
        row.kind === 'bundle'
          ? { name: row.name, nameAr: row.nameAr, quantity: row.quantity, price: row.total }
          : {
              name: row.item.productName,
              nameAr: row.item.product?.nameAr ?? null,
              variantName: row.item.variantName ?? null,
              variantNameAr: row.item.variantNameAr ?? null,
              personalisation: row.item.personalisation ?? null,
              quantity: row.item.quantity,
              price: row.item.price,
            }
      ),
      subtotal: order.subtotal,
      tax: order.tax,
      taxIncludedInPrice: order.taxIncludedInPrice,
      // Tax-invoice identity frozen at sale (ruling TAX-2); null = no VAT wording.
      sellerTaxRegistrationNumber: order.sellerTaxRegistrationNumber,
      sellerTaxLegalName: order.sellerTaxLegalName,
      taxRateBps: order.taxRateBps,
      shipping: order.shipping,
      codFee: order.codFee,
      taxableAmount: order.taxableAmount,
      discount: order.discount,
      couponDiscount: order.couponDiscount,
      promotionDiscount: order.promotionDiscount,
      loyaltyDiscount: order.loyaltyDiscount,
      loyaltyPointsRedeemed: order.loyaltyPointsRedeemed,
      currency: order.currency,
      couponCode: order.couponCode ?? undefined,
      promotionName: order.appliedPromotion?.name ?? undefined,
      promotionNameAr: order.appliedPromotion?.nameAr ?? undefined,
      total: order.total,
      deliveryLine: deliveryLineFromNotes(order.notes),
      shippingAddress: shippingAddress as OrderEmailData['shippingAddress'],
      isCod: (paymentMethod || '').toLowerCase() === 'cod',
    };

    const store = await step.run('load-store', () =>
      // Postgres: exactly as before; a DO store has no tenant transaction to open for a platform row
      (money
        ? withStore(storeId, tx =>
            tx.store.findUnique({ where: { id: storeId }, select: { name: true, settings: true } })
          )
        : runInTenantContext(storeId, () =>
            prisma.store.findUnique({
              where: { id: storeId },
              select: { name: true, settings: true },
            })
          )
      ).catch(() => null)
    );

    const results = await Promise.allSettled([
      step.run('send-customer-confirmation', () =>
        EmailService.sendOrderConfirmation(storeId, emailData, emailLocale)
      ),
      // No "new order" alert to Ebda's own address any more (Ruling FU46-1a): it carried
      // every store's shopper name, email and items. The store's own notice is the invoice
      // below, sent only to the address it configured.
      // Opt-in per-store owner invoice: when the store configured
      // `settings.orderInvoiceEmail`, auto-email the rendered invoice to that
      // address (e.g. the store owner) on every order. Stores that didn't
      // configure it get nothing (this is an option, not a default). Reuses
      // the existing `order/invoice.email-requested` → invoice-email pipeline
      // (renders the PDF invoice + queued/retried send).
      step.run('send-owner-invoice', async () => {
        const to = resolveOrderInvoiceRecipient(store?.settings);
        if (!to) return;
        await inngest.send({
          name: 'order/invoice.email-requested',
          data: { orderId: order.id, storeId, to },
        });
      }),
      step.run('dispatch-notification-channels', async () => {
        await notificationDispatcher.dispatch(storeId, 'order_confirmed', {
          customerName,
          customerPhone: guestPhone || undefined,
          orderNumber: order.orderNumber,
          total: order.total,
          storeId,
          storeName: store?.name ?? storeId,
          locale: emailLocale,
        });
      }),
      step.run('onesignal-admin-push', () => {
        // De-dupe the admin push. For an ONLINE-paid order this fanout runs at
        // payment confirmation, which ALSO fires the "Payment received" admin
        // push (notifyAdminsOfPaymentSuccess) — so a "New order" push here is a
        // duplicate: the merchant gets 2 pushes seconds apart for 1 order.
        // Fire "New order" only when NO payment-received push will follow: a
        // cash/COD order (paid on delivery) or a not-yet-paid order. Online-paid
        // is fully covered by "Payment received".
        // 'wallet' = paid in full from the customer wallet at checkout (D1):
        // paid, but no gateway webhook exists to fire a "Payment received"
        // push, so it takes the same branch as cash.
        const isCash = ['cod', 'cash', 'cash_on_delivery', 'wallet'].includes(
          (paymentMethod || '').toLowerCase()
        );
        if (order.paymentStatus === 'paid' && !isCash) {
          return Promise.resolve({ skipped: 'online-paid: covered by payment-received push' });
        }
        return OneSignalService.notifyAdminsOfOrder({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId,
          storeName: store?.name ?? storeId,
          customerName,
          total: order.total,
          currency: order.currency,
          paymentMethod,
        });
      }),
      // Orders-PWA (orders.ebda.app) staff push via OneSignal.
      // Targets ONLY the Orders OneSignal app — a different device set + a
      // different origin from the OneSignal admin app (store.ebda.app),
      // so the two never double-send. Tag-based: only devices tagged with
      // this store's `store_id` (set when staff enable notifications) receive
      // it. Replaces the old VAPID web-push path (server 403 + iOS-unreliable).
      //
      // Fire-once: the whole fanout is already deduped per order via the
      // `order_created_notified_at` claim above, so this fires exactly once.
      step.run('orders-app-push', () =>
        OneSignalService.notifyOrdersAppOfOrder({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId,
          total: order.total,
          currency: order.currency,
          customerName,
          locale: emailLocale,
        })
      ),
    ]);

    // Re-throw if ANY step ultimately failed (after Inngest's per-step retries).
    // Without this, Promise.allSettled swallowed every rejection and the run
    // always completed as "success" — so `inngest/function.failed` never fired
    // and alerts-failure-watch could never dead-letter this fanout, even when
    // every customer/admin notification was lost. Sibling consumers of the same
    // order/created event (accounting-post-order-journal)
    // already throw + escalate; this brings the notification fanout up to parity.
    // Idempotent on retry: each side-effect is its own memoized step.run, so a
    // retry re-runs only the failed steps.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length > 0) {
      rejected.forEach(r => logger.error({ err: r.reason }, 'order/created step failed'));
      throw new AggregateError(
        rejected.map(r => r.reason),
        `order-created-fanout: ${rejected.length}/${results.length} side-effect step(s) failed`
      );
    }
  }
);
