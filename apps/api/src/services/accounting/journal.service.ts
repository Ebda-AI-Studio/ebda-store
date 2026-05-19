import { prisma } from '@force/database';
import type { JournalEntry, JournalEntrySource, Prisma } from '@prisma/client';
import { nextSequence } from '../sequence.service';

export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string;
  lineMemoAr?: string;
  refTable?: string;
  refId?: string;
}

export interface PostEntryInput {
  storeId: string;
  source: JournalEntrySource;
  sourceId?: string;
  memo?: string;
  memoAr?: string;
  postedAt?: Date;
  postedBy?: string;
  lines: JournalLineInput[];
  /**
   * Optional Prisma transaction client. When provided, the post happens inside
   * the caller's transaction so operational write + journal post commit
   * atomically (used by order-posting / refund-posting / po-receive).
   */
  tx?: Prisma.TransactionClient;
}

/**
 * Idempotent journal-entry post. Returns the existing entry if
 * (source, sourceId) already exists for this store. Validates DR=CR
 * client-side; the DB-level deferred trigger is the final guard.
 */
export async function postEntry(input: PostEntryInput): Promise<JournalEntry> {
  const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new Error(`Journal lines unbalanced: DR=${totalDebit} CR=${totalCredit}`);
  }
  if (input.lines.length === 0) {
    throw new Error('Journal entry requires at least one line');
  }

  const run = async (tx: Prisma.TransactionClient) => {
    if (input.sourceId) {
      const existing = await tx.journalEntry.findFirst({
        where: {
          storeId: input.storeId,
          source: input.source,
          sourceId: input.sourceId,
        },
      });
      if (existing) return existing;
    }

    const entryNumber = await nextSequence(input.storeId, 'journal');
    return tx.journalEntry.create({
      data: {
        storeId: input.storeId,
        entryNumber,
        postedAt: input.postedAt ?? new Date(),
        source: input.source,
        sourceId: input.sourceId,
        memo: input.memo,
        memoAr: input.memoAr,
        status: 'posted',
        postedBy: input.postedBy,
        lines: {
          create: input.lines.map(l => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            lineMemo: l.lineMemo,
            lineMemoAr: l.lineMemoAr,
            refTable: l.refTable,
            refId: l.refId,
          })),
        },
      },
    });
  };

  return input.tx ? run(input.tx) : prisma.$transaction(run);
}

/**
 * Post the mirror of an existing entry (debits become credits and vice versa).
 * Sets the original's reversedById to the new reversal entry's id; the new
 * entry's `reverses` accessor resolves via the inverse "Reversal" relation.
 *
 * NOTE: schema uses a single "Reversal" named relation with one FK
 * (reversedById on the entry being reversed). The reversal entry has no
 * reversesId column — its identity as a reversal is derivable from the
 * inverse query (`SELECT … WHERE reversed_by_id = <reversal.id>`).
 */
export async function reverseEntry(
  originalId: string,
  reason?: string,
  tx?: Prisma.TransactionClient
): Promise<JournalEntry> {
  const run = async (t: Prisma.TransactionClient) => {
    const original = await t.journalEntry.findUnique({
      where: { id: originalId },
      include: { lines: true },
    });
    if (!original) throw new Error(`JournalEntry ${originalId} not found`);
    if (original.status === 'reversed') {
      throw new Error(`JournalEntry ${originalId} is already reversed`);
    }

    const entryNumber = await nextSequence(original.storeId, 'journal');
    const reversal = await t.journalEntry.create({
      data: {
        storeId: original.storeId,
        entryNumber,
        postedAt: new Date(),
        source: original.source,
        sourceId: original.sourceId ? `${original.sourceId}:reversal` : undefined,
        memo: reason ?? `Reversal of ${original.entryNumber}`,
        memoAr: reason ?? `إلغاء قيد ${original.entryNumber}`,
        status: 'posted',
        lines: {
          create: original.lines.map(l => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            lineMemo: l.lineMemo,
            lineMemoAr: l.lineMemoAr,
            refTable: l.refTable,
            refId: l.refId,
          })),
        },
      },
    });

    // Mark original as reversed + link via reversedById (FK side of "Reversal")
    await t.journalEntry.update({
      where: { id: original.id },
      data: { status: 'reversed', reversedById: reversal.id },
    });

    return reversal;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
