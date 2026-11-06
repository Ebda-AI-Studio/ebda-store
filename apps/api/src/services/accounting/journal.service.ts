import { prisma, withStore, currentStoreId } from '@ebda/database';
import { getEntityStoreId } from '../../lib/definer';
import type { JournalEntry, JournalEntrySource, Prisma } from '@prisma/client';
import { Prisma as PrismaNs } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { broadcastToStore } from '../../lib/socket-broadcast';
import { withSavepointOn } from '../../lib/savepoint';
import { storeDb, storeMoney } from '../../lib/repo-factory';
import { AppError } from '../../middleware/error-handler';

import { REGION } from '@ebda/shared';
export interface JournalLineInput {
  accountId: string;
  debit: number;
  credit: number;
  lineMemo?: string;
  lineMemoAr?: string;
  refTable?: string;
  refId?: string;
  /**
   * ISO-4217 currency code of the original transaction.
   * Defaults to 'EGP' (no conversion needed).
   */
  currency?: string;
  /**
   * FX rate: 1 unit of `currency` = fxRate EGP.
   * Required when currency !== 'EGP'.
   * Stored as Prisma Decimal (numeric(16,8)) for exact arithmetic.
   * Pass as a number or string — it is coerced to Decimal on write.
   */
  fxRate?: number;
  /**
   * Original amount in the foreign currency's minor units (before EGP conversion).
   * For EGP lines this equals debit or credit.
   * For non-EGP lines, debit/credit hold the EGP-converted piastres.
   */
  originalAmount?: number;
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

  // RLS escape hatch 2026-05-21: when no caller-provided tx exists, Inngest
  // jobs and other background workers call postEntry directly via the
  // proxy, which falls through to basePrisma with no app.current_store_id
  // GUC set. The journal_entries RLS policy then filters every INSERT /
  // SELECT to invisible — silent no-op, no error. Wrap in withStore
  // when standalone so the GUC is set inside our own transaction.
  // Caller-provided tx is assumed to have app.current_store_id set (from
  // request middleware or a store-scoped delete).
  if (!input.tx) {
    return withStore(input.storeId, tx => postEntry({ ...input, tx }));
  }

  // Fast-path idempotency check (skipped if no sourceId — manual entries are
  // never coalesced). Cheap: indexed by (source, source_id). If hit, return
  // without locking anything.
  if (input.sourceId) {
    const client = input.tx ?? prisma;
    const existing = await client.journalEntry.findFirst({
      where: {
        storeId: input.storeId,
        source: input.source,
        sourceId: input.sourceId,
      },
    });
    if (existing) return existing;
  }

  // Reserve the sequence number using the SAME transaction connection (input.tx)
  // so that no additional pool connection is needed. Previously nextSequence was
  // called without a tx, which internally called withRlsBypass and opened a second
  // connection. Under concurrent fan-out (5 parallel webhook retries) with
  // connection_limit=5, all 5 outer bypass transactions held the pool connections
  // and the 5 inner nextSequence→withRlsBypass calls deadlocked waiting for a free
  // slot. Passing input.tx reuses the already-open bypass connection — zero
  // additional pool pressure. The sequences table upsert is still atomic because
  // it's a single INSERT … ON CONFLICT DO UPDATE … RETURNING statement.
  const entryNumber = await nextSequence(input.storeId, 'journal', input.tx);

  const createData: PrismaNs.JournalEntryCreateInput = {
    store: { connect: { id: input.storeId } },
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
        // Multi-currency: thread FX fields through when present.
        // EGP lines omit these (Prisma uses schema defaults: currency='EGP', fxRate=1, originalAmount=0).
        ...(l.currency && l.currency !== REGION.currency
          ? {
              currency: l.currency,
              fxRate: l.fxRate ?? 1,
              originalAmount: l.originalAmount ?? (l.debit || l.credit),
            }
          : {}),
        lineMemo: l.lineMemo,
        lineMemoAr: l.lineMemoAr,
        refTable: l.refTable,
        refId: l.refId,
      })),
    },
  };

  let entry: JournalEntry;

  if (input.tx && input.sourceId) {
    // We are inside a caller's Postgres transaction. A plain `create` that hits
    // the partial unique index on (store_id, source, source_id) would raise
    // P2002 and put the ENTIRE outer transaction into ABORTED state — every
    // subsequent statement in the transaction then throws "current transaction
    // is aborted, commands ignored until end of transaction block".
    //
    // Fix: wrap the create in a Postgres SAVEPOINT so that a conflict only
    // rolls back to the savepoint, leaving the outer transaction healthy.
    // If the conflict fires we fall back to a findFirst on the existing entry.
    // `withSavepointOn` keeps the original error even if the rollback itself
    // fails, so the P2002 check below still sees the P2002.
    const tx = input.tx;
    try {
      entry = await withSavepointOn(tx, () => tx.journalEntry.create({ data: createData }));
    } catch (err: unknown) {
      if (err instanceof PrismaNs.PrismaClientKnownRequestError && err.code === 'P2002') {
        // A concurrent caller (or a retry) already posted this entry — return it.
        const winner = await input.tx.journalEntry.findFirst({
          where: {
            storeId: input.storeId,
            source: input.source,
            sourceId: input.sourceId,
          },
        });
        if (winner) return winner;
      }
      throw err;
    }
  } else {
    // No outer transaction: a plain try/catch is safe because there is no
    // parent transaction state to corrupt on a P2002.
    try {
      const client = input.tx ?? prisma;
      entry = await client.journalEntry.create({ data: createData });
    } catch (err: unknown) {
      // P2002 = unique constraint violation on
      // journal_entries_store_source_source_id_unique partial index.
      if (
        err instanceof PrismaNs.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        input.sourceId
      ) {
        const winner = await prisma.journalEntry.findFirst({
          where: {
            storeId: input.storeId,
            source: input.source,
            sourceId: input.sourceId,
          },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // Non-blocking UI refresh signal — best-effort, never throws
  broadcastToStore(input.storeId, {
    name: 'ui/journal-posted',
    data: { entryId: entry.id, source: input.source, sourceId: input.sourceId },
  });

  return entry;
}

/**
 * The merchant-facing manual adjusting entry (`POST /finance/journal`). A store on its Durable Object posts it through the
 * `journalManual` money op: one atomic section that checks balance, that every account is an active account of THIS store, and
 * writes the entry and its lines together (Ruling NZ-FEAT-1). A Postgres store runs `postEntry`, unchanged. The refusals read
 * the same on both: an unbalanced entry is a 400, an unknown account a 404, a disabled one a 409.
 */
export async function postManualEntry(input: PostEntryInput): Promise<JournalEntry> {
  const money = await storeMoney(input.storeId);
  if (!money) return postEntry(input);
  const { id } = await money.journalManual({
    memo: input.memo ?? null,
    memoAr: input.memoAr ?? null,
    postedAtMs: input.postedAt ? input.postedAt.getTime() : null,
    postedBy: input.postedBy ?? null,
    lines: input.lines.map(l => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      lineMemo: l.lineMemo ?? null,
      currency: l.currency,
      fxRate: l.fxRate ?? null,
      originalAmount: l.originalAmount,
    })),
  });
  const entry = await (
    await storeDb(input.storeId)
  ).journalEntry.findFirst({
    where: { id, storeId: input.storeId },
  });
  if (!entry)
    throw new AppError(500, 'JOURNAL_READBACK_FAILED', 'Posted entry could not be read back');
  broadcastToStore(input.storeId, {
    name: 'ui/journal-posted',
    data: { entryId: entry.id, source: input.source, sourceId: input.sourceId },
  });
  return entry as JournalEntry;
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
      where: { id: originalId, storeId: currentStoreId() },
      include: { lines: true },
    });
    if (!original) throw new Error(`JournalEntry ${originalId} not found`);
    if (original.status === 'reversed') {
      throw new Error(`JournalEntry ${originalId} is already reversed`);
    }

    // Pass `t` so nextSequence reuses the same connection (prevents nested
    // withRlsBypass from exhausting the pool under concurrent reversal calls).
    const entryNumber = await nextSequence(original.storeId, 'journal', t);
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
            // Preserve FX metadata on reversals so the reversal entry still
            // shows the original foreign-currency context.
            ...(l.currency && l.currency !== REGION.currency
              ? {
                  currency: l.currency,
                  fxRate: l.fxRate ?? 1,
                  originalAmount: l.originalAmount ?? 0,
                }
              : {}),
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
      where: { id: original.id, storeId: original.storeId },
      data: { status: 'reversed', reversedById: reversal.id },
    });

    return reversal;
  };
  // When no caller-provided tx, wrap in withStore — Inngest reversal
  // paths (refund posting, profit-anomaly remediation) run without tenant
  // context, so RLS on journal_entries would silently filter every read
  // and the create would fail WITH CHECK. See journal.service.postEntry
  // for the same pattern + feedback-postgres-rls-silent-filter-trap.md.
  let reversal: JournalEntry;
  if (tx) {
    reversal = await run(tx);
  } else {
    // The entry's store is found by primary key through a definer, and the
    // reversal runs inside it.
    const originalStoreId = await getEntityStoreId('journal_entry', originalId);
    if (!originalStoreId) throw new Error(`JournalEntry ${originalId} not found`);
    reversal = await withStore(originalStoreId, t => run(t as unknown as Prisma.TransactionClient));
  }

  // Non-blocking UI refresh signal — best-effort, never throws
  broadcastToStore(reversal.storeId, {
    name: 'ui/journal-reversed',
    data: { entryId: reversal.id, originalId },
  });

  return reversal;
}
