/**
 * Order CAPI Conversion — server-side pixel conversion on purchase
 *
 * Sibling function to `order-created-fanout`. Listens to the same
 * `order/created` event but is intentionally isolated here so that a
 * CAPI failure, a future provider addition, or a feature flag change
 * can be modified without touching the primary order fanout.
 *
 * Why isolated rather than a step inside order-created.ts:
 *   - `order-created.ts` is touched by multiple in-flight PRs; keeping CAPI
 *     separate prevents merge conflicts.
 *   - Failure isolation: Inngest retries steps inside a function as a unit.
 *     A separate function means CAPI retries don't interfere with email/push
 *     retries.
 *   - Feature-gated independently: `marketing_pixels` feature flag checked
 *     here; no risk of the gate touching notification logic.
 *
 * Fail-open contract:
 *   `sendPurchaseConversion` catches and logs all CAPI errors internally.
 *   This function therefore never throws from the conversion call — Inngest
 *   will only retry if the store or order load fails.
 */

import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { inngest } from '../client';
import { featureService } from '../../../services/feature.service';
import { sendPurchaseConversion } from '../../../services/pixels-capi.service';
import { config } from '../../../config';
import logger from '../../logger';

export const orderCapiConversion: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-capi-conversion',
    name: 'Order — server-side CAPI conversion (Meta + TikTok)',
    // Mirror the primary fanout concurrency key so we don't spawn unbounded
    // parallel CAPI calls for the same store during a burst.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    // One retry is plenty — if the CAPI endpoint is down for a second attempt
    // the deduplication window (24 h for Meta) covers late arrivals.
    retries: 1,
    triggers: [{ event: 'order/created' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId } = (event.data ?? {}) as {
      orderId?: string;
      storeId?: string;
    };

    if (!orderId || !storeId) {
      logger.warn({ event: event.name, data: event.data }, '[order-capi] missing ids — skipping');
      return { skipped: 'missing-ids' };
    }

    // Feature gate: skip the entire function when marketing_pixels is off
    // for this store. Cheap check before we do any DB reads.
    const pixelsEnabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'marketing_pixels')
    );
    if (!pixelsEnabled) {
      logger.info(
        { storeId, orderId },
        '[order-capi] marketing_pixels feature disabled — skipping'
      );
      return { skipped: true, reason: 'feature_disabled' };
    }

    // Load the store's marketingPixels config — this is the raw DB row value
    // (plaintext access tokens, not masked). We need the DIRECT Prisma call
    // with runInTenantContext so RLS doesn't filter it out.
    const store = await step.run('load-store-pixels', () =>
      runInTenantContext(storeId, () =>
        prisma.store
          .findUnique({
            where: { id: storeId },
            select: {
              marketingPixels: true,
              slug: true,
              domain: true,
            },
          })
          .catch(() => null)
      )
    );

    if (!store) {
      logger.warn({ storeId, orderId }, '[order-capi] store not found — skipping');
      return { skipped: 'store-not-found' };
    }

    // Determine the store's public URL for event_source_url:
    //   custom domain wins, then slug-based path on the platform web URL.
    const storeUrl = store.domain ? `https://${store.domain}` : `${config.webUrl}/${store.slug}`;

    // Load the order — only need PII fields for hashing + the total.
    // runInTenantContext ensures RLS allows the read (Inngest runs without
    // an HTTP request context, so there's no middleware-set tenant GUC).
    const order = await step.run('load-order', () =>
      runInTenantContext(storeId, () =>
        prisma.order
          .findUnique({
            where: { id: orderId },
            select: {
              id: true,
              total: true,
              currency: true,
              shippingAddress: true,
              customer: {
                select: { email: true, phone: true },
              },
            },
          })
          .catch(() => null)
      )
    );

    if (!order) {
      logger.warn({ storeId, orderId }, '[order-capi] order not found — skipping');
      return { skipped: 'order-not-found' };
    }

    // Send to all configured CAPI providers. sendPurchaseConversion is
    // fail-open internally — this step will not throw from a CAPI error.
    await step.run('send-capi', () =>
      sendPurchaseConversion(
        store.marketingPixels,
        {
          id: order.id,
          total: order.total,
          currency: order.currency,
          customer: order.customer,
          shippingAddress: order.shippingAddress as Record<string, unknown> | null,
        },
        storeUrl
      )
    );

    return { sent: true, orderId, storeId };
  }
);
