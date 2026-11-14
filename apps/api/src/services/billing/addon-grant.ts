/**
 * Entitlement from the ledger (SELF-SERVICE A8 + A9). A purchase is ONE succeeded `billing_events` row whose
 * `forPeriodEnd` is the end of the term it paid for; nothing else stores the entitlement, so a replayed webhook,
 * a refund (succeeded -> refunded) and expiry all behave by reading that row.
 *
 * Exactly once: `applyAddonGrant` runs only from `settleInTx`, on the pending -> succeeded transition that the
 * dedupe claim and the guarded status update already make single-shot. It writes inside the payment transaction, so
 * a failing grant write rolls the payment's settlement back and the gateway redelivery retries it (nothing is
 * granted without a settled payment, and no settled payment is left ungranted).
 */
import type { Prisma } from '@ebda/database';
import { addDays } from './period';
import { ADDON_CATALOG, ADDON_PLAN_PREFIX, ADDON_TERM_DAYS, skuOfPlanCode } from './addon-catalog';
import type { BillingEffect } from './billing-notify';

type Tx = Prisma.TransactionClient;

interface ActiveAddon {
  eventId: string;
  sku: string;
  endsAt: Date;
  cancelAtPeriodEnd: boolean;
  /** The row's stored `raw` (provider payload + our cancel flag), so a cancel merges instead of overwriting. */
  raw: Record<string, unknown>;
}

/** Running terms: succeeded, not refunded, `forPeriodEnd` still ahead. */
export async function activeAddons(tx: Tx, storeId: string, now: Date): Promise<ActiveAddon[]> {
  const rows = await tx.billingEvent.findMany({
    where: {
      storeId,
      type: 'upgrade',
      status: 'succeeded',
      planCode: { startsWith: ADDON_PLAN_PREFIX },
      forPeriodEnd: { gt: now },
    },
    select: { id: true, planCode: true, forPeriodEnd: true, raw: true },
  });
  const out: ActiveAddon[] = [];
  for (const r of rows) {
    const sku = skuOfPlanCode(r.planCode);
    if (!sku || !r.forPeriodEnd) continue;
    out.push({
      eventId: r.id,
      sku,
      endsAt: r.forPeriodEnd,
      cancelAtPeriodEnd:
        (r.raw as { cancelAtPeriodEnd?: boolean } | null)?.cancelAtPeriodEnd === true,
      raw: (r.raw as Record<string, unknown> | null) ?? {},
    });
  }
  return out;
}

export async function applyAddonGrant(
  tx: Tx,
  row: { id: string; storeId: string; planCode: string | null },
  now: Date,
  effects: BillingEffect[]
): Promise<void> {
  const sku = skuOfPlanCode(row.planCode);
  if (!sku) {
    // Money was taken for something we cannot deliver: grant nothing, hand it back (billing-notify refunds + alerts).
    effects.push({ kind: 'addon_unapplied', storeId: row.storeId, billingEventId: row.id });
    return;
  }
  // A second payment while a term runs stacks after it, so a merchant never loses days by paying early.
  const running = await tx.billingEvent.findFirst({
    where: {
      storeId: row.storeId,
      type: 'upgrade',
      planCode: row.planCode!,
      status: 'succeeded',
      id: { not: row.id },
      forPeriodEnd: { gt: now },
    },
    orderBy: { forPeriodEnd: 'desc' },
    select: { forPeriodEnd: true },
  });
  const start = running?.forPeriodEnd ?? now;
  await tx.billingEvent.updateMany({
    where: { id: row.id, storeId: row.storeId },
    data: { forPeriodEnd: addDays(start, ADDON_TERM_DAYS) },
  });
  const item = ADDON_CATALOG[sku];
  if (item.kind === 'feature') {
    // A stale "off" override would silently cancel what was just paid for. A later super-admin "off" still wins.
    await tx.storeFeature.deleteMany({
      where: { storeId: row.storeId, featureKey: item.featureKey!, enabled: false },
    });
  }
  effects.push({ kind: 'addon_granted', storeId: row.storeId });
}
