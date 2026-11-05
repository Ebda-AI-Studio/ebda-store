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
 *
 * Erasure suppression:
 *   An order whose customer has since been erased (`eraseAccount` marks
 *   `shippingAddress` `{ anonymized: true }`) never gets a CAPI event sent,
 *   even on a delayed/retried delivery of this event — see the check below.
 */

import type { JobDef } from '../../jobs/types';
import { storefrontOrigin } from '@ebda/shared';

import { storeDb } from '../../repo-factory';
import { customersById, runInStoreCtx, withStoreDb } from '../../jobs/store-db';
import { inngest } from '../client';
import { featureService } from '../../../services/feature.service';
import {
  sendPurchaseConversion,
  isErasedCustomerOrder,
} from '../../../services/pixels-capi.service';
import logger from '../../logger';

export const orderCapiConversion: JobDef = inngest.createFunction(
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
      // `Store` is a platform row (D1): the same read for a Postgres store and a store on its Durable Object
      withStoreDb(storeId, db =>
        db.store.findUnique({
          where: { id: storeId },
          select: {
            marketingPixels: true,
            slug: true,
            domain: true,
          },
        })
      ).catch(() => null)
    );

    if (!store) {
      logger.warn({ storeId, orderId }, '[order-capi] store not found — skipping');
      return { skipped: 'store-not-found' };
    }

    // Determine the store's public URL for event_source_url:
    //   custom domain wins, then the store's free `<slug>.ebda.app` origin.
    const storeUrl = storefrontOrigin(store);

    // Load the order — only need PII fields for hashing + the total.
    // runInTenantContext ensures RLS allows the read (Inngest runs without
    // an HTTP request context, so there's no middleware-set tenant GUC).
    const order = await step.run('load-order', () =>
      runInStoreCtx(storeId, async () => {
        // `Promise.resolve`: a Durable Object store's read client returns a thenable with no `.catch` (the sweep found the
        // uncaught TypeError after every order create); a Postgres PrismaPromise has one. Either way a failed read is "no row".
        const row = await Promise.resolve(
          (await storeDb(storeId)).order.findUnique({
            where: { id: orderId, storeId },
            select: {
              id: true,
              total: true,
              currency: true,
              shippingAddress: true,
              customerId: true,
            },
          })
        ).catch(() => null);
        if (!row) return null;
        // the buyer is a platform `User`, attached after the read (Ruling CF-JOBS-4)
        const c = (await customersById(storeId, [row.customerId])).get(row.customerId ?? '');
        return { ...row, customer: c ? { email: c.email, phone: c.phone } : null };
      })
    );

    if (!order) {
      logger.warn({ storeId, orderId }, '[order-capi] order not found — skipping');
      return { skipped: 'order-not-found' };
    }

    // Right-to-erasure suppression: `AuthService.eraseAccount` nulls
    // `order.customerId` AND rewrites `shippingAddress`/`billingAddress` to
    // `{ anonymized: true }` inside its transaction. There is no per-subject
    // deletion API for Meta/TikTok CAPI (it's a one-way event stream, not a
    // queryable profile — see docs/privacy/data-map.md), so the only
    // available control is to never send another event tied to an erased
    // subject's order in the first place — a delayed/retried Inngest
    // delivery of this same `order/created` event after the customer erased
    // their account must not (re)send a conversion event for them. The
    // anonymized marker is the signal: an order that's been through
    // `eraseAccount` always carries it, a normal order never does.
    if (isErasedCustomerOrder(order.shippingAddress)) {
      logger.info(
        { storeId, orderId },
        '[order-capi] order belongs to an erased customer — suppressing CAPI event'
      );
      return { skipped: 'erased-customer-suppressed' };
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
