/**
 * NEON-ZERO-1 (N-10d, Ruling NZ-10D-3): reconcile job for InstaPay receipts and manual-payment claims.
 *
 * With the `payments` family on D1 a subscription receipt submit is several single statements, not one transaction, so a
 * Worker that dies between two of them leaves one of these (each handled idempotently, oldest first, older than `minAgeMs`):
 *   1. a `submitted` subscription receipt with NO claim:
 *        - a pending claim of the same store already holds its transfer reference -> LINK the receipt to it (the claim was
 *          created, the link was not);
 *        - otherwise ROLL BACK: receipt -> draft, reference key cleared, the cross-store reference claim released, so the
 *          payer can re-file.
 *   2. a `pending` claim whose payment is ALREADY in the billing ledger (succeeded manual_payment event with this
 *      reference's idempotency key): the ledger-first D1 write happened, the claim confirm did not -> CONFIRM the claim and
 *      APPROVE its receipt (the same two steps `recordManualPayment` runs, both compare-and-set on `pending`/`submitted`).
 *   3. anything it cannot decide pages P1 and is left untouched: a `confirmed` claim with no ledger event, a receipt whose
 *      claim exists in another state, a ledger event that names no claim.
 */
import { acrossStores, prisma, withStore } from '@ebda/database';
import logger from '../../lib/logger';
import { releaseInstapayReference } from '../../lib/instapay-ref-claim';
import { sendAlert } from '../alerts.service';
import { platformFamilyOnD1 } from '../platform/cutover';
import { manualPaymentKey } from './account.service';

export const RECONCILE_MIN_AGE_MS = 15 * 60_000;
const LIMIT = 200;

export interface ReconcileReport {
  linked: number;
  rolledBack: number;
  confirmed: number;
  undecided: string[];
}

async function scan<T>(fn: (storeId?: string) => Promise<T[]>): Promise<T[]> {
  if (await platformFamilyOnD1('payments')) return fn(undefined);
  return (await acrossStores(id => fn(id))).flatMap(p => p.value);
}

/** D1: the routed `prisma`. Postgres: the same delegates inside the store's tenant transaction. */
async function inScope<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  if (await platformFamilyOnD1('payments')) return fn();
  return withStore(storeId, fn);
}

export async function reconcilePayments(
  opts: { now?: Date; minAgeMs?: number } = {}
): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.minAgeMs ?? RECONCILE_MIN_AGE_MS));
  const report: ReconcileReport = { linked: 0, rolledBack: 0, confirmed: 0, undecided: [] };

  // 1. submitted subscription receipts without a claim
  const orphans = await scan(storeId =>
    prisma.instapayReceipt.findMany({
      where: {
        ...(storeId ? { storeId } : {}),
        kind: 'subscription',
        status: 'submitted',
        claimId: null,
        submittedAt: { lt: cutoff },
      },
      orderBy: { submittedAt: 'asc' },
      take: LIMIT,
    })
  );
  for (const r of orphans) {
    try {
      const claim = r.referenceKey
        ? await inScope(r.storeId, () =>
            prisma.manualPaymentClaim.findFirst({
              where: { storeId: r.storeId, method: 'instapay', payerReference: r.referenceKey! },
            })
          )
        : null;
      if (claim && claim.status === 'pending') {
        const { count } = await inScope(r.storeId, () =>
          prisma.instapayReceipt.updateMany({
            where: { id: r.id, storeId: r.storeId, claimId: null, status: 'submitted' },
            data: { claimId: claim.id },
          })
        );
        if (count) report.linked++;
      } else if (claim) {
        report.undecided.push(`receipt ${r.id}: claim ${claim.id} is ${claim.status}`);
      } else {
        const { count } = await inScope(r.storeId, () =>
          prisma.instapayReceipt.updateMany({
            where: { id: r.id, storeId: r.storeId, claimId: null, status: 'submitted' },
            data: { status: 'draft', referenceKey: null, submittedAt: null },
          })
        );
        if (count && r.referenceKey)
          await releaseInstapayReference(r.referenceKey, r.storeId, r.id);
        if (count) report.rolledBack++;
      }
    } catch (err) {
      report.undecided.push(`receipt ${r.id}: ${(err as Error).message}`);
    }
  }

  // 2 + 3. claims against the billing ledger
  const claims = await scan(storeId =>
    prisma.manualPaymentClaim.findMany({
      where: {
        ...(storeId ? { storeId } : {}),
        status: { in: ['pending', 'confirmed'] },
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: LIMIT,
    })
  );
  for (const c of claims) {
    try {
      const event = await inScope(c.storeId, () =>
        prisma.billingEvent.findFirst({
          where: {
            storeId: c.storeId,
            type: 'manual_payment',
            status: 'succeeded',
            idempotencyKey: manualPaymentKey('instapay', c.payerReference),
          },
          select: { id: true },
        })
      );
      if (c.status === 'confirmed') {
        // confirmed: its ledger event must exist and be the one the claim names
        if (!c.billingEventId || !event || event.id !== c.billingEventId)
          report.undecided.push(`claim ${c.id}: confirmed without a matching ledger event`);
        continue;
      }
      if (!event) continue; // pending, nothing paid: the super-admin queue owns it
      const done = await inScope(c.storeId, async () => {
        const { count } = await prisma.manualPaymentClaim.updateMany({
          where: { id: c.id, storeId: c.storeId, status: 'pending' },
          data: {
            status: 'confirmed',
            reviewedBy: 'system:payments-reconcile',
            reviewedAt: now,
            billingEventId: event.id,
          },
        });
        if (count)
          await prisma.instapayReceipt.updateMany({
            where: { storeId: c.storeId, claimId: c.id, status: 'submitted' },
            data: { status: 'approved', reviewedBy: 'system:payments-reconcile', reviewedAt: now },
          });
        return count;
      });
      if (done) report.confirmed++;
    } catch (err) {
      report.undecided.push(`claim ${c.id}: ${(err as Error).message}`);
    }
  }

  if (report.undecided.length) {
    logger.error({ undecided: report.undecided.length }, '[payments-reconcile] undecidable rows');
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'payments.reconcile.undecided',
      title: 'Payments reconcile: rows it cannot decide',
      body: `${report.undecided.length} row(s) need a human:\n${report.undecided.slice(0, 20).join('\n')}`,
      context: { undecided: report.undecided.length },
    }).catch(() => undefined);
  }
  if (report.linked || report.rolledBack || report.confirmed)
    logger.warn({ ...report, undecided: report.undecided.length }, '[payments-reconcile] repaired');
  return report;
}
