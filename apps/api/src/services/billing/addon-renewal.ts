/**
 * Add-on renewal (SELF-SERVICE A8): a feature add-on renews on the store's saved card unless the owner cancelled it.
 * Runs inside `runBillingCycle`. One attempt per (store, sku, running term end): the ledger key is derived from that
 * end, so a second cron run, a retry or a concurrent run cannot charge twice, and a declined renewal is not re-tried
 * (the add-on simply ends at its term end and the merchant can buy it again). AI packs never renew.
 */
import { prisma, withStore } from '@ebda/database';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { encryption } from '../encryption.service';
import { acrossBilling } from '../platform/billing-d1';
import { getBillingProvider } from './index';
import type { BillingProvider } from './types';
import { chargeFor } from './charge-amount';
import { addDays } from './period';
import { isBillableStoreId } from './account.service';
import { chargeAndSettle, claimEvent } from './subscription-billing.service';
import { ADDON_CATALOG, ADDON_PLAN_PREFIX, skuOfPlanCode } from './addon-catalog';
import { activeAddons } from './addon-grant';

/** Renew when the term ends within a day, so the new term stacks and there is no gap between two cron runs. */
const RENEW_AHEAD_DAYS = 1;
/** A term that ended longer ago than this is a lapse: the merchant re-buys it, we do not surprise-charge. */
const RENEW_LAPSE_DAYS = 3;

export async function renewDueAddons(now: Date, providerArg?: BillingProvider): Promise<number> {
  const parts = await acrossBilling(
    storeId =>
      prisma.billingEvent.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          type: 'upgrade',
          status: 'succeeded',
          planCode: { startsWith: `${ADDON_PLAN_PREFIX}feature:` },
          forPeriodEnd: {
            gte: addDays(now, -RENEW_LAPSE_DAYS),
            lte: addDays(now, RENEW_AHEAD_DAYS),
          },
        },
        select: { storeId: true, planCode: true, forPeriodEnd: true, raw: true },
      }),
    {
      onStoreError: (storeId, err) =>
        logger.error({ err, storeId }, '[addons] renewal scan failed'),
    }
  );
  let charged = 0;
  for (const c of parts.flatMap(p => p.value)) {
    try {
      const sku = skuOfPlanCode(c.planCode);
      if (!sku || !c.forPeriodEnd) continue;
      if ((c.raw as { cancelAtPeriodEnd?: boolean } | null)?.cancelAtPeriodEnd === true) continue;
      // A later term already exists (renewed, or the merchant re-bought): nothing to charge.
      const running = await withStore(c.storeId, tx => activeAddons(tx, c.storeId, now));
      if (running.some(r => r.sku === sku && r.endsAt.getTime() > c.forPeriodEnd!.getTime()))
        continue;
      if (!(await isBillableStoreId(c.storeId))) continue;
      const sub = await withStore(c.storeId, tx =>
        tx.storeSubscription.findUnique({ where: { storeId: c.storeId } })
      );
      if (
        !sub ||
        !sub.provider ||
        !sub.providerPaymentMethodRef ||
        !['active', 'trialing', 'past_due'].includes(sub.status)
      )
        continue;
      const provider = providerArg ?? getBillingProvider();
      const item = ADDON_CATALOG[sku];
      const amount = await chargeFor(item.priceMinor);
      const key = `addon-renew:${c.storeId}:${sku}:${c.forPeriodEnd.toISOString()}`;
      const eventId = await claimEvent({
        storeId: c.storeId,
        subscriptionId: sub.id,
        type: 'upgrade',
        planCode: c.planCode,
        amountMinor: amount.totalMinor,
        charge: amount,
        provider: provider.name,
        idempotencyKey: key,
      });
      if (!eventId) continue; // already attempted for this term end
      const r = await chargeAndSettle({
        provider,
        eventId,
        token: encryption.decrypt(sub.providerPaymentMethodRef),
        amountMinor: amount.totalMinor,
        idempotencyKey: key,
        description: `${item.nameEn} (renewal)`,
        now,
      });
      if (r.settled === 'succeeded') charged++;
    } catch (err) {
      // A closed / removed store is skipped, never a failed run (gone-store guard).
      if (isStoreGoneError(err)) {
        logger.warn({ storeId: c.storeId }, '[addons] renewal skipped: store is gone');
        continue;
      }
      logger.error({ err, storeId: c.storeId, planCode: c.planCode }, '[addons] renewal threw');
    }
  }
  return charged;
}
