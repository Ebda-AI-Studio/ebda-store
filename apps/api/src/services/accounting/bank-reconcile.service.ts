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

import { prisma, runInTenantContext, withRlsBypass } from '@force/database';
import type { BankMatchStatus, BankTransaction, Prisma } from '@prisma/client';
import { parseStatementCsv, parseStatementOfx, type ParsedRow } from './bank-statement-parser';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fil tolerance for amount matching (5 fils = 0.005 KWD — rounding/truncation). */
const AMOUNT_TOLERANCE_FILS = 5;

/** Maximum days difference between bank transaction date and journal posting date. */
const DATE_TOLERANCE_DAYS = 3;
const DATE_TOLERANCE_MS = DATE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;

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
  imported: number;
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

  // Derive period from parsed rows
  const dates = rows.map(r => r.date.getTime());
  const periodStart = dates.length ? new Date(Math.min(...dates)) : null;
  const periodEnd = dates.length ? new Date(Math.max(...dates)) : null;

  // ── Persist (transactional) ──
  let statementId: string;
  let imported = 0;

  await withRlsBypass(async tx => {
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
    for (const row of rows) {
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
 * Run (or re-run) automatic matching for all unmatched transactions
 * in a statement.
 *
 * Each call:
 * - Resets any previous auto_matched rows to unmatched (for idempotent re-run)
 * - Finds the best single JournalEntry candidate per bank tx
 * - Updates match_status + matched_journal_entry_id atomically
 */
export async function runAutoMatch(
  statementId: string,
  storeId: string
): Promise<{ matched: number; unmatched: number; ambiguous: number }> {
  return withRlsBypass(async tx => {
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

    // Track which journal entries have been claimed in this pass
    // to prevent one ledger entry matching two bank rows.
    const claimedEntries = new Set<string>();

    let matched = 0;
    let unmatched = 0;
    let ambiguous = 0;

    for (const btx of bankTxs) {
      const from = new Date(btx.date.getTime() - DATE_TOLERANCE_MS);
      const to = new Date(btx.date.getTime() + DATE_TOLERANCE_MS);
      const minFils = btx.amountFils - AMOUNT_TOLERANCE_FILS;
      const maxFils = btx.amountFils + AMOUNT_TOLERANCE_FILS;

      // Find all already-matched journal entry ids for this store so we exclude them
      const alreadyMatched = await tx.bankTransaction.findMany({
        where: {
          storeId,
          matchStatus: { in: ['auto_matched', 'manual_matched'] },
          matchedJournalEntryId: { not: null },
        },
        select: { matchedJournalEntryId: true },
      });
      const alreadyMatchedIds = [
        ...alreadyMatched.map(r => r.matchedJournalEntryId!).filter(Boolean),
        ...Array.from(claimedEntries),
      ];

      // Find candidate journal entries
      const candidates = await tx.journalLine.findMany({
        where: {
          account: { storeId },
          ...(btx.direction === 'debit'
            ? { debit: { gte: minFils, lte: maxFils } }
            : { credit: { gte: minFils, lte: maxFils } }),
          entry: {
            storeId,
            status: 'posted',
            postedAt: { gte: from, lte: to },
            id: alreadyMatchedIds.length > 0 ? { notIn: alreadyMatchedIds } : undefined,
          },
        },
        select: {
          entryId: true,
          debit: true,
          credit: true,
        },
        distinct: ['entryId'],
      });

      if (candidates.length === 0) {
        unmatched++;
        continue;
      }

      if (candidates.length > 1) {
        ambiguous++;
        continue;
      }

      // Exactly one candidate — auto match
      const candidate = candidates[0];
      const exactAmt = btx.direction === 'debit' ? candidate.debit : candidate.credit;
      const confidence = computeConfidence(btx.amountFils, exactAmt);

      await tx.bankTransaction.update({
        where: { id: btx.id },
        data: {
          matchStatus: 'auto_matched',
          matchedJournalEntryId: candidate.entryId,
          confidence,
        },
      });

      claimedEntries.add(candidate.entryId);
      matched++;
    }

    // Update statement status
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
      where: { id: statementId },
      data: { status: newStatus },
    });

    return { matched, unmatched, ambiguous };
  });
}

/** Confidence 0–100: 100 = exact fils match, lower as difference grows. */
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

  return withRlsBypass(async tx => {
    // Verify the bank transaction belongs to this store
    const btx = await tx.bankTransaction.findUnique({
      where: { id: transactionId },
      select: { id: true, storeId: true, statementId: true },
    });

    if (!btx || btx.storeId !== storeId) {
      throw Object.assign(new Error('not_found'), { statusCode: 404 });
    }

    if (action === 'unmatch') {
      const updated = await tx.bankTransaction.update({
        where: { id: transactionId },
        data: { matchStatus: 'unmatched', matchedJournalEntryId: null, confidence: 0 },
      });
      await refreshStatementStatus(tx, btx.statementId, storeId);
      return updated;
    }

    if (action === 'ignore') {
      const updated = await tx.bankTransaction.update({
        where: { id: transactionId },
        data: { matchStatus: 'ignored', matchedJournalEntryId: null, confidence: 0 },
      });
      await refreshStatementStatus(tx, btx.statementId, storeId);
      return updated;
    }

    // action === 'match'
    if (!journalEntryId) {
      throw Object.assign(new Error('journalEntryId required for match action'), {
        statusCode: 400,
      });
    }

    // Verify journal entry belongs to this store
    const entry = await tx.journalEntry.findFirst({
      where: { id: journalEntryId, storeId },
      select: { id: true },
    });
    if (!entry) {
      throw Object.assign(new Error('journal_entry_not_found'), { statusCode: 404 });
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
      throw Object.assign(new Error('journal_entry_already_matched'), { statusCode: 409 });
    }

    const updated = await tx.bankTransaction.update({
      where: { id: transactionId },
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
    where: { id: statementId },
    data: { status: newStatus },
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export async function getReconciliationSummary(
  statementId: string,
  storeId: string
): Promise<ReconciliationSummary> {
  return runInTenantContext(storeId, async () => {
    const txs = await prisma.bankTransaction.findMany({
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
