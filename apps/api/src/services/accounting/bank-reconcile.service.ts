/**
 * Bank Reconciliation Service
 *
 * Handles statement import (parse → persist → auto-match) and
 * manual match/unmatch/ignore overrides.
 *
 * MATCHING RULES (deterministic, no ML):
 * For each bank transaction, find JournalLines where:
 *   • direction-matched: bank debit → ledger debit line; bank credit → ledger credit line
 *   • amount equal: |line.debit/credit - tx.amountFils| <= AMOUNT_TOLERANCE_FILS
 *   • date within ±DATE_TOLERANCE_DAYS
 *   • entry is 'posted' and not already matched to another bank transaction
 *   • entry belongs to the same store (RLS enforces this too)
 *
 * Result:
 *   • 0 candidates → unmatched
 *   • 1 candidate  → auto_matched (confidence 0–100 based on amount exactness)
 *   • 2+ candidates → unmatched (ambiguous; user must resolve manually)
 *
 * A ledger entry that is already matched to one bank row cannot be
 * re-matched to a second row (enforced by the exclusion query).
 */

import { withStore } from '@ebda/database';
import type { BankMatchStatus, BankTransaction, Prisma } from '@prisma/client';
import { parseStatementCsv, parseStatementOfx, type ParsedRow } from './bank-statement-parser';
import { assertStoreOwns, assertStoreOwnsInTenantScope } from './assert-store-owns';
import { AppError } from '../../middleware/error-handler';
import { isP2002 } from '../../lib/prisma-errors';
import { COUNTED_STATUSES_SQL } from './reports.service';
import { storeDb, storeMoney, storeRepo, storeWriter } from '../../lib/repo-factory';
import { runInStoreCtx } from '../../lib/jobs/store-db';

import { minorToDecimalString } from '@ebda/shared';
// ─── Constants ────────────────────────────────────────────────────────────────

/** Tolerance for amount matching: 5 piastres = EGP 0.05 (rounding/truncation). */
const AMOUNT_TOLERANCE_FILS = 5;

/** Maximum days difference between bank transaction date and journal posting date. */
const DATE_TOLERANCE_DAYS = 3;
const DATE_TOLERANCE_MS = DATE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hard row cap per statement (FIX-013, audit 2026-10-05). Import upserts every
 * row inside one interactive transaction and auto-match runs inline in the
 * request, so work scales linearly with row count and there was no bound but
 * the 5MB upload limit (tens of thousands of rows). Not benchmarked: 2000 is a
 * conservative ceiling (a month of a small merchant's bank activity is far
 * below it); split larger statements by period. Raise only after measuring.
 */
export const MAX_STATEMENT_ROWS = 2000;

function assertWithinRowCap(rowCount: number): void {
  if (rowCount > MAX_STATEMENT_ROWS) {
    throw new AppError(
      422,
      'STATEMENT_TOO_LARGE',
      `Statement has ${rowCount} rows; the maximum is ${MAX_STATEMENT_ROWS}. Split the file by period and import each part.`
    );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportStatementInput {
  storeId: string;
  glAccountId: string;
  fileName: string;
  buffer: Buffer;
  fileType: 'csv' | 'ofx';
}

export interface ImportStatementResult {
  statementId: string;
  /** Rows newly stored by THIS import. */
  imported: number;
  /** Rows in the file whose line was already stored by an earlier import (same row hash). */
  alreadyImported: number;
  skipped: number;
  parseErrors: string[];
}

export interface ReconciliationSummary {
  total: number;
  autoMatched: number;
  manualMatched: number;
  unmatched: number;
  ignored: number;
  matchedAmountFils: number;
  unmatchedAmountFils: number;
}

/**
 * Reconciliation difference panel — the "where is the gap and what to do" block.
 *
 * bankBalanceFils
 *   = sum of all bank statement lines (debits and credits net, from the
 *     merchant's perspective: credits add to the bank account, debits reduce it).
 *     This is what the bank statement says the closing balance contribution is.
 *
 * ledgerBalanceFils
 *   = debit_total - credit_total of all posted journal lines against the GL
 *     account linked to this statement, up to the statement's periodEnd.
 *     Asset accounts (bank/cash) are debit-natural, so a positive balance
 *     means the ledger agrees funds exist.
 *
 * differenceFils = bankBalanceFils - ledgerBalanceFils
 *   > 0 → bank shows more than ledger (unrecorded receipts or missing ledger entries)
 *   < 0 → ledger shows more than bank (unrecorded payments or duplicate ledger entries)
 *   = 0 → fully reconciled
 *
 * unmatchedBankFils   — net of bank lines not yet matched to a ledger entry
 * unmatchedLedgerFils — net of ledger entries against this GL account with no
 *                       matching bank transaction in this statement
 *
 * suggestedAction — human-readable string (English + Arabic stored separately)
 *   explaining what the merchant should do to close the gap.
 */
export interface ReconciliationDifference {
  /** Sum of all bank statement lines net in piastres (credits positive, debits negative from bank POV). */
  bankBalanceFils: number;
  /** Ledger balance for the linked GL account up to statement period end (debit−credit, piastres). */
  ledgerBalanceFils: number;
  /** bankBalanceFils − ledgerBalanceFils. Zero = reconciled. */
  differenceFils: number;
  /** Total piastres of unmatched bank lines (explains bank side of the gap). */
  unmatchedBankFils: number;
  /** Total piastres of unmatched ledger entries for this GL account in the period (explains ledger side). */
  unmatchedLedgerFils: number;
  /** How many ledger entries against this GL account in the period have no matching bank tx. */
  unmatchedLedgerCount: number;
  /** Suggested action string (English). */
  suggestedActionEn: string;
  /** Suggested action string (Arabic). */
  suggestedActionAr: string;
  /** True when differenceFils === 0 (fully reconciled). */
  isReconciled: boolean;
}

// ─── Import ───────────────────────────────────────────────────────────────────

/**
 * Import a bank statement file.
 * 1. Parse the buffer (CSV or OFX).
 * 2. Create the BankStatement record.
 * 3. Upsert BankTransaction rows (idempotent via row_hash unique constraint).
 * 4. Run auto-match for all unmatched transactions.
 * All steps inside one $transaction for atomicity.
 */
export async function importBankStatement(
  input: ImportStatementInput
): Promise<ImportStatementResult> {
  const { storeId, glAccountId, fileName, buffer, fileType } = input;

  // ── Parse ──
  const parsed = fileType === 'ofx' ? parseStatementOfx(buffer) : parseStatementCsv(buffer);

  const { rows, skipped, errors: parseErrors } = parsed;
  assertWithinRowCap(rows.length);

  // Derive period from parsed rows
  const dates = rows.map(r => r.date.getTime());
  const periodStart = dates.length ? new Date(Math.min(...dates)) : null;
  const periodEnd = dates.length ? new Date(Math.max(...dates)) : null;

  // A store on its Durable Object persists the statement and its rows in ONE atomic batch (Ruling NZ-FEAT-1); the Postgres
  // transaction below is unchanged.
  if ((await storeRepo(storeId)).backend === 'do') {
    await assertStoreOwnsInTenantScope(storeId, { accountIds: [glAccountId] });
    const db = await storeDb(storeId);
    const w = await storeWriter(storeId);
    // Row hashes are unique within a file (identical lines carry an occurrence ordinal, ACCT-AUDIT-6); a line an earlier
    // import already stored is skipped and COUNTED, never silently dropped.
    const have = new Set(
      (
        await db.bankTransaction.findMany({
          where: { storeId, rowHash: { in: rows.map(r => r.rowHash) } },
          select: { rowHash: true },
        })
      ).map(r => r.rowHash)
    );
    const fresh = rows.filter(r => !have.has(r.rowHash));
    const statementId = crypto.randomUUID();
    const ops: Promise<unknown>[] = [
      w.bankStatement.create({
        data: {
          id: statementId,
          storeId,
          glAccountId,
          fileName,
          periodStart,
          periodEnd,
          status: 'pending',
        },
        select: { id: true },
      }) as Promise<unknown>,
    ];
    const CHUNK = 100;
    for (let i = 0; i < fresh.length; i += CHUNK)
      ops.push(
        w.bankTransaction.createMany({
          data: fresh.slice(i, i + CHUNK).map(r => buildBankTxCreateData(r, statementId, storeId)),
        }) as Promise<unknown>
      );
    try {
      await w.$transaction(ops as never);
    } catch (err) {
      // Two imports of overlapping files at once: both read "not imported yet", the second batch then hits the
      // (store_id, row_hash) unique and the WHOLE batch rolls back (no statement, no rows). A conflict, not a server error.
      if (isP2002(err))
        throw new AppError(
          409,
          'BANK_IMPORT_CONFLICT',
          'These bank lines are being imported by another upload right now. Refresh and try again.'
        );
      throw err;
    }
    await runAutoMatch(statementId, storeId);
    return {
      statementId,
      imported: fresh.length,
      alreadyImported: rows.length - fresh.length,
      skipped,
      parseErrors,
    };
  }

  // ── Persist (transactional) ──
  let statementId: string;
  let imported = 0;
  let alreadyImported = 0;

  await withStore(storeId, async tx => {
    // glAccountId comes from the request body and is written onto the
    // BankStatement unchecked, then read back with the account's code and
    // name. #1241: this used to run BEFORE this block, on the bare `prisma`
    // client with no tenant context at all (this router is mounted
    // CONTEXT-LESS — see routes/index.ts) — under RLS-enforced posture a read
    // with no GUC set returns zero rows, so the guard would 404 every
    // legitimately-owned account. Run it against `tx`, in the same RLS
    // posture as the writes it protects.
    await assertStoreOwns(storeId, { accountIds: [glAccountId] }, tx);

    // Create statement
    const stmt = await tx.bankStatement.create({
      data: {
        storeId,
        glAccountId,
        fileName,
        periodStart,
        periodEnd,
        status: 'pending',
      },
      select: { id: true },
    });
    statementId = stmt.id;

    // Upsert each row — the unique constraint on (storeId, rowHash) makes this
    // idempotent: re-importing the same statement is a no-op per row.
    const have = new Set(
      (
        await tx.bankTransaction.findMany({
          where: { storeId, rowHash: { in: rows.map(r => r.rowHash) } },
          select: { rowHash: true },
        })
      ).map(r => r.rowHash)
    );
    for (const row of rows) {
      if (have.has(row.rowHash)) {
        alreadyImported++;
        continue;
      }
      const result = await tx.bankTransaction.upsert({
        where: {
          storeId_rowHash: { storeId, rowHash: row.rowHash },
        },
        create: buildBankTxCreateData(row, statementId!, storeId),
        update: {}, // already exists — no-op
        select: { id: true },
      });
      if (result) imported++;
    }
  });

  // ── Auto-match (separate operation, can re-run) ──
  await runAutoMatch(statementId!, storeId);

  return {
    statementId: statementId!,
    imported,
    alreadyImported,
    skipped,
    parseErrors,
  };
}

function buildBankTxCreateData(
  row: ParsedRow,
  statementId: string,
  storeId: string
): Prisma.BankTransactionUncheckedCreateInput {
  return {
    statementId,
    storeId,
    date: row.date,
    description: row.description,
    amountFils: row.amountFils,
    direction: row.direction,
    externalRef: row.externalRef,
    rowHash: row.rowHash,
    matchStatus: 'unmatched',
    confidence: 0,
  };
}

// ─── Auto-match ───────────────────────────────────────────────────────────────

/**
 * Bounded chunk size for the auto-match loop below. Mirrors the
 * `SCAN_CHUNK_SIZE` pattern in `reorder-scan.service.ts` — each chunk runs
 * inside its OWN short `withStore` transaction so a large statement
 * (500+ rows) can never blow the 30s interactive-tx timeout regardless of
 * total row count.
 */
const MATCH_CHUNK_SIZE = 50;

/**
 * Run (or re-run) automatic matching for all unmatched transactions
 * in a statement.
 *
 * Each call:
 * - Resets any previous auto_matched rows to unmatched (for idempotent re-run)
 * - Finds the best single JournalEntry candidate per bank tx
 * - Updates match_status + matched_journal_entry_id atomically per row
 *
 * Execution shape (fixed 2026-07-02 — same defect class as the low-stock-scan
 * / reorder-scan 30s interactive-tx timeout, P1 2026-06-27/30): the original
 * version held the ENTIRE per-bank-tx-row loop inside one `withStore`
 * transaction, and re-fetched the full store-wide "already matched" entry
 * list from scratch on EVERY iteration (redundant — that baseline never
 * changes during a pass; only the in-memory `claimedEntries` set does). On a
 * 500+ row statement, up to 3 sequential Prisma calls per row inside one
 * open transaction blew the 30s cap ("Transaction already closed").
 *
 * Fix: fetch the already-matched baseline ONCE (not per row), then chunk the
 * per-row candidate-lookup + write loop into bounded `MATCH_CHUNK_SIZE`
 * batches, each its own short `withStore` transaction, so no single
 * transaction's duration scales with the statement's row count. The
 * candidate-matching logic and per-row confidence math are unchanged.
 */
export async function runAutoMatch(
  statementId: string,
  storeId: string
): Promise<{ matched: number; unmatched: number; ambiguous: number }> {
  if ((await storeRepo(storeId)).backend === 'do') return runAutoMatchOnDo(statementId, storeId);

  // -------------------------------------------------------------------------
  // Step 1: short tx — reset prior auto-matches + fetch the rows to match +
  // fetch the "already matched" baseline ONCE (was re-fetched every loop
  // iteration before; that baseline is invariant for the duration of this
  // pass — only `claimedEntries`, tracked in memory below, changes).
  // -------------------------------------------------------------------------
  const { bankTxs, alreadyMatchedIds, bankAccountId } = await withStore(storeId, async tx => {
    // the matcher only looks at the statement's own bank account (ACCT-AUDIT-7)
    const stmt = await tx.bankStatement.findFirst({
      where: { id: statementId, storeId },
      select: { glAccountId: true },
    });
    if (!stmt) throw new AppError(404, 'statement_not_found', 'statement_not_found');
    // Reset prior auto_matches so re-runs are idempotent
    await tx.bankTransaction.updateMany({
      where: { statementId, storeId, matchStatus: 'auto_matched' },
      data: { matchStatus: 'unmatched', matchedJournalEntryId: null, confidence: 0 },
    });

    // Fetch all unmatched transactions for this statement
    const bankTxs = await tx.bankTransaction.findMany({
      where: { statementId, storeId, matchStatus: 'unmatched' },
      select: {
        id: true,
        date: true,
        amountFils: true,
        direction: true,
      },
    });
    // Throwing inside the tx rolls back the reset above, so an oversized
    // (legacy, pre-cap) statement is left exactly as it was.
    assertWithinRowCap(bankTxs.length);

    // Already-matched journal entry ids for this store — fetched ONCE here
    // rather than re-fetched on every bank-tx-row iteration.
    const alreadyMatched = await tx.bankTransaction.findMany({
      where: {
        storeId,
        matchStatus: { in: ['auto_matched', 'manual_matched'] },
        matchedJournalEntryId: { not: null },
      },
      select: { matchedJournalEntryId: true },
    });
    const alreadyMatchedIds = alreadyMatched.map(r => r.matchedJournalEntryId!).filter(Boolean);

    return { bankTxs, alreadyMatchedIds, bankAccountId: stmt.glAccountId };
  });

  // Track which journal entries have been claimed in this pass (across ALL
  // chunks) to prevent one ledger entry matching two bank rows.
  const claimedEntries = new Set<string>();

  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;

  // -------------------------------------------------------------------------
  // Step 2: match + write in BOUNDED chunks, each its own short RLS-bypass
  // tx. Per-row logic (candidate lookup + conditional update) is identical to
  // before — only the transaction boundary changed.
  // -------------------------------------------------------------------------
  for (let chunkStart = 0; chunkStart < bankTxs.length; chunkStart += MATCH_CHUNK_SIZE) {
    const chunk = bankTxs.slice(chunkStart, chunkStart + MATCH_CHUNK_SIZE);

    await withStore(storeId, async tx => {
      for (const btx of chunk) {
        const from = new Date(btx.date.getTime() - DATE_TOLERANCE_MS);
        const to = new Date(btx.date.getTime() + DATE_TOLERANCE_MS);
        const minFils = btx.amountFils - AMOUNT_TOLERANCE_FILS;
        const maxFils = btx.amountFils + AMOUNT_TOLERANCE_FILS;

        const excludedIds = [...alreadyMatchedIds, ...Array.from(claimedEntries)];

        // Find candidate journal entries
        const candidates = await tx.journalLine.findMany({
          where: {
            accountId: bankAccountId,
            account: { storeId },
            ...ledgerSideFilter(btx.direction, minFils, maxFils),
            entry: {
              storeId,
              // A refunded sale's original entry is flipped to 'reversed' but
              // its cash line still happened at the bank — it must stay
              // matchable, the same counted set the reports use.
              status: { in: ['posted', 'reversed'] },
              postedAt: { gte: from, lte: to },
              id: excludedIds.length > 0 ? { notIn: excludedIds } : undefined,
            },
          },
          select: {
            entryId: true,
            debit: true,
            credit: true,
            entry: { select: { postedAt: true } },
          },
        });

        const pick = pickMatch(btx, candidates);
        if (pick.kind === 'none') {
          unmatched++;
          continue;
        }
        if (pick.kind === 'ambiguous') {
          ambiguous++;
          continue;
        }

        await tx.bankTransaction.update({
          where: { id: btx.id, storeId },
          data: {
            matchStatus: 'auto_matched',
            matchedJournalEntryId: pick.entryId,
            confidence: pick.confidence,
          },
        });

        claimedEntries.add(pick.entryId);
        matched++;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: recompute + persist statement status in its own short tx.
  // -------------------------------------------------------------------------
  await withStore(storeId, async tx => {
    const totalTx = await tx.bankTransaction.count({ where: { statementId, storeId } });
    const matchedTotal = await tx.bankTransaction.count({
      where: {
        statementId,
        storeId,
        matchStatus: { in: ['auto_matched', 'manual_matched'] },
      },
    });

    const newStatus =
      matchedTotal === totalTx ? 'reconciled' : matchedTotal > 0 ? 'reconciling' : 'pending';

    await tx.bankStatement.update({
      where: { id: statementId, storeId },
      data: { status: newStatus },
    });
  });

  return { matched, unmatched, ambiguous };
}

/**
 * `runAutoMatch` on a store's Durable Object (Ruling NZ-FEAT-1): the same rules and confidence math, the reads on the DO read
 * client, the reset / per-chunk updates / status as atomic DO batches. Bank rows are bookkeeping, not GL: a concurrent
 * auto-match can at worst match one entry twice, which a re-run (it resets auto matches first) repairs.
 */
async function runAutoMatchOnDo(
  statementId: string,
  storeId: string
): Promise<{ matched: number; unmatched: number; ambiguous: number }> {
  const db = await storeDb(storeId);
  const w = await storeWriter(storeId);
  // the matcher only looks at the statement's own bank account (ACCT-AUDIT-7)
  const stmt = await db.bankStatement.findFirst({
    where: { id: statementId, storeId },
    select: { glAccountId: true },
  });
  if (!stmt) throw new AppError(404, 'statement_not_found', 'statement_not_found');
  const bankAccountId = stmt.glAccountId;
  await w.bankTransaction.updateMany({
    where: { statementId, storeId, matchStatus: 'auto_matched' },
    data: { matchStatus: 'unmatched', matchedJournalEntryId: null, confidence: 0 },
  });
  const bankTxs = await db.bankTransaction.findMany({
    where: { statementId, storeId, matchStatus: 'unmatched' },
    select: { id: true, date: true, amountFils: true, direction: true },
  });
  assertWithinRowCap(bankTxs.length);
  const alreadyMatchedIds = (
    await db.bankTransaction.findMany({
      where: {
        storeId,
        matchStatus: { in: ['auto_matched', 'manual_matched'] },
        matchedJournalEntryId: { not: null },
      },
      select: { matchedJournalEntryId: true },
    })
  )
    .map(r => r.matchedJournalEntryId!)
    .filter(Boolean);

  const claimedEntries = new Set<string>();
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;

  for (let chunkStart = 0; chunkStart < bankTxs.length; chunkStart += MATCH_CHUNK_SIZE) {
    const updates: Promise<unknown>[] = [];
    for (const btx of bankTxs.slice(chunkStart, chunkStart + MATCH_CHUNK_SIZE)) {
      const from = new Date(btx.date.getTime() - DATE_TOLERANCE_MS);
      const to = new Date(btx.date.getTime() + DATE_TOLERANCE_MS);
      const minFils = btx.amountFils - AMOUNT_TOLERANCE_FILS;
      const maxFils = btx.amountFils + AMOUNT_TOLERANCE_FILS;
      const excludedIds = [...alreadyMatchedIds, ...Array.from(claimedEntries)];
      const lines = await db.journalLine.findMany({
        where: {
          accountId: bankAccountId,
          account: { storeId },
          ...ledgerSideFilter(btx.direction, minFils, maxFils),
          entry: {
            storeId,
            status: { in: ['posted', 'reversed'] },
            postedAt: { gte: from, lte: to },
            id: excludedIds.length > 0 ? { notIn: excludedIds } : undefined,
          },
        },
        select: { entryId: true, debit: true, credit: true, entry: { select: { postedAt: true } } },
      });
      // `distinct: ['entryId']` is not in the DO read surface: pickMatch keeps one line per entry
      const pick = pickMatch(btx, lines);
      if (pick.kind === 'none') {
        unmatched++;
        continue;
      }
      if (pick.kind === 'ambiguous') {
        ambiguous++;
        continue;
      }
      updates.push(
        w.bankTransaction.update({
          where: { id: btx.id, storeId },
          data: {
            matchStatus: 'auto_matched',
            matchedJournalEntryId: pick.entryId,
            confidence: pick.confidence,
          },
        }) as Promise<unknown>
      );
      claimedEntries.add(pick.entryId);
      matched++;
    }
    if (updates.length > 0) await w.$transaction(updates as never);
  }

  const totalTx = await db.bankTransaction.count({ where: { statementId, storeId } });
  const matchedTotal = await db.bankTransaction.count({
    where: { statementId, storeId, matchStatus: { in: ['auto_matched', 'manual_matched'] } },
  });
  await w.bankStatement.update({
    where: { id: statementId, storeId },
    data: {
      status:
        matchedTotal === totalTx ? 'reconciled' : matchedTotal > 0 ? 'reconciling' : 'pending',
    },
  });
  return { matched, unmatched, ambiguous };
}

/** Confidence points lost per whole day between the bank line and the journal entry (ACCT-AUDIT-7). */
const DATE_PENALTY_PER_DAY = 10;

interface MatchLine {
  entryId: string;
  debit: number;
  credit: number;
  entry: { postedAt: Date };
}

type MatchPick =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'match'; entryId: string; confidence: number };

/**
 * Choose the journal entry for one bank line among the lines on the statement's bank account (ACCT-AUDIT-7).
 * The bank account is an asset: money IN (bank credit) is a DEBIT on it and money OUT (bank debit) a CREDIT, so the
 * line's own side is the opposite of the bank direction. Candidates are scored on amount closeness minus a penalty per
 * day apart; the best wins only when it strictly beats the runner-up, otherwise the line stays for a human (ambiguous).
 */
export function pickMatch(
  btx: { date: Date; amountFils: number; direction: string },
  lines: MatchLine[]
): MatchPick {
  const byEntry = new Map<string, MatchLine>();
  for (const l of lines) if (!byEntry.has(l.entryId)) byEntry.set(l.entryId, l);
  if (byEntry.size === 0) return { kind: 'none' };
  const scored = [...byEntry.values()]
    .map(l => {
      const ledgerFils = btx.direction === 'credit' ? l.debit : l.credit;
      const days = Math.floor(
        Math.abs(l.entry.postedAt.getTime() - btx.date.getTime()) / 86_400_000
      );
      return {
        entryId: l.entryId,
        confidence: Math.max(
          0,
          computeConfidence(btx.amountFils, ledgerFils) - days * DATE_PENALTY_PER_DAY
        ),
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  if (scored.length > 1 && scored[0].confidence === scored[1].confidence)
    return { kind: 'ambiguous' };
  return { kind: 'match', ...scored[0] };
}

/** The side of the bank GL account a bank line of this direction lands on, as a prisma amount filter. */
function ledgerSideFilter(direction: string, minFils: number, maxFils: number) {
  return direction === 'credit'
    ? { debit: { gte: minFils, lte: maxFils } }
    : { credit: { gte: minFils, lte: maxFils } };
}

/** Confidence 0–100: 100 = exact piastres match, lower as difference grows. */
function computeConfidence(txFils: number, ledgerFils: number): number {
  const diff = Math.abs(txFils - ledgerFils);
  if (diff === 0) return 100;
  if (diff >= AMOUNT_TOLERANCE_FILS) return 0;
  return Math.round(((AMOUNT_TOLERANCE_FILS - diff) / AMOUNT_TOLERANCE_FILS) * 100);
}

// ─── Manual override ──────────────────────────────────────────────────────────

export type ManualMatchAction = 'match' | 'unmatch' | 'ignore';

export interface ManualMatchInput {
  storeId: string;
  transactionId: string;
  action: ManualMatchAction;
  /** Required when action = 'match' */
  journalEntryId?: string;
}

/**
 * Apply a manual match/unmatch/ignore override.
 *
 * 'match'   — links the bank tx to a specific journal entry (manual_matched).
 *             Guards: entry must belong to same store and not be matched elsewhere.
 * 'unmatch' — clears any existing match (→ unmatched).
 * 'ignore'  — marks the tx as intentionally ignored (no ledger counterpart).
 */
export async function applyManualMatch(input: ManualMatchInput): Promise<BankTransaction> {
  const { storeId, transactionId, action, journalEntryId } = input;

  if ((await storeRepo(storeId)).backend === 'do') return applyManualMatchOnDo(input);

  return withStore(storeId, async tx => {
    // Verify the bank transaction belongs to this store
    const btx = await tx.bankTransaction.findUnique({
      where: { id: transactionId, storeId },
      select: { id: true, storeId: true, statementId: true },
    });

    if (!btx || btx.storeId !== storeId) {
      throw new AppError(404, 'not_found', 'not_found');
    }

    if (action === 'unmatch') {
      const updated = await tx.bankTransaction.update({
        where: { id: transactionId, storeId },
        data: { matchStatus: 'unmatched', matchedJournalEntryId: null, confidence: 0 },
      });
      await refreshStatementStatus(tx, btx.statementId, storeId);
      return updated;
    }

    if (action === 'ignore') {
      const updated = await tx.bankTransaction.update({
        where: { id: transactionId, storeId },
        data: { matchStatus: 'ignored', matchedJournalEntryId: null, confidence: 0 },
      });
      await refreshStatementStatus(tx, btx.statementId, storeId);
      return updated;
    }

    // action === 'match'
    if (!journalEntryId) {
      throw new AppError(400, 'bad_request', 'journalEntryId required for match action');
    }

    // Verify journal entry belongs to this store
    const entry = await tx.journalEntry.findFirst({
      where: { id: journalEntryId, storeId },
      select: { id: true },
    });
    if (!entry) {
      throw new AppError(404, 'journal_entry_not_found', 'journal_entry_not_found');
    }

    // Guard: entry must not already be matched to a different bank tx
    const existing = await tx.bankTransaction.findFirst({
      where: {
        storeId,
        matchedJournalEntryId: journalEntryId,
        id: { not: transactionId },
      },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, 'journal_entry_already_matched', 'journal_entry_already_matched');
    }

    const updated = await tx.bankTransaction.update({
      where: { id: transactionId, storeId },
      data: {
        matchStatus: 'manual_matched',
        matchedJournalEntryId: journalEntryId,
        confidence: 100,
      },
    });
    await refreshStatementStatus(tx, btx.statementId, storeId);
    return updated;
  });
}

/**
 * `applyManualMatch` on a store's Durable Object (Ruling NZ-FEAT-1): the same checks and errors. The checks and the update are
 * separate RPCs (residual of CF-WRITES-1): two admins matching one entry to two rows at the same instant could both pass the
 * "already matched" check; the entry still shows on both rows and an unmatch repairs it. No GL is touched.
 */
async function applyManualMatchOnDo(input: ManualMatchInput): Promise<BankTransaction> {
  const { storeId, transactionId, action, journalEntryId } = input;
  const db = await storeDb(storeId);
  const w = await storeWriter(storeId);
  const btx = await db.bankTransaction.findFirst({
    where: { id: transactionId, storeId },
    select: { id: true, storeId: true, statementId: true },
  });
  if (!btx) throw new AppError(404, 'not_found', 'not_found');

  let data: Prisma.BankTransactionUncheckedUpdateInput;
  if (action === 'unmatch') {
    data = { matchStatus: 'unmatched', matchedJournalEntryId: null, confidence: 0 };
  } else if (action === 'ignore') {
    data = { matchStatus: 'ignored', matchedJournalEntryId: null, confidence: 0 };
  } else {
    if (!journalEntryId) {
      throw new AppError(400, 'bad_request', 'journalEntryId required for match action');
    }
    const entry = await db.journalEntry.findFirst({
      where: { id: journalEntryId, storeId },
      select: { id: true },
    });
    if (!entry) throw new AppError(404, 'journal_entry_not_found', 'journal_entry_not_found');
    const existing = await db.bankTransaction.findFirst({
      where: { storeId, matchedJournalEntryId: journalEntryId, id: { not: transactionId } },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, 'journal_entry_already_matched', 'journal_entry_already_matched');
    }
    data = {
      matchStatus: 'manual_matched',
      matchedJournalEntryId: journalEntryId,
      confidence: 100,
    };
  }
  const updated = await w.bankTransaction.update({ where: { id: transactionId, storeId }, data });

  const totalTx = await db.bankTransaction.count({
    where: { statementId: btx.statementId, storeId },
  });
  const matchedTotal = await db.bankTransaction.count({
    where: {
      statementId: btx.statementId,
      storeId,
      matchStatus: { in: ['auto_matched', 'manual_matched', 'ignored'] },
    },
  });
  await w.bankStatement.update({
    where: { id: btx.statementId, storeId },
    data: {
      status:
        matchedTotal === totalTx && totalTx > 0
          ? 'reconciled'
          : matchedTotal > 0
            ? 'reconciling'
            : 'pending',
    },
  });
  return updated as BankTransaction;
}

async function refreshStatementStatus(
  tx: Prisma.TransactionClient,
  statementId: string,
  storeId: string
): Promise<void> {
  const totalTx = await tx.bankTransaction.count({ where: { statementId, storeId } });
  const matchedTotal = await tx.bankTransaction.count({
    where: {
      statementId,
      storeId,
      matchStatus: { in: ['auto_matched', 'manual_matched', 'ignored'] },
    },
  });

  const newStatus =
    matchedTotal === totalTx && totalTx > 0
      ? 'reconciled'
      : matchedTotal > 0
        ? 'reconciling'
        : 'pending';

  await tx.bankStatement.update({
    where: { id: statementId, storeId },
    data: { status: newStatus },
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getReconciliationSummary(
  statementId: string,
  storeId: string
): Promise<ReconciliationSummary> {
  const db = await storeDb(storeId);
  return runInStoreCtx(storeId, async () => {
    const txs = await db.bankTransaction.findMany({
      where: { statementId, storeId },
      select: { matchStatus: true, amountFils: true },
    });

    const summary: ReconciliationSummary = {
      total: txs.length,
      autoMatched: 0,
      manualMatched: 0,
      unmatched: 0,
      ignored: 0,
      matchedAmountFils: 0,
      unmatchedAmountFils: 0,
    };

    for (const tx of txs) {
      switch (tx.matchStatus as BankMatchStatus) {
        case 'auto_matched':
          summary.autoMatched++;
          summary.matchedAmountFils += tx.amountFils;
          break;
        case 'manual_matched':
          summary.manualMatched++;
          summary.matchedAmountFils += tx.amountFils;
          break;
        case 'unmatched':
          summary.unmatched++;
          summary.unmatchedAmountFils += tx.amountFils;
          break;
        case 'ignored':
          summary.ignored++;
          break;
      }
    }

    return summary;
  });
}

// ─── Reconciliation Difference ────────────────────────────────────────────────

/**
 * Compute the reconciliation difference between the bank statement and the
 * linked GL account in the ledger.
 *
 * BANK BALANCE (bankBalanceFils):
 *   Sum of all BankTransaction rows for this statement. For the merchant's bank
 *   account, credits (money coming in) are positive and debits (money going out)
 *   are negative. This gives the net cash flow the bank statement records for the
 *   period, not a closing balance.
 *
 * LEDGER BALANCE (ledgerBalanceFils):
 *   Sum of all counted (posted + reversed) JournalLine rows for the GL account linked to this
 *   statement, up to the statement's periodEnd (or "now" when periodEnd is null).
 *   Bank/cash accounts are ASSET accounts (debit-natural), so:
 *     ledgerBalance = debit_total − credit_total
 *   A positive ledger balance means the account has a debit balance (value held).
 *
 * DIFFERENCE (differenceFils = bankBalanceFils − ledgerBalanceFils):
 *   > 0 → bank shows more inflow than ledger recorded (missing receipts in ledger)
 *   < 0 → ledger shows more than bank (over-posted or duplicate ledger entries)
 *   = 0 → bank and ledger agree for this period
 *
 * UNMATCHED BANK PIASTRES:
 *   Sum of unmatched BankTransaction amounts. These are the bank lines that have
 *   no corresponding ledger entry — they represent the "missing" ledger side.
 *
 * UNMATCHED LEDGER PIASTRES:
 *   Net of counted (posted + reversed) JournalLine entries against the GL account in the period that
 *   are NOT matched to any BankTransaction. These are ledger entries that have
 *   no bank confirmation.
 *
 * NOTE on GL account link:
 *   BankStatement.glAccountId is the explicit link set at import time (the
 *   merchant selects a GL account from the COA, e.g. "1030 Bank Main"). This is
 *   the definitive link — no heuristic needed. If a store has multiple bank
 *   accounts they import separate statements each linked to their own GL account.
 */
export async function getReconciliationDifference(
  statementId: string,
  storeId: string
): Promise<ReconciliationDifference> {
  // A store on its Durable Object reads the statement from its read client and the ledger side from the `bankLedgerSide` op
  // (the same two aggregates, one statement each, in the DO); the figures and advice come from the shared composer.
  const money = await storeMoney(storeId);
  if (money) {
    const db = await storeDb(storeId);
    const stmt = await db.bankStatement.findFirst({
      where: { id: statementId, storeId },
      select: { glAccountId: true, periodStart: true, periodEnd: true },
    });
    if (!stmt) throw new AppError(404, 'statement_not_found', 'statement_not_found');
    const bankTxs = await db.bankTransaction.findMany({
      where: { statementId, storeId },
      select: { amountFils: true, direction: true, matchStatus: true },
    });
    const side = await money.bankLedgerSide({
      accountId: stmt.glAccountId,
      statementId,
      asOfMs: (stmt.periodEnd ?? new Date()).getTime(),
      startMs: stmt.periodStart ? stmt.periodStart.getTime() : null,
    });
    return composeDifference(
      bankTxs,
      side.debit - side.credit,
      side.unmatchedCount,
      side.unmatchedNet
    );
  }
  return withStore(storeId, async tx => {
    // Fetch statement meta (linked GL account + period)
    const stmt = await tx.bankStatement.findFirst({
      where: { id: statementId, storeId },
      select: { glAccountId: true, periodEnd: true },
    });

    if (!stmt) {
      throw new AppError(404, 'statement_not_found', 'statement_not_found');
    }

    const { glAccountId, periodEnd } = stmt;
    // Use periodEnd as the ledger snapshot date; fall back to "now" when absent
    const ledgerAsOf = periodEnd ?? new Date();

    // ── Bank side ──
    // Fetch all transactions; compute net bank balance (credits positive, debits negative).
    const bankTxs = await tx.bankTransaction.findMany({
      where: { statementId, storeId },
      select: { amountFils: true, direction: true, matchStatus: true },
    });

    // ── Ledger side ──
    // Sum every COUNTED journal line (posted + reversed — a reversal pair only
    // nets when both halves count, the same set the balance sheet uses; issue
    // 2186) against the linked GL account up to periodEnd.
    // Using raw SQL for the same pattern as trialBalance (pgbouncer-safe schema prefix).
    const ledgerRows = await tx.$queryRawUnsafe<
      Array<{ debit_total: bigint; credit_total: bigint }>
    >(
      `SELECT
        COALESCE(SUM(l.debit), 0)  AS debit_total,
        COALESCE(SUM(l.credit), 0) AS credit_total
       FROM public.journal_lines l
       JOIN public.journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1
         AND e.store_id = $2
         AND ${COUNTED_STATUSES_SQL}
         AND e.posted_at <= $3::timestamp`,
      glAccountId,
      storeId,
      ledgerAsOf.toISOString()
    );

    const ledgerDebit = Number(ledgerRows[0]?.debit_total ?? 0);
    const ledgerCredit = Number(ledgerRows[0]?.credit_total ?? 0);
    // Asset account (debit-natural): balance = DR - CR
    const ledgerBalanceFils = ledgerDebit - ledgerCredit;

    // ── Unmatched ledger entries ──
    // Journal entries that touched this GL account in the period but are NOT
    // linked to any BankTransaction in this statement.
    // "In the period" = posted_at between statement's periodStart..periodEnd.
    const periodStart = await tx.bankStatement
      .findFirst({ where: { id: statementId, storeId }, select: { periodStart: true } })
      .then(s => s?.periodStart ?? null);

    const unmatched = await tx.$queryRawUnsafe<
      Array<{ entry_id: string; debit: bigint; credit: bigint }>
    >(
      `SELECT l.entry_id, l.debit, l.credit
       FROM public.journal_lines l
       JOIN public.journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1
         AND e.store_id = $2
         AND ${COUNTED_STATUSES_SQL}
         AND ($4::timestamp IS NULL OR e.posted_at >= $4::timestamp)
         AND e.posted_at <= $3::timestamp
         AND NOT EXISTS (
           SELECT 1 FROM public.bank_transactions bt
           WHERE bt.matched_journal_entry_id = e.id
             AND bt.statement_id = $5
         )`,
      glAccountId,
      storeId,
      ledgerAsOf.toISOString(),
      // ALWAYS bound (issue 2186): the placeholder set is constant, so a
      // statement with a null periodStart binds five values for $1..$5
      // instead of four — the old conditional spread shifted statementId
      // onto $4 and Postgres rejected the bind.
      periodStart ? periodStart.toISOString() : null,
      statementId
    );

    return composeDifference(
      bankTxs,
      ledgerBalanceFils,
      unmatched.length,
      unmatched.reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0)
    );
  });
}

/**
 * Bank side (from the statement's rows) + ledger side (already summed by the caller: Postgres raw SQL or the DO's
 * `bankLedgerSide`) -> the difference panel. Pure; shared by both backends so the figures and the EN / AR advice cannot drift.
 */
function composeDifference(
  bankTxs: Array<{ amountFils: number; direction: string; matchStatus: string }>,
  ledgerBalanceFils: number,
  unmatchedLedgerCount: number,
  unmatchedLedgerFils: number
): ReconciliationDifference {
  let bankBalanceFils = 0;
  let unmatchedBankFils = 0;
  for (const btx of bankTxs) {
    // credit from the bank (money in) = debit to the asset account; expressed in asset-account terms: credits positive
    bankBalanceFils += btx.direction === 'credit' ? btx.amountFils : -btx.amountFils;
    if ((btx.matchStatus as BankMatchStatus) === 'unmatched') unmatchedBankFils += btx.amountFils;
  }
  // ── Difference ──
  const differenceFils = bankBalanceFils - ledgerBalanceFils;
  const isReconciled = differenceFils === 0;

  // ── Suggested action ──
  const baseBank = minorToDecimalString(Math.abs(bankBalanceFils));
  const baseLedger = minorToDecimalString(Math.abs(ledgerBalanceFils));
  const baseDiff = minorToDecimalString(Math.abs(differenceFils));
  const unmatchedCount = bankTxs.filter(b => b.matchStatus === 'unmatched').length;

  let suggestedActionEn: string;
  let suggestedActionAr: string;

  if (isReconciled) {
    suggestedActionEn =
      'Bank and ledger agree — this statement is fully reconciled. No action required.';
    suggestedActionAr = 'البنك والدفتر متطابقان — تم إغلاق كشف الحساب بالكامل. لا يلزم أي إجراء.';
  } else if (differenceFils > 0) {
    suggestedActionEn =
      `Bank balance (EGP ${baseBank}) exceeds ledger balance (EGP ${baseLedger}) by EGP ${baseDiff}. ` +
      `${unmatchedCount} unmatched bank line(s) totalling EGP ${minorToDecimalString(unmatchedBankFils)} have no ledger entry. ` +
      `Suggested action: record journal entries for the missing bank transactions, ` +
      `or post an adjusting entry of EGP ${baseDiff} (debit bank account, credit appropriate account).`;
    suggestedActionAr =
      `رصيد البنك (${baseBank} ج.م) يتجاوز رصيد الدفتر (${baseLedger} ج.م) بفارق ${baseDiff} ج.م ` +
      `${unmatchedCount} حركة/حركات بنكية غير مطابقة بمجموع ${minorToDecimalString(unmatchedBankFils)} ج.م لا يقابلها قيود في الدفتر. ` +
      `الإجراء المقترح: سجّل قيوداً محاسبية للحركات البنكية الغائبة، ` +
      `أو أضف قيد تسوية بقيمة ${baseDiff} ج.م (مدين: حساب البنك، دائن: الحساب المناسب).`;
  } else {
    suggestedActionEn =
      `Ledger balance (EGP ${baseLedger}) exceeds bank balance (EGP ${baseBank}) by EGP ${baseDiff}. ` +
      `${unmatchedLedgerCount} unmatched ledger entry/entries totalling EGP ${minorToDecimalString(Math.abs(unmatchedLedgerFils))} have no bank confirmation. ` +
      `Suggested action: verify the ${unmatchedLedgerCount} unmatched ledger entries — reverse any duplicates, ` +
      `or post an adjusting entry of EGP ${baseDiff} (credit bank account, debit appropriate account).`;
    suggestedActionAr =
      `رصيد الدفتر (${baseLedger} ج.م) يتجاوز رصيد البنك (${baseBank} ج.م) بفارق ${baseDiff} ج.م ` +
      `${unmatchedLedgerCount} قيد/قيود في الدفتر بمجموع ${minorToDecimalString(Math.abs(unmatchedLedgerFils))} ج.م لا يقابلها حركات بنكية. ` +
      `الإجراء المقترح: راجع القيود ${unmatchedLedgerCount} غير المطابقة — اعكس أي قيود مكررة، ` +
      `أو أضف قيد تسوية بقيمة ${baseDiff} ج.م (دائن: حساب البنك، مدين: الحساب المناسب).`;
  }

  return {
    bankBalanceFils,
    ledgerBalanceFils,
    differenceFils,
    unmatchedBankFils,
    unmatchedLedgerFils,
    unmatchedLedgerCount,
    suggestedActionEn,
    suggestedActionAr,
    isReconciled,
  };
}
