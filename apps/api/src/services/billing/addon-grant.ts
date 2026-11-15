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
import crypto from 'crypto';
import type { Prisma } from '@ebda/database';
import { sendAlert } from '../alerts.service';
import { claimAddonMarkerD1, onD1, setTermEndOnceD1 } from '../platform/billing-d1';
import { addDays } from './period';
import {
  ADDON_CANCEL_PREFIX,
  ADDON_CATALOG,
  ADDON_MARKER_PREFIX,
  ADDON_PLAN_PREFIX,
  ADDON_RESUME_PREFIX,
  ADDON_TERM_DAYS,
  skuOfPlanCode,
} from './addon-catalog';

/**
 * The two effects a grant can raise. Declared here, NOT imported from billing-notify: feature.service imports this
 * file, and a type import of billing-notify drags email.service and the Express request augmentation into every
 * TypeScript project that touches FeatureService (that broke `npm run typecheck` in the projects without it).
 */
type GrantEffect =
  | { kind: 'addon_granted'; storeId: string }
  | { kind: 'addon_unapplied'; storeId: string; billingEventId: string };

type Tx = Prisma.TransactionClient;

interface ActiveAddon {
  eventId: string;
  sku: string;
  endsAt: Date;
  cancelAtPeriodEnd: boolean;
}

/**
 * Has the owner stopped renewal of this paid term? The LATEST append-only marker row tied to the term decides
 * (`addon-cancel:` vs `addon-resume:`); no marker = renewing. Never read from the paid row itself.
 */
async function cancelledTerms(tx: Tx, storeId: string, termIds: string[]): Promise<Set<string>> {
  if (termIds.length === 0) return new Set();
  const markers = await tx.billingEvent.findMany({
    where: {
      storeId,
      type: 'upgrade',
      status: 'succeeded',
      planCode: { startsWith: ADDON_MARKER_PREFIX },
      relatedEventId: { in: termIds },
    },
    orderBy: { createdAt: 'asc' },
    select: { planCode: true, relatedEventId: true },
  });
  const stopped = new Set<string>();
  for (const m of markers) {
    if (!m.relatedEventId) continue;
    if (m.planCode?.startsWith(ADDON_CANCEL_PREFIX)) stopped.add(m.relatedEventId);
    else if (m.planCode?.startsWith(ADDON_RESUME_PREFIX)) stopped.delete(m.relatedEventId);
  }
  return stopped;
}

export const isTermCancelled = async (tx: Tx, storeId: string, termId: string) =>
  (await cancelledTerms(tx, storeId, [termId])).has(termId);

/** Append the owner's cancel / resume intent for a paid term. Zero amount, succeeded, never edits the paid row. */
export async function appendRenewalMarker(
  tx: Tx,
  a: { storeId: string; termId: string; sku: string; cancel: boolean }
): Promise<void> {
  await tx.billingEvent.create({
    data: {
      id: crypto.randomUUID(),
      storeId: a.storeId,
      type: 'upgrade',
      planCode: `${a.cancel ? ADDON_CANCEL_PREFIX : ADDON_RESUME_PREFIX}${a.sku}`,
      amountMinor: 0,
      currency: 'EGP',
      provider: 'ebda',
      status: 'succeeded',
      relatedEventId: a.termId,
      idempotencyKey: `${a.cancel ? 'addon-cancel' : 'addon-resume'}:${a.storeId}:${a.termId}:${crypto.randomUUID()}`,
    },
  });
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
    select: { id: true, planCode: true, forPeriodEnd: true },
  });
  const stopped = await cancelledTerms(
    tx,
    storeId,
    rows.map(r => r.id)
  );
  const out: ActiveAddon[] = [];
  for (const r of rows) {
    const sku = skuOfPlanCode(r.planCode);
    if (!sku || !r.forPeriodEnd) continue;
    out.push({ eventId: r.id, sku, endsAt: r.forPeriodEnd, cancelAtPeriodEnd: stopped.has(r.id) });
  }
  return out;
}

const GRANT_PREFIX = 'addon-grant:';
const CHAIN_TRIES = 6;

/**
 * Give the paid row its term, exactly once and never overlapping another payment of the same add-on, WITHOUT counting
 * on a prisma-lite write count (not atomic on the platform D1):
 *  - a zero-amount marker row (`addon-grant:<sku>`, `relatedEventId` = this payment, `forPeriodEnd` = the term end) is
 *    inserted under a UNIQUE key that names the term's PREDECESSOR (`addon-after:<store>:<sku>:<predecessor id>`). A term
 *    follows exactly one predecessor, so two racing payments cannot both take the same slot: the loser reads the winner's
 *    marker, adopts it as its predecessor and tries the next slot;
 *  - if the slot is already held by THIS payment (a concurrent or earlier settle), the grant was already made: only make
 *    sure the paid row carries the end (set once);
 *  - the term end on the paid row is set ONCE (`for_period_end IS NULL`).
 */
async function grantTerm(
  tx: Tx,
  row: { id: string; storeId: string; planCode: string | null },
  sku: string,
  now: Date
): Promise<void> {
  const D1 = await onD1();
  const setEnd = async (end: Date): Promise<void> => {
    if (D1) await setTermEndOnceD1(row.id, row.storeId, end.getTime());
    else
      await tx.billingEvent.updateMany({
        where: { id: row.id, storeId: row.storeId, forPeriodEnd: null },
        data: { forPeriodEnd: end },
      });
  };
  // This payment already has its marker (a crash between the marker and the end, or a replay): finish, never re-chain.
  const mine = await tx.billingEvent.findFirst({
    where: {
      storeId: row.storeId,
      type: 'upgrade',
      planCode: { startsWith: GRANT_PREFIX },
      relatedEventId: row.id,
    },
    select: { forPeriodEnd: true },
  });
  if (mine?.forPeriodEnd) return setEnd(mine.forPeriodEnd);

  const latest = await tx.billingEvent.findFirst({
    where: {
      storeId: row.storeId,
      type: 'upgrade',
      planCode: row.planCode!,
      status: 'succeeded',
      id: { not: row.id },
      forPeriodEnd: { gt: new Date(0) },
    },
    orderBy: { forPeriodEnd: 'desc' },
    select: { id: true, forPeriodEnd: true },
  });
  let predId = latest?.id ?? 'none';
  let predEnd = latest?.forPeriodEnd ?? null;
  for (let i = 0; i < CHAIN_TRIES; i++) {
    const start = predEnd && predEnd.getTime() > now.getTime() ? predEnd : now;
    const end = addDays(start, ADDON_TERM_DAYS);
    const key = `addon-after:${row.storeId}:${sku}:${predId}`;
    const marker = {
      id: crypto.randomUUID(),
      storeId: row.storeId,
      planCode: `${GRANT_PREFIX}${sku}`,
      relatedEventId: row.id,
      endMs: end.getTime(),
      key,
    };
    const won = D1
      ? await claimAddonMarkerD1(marker)
      : (
          await tx.billingEvent.createMany({
            data: [
              {
                id: marker.id,
                storeId: marker.storeId,
                type: 'upgrade',
                planCode: marker.planCode,
                forPeriodEnd: end,
                amountMinor: 0,
                currency: 'EGP',
                provider: 'ebda',
                status: 'succeeded',
                relatedEventId: marker.relatedEventId,
                idempotencyKey: key,
              },
            ],
            skipDuplicates: true,
          })
        ).count === 1;
    if (won) return setEnd(end);
    const held = await tx.billingEvent.findFirst({
      where: { storeId: row.storeId, idempotencyKey: key },
      select: { relatedEventId: true, forPeriodEnd: true },
    });
    if (!held?.forPeriodEnd || !held.relatedEventId) continue;
    if (held.relatedEventId === row.id) return setEnd(held.forPeriodEnd); // already granted by another settle
    predId = held.relatedEventId;
    predEnd = held.forPeriodEnd;
  }
  // Money is in and there is no term: loud, with the billing event, then throw so the settlement is retried.
  void sendAlert({
    level: 'p1',
    title: 'Add-on paid but no term could be placed',
    body: `billing_events ${row.id} (store ${row.storeId}, ${sku}): the term chain lost ${CHAIN_TRIES} slots in a row. The payment stays unsettled until the gateway redelivers; check it if it does not clear.`,
  }).catch(() => undefined);
  throw new Error(
    'ADDON_GRANT_CHAIN_CONTENDED: could not place the term, the settlement will be retried'
  );
}

export async function applyAddonGrant(
  tx: Tx,
  row: { id: string; storeId: string; planCode: string | null },
  now: Date,
  effects: { push(e: GrantEffect): unknown }
): Promise<void> {
  const sku = skuOfPlanCode(row.planCode);
  if (!sku) {
    // Money was taken for something we cannot deliver: grant nothing, hand it back (billing-notify refunds + alerts).
    effects.push({ kind: 'addon_unapplied', storeId: row.storeId, billingEventId: row.id });
    return;
  }
  // A super-admin "off" is never overridden by a payment (ADDON-RENEW-1): if one appeared between the quote and the
  // payment, grant nothing and hand the money back.
  const item0 = ADDON_CATALOG[sku];
  if (item0.kind === 'feature') {
    const off = await tx.storeFeature.findFirst({
      where: { storeId: row.storeId, featureKey: item0.featureKey!, enabled: false },
      select: { featureKey: true },
    });
    if (off) {
      effects.push({ kind: 'addon_unapplied', storeId: row.storeId, billingEventId: row.id });
      return;
    }
  }
  await grantTerm(tx, row, sku, now);
  effects.push({ kind: 'addon_granted', storeId: row.storeId });
}
