import { currentStoreId } from '@ebda/database';
import { withScopedToOrderStore } from './order-scope';
import type { Prisma } from '@prisma/client';
import { reverseEntry } from '../journal.service';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';

/**
 * Reverse the GL entries associated with a refunded order. Reverses:
 *   - The cash/sales entry (source='order', sourceId=orderId)
 *   - The COGS entry (source='order', sourceId=`${orderId}:cogs`)
 *   - Any pro-rata PARTIAL-return adjustment entries posted before this full
 *     refund (sourceId `${orderId}:partial:<refundKey>[…:cogs]`, see
 *     partial-return-posting.ts). Without this, a full refund after a
 *     partial return would double-reverse the already-adjusted portion —
 *     the original mirror reverses the WHOLE sale, so the partial
 *     adjustments must be backed out too for the ledger to net to zero.
 *     (`:reversal`-suffixed entries are reverseEntry's own output and are
 *     excluded — re-reversing one would resurrect what it reversed.)
 *
 * Idempotent. If an entry is already reversed (status='reversed') we skip
 * it. If none exist (order was never posted as paid), we no-op silently.
 *
 * When no caller-provided tx exists, the whole pass runs inside
 * withRlsBypass: journal_entries is FORCE RLS and Inngest jobs carry no
 * tenant ALS scope, so a bare-prisma read here would be silently filtered
 * to zero candidates and the reversal would no-op without an error (same
 * escape-hatch class as journal.service.postEntry — see its 2026-05-21
 * comment and feedback-postgres-rls-silent-filter-trap.md). Bundling the
 * pass in one transaction also makes the reversals atomic as a set.
 */
export async function postRefundJournal(args: {
  orderId: string;
  reason?: string;
  /**
   * The event's storeId, when the caller has one. Added to the candidate
   * WHERE so a hand-crafted or replayed event with a mismatched
   * (orderId, storeId) pair reverses nothing — under withRlsBypass, RLS
   * provides no backstop for the mismatch (issue 1190).
   */
  storeId?: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ reversed: number }> {
  // A store on its Durable Object reverses its own sale, COGS and partial entries in one section (Ruling CF-LEDGER-1).
  if (args.storeId) {
    const money = await storeMoney(args.storeId);
    if (money) return money.journalRefund({ orderId: args.orderId, reason: args.reason });
  }
  if (!args.tx) {
    return withScopedToOrderStore(args, tx => postRefundJournal({ ...args, tx }), { reversed: 0 });
  }
  const { orderId, reason, storeId, tx } = args;

  // Contend on the sale-entry row BEFORE snapshotting candidates.
  // postPartialReturnJournal takes the same FOR UPDATE while it posts its
  // adjustment entries; without this lock the findMany below could snapshot
  // mid-partial (the uncommitted adjustments invisible under READ
  // COMMITTED), reverse only the originals, and leave the partial
  // adjustments standing — a ledger that never nets to zero (issue 1187).
  // No sale entry → nothing to lock and nothing the query below can find
  // except partial adjustments, which only exist if the sale entry does.
  await tx.$queryRaw`SELECT id FROM public.journal_entries WHERE source = 'order' AND source_id = ${orderId} FOR UPDATE`;

  const candidates = await tx.journalEntry.findMany({
    where: {
      source: 'order',
      storeId: storeId ?? currentStoreId(),
      OR: [
        { sourceId: { in: [orderId, `${orderId}:cogs`] } },
        { sourceId: { startsWith: `${orderId}:partial:`, not: { endsWith: ':reversal' } } },
      ],
    },
    select: { id: true, status: true, sourceId: true },
  });

  let reversed = 0;
  for (const entry of candidates) {
    if (entry.status === 'reversed') continue;
    try {
      await reverseEntry(entry.id, reason ?? 'refund applied', tx);
      reversed += 1;
    } catch (err: unknown) {
      // reverseEntry throws "already reversed" — treat as no-op
      if (err instanceof Error && /already reversed/i.test(err.message)) continue;
      throw err;
    }
  }

  if (candidates.length === 0) {
    logger.info({ orderId }, 'postRefundJournal: no original entries to reverse');
  }
  return { reversed };
}
