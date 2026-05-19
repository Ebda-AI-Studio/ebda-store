import { prisma } from '@force/database';
import type { Prisma } from '@prisma/client';
import { reverseEntry } from '../journal.service';
import logger from '../../../lib/logger';

/**
 * Reverse the GL entries associated with a refunded order. Reverses BOTH:
 *   - The cash/sales entry (source='order', sourceId=orderId)
 *   - The COGS entry (source='order', sourceId=`${orderId}:cogs`)
 *
 * Idempotent. If either entry is already reversed (status='reversed') we skip
 * it. If neither exists (order was never posted as paid), we no-op silently.
 *
 * Partial refunds: v1 reverses the entire entry. Proportional partial-refund
 * reversal is a Batch 2 follow-up.
 */
export async function postRefundJournal(args: {
  orderId: string;
  reason?: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ reversed: number }> {
  const { orderId, reason, tx } = args;
  const client: Prisma.TransactionClient | typeof prisma = tx ?? prisma;

  const candidates = await client.journalEntry.findMany({
    where: {
      source: 'order',
      sourceId: { in: [orderId, `${orderId}:cogs`] },
    },
    select: { id: true, status: true, sourceId: true },
  });

  let reversed = 0;
  for (const entry of candidates) {
    if (entry.status === 'reversed') continue;
    try {
      await reverseEntry(entry.id, reason ?? 'refund applied', tx);
      reversed += 1;
    } catch (err: any) {
      // reverseEntry throws "already reversed" — treat as no-op
      if (/already reversed/i.test(err?.message ?? '')) continue;
      throw err;
    }
  }

  if (candidates.length === 0) {
    logger.info({ orderId }, 'postRefundJournal: no original entries to reverse');
  }
  return { reversed };
}
