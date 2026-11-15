/**
 * Add-on renewal (SELF-SERVICE A8, Ruling ADDON-RENEW-1): a feature add-on renews on the store's saved card only on
 * the terms the owner confirmed (the amount, every 30 days, stoppable any time), and never by surprise:
 *  - the owner is told (bell + email) up to 3 days before the term ends; a charge happens only on a LATER run than the
 *    one that sent the notice, and only when that notice is on record (no record, e.g. the store is unreachable = no
 *    charge);
 *  - no charge, with a notice, when the price is no longer the agreed one, the plan now includes the feature, a
 *    super-admin switched it off, or there is no saved card: the owner buys again to give new consent;
 *  - one attempt per (store, sku, term end) via the ledger key, a declined renewal is not retried and is announced.
 * AI packs never renew. Runs inside `runBillingCycle`.
 */
import { prisma, withStore } from '@ebda/database';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { encryption } from '../encryption.service';
import { featureService } from '../feature.service';
import { redis } from '../redis.service';
import { acrossBilling } from '../platform/billing-d1';
import { getBillingProvider } from './index';
import type { BillingProvider } from './types';
import { chargeFor } from './charge-amount';
import { addDays } from './period';
import { isBillableStoreId } from './account.service';
import { runBillingEffects, type BillingEffect } from './billing-notify';
import { chargeAndSettle, claimEvent } from './subscription-billing.service';
import { ADDON_CATALOG, ADDON_PLAN_PREFIX, skuOfPlanCode } from './addon-catalog';
import { activeAddons, isTermCancelled } from './addon-grant';

/** The owner is told this long before the term ends. */
const NOTICE_AHEAD_DAYS = 3;
/** The charge itself happens when the term ends within a day, so the new term stacks with no gap. */
const CHARGE_AHEAD_DAYS = 1;
/** A term that ended longer ago than this is a lapse: the merchant re-buys it, we do not surprise-charge. */
const LAPSE_DAYS = 3;
const SENTINEL_TTL_S = 14 * 24 * 3600;

type Reason = Extract<BillingEffect, { kind: 'addon_notice' }>['reason'];

/**
 * Record (once) that a given notice went out. Returns 'first' for the caller that must send it, 'seen' when it was
 * already sent, 'unknown' when the record cannot be kept (then nothing may be charged on the strength of it).
 */
async function claimNotice(key: string): Promise<'first' | 'seen' | 'unknown'> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return 'unknown';
  try {
    return (await client.set(key, '1', 'EX', SENTINEL_TTL_S, 'NX')) === 'OK' ? 'first' : 'seen';
  } catch {
    return 'unknown';
  }
}

async function noticeSent(key: string): Promise<boolean> {
  const client = redis.getClient();
  if (!client || !redis.isAvailable()) return false;
  try {
    return (await client.get(key)) !== null;
  } catch {
    return false;
  }
}

export async function renewDueAddons(now: Date, providerArg?: BillingProvider): Promise<number> {
  const parts = await acrossBilling(
    storeId =>
      prisma.billingEvent.findMany({
        where: {
          ...(storeId ? { storeId } : {}),
          type: 'upgrade',
          status: 'succeeded',
          planCode: { startsWith: `${ADDON_PLAN_PREFIX}feature:` },
          forPeriodEnd: { gte: addDays(now, -LAPSE_DAYS), lte: addDays(now, NOTICE_AHEAD_DAYS) },
        },
        select: { id: true, storeId: true, planCode: true, forPeriodEnd: true, amountMinor: true },
      }),
    {
      onStoreError: (storeId, err) =>
        logger.error({ err, storeId }, '[addons] renewal scan failed'),
    }
  );
  let charged = 0;
  const effects: BillingEffect[] = [];
  // A term that has ended is an entitlement change: drop every layer for that store once per run (Ruling ADDON-SS-3).
  // The feature-map cache already dies at the term end (`ttlFor`); this also clears the public store payload and any
  // entry written before the clamp shipped. `addon_granted` is the existing "entitlement changed" effect.
  const lapsed = new Set<string>();
  for (const c of parts.flatMap(p => p.value)) {
    try {
      const sku = skuOfPlanCode(c.planCode);
      if (!sku || !c.forPeriodEnd) continue;
      const item = ADDON_CATALOG[sku];
      const end = c.forPeriodEnd;
      if (end.getTime() <= now.getTime()) lapsed.add(c.storeId);
      const stamp = `${c.storeId}:${sku}:${end.toISOString()}`;
      const notice = async (reason: Reason) => {
        if ((await claimNotice(`addon-notice:${reason}:${stamp}`)) !== 'first') return;
        effects.push({
          kind: 'addon_notice',
          storeId: c.storeId,
          sku,
          reason,
          endsAt: end,
          amountMinor: c.amountMinor,
        });
      };

      // The owner stopped it, or a later term already exists (renewed, or re-bought): nothing to do.
      if (await withStore(c.storeId, tx => isTermCancelled(tx, c.storeId, c.id))) continue;
      const running = await withStore(c.storeId, tx => activeAddons(tx, c.storeId, now));
      if (running.some(r => r.sku === sku && r.endsAt.getTime() > end.getTime())) continue;
      if (!(await isBillableStoreId(c.storeId))) continue;

      // Would the charge surprise the owner? Then no charge and a notice; they buy again to consent anew.
      const off = await withStore(c.storeId, tx =>
        tx.storeFeature.findFirst({
          where: { storeId: c.storeId, featureKey: item.featureKey!, enabled: false },
          select: { featureKey: true },
        })
      );
      if (off) {
        await notice('disabled');
        continue;
      }
      if ((await featureService.resolveWithoutAddons(c.storeId))[item.featureKey!] === true) {
        await notice('now_included');
        continue;
      }
      const amount = await chargeFor(item.priceMinor);
      if (amount.totalMinor !== c.amountMinor) {
        await notice('price_changed');
        continue;
      }
      const sub = await withStore(c.storeId, tx =>
        tx.storeSubscription.findUnique({ where: { storeId: c.storeId } })
      );
      if (
        !sub ||
        !sub.provider ||
        !sub.providerPaymentMethodRef ||
        !['active', 'trialing', 'past_due'].includes(sub.status)
      ) {
        await notice('no_card');
        continue;
      }

      // The heads-up comes first, on an earlier run than the charge.
      const upcomingKey = `addon-notice:renewal_upcoming:${stamp}`;
      if (
        end.getTime() > addDays(now, CHARGE_AHEAD_DAYS).getTime() ||
        !(await noticeSent(upcomingKey))
      ) {
        await notice('renewal_upcoming');
        continue;
      }

      const provider = providerArg ?? getBillingProvider();
      const key = `addon-renew:${stamp}`;
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
      else if (r.settled === 'failed') await notice('renewal_declined');
    } catch (err) {
      // A closed / removed store is skipped, never a failed run (gone-store guard).
      if (isStoreGoneError(err)) {
        logger.warn({ storeId: c.storeId }, '[addons] renewal skipped: store is gone');
        continue;
      }
      logger.error({ err, storeId: c.storeId, planCode: c.planCode }, '[addons] renewal threw');
    }
  }
  for (const storeId of lapsed) effects.push({ kind: 'addon_granted', storeId });
  await runBillingEffects(effects);
  return charged;
}
