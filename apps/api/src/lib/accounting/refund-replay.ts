/**
 * Replay of partial-refund journals that were skipped because the order's sale journal did not exist yet.
 *
 * A refund booked before the sale entry exists (a COD return before delivery settles it, a cancelled backorder line, a provider
 * dashboard refund) has its journal skipped by the money ops (`no-original-entry`), and nothing retries it. Two callers fix that:
 *  - the sale posting itself (`replayPreSaleRefunds`, called right after `journalSale`), and
 *  - the one-off backfill for orders that predate this (`sale-journal-backfill.ts`).
 * Both use the refund job's own money ops (journalPartialReturn / journalAmountOnlyRefund), idempotent per refundKey.
 */
import { storeMoney, storeRepo } from '../repo-factory';

// Item-level markers (a return's partial restore, a cancelled backorder line `backorder:<lineId>`) route to journalPartialReturn;
// the amount-only marker to journalAmountOnlyRefund: the same routing as accounting-post-refund-journal.
const ITEM_MARKERS = ['partial_return_restored', 'backorder_line_cancelled'] as const;
const PARTIAL_MARKERS = [...ITEM_MARKERS, 'partial_refund_recorded'] as const;

const bump = (r: Record<string, number>, k: string, n = 1): void => {
  r[k] = (r[k] ?? 0) + n;
};

const isItemMarker = (m: string): boolean => (ITEM_MARKERS as readonly string[]).includes(m);

export type Repo = Awaited<ReturnType<typeof storeRepo>>;
export type Money = NonNullable<Awaited<ReturnType<typeof storeMoney>>>;
export interface PartialRefund {
  refundKey: string;
  at: number;
  items: Array<{ orderItemId: string; quantity: number }>;
  amount: number;
}

/** The order's partial refunds, oldest first, as the refund job would have been told about them. */
export async function partialRefunds(
  repo: Repo,
  storeId: string,
  orderId: string
): Promise<PartialRefund[]> {
  const out: PartialRefund[] = [];
  for (const marker of PARTIAL_MARKERS) {
    const rows = await repo.db.orderEvent.findMany({
      where: { storeId, orderId, toStatus: marker },
      select: { metadata: true, createdAt: true },
    });
    for (const r of rows) {
      const m = (r.metadata ?? null) as {
        refundKey?: unknown;
        items?: unknown;
        amount?: unknown;
      } | null;
      if (!m || typeof m.refundKey !== 'string') continue;
      const items = Array.isArray(m.items)
        ? (m.items as Array<{ orderItemId: string; quantity: number }>).filter(
            i => typeof i?.orderItemId === 'string' && typeof i?.quantity === 'number'
          )
        : [];
      const amount = typeof m.amount === 'number' ? m.amount : 0;
      // Same routing as accounting-post-refund-journal: items => pro-rata adjustment; no items => an amount-only refund.
      if (isItemMarker(marker) && items.length === 0) continue;
      if (marker === 'partial_refund_recorded' && amount <= 0) continue;
      out.push({
        refundKey: m.refundKey,
        at: new Date(r.createdAt as string | Date).getTime(),
        items: isItemMarker(marker) ? items : [],
        amount,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Replay each refund's journal through the refund job's own money ops (idempotent per refundKey). */
export async function replayRefunds(
  money: Money,
  orderId: string,
  refunds: PartialRefund[],
  reasons: Record<string, number>
): Promise<void> {
  for (const r of refunds) {
    const res =
      r.items.length > 0
        ? await money.journalPartialReturn({ orderId, refundKey: r.refundKey, items: r.items })
        : await money.journalAmountOnlyRefund({
            orderId,
            refundKey: r.refundKey,
            amount: r.amount,
          });
    if (res.posted > 0) bump(reasons, 'refunds_replayed');
    else bump(reasons, `refund_replay_skipped_${res.skipped ?? 'none'}`);
  }
}

/**
 * After an order's sale journal exists: replay every refund that happened BEFORE it (event no newer than the sale entry) and whose
 * partial journal (or its cogs twin) is missing. Refunds made after the sale existed were journalled by the normal flow and are
 * never touched. Idempotent and safe to repeat, so a retry of a failed posting step completes what the first attempt left.
 * Returns how many refund journals were posted.
 */
export async function replayPreSaleRefunds(
  repo: Repo,
  money: Money,
  storeId: string,
  orderId: string
): Promise<{ replayed: number; reasons: Record<string, number> }> {
  const reasons: Record<string, number> = {};
  const sale = await repo.db.journalEntry.findFirst({
    where: { storeId, source: 'order', sourceId: orderId },
    select: { id: true, createdAt: true },
  });
  if (!sale) return { replayed: 0, reasons };
  const pending = await pendingPreSaleRefunds(
    repo,
    storeId,
    orderId,
    sale.createdAt as string | Date
  );
  if (pending.length > 0) await replayRefunds(money, orderId, pending, reasons);
  return { replayed: reasons.refunds_replayed ?? 0, reasons };
}

/** Refunds older than the sale entry whose partial journal does not exist. */
export async function pendingPreSaleRefunds(
  repo: Repo,
  storeId: string,
  orderId: string,
  saleCreatedAt: string | Date
): Promise<PartialRefund[]> {
  const saleAt = new Date(saleCreatedAt).getTime();
  const pending: PartialRefund[] = [];
  for (const r of await partialRefunds(repo, storeId, orderId)) {
    // <=: a refund and the sale stamped in the same millisecond must not lose the refund (the replay is idempotent per key)
    if (!(r.at <= saleAt)) continue;
    const base = `${orderId}:partial:${r.refundKey}`;
    const done = await repo.db.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: { in: [base, `${base}:cogs`] } },
      select: { id: true },
    });
    if (!done) pending.push(r);
  }
  return pending;
}
