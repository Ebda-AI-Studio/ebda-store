/**
 * getReconciliationDifference against a real Postgres (issue 2186).
 *
 * Two defects pinned here:
 *  1. The unmatched-ledger query bound FOUR values but referenced $5 whenever
 *     the statement had no periodStart (a conditional spread shifted
 *     statementId onto $4), so Postgres rejected the bind and the summary
 *     500'd for any statement imported without a period start.
 *  2. The ledger side counted only status 'posted'. A refund flips the
 *     original sale entry to 'reversed' and posts its mirror as 'posted', so
 *     a posted-only sum kept the mirror (CR cash) and dropped the original
 *     (DR cash) — understating GL cash by 2x the refund versus the balance
 *     sheet. Both halves must count.
 *
 * Fixtures are per test run (unique store), so a --retry re-run gets fresh rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';
import { postEntry, reverseEntry } from '../../../apps/api/src/services/accounting/journal.service';
import { getReconciliationDifference } from '../../../apps/api/src/services/accounting/bank-reconcile.service';

const OWNER = '00000000-0000-0000-0000-0000000000f8';
let storeId: string;
let cash: string;
let revenue: string;
let suffix: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `bank-rec-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Bank',
      lastName: 'Rec',
    },
  });
  suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: { name: `bank-rec-${suffix}`, slug: `bank-rec-${suffix}`, ownerId: OWNER },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);
  cash = await getSystemAccountIdByCode(storeId, '1000');
  revenue = await getSystemAccountIdByCode(storeId, '4000');

  const sale = (sourceId: string, amount: number) =>
    postEntry({
      storeId,
      source: 'order',
      sourceId,
      postedAt: new Date('2026-03-05T10:00:00.000Z'),
      lines: [
        { accountId: cash, debit: amount, credit: 0 },
        { accountId: revenue, debit: 0, credit: amount },
      ],
    });
  await sale(`kept-${suffix}`, 10000);
  const refunded = await sale(`refunded-${suffix}`, 3000);
  await reverseEntry(refunded.id, 'refund applied');
});

afterAll(async () => {
  await prisma.bankStatement.deleteMany({ where: { storeId } });
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.updateMany({ where: { storeId }, data: { reversedById: null } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

async function statement(periodStart: Date | null) {
  return prisma.bankStatement.create({
    data: {
      storeId,
      glAccountId: cash,
      fileName: `stmt-${Math.random().toString(36).slice(2, 8)}.csv`,
      periodStart,
      periodEnd: null,
    },
  });
}

describe('getReconciliationDifference', () => {
  it('a statement with NO periodStart resolves instead of failing the bind', async () => {
    const stmt = await statement(null);
    const diff = await getReconciliationDifference(stmt.id, storeId);
    // 10000 kept sale; the refunded sale's DR 3000 and its mirror's CR 3000 net to 0.
    expect(diff.ledgerBalanceFils).toBe(10000);
    expect(diff.unmatchedLedgerFils).toBe(10000);
  });

  it('a statement WITH a periodStart still filters by it', async () => {
    const stmt = await statement(new Date('2099-01-01T00:00:00.000Z'));
    const diff = await getReconciliationDifference(stmt.id, storeId);
    expect(diff.ledgerBalanceFils).toBe(10000);
    // Every entry predates the period start, so none is "unmatched in the period".
    expect(diff.unmatchedLedgerFils).toBe(0);
  });
});
