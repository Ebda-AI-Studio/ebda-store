import { prisma, runInTenantContext } from '@ebda/database';
import { EmailService } from '../../../services/email.service';
import { signReviewToken } from '../../review-token';
import logger from '../../logger';
import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { featureService } from '../../../services/feature.service';
import { storeOrigin } from '@ebda/shared';
import { storeDb, storeMoney } from '../../repo-factory';
import { customersById, runInStoreCtx, withStoreDb } from '../../jobs/store-db';

/**
 * Post-purchase review request — fires when an order transitions to
 * 'delivered'. Schedules a durable 7-day delay, then emails the buyer a
 * token-signed deep link to leave a review for each item.
 *
 * Idempotency: checks Order.reviewRequestSentAt before sending so retries
 * and accidental double-fires are both no-ops.
 *
 * Skip conditions (all logged):
 *   - Order no longer in 'delivered' state (refunded / cancelled meanwhile)
 *   - reviewRequestSentAt already set
 *   - No customer email (guest checkout with no email, edge case)
 *   - Order has no items
 *   - Store not found (deleted between fire and execution)
 */
export const reviewRequest: JobDef = inngest.createFunction(
  {
    id: 'review-request',
    name: 'Post-purchase review request — 7-day delay',
    retries: 3,
    triggers: [{ event: 'order/delivered' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = event.data as { orderId: string; storeId: string };

    // Guard against Inngest sync UI test payloads (data: {})
    if (!orderId || !storeId) {
      logger.warn({ event: event.name }, '[REVIEW-REQUEST] fired without ids — skipping');
      return { skipped: 'missing-ids' };
    }

    // Feature gate — skip review requests when reviews feature is disabled.
    // In a step: on a Workflow only step bodies hold a database connection.
    const reviewsEnabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'reviews')
    );
    if (!reviewsEnabled) {
      logger.info({ storeId, orderId }, '[REVIEW-REQUEST] reviews feature disabled, skipping');
      return { skipped: true, reason: 'feature_disabled', feature: 'reviews' };
    }

    // Durable 7-day wait — survives API restarts / redeploys
    await step.sleep('wait-7-days', '7d');

    // ── Re-verify order state after the delay ──────────────────────────────
    // The order lives in the store's backend (its Durable Object, or Postgres under the tenant scope); the customer is a platform
    // `User`, attached after the read (Ruling CF-JOBS-4).
    const order = await step.run('load-order', () =>
      runInStoreCtx(storeId, async () => {
        const row = await (
          await storeDb(storeId)
        ).order.findUnique({
          where: { id: orderId, storeId },
          select: {
            id: true,
            status: true,
            storeId: true,
            locale: true,
            customerId: true,
            reviewRequestSentAt: true,
            shippingAddress: true,
            items: {
              select: {
                productId: true,
                product: {
                  select: {
                    id: true,
                    name: true,
                    nameAr: true,
                    images: true,
                  },
                },
              },
            },
          },
        });
        if (!row) return null;
        const customer = (await customersById(storeId, [row.customerId])).get(row.customerId ?? '');
        return { ...row, customer: customer ?? null };
      })
    );

    if (!order) {
      logger.warn({ orderId }, '[REVIEW-REQUEST] order not found, skipping');
      return { skipped: 'order-missing' };
    }
    if (order.status !== 'delivered') {
      logger.info(
        { orderId, status: order.status },
        '[REVIEW-REQUEST] order no longer delivered, skipping'
      );
      return { skipped: `status-is-${order.status}` };
    }
    if (order.reviewRequestSentAt) {
      logger.info({ orderId }, '[REVIEW-REQUEST] already sent, skipping');
      return { skipped: 'already-sent' };
    }
    if (!order.items || order.items.length === 0) {
      logger.warn({ orderId }, '[REVIEW-REQUEST] order has no items, skipping');
      return { skipped: 'no-items' };
    }

    // ── Resolve recipient email ────────────────────────────────────────────
    // Prefer the registered customer's email; fall back to the shipping
    // address email (guest checkout path). Both nullable — skip if missing.
    const shippingAddr = order.shippingAddress as Record<string, string> | null;
    const recipientEmail =
      order.customer?.email ||
      (typeof shippingAddr?.email === 'string' ? shippingAddr.email : null);

    if (!recipientEmail) {
      logger.warn({ orderId }, '[REVIEW-REQUEST] no customer email, skipping');
      return { skipped: 'no-email' };
    }

    const customerName =
      `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
      shippingAddr?.firstName ||
      '' ||
      'there';

    // ── Resolve language ───────────────────────────────────────────────────
    const language: 'en' | 'ar' =
      order.locale === 'ar' || order.customer?.language === 'ar' ? 'ar' : 'en';

    // ── Resolve store base URL ─────────────────────────────────────────────
    const store = await step.run('load-store', () =>
      // `Store` is a platform row (D1), read for either backend
      withStoreDb(storeId, db =>
        db.store.findUnique({
          where: { id: storeId },
          select: { slug: true, domain: true },
        })
      )
    );

    if (!store) {
      logger.warn({ storeId }, '[REVIEW-REQUEST] store not found, skipping');
      return { skipped: 'store-missing' };
    }

    const base = store.domain ? `https://${store.domain}` : storeOrigin(store.slug);

    // ── Build per-item review links ────────────────────────────────────────
    type OrderItemForReview = {
      productId: string;
      product: { id: string; name: string; nameAr: string | null; images: unknown };
    };
    const items = (order.items as OrderItemForReview[]).map(it => {
      const images = it.product.images;
      const firstImage =
        Array.isArray(images) && images.length > 0
          ? typeof images[0] === 'string'
            ? images[0]
            : null
          : null;
      return {
        productName: it.product.name,
        productNameAr: it.product.nameAr,
        productImage: firstImage,
        reviewLink: `${base}/review/${order.id}/${it.productId}?token=${signReviewToken(order.id, it.productId)}`,
      };
    });

    // ── Send email (single consolidated email, all items) ─────────────────
    await step.run('send-email', () =>
      EmailService.sendReviewRequest(storeId, { to: recipientEmail, customerName, items }, language)
    );

    // ── Mark order so retries are idempotent ──────────────────────────────
    await step.run('mark-sent', async () => {
      // A store on its Durable Object stamps through the once-only op; a Postgres store keeps the plain update
      const money = await storeMoney(storeId);
      if (money) return money.orderStamp({ orderId, stamp: 'reviewRequestSentAt' });
      return runInTenantContext(storeId, () =>
        prisma.order.update({
          where: { id: orderId, storeId },
          data: { reviewRequestSentAt: new Date() },
        })
      );
    });

    logger.info({ orderId, itemCount: items.length, language }, '[REVIEW-REQUEST] sent');
    return { sent: true, itemCount: items.length, language };
  }
);
