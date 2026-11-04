import type { JobDef } from '../../jobs/types';
import { withStoreDb } from '../../jobs/store-db';
import { storeDirectory } from '@ebda/database';
import { storeFilter } from '../../jobs/store-scope';
import logger from '../../logger';
import { maskEmail } from '../../pii-mask';
import { inngest } from '../client';
import {
  runLowStockScan,
  commitLowStockAlertSentinels,
} from '../../../services/inventory/low-stock-scan.service';
import { EmailService } from '../../../services/email.service';
import { featureService } from '../../../services/feature.service';
import { config } from '../../../config';
import { buildInventoryLowEvents } from '../../../services/webhook-events';
import type { LowStockAlertItem } from '../../../services/email-templates/low-stock-alert';

/**
 * Cron-triggered low-stock alert — runs every 6 hours (every 6th hour, UTC).
 *
 * For every store with the `inventory.stock_alerts` feature enabled:
 *   1. Calls runLowStockScan() which:
 *      a. Queries active, trackInventory products where inventory > 0
 *         AND inventory <= lowStockThreshold (in-stock-but-low).
 *      b. Deduplicates via Redis sentinels per (storeId, productId) so each
 *         low-stock event fires ONCE until the product is restocked above
 *         threshold (at which point the sentinel is cleared).
 *      c. Clears sentinels for products now back above threshold.
 *   2. If the digest is non-empty, sends ONE branded bilingual email to the
 *      store owner (store.owner.email).
 *
 * Each per-store scan runs inside step.run() so Inngest retries only the
 * failing store without re-running healthy ones.
 *
 * RLS note: the cron job has no tenant GUC — runLowStockScan wraps its DB
 * work in withRlsBypass (same pattern as stock-reorder-scan and
 * stock-deadstock-scan).
 */
export const stockLowStockAlertCron: JobDef = inngest.createFunction(
  {
    id: 'stock-low-stock-alert-cron',
    name: 'Low-stock alert — 6-hourly cron',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 */6 * * *' }], // every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
  },
  async ({ event, step }) => {
    // FORCE RLS: cron has no storeId — use withRlsBypass to enumerate stores.
    const stores = await step.run('list-stores', () =>
      // `stores` is under RLS: a cron lists stores through the directory definer.
      storeDirectory(storeFilter(event)).then(list => list.map(s => ({ id: s.id })))
    );

    // One UTC day for the whole run (memoized), so webhook inventory.low dedupes per product per day.
    const day = await step.run('webhook-day', () => new Date().toISOString().slice(0, 10));

    const webhookPending: Array<{ storeId: string; items: LowStockAlertItem[] }> = [];
    let totalAlerted = 0;
    let totalCleared = 0;
    let totalSkipped = 0;
    let emailsSent = 0;

    for (const store of stores) {
      // Step 1 — scan (sets the Redis dedup sentinels). Kept in its OWN
      // memoized step so a downstream email failure cannot cause it to re-run:
      // on retry Inngest replays this step's cached result, so the sentinels are
      // never re-evaluated and the digest stays intact for the send step.
      const scan = await step.run(`scan-${store.id}`, async () => {
        // Feature gate — low-stock alerts require inventory.stock_alerts (Professional+).
        const enabled = await featureService.isFeatureEnabled(store.id, 'inventory.stock_alerts');
        if (!enabled) {
          logger.debug(
            { storeId: store.id },
            'stock-low-stock-alert: inventory.stock_alerts disabled, skipping'
          );
          return {
            alerted: 0,
            cleared: 0,
            skipped: 0,
            skippedFeature: true,
            alertedProducts: [] as Awaited<ReturnType<typeof runLowStockScan>>['alertedProducts'],
            recipientEmail: null as string | null,
          };
        }

        const scanResult = await runLowStockScan(store.id);

        return {
          alerted: scanResult.alertedProducts.length,
          cleared: scanResult.clearedCount,
          skipped: scanResult.skippedCount,
          skippedFeature: false,
          alertedProducts: scanResult.alertedProducts,
          recipientEmail: scanResult.recipientEmail,
        };
      });

      // Merchant webhooks (inventory.low): collected here, sent once after the loop (M8).
      webhookPending.push({ storeId: store.id, items: scan.alertedProducts });

      // Step 2 — send the digest in a SEPARATE memoized step. If the email send
      // throws, only this step is retried; the scan step (and its sentinels) is
      // not re-run, so the digest is still populated on retry.
      let emailed = false;
      if (scan.alertedProducts.length > 0) {
        if (!scan.recipientEmail) {
          logger.warn(
            { storeId: store.id },
            'stock-low-stock-alert: no recipient email on store owner, skipping send'
          );
        } else {
          await step.run(`send-email-${store.id}`, async () => {
            // Load the store name for the email subject/body.
            // withRlsBypass is needed here too because we're outside HTTP context.
            const storeRow = await withStoreDb(store.id, db =>
              db.store.findUnique({
                where: { id: store.id },
                select: { name: true },
              })
            );

            await EmailService.sendLowStockAlert(store.id, {
              to: scan.recipientEmail!,
              items: scan.alertedProducts,
              storeName: storeRow?.name ?? store.id,
              adminUrl: config.adminUrl,
            });

            logger.info(
              {
                storeId: store.id,
                recipient: maskEmail(scan.recipientEmail),
                count: scan.alertedProducts.length,
              },
              'stock-low-stock-alert: digest email sent'
            );
          });
          emailed = true;
          // Mark these products alerted ONLY now that the digest actually
          // sent — see the comment on runLowStockScan's writeSentinels
          // call. A separate memoized step: if it throws (a transient Redis
          // blip) Inngest retries just this step, without re-sending the
          // email the customer already received.
          await step.run(`commit-sentinels-${store.id}`, () =>
            commitLowStockAlertSentinels(
              store.id,
              scan.alertedProducts.map((p: { productId: string }) => p.productId)
            )
          );
        }
      }

      totalAlerted += scan.alerted;
      totalCleared += scan.cleared;
      totalSkipped += scan.skipped;
      if (emailed) emailsSent++;
    }

    // Merchant webhooks (inventory.low): independent of the owner email (a store with no recipient
    // address still tells its endpoints); the fan-out dedupes per product per day. ONE step for all
    // stores so the cron's step count does not grow with them (M8).
    const lowEvents = buildInventoryLowEvents(day, webhookPending);
    if (lowEvents.length > 0) await step.sendEvent('webhook-inventory-low', lowEvents);

    logger.info(
      { stores: stores.length, totalAlerted, totalCleared, totalSkipped, emailsSent },
      'stock-low-stock-alert-cron completed'
    );

    return { stores: stores.length, totalAlerted, totalCleared, totalSkipped, emailsSent };
  }
);

/**
 * Event-triggered on-demand low-stock scan.
 *
 * Fired by the "Send low-stock alert now" button on the admin stock
 * dashboard (super_admin only) via POST /:storeId/stock/low-stock-scan/run-now.
 * Overlapping runs (a double click, or the 6-hourly cron mid-scan) cannot
 * send the same digest twice: runLowStockScan claims each product with a
 * short SET NX before it enters a digest.
 * Event: `stock/low-stock-scan-requested` with data: { storeId, requestedBy? }
 */
export const stockLowStockAlertOnDemand: JobDef = inngest.createFunction(
  {
    id: 'stock-low-stock-alert-on-demand',
    name: 'Low-stock alert — on-demand',
    retries: 1,
    triggers: [{ event: 'stock/low-stock-scan-requested' }],
  },
  async ({ event, step }) => {
    const { storeId, requestedBy } = event.data;

    logger.info({ storeId, requestedBy }, 'stock-low-stock-alert-on-demand: starting');

    // Feature gate — skip when inventory.stock_alerts is disabled.
    const enabled = await step.run('check-feature', () =>
      featureService.isFeatureEnabled(storeId, 'inventory.stock_alerts')
    );
    if (!enabled) {
      logger.info(
        { storeId },
        'stock-low-stock-alert-on-demand: inventory.stock_alerts disabled, skipping'
      );
      return { skipped: true, reason: 'feature_disabled', feature: 'inventory.stock_alerts' };
    }

    const scanResult = await step.run(`scan-${storeId}`, () => runLowStockScan(storeId));

    let emailed = false;
    if (scanResult.alertedProducts.length > 0 && scanResult.recipientEmail) {
      await step.run('send-email', async () => {
        const storeRow = await withStoreDb(storeId, db =>
          db.store.findUnique({
            where: { id: storeId },
            select: { name: true },
          })
        );

        await EmailService.sendLowStockAlert(storeId, {
          to: scanResult.recipientEmail!,
          items: scanResult.alertedProducts,
          storeName: storeRow?.name ?? storeId,
          adminUrl: config.adminUrl,
        });
        emailed = true;
      });
      // Mark alerted only now that the digest actually sent — see the
      // comment on runLowStockScan's writeSentinels call.
      await step.run('commit-sentinels', () =>
        commitLowStockAlertSentinels(
          storeId,
          scanResult.alertedProducts.map((p: { productId: string }) => p.productId)
        )
      );
    }

    // Named fields, not `...scanResult`: the scan result carries the owner's
    // raw `recipientEmail` (issue 2392).
    logger.info(
      {
        storeId,
        requestedBy,
        alerted: scanResult.alertedProducts.length,
        cleared: scanResult.clearedCount,
        skipped: scanResult.skippedCount,
        recipient: maskEmail(scanResult.recipientEmail),
        emailed,
      },
      'stock-low-stock-alert-on-demand completed'
    );

    return {
      alerted: scanResult.alertedProducts.length,
      cleared: scanResult.clearedCount,
      skipped: scanResult.skippedCount,
      emailed,
    };
  }
);
