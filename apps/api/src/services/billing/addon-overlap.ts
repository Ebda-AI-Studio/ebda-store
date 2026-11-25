/**
 * Daily reconcile of overlapping PAID add-on terms for one store + feature (SELF-SERVICE A8, review of #797).
 *
 * The term chain (addon-grant.ts) keeps paid terms back to back. In the rare stalled-settlement case two terms can still
 * overlap (a payment that settled late, outside the chain). Access is checked by END DATE only, so the overlap is free
 * days: this job finds it and raises ONE P1 so a super admin can refund the overlap from the ledger.
 *
 * A term runs `[forPeriodEnd - ADDON_TERM_DAYS, forPeriodEnd]` (the chain always starts a term at max(now, previous end)).
 * Terms of one (store, add-on) sorted by end overlap by `previous.end - next.start` when that is positive.
 * Idempotent: the pair is recorded once as a zero-amount marker row (`addon-overlap:<sku>`, UNIQUE key from the two
 * billing event ids); only the run that records it alerts. The alert carries ids and a length only (no PII).
 * Reads use an explicit select and key pagination (`id > last`, page size `pageSize`).
 */
import crypto from 'crypto';
import { prisma, withStore } from '@ebda/database';
import logger from '../../lib/logger';
import { isStoreGoneError } from '../../lib/jobs/store-gone';
import { sendAlert } from '../alerts.service';
import { acrossBilling } from '../platform/billing-d1';
import { ADDON_PLAN_PREFIX, ADDON_TERM_DAYS, skuOfPlanCode } from './addon-catalog';
import { claimMarkerRow } from './addon-grant';

const DAY_MS = 86_400_000;
const OVERLAP_PREFIX = 'addon-overlap:';

interface TermRow {
  id: string;
  storeId: string;
  planCode: string | null;
  forPeriodEnd: Date | null;
}

async function pageTerms(
  storeId: string | undefined,
  now: Date,
  pageSize: number
): Promise<TermRow[]> {
  const out: TermRow[] = [];
  let last: string | undefined;
  for (;;) {
    const where = {
      ...(storeId ? { storeId } : {}),
      type: 'upgrade',
      status: 'succeeded',
      planCode: { startsWith: ADDON_PLAN_PREFIX },
      forPeriodEnd: { gt: now },
      ...(last ? { id: { gt: last } } : {}),
    };
    const args = {
      where,
      orderBy: { id: 'asc' as const },
      take: pageSize,
      select: { id: true, storeId: true, planCode: true, forPeriodEnd: true },
    };
    const page = storeId
      ? await withStore(storeId, tx => tx.billingEvent.findMany(args))
      : await prisma.billingEvent.findMany(args);
    out.push(...page);
    if (page.length < pageSize) return out;
    last = page[page.length - 1].id;
  }
}

/** Overlaps between consecutive terms of each (store, add-on), longest-first not needed: one entry per pair. */
function overlapsOf(
  rows: TermRow[]
): Array<{ storeId: string; sku: string; a: TermRow; b: TermRow; days: number }> {
  const groups = new Map<string, TermRow[]>();
  for (const r of rows) {
    const sku = skuOfPlanCode(r.planCode);
    if (!sku || !r.forPeriodEnd) continue;
    const k = `${r.storeId}|${sku}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: ReturnType<typeof overlapsOf> = [];
  for (const [k, terms] of groups) {
    const [storeId, sku] = k.split('|');
    terms.sort(
      (x, y) => x.forPeriodEnd!.getTime() - y.forPeriodEnd!.getTime() || (x.id < y.id ? -1 : 1)
    );
    for (let i = 1; i < terms.length; i++) {
      const prev = terms[i - 1];
      const next = terms[i];
      const nextStart = next.forPeriodEnd!.getTime() - ADDON_TERM_DAYS * DAY_MS;
      const days = Math.floor((prev.forPeriodEnd!.getTime() - nextStart) / DAY_MS);
      if (days >= 1) out.push({ storeId, sku, a: prev, b: next, days });
    }
  }
  return out;
}

export async function reconcileAddonOverlaps(
  now: Date = new Date(),
  opts: { pageSize?: number } = {}
): Promise<{ scanned: number; overlaps: number; alerted: number }> {
  const pageSize = opts.pageSize ?? 500;
  const parts = await acrossBilling(storeId => pageTerms(storeId, now, pageSize), {
    onStoreError: (storeId, err) => logger.error({ err, storeId }, '[addon-overlap] scan failed'),
  });
  const rows = parts.flatMap(p => p.value);
  const found = overlapsOf(rows);
  let alerted = 0;
  for (const o of found) {
    try {
      const [first, second] = [o.a.id, o.b.id].sort();
      const claimed = await withStore(o.storeId, tx =>
        claimMarkerRow(tx, {
          id: crypto.randomUUID(),
          storeId: o.storeId,
          planCode: `${OVERLAP_PREFIX}${o.sku}`,
          relatedEventId: o.b.id,
          endAt: o.a.forPeriodEnd!,
          key: `addon-overlap:${o.storeId}:${o.sku}:${first}:${second}`,
        })
      );
      if (!claimed) continue; // already reported
      await sendAlert({
        level: 'p1',
        title: 'Add-on terms overlap: refund the overlap',
        body: `store ${o.storeId}, ${o.sku}: billing_events ${o.a.id} and ${o.b.id} overlap by ${o.days} days (free days). A super admin can refund the overlap from the ledger.`,
      });
      alerted++;
    } catch (err) {
      // A closed / removed store is skipped, never a failed run (gone-store guard).
      if (isStoreGoneError(err)) {
        logger.warn({ storeId: o.storeId }, '[addon-overlap] skipped: store is gone');
        continue;
      }
      logger.error({ err, storeId: o.storeId }, '[addon-overlap] report failed');
    }
  }
  return { scanned: rows.length, overlaps: found.length, alerted };
}
