/**
 * Unit tests for bank reconciliation parsers and matching engine.
 *
 * No DB required — parsers are pure functions; matching engine is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Parser tests (pure, no mocks needed) ────────────────────────────────────

import {
  decimalStringToFils,
  parseStatementCsv,
  parseStatementOfx,
} from '../../apps/api/src/services/accounting/bank-statement-parser';

// ─── Piastres conversion ──────────────────────────────────────────────────────────

describe('decimalStringToFils — money precision', () => {
  it('converts a standard 2-decimal EGP amount', () => {
    expect(decimalStringToFils('12.34')).toBe(1234);
  });

  it('converts an amount padded to 2 decimal places', () => {
    expect(decimalStringToFils('1.50')).toBe(150);
  });

  it('converts a 1-decimal amount', () => {
    expect(decimalStringToFils('10.5')).toBe(1050);
  });

  it('converts a whole number (no decimal point)', () => {
    expect(decimalStringToFils('100')).toBe(10000);
  });

  it('converts the smallest unit: 0.01 EGP → 1 piastre', () => {
    expect(decimalStringToFils('0.01')).toBe(1);
  });

  it('converts zero', () => {
    expect(decimalStringToFils('0.00')).toBe(0);
  });

  it('handles negative amounts (debit direction)', () => {
    expect(decimalStringToFils('-12.50')).toBe(-1250);
  });

  it('strips thousands separators', () => {
    expect(decimalStringToFils('1,234.56')).toBe(123456);
  });

  it('returns 0 for empty string', () => {
    expect(decimalStringToFils('')).toBe(0);
  });

  it('normalises Arabic-Indic digits', () => {
    // ١٢.٣٤ → 12.34
    expect(decimalStringToFils('١٢.٣٤')).toBe(1234);
  });

  it('truncates to 2 decimal places (no rounding up beyond piastres)', () => {
    // "1.0099" → frac = "00" (first 2 chars), so 100 piastres — never rounded up to 101
    expect(decimalStringToFils('1.0099')).toBe(100);
  });

  it('converts large amounts correctly', () => {
    expect(decimalStringToFils('99999.99')).toBe(9999999);
  });
});

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf-8');
}

describe('parseStatementCsv — English headers', () => {
  it('parses a standard debit/credit CSV', () => {
    const csv = [
      'Date,Description,Debit,Credit,Reference',
      '2026-01-10,Coffee shop,15.00,,CHQ001',
      '2026-01-11,Salary deposit,,5000.00,SAL001',
    ].join('\n');

    const { rows, skipped, errors } = parseStatementCsv(buf(csv));

    expect(errors).toHaveLength(0);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(2);

    expect(rows[0].date.toISOString().slice(0, 10)).toBe('2026-01-10');
    expect(rows[0].description).toBe('Coffee shop');
    expect(rows[0].amountFils).toBe(1500);
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].externalRef).toBe('CHQ001');

    expect(rows[1].amountFils).toBe(500000);
    expect(rows[1].direction).toBe('credit');
  });

  it('parses a single amount column (positive = credit, negative = debit)', () => {
    const csv = [
      'Date,Description,Amount',
      '2026-02-01,Purchase,-250.00',
      '2026-02-02,Refund,100.00',
    ].join('\n');

    const { rows } = parseStatementCsv(buf(csv));
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].amountFils).toBe(25000);
    expect(rows[1].direction).toBe('credit');
    expect(rows[1].amountFils).toBe(10000);
  });

  it('skips rows with zero amount', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '2026-01-01,Zero row,0.00,0.00',
      '2026-01-02,Real row,50.00,',
    ].join('\n');

    const { rows, skipped } = parseStatementCsv(buf(csv));
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('skips rows with invalid date and records an error', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      'not-a-date,Bad row,50.00,',
      '2026-01-02,Good row,30.00,',
    ].join('\n');

    const { rows, skipped, errors } = parseStatementCsv(buf(csv));
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid date');
  });

  it('returns an error for an empty file', () => {
    const { rows, errors } = parseStatementCsv(buf(''));
    expect(rows).toHaveLength(0);
    expect(errors[0]).toContain('empty');
  });

  it('returns an error when no date column found', () => {
    const csv = ['Description,Amount', 'Purchase,100.00'].join('\n');
    const { errors } = parseStatementCsv(buf(csv));
    expect(errors[0]).toContain('date column');
  });

  it('handles semicolon-separated CSV', () => {
    const csv = ['Date;Description;Debit;Credit', '2026-03-01;Shop;200.00;'].join('\n');

    const { rows } = parseStatementCsv(buf(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0].amountFils).toBe(20000);
  });
});

describe('parseStatementCsv — Arabic headers', () => {
  it('parses Arabic column names correctly', () => {
    const csv = [
      'تاريخ,الوصف,مدين,دائن',
      '2026-04-05,شراء أثاث,1500.00,',
      '2026-04-06,إيداع راتب,,10000.00',
    ].join('\n');

    const { rows, errors } = parseStatementCsv(buf(csv));
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].amountFils).toBe(150000);
    expect(rows[1].direction).toBe('credit');
    expect(rows[1].amountFils).toBe(1000000);
  });
});

describe('parseStatementCsv — idempotent row hashing', () => {
  it('produces the same rowHash for the same row data', () => {
    const csv = [
      'Date,Description,Debit,Credit,Reference',
      '2026-01-10,Coffee shop,15.00,,CHQ001',
    ].join('\n');

    const r1 = parseStatementCsv(buf(csv));
    const r2 = parseStatementCsv(buf(csv));
    expect(r1.rows[0].rowHash).toBe(r2.rows[0].rowHash);
  });

  it('produces different rowHash for different amounts', () => {
    const csv1 = 'Date,Description,Debit\n2026-01-10,Coffee,15.00';
    const csv2 = 'Date,Description,Debit\n2026-01-10,Coffee,20.00';
    const r1 = parseStatementCsv(buf(csv1));
    const r2 = parseStatementCsv(buf(csv2));
    expect(r1.rows[0].rowHash).not.toBe(r2.rows[0].rowHash);
  });
});

// ─── OFX Parser ───────────────────────────────────────────────────────────────

describe('parseStatementOfx — SGML format', () => {
  const sgml = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-255.00
<FITID>TXN001
<NAME>Supermarket
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260116120000
<TRNAMT>5000.00
<FITID>TXN002
<NAME>Salary
</STMTTRN>
</BANKTRANLIST>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
  `;

  it('parses SGML OFX with negative debit and positive credit', () => {
    const { rows, errors, skipped } = parseStatementOfx(buf(sgml));
    expect(errors).toHaveLength(0);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(2);

    expect(rows[0].amountFils).toBe(25500);
    expect(rows[0].direction).toBe('debit');
    expect(rows[0].externalRef).toBe('TXN001');
    expect(rows[0].description).toBe('Supermarket');
    expect(rows[0].date.toISOString().slice(0, 10)).toBe('2026-01-15');

    expect(rows[1].amountFils).toBe(500000);
    expect(rows[1].direction).toBe('credit');
    expect(rows[1].externalRef).toBe('TXN002');
  });
});

describe('parseStatementOfx — XML format', () => {
  const xml = `<?xml version="1.0"?>
<OFX>
  <STMTTRNRS>
    <BANKTRANLIST>
      <STMTTRN>
        <DTPOSTED>20260201</DTPOSTED>
        <TRNAMT>-100.00</TRNAMT>
        <FITID>X001</FITID>
        <NAME>Grocery</NAME>
      </STMTTRN>
    </BANKTRANLIST>
  </STMTTRNRS>
</OFX>`;

  it('parses XML OFX', () => {
    const { rows, errors } = parseStatementOfx(buf(xml));
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountFils).toBe(10000);
    expect(rows[0].direction).toBe('debit');
  });
});

describe('parseStatementOfx — error cases', () => {
  it('reports error for missing DTPOSTED', () => {
    const ofx = `<OFX><STMTTRN><TRNAMT>-50.00</TRNAMT><FITID>X1</FITID></STMTTRN></OFX>`;
    const { skipped, errors } = parseStatementOfx(buf(ofx));
    expect(skipped).toBe(1);
    expect(errors[0]).toContain('DTPOSTED');
  });

  it('reports error for missing TRNAMT', () => {
    const ofx = `<OFX><STMTTRN><DTPOSTED>20260101</DTPOSTED></STMTTRN></OFX>`;
    const { skipped, errors } = parseStatementOfx(buf(ofx));
    expect(skipped).toBe(1);
    expect(errors[0]).toContain('TRNAMT');
  });

  it('reports error when no STMTTRN blocks found', () => {
    const { errors } = parseStatementOfx(buf('<OFX></OFX>'));
    expect(errors[0]).toContain('no STMTTRN blocks');
  });
});

// ─── Matching engine ──────────────────────────────────────────────────────────
// The matching engine queries the DB; we test the pure matching *logic*
// by mocking @ebda/database and driving runAutoMatch with controlled data.

const mockWithRlsBypass = vi.fn();
const mockRunInTenantContext = vi.fn();
const mockBankTxUpdateMany = vi.fn();
const mockBankTxFindMany = vi.fn();
const mockJournalLineFindMany = vi.fn();
const mockBankTxFindUnique = vi.fn();
const mockBankTxCount = vi.fn();
const mockBankStatementUpdate = vi.fn();
const mockBankTxUpdate = vi.fn();
const mockJournalEntryFindFirst = vi.fn();
const mockBankTxFindFirst = vi.fn();
const mockQueryRawUnsafe = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: {
    bankTransaction: {
      updateMany: (...a: unknown[]) => mockBankTxUpdateMany(...a),
      findMany: (...a: unknown[]) => mockBankTxFindMany(...a),
      findUnique: (...a: unknown[]) => mockBankTxFindUnique(...a),
      findFirst: (...a: unknown[]) => mockBankTxFindFirst(...a),
      count: (...a: unknown[]) => mockBankTxCount(...a),
      update: (...a: unknown[]) => mockBankTxUpdate(...a),
    },
    journalLine: {
      findMany: (...a: unknown[]) => mockJournalLineFindMany(...a),
    },
    bankStatement: {
      update: (...a: unknown[]) => mockBankStatementUpdate(...a),
    },
    journalEntry: {
      findFirst: (...a: unknown[]) => mockJournalEntryFindFirst(...a),
    },
  },
  withStore: (_storeId: string, fn: (tx: unknown) => unknown) => mockWithRlsBypass(fn),
  runInTenantContext: (sid: string, fn: () => unknown) => mockRunInTenantContext(sid, fn),
}));

import {
  runAutoMatch,
  importBankStatement,
  MAX_STATEMENT_ROWS,
  applyManualMatch,
  getReconciliationDifference,
} from '../../apps/api/src/services/accounting/bank-reconcile.service';

const STORE_ID = 'store-test-001';
const STMT_ID = 'stmt-test-001';

function makeTx(overrides: {
  id?: string;
  date?: Date;
  amountFils?: number;
  direction?: 'debit' | 'credit';
}) {
  return {
    id: overrides.id ?? 'btx-001',
    date: overrides.date ?? new Date('2026-01-15'),
    amountFils: overrides.amountFils ?? 10000,
    // a deposit: money IN is a DEBIT on the bank's asset account (ACCT-AUDIT-7)
    direction: overrides.direction ?? 'credit',
  };
}

function makeCandidate(
  entryId: string,
  debit = 10000,
  credit = 0,
  postedAt = new Date('2026-01-15')
) {
  return { entryId, debit, credit, entry: { postedAt } };
}

// Wire the withRlsBypass mock to execute the callback with a mock tx
beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks. clearAllMocks only wipes call history —
  // it leaves queued `mockResolvedValueOnce` implementations in place. This
  // file queues them heavily (setupMocks and every runAutoMatch case), so an
  // undrained queue from an earlier test fed the NEXT test's first call,
  // producing assertions crossed between cases. Vitest's `retry: 1` then hid
  // it: the retry re-runs only the failed tests, by which point the stale
  // queue is drained and they pass. Measured 2026-09-02 — with `--retry=0`
  // five tests in `getReconciliationDifference` failed on the first attempt.
  // A test that only passes on the second run is not a gate.
  vi.resetAllMocks();

  // The mock tx passed to the callback mirrors the prisma client mocks
  const mockTx = {
    bankTransaction: {
      updateMany: mockBankTxUpdateMany,
      findMany: mockBankTxFindMany,
      findUnique: mockBankTxFindUnique,
      findFirst: mockBankTxFindFirst,
      count: mockBankTxCount,
      update: mockBankTxUpdate,
    },
    journalLine: { findMany: mockJournalLineFindMany },
    bankStatement: {
      update: mockBankStatementUpdate,
      findFirst: mockBankTxFindFirst,
    },
    journalEntry: { findFirst: mockJournalEntryFindFirst },
    $queryRawUnsafe: (...a: unknown[]) => mockQueryRawUnsafe(...a),
  };

  mockWithRlsBypass.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockTx));
  mockRunInTenantContext.mockImplementation((_sid: string, fn: () => unknown) => fn());
});

describe('runAutoMatch — matching rules', () => {
  beforeEach(() => {
    mockBankTxFindFirst.mockResolvedValue({ glAccountId: 'gl-bank' });
  });

  it('auto-matches a single exact candidate', async () => {
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany
      .mockResolvedValueOnce([makeTx({ id: 'btx-1', amountFils: 10000 })])
      .mockResolvedValueOnce([]); // alreadyMatched query
    mockJournalLineFindMany.mockResolvedValueOnce([makeCandidate('entry-1', 10000, 0)]);
    mockBankTxUpdate.mockResolvedValue({});
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await runAutoMatch(STMT_ID, STORE_ID);

    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.ambiguous).toBe(0);

    expect(mockBankTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: 'auto_matched',
          matchedJournalEntryId: 'entry-1',
          confidence: 100,
        }),
      })
    );
  });

  it('leaves transaction unmatched when no candidate found', async () => {
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany.mockResolvedValueOnce([makeTx({ id: 'btx-2' })]).mockResolvedValueOnce([]);
    mockJournalLineFindMany.mockResolvedValueOnce([]); // no candidates
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await runAutoMatch(STMT_ID, STORE_ID);

    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(mockBankTxUpdate).not.toHaveBeenCalled();
  });

  it('marks as ambiguous when multiple candidates exist', async () => {
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany.mockResolvedValueOnce([makeTx({ id: 'btx-3' })]).mockResolvedValueOnce([]);
    mockJournalLineFindMany.mockResolvedValueOnce([
      makeCandidate('entry-A', 10000, 0),
      makeCandidate('entry-B', 10000, 0),
    ]);
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await runAutoMatch(STMT_ID, STORE_ID);

    expect(result.ambiguous).toBe(1);
    expect(result.matched).toBe(0);
    expect(mockBankTxUpdate).not.toHaveBeenCalled();
  });

  it('computes lower confidence for near-miss amount', async () => {
    mockBankTxUpdateMany.mockResolvedValue({});
    // Bank tx: 10000 piastres; ledger line: 10003 piastres (diff = 3, within tolerance of 5)
    mockBankTxFindMany
      .mockResolvedValueOnce([makeTx({ id: 'btx-4', amountFils: 10000 })])
      .mockResolvedValueOnce([]);
    mockJournalLineFindMany.mockResolvedValueOnce([makeCandidate('entry-C', 10003, 0)]);
    mockBankTxUpdate.mockResolvedValue({});
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mockBankStatementUpdate.mockResolvedValue({});

    await runAutoMatch(STMT_ID, STORE_ID);

    const updateCall = mockBankTxUpdate.mock.calls[0][0];
    // confidence = round((5-3)/5 * 100) = 40
    expect(updateCall.data.confidence).toBe(40);
  });

  it('does not double-match: second tx claiming same entry is unmatched', async () => {
    // Two bank transactions, one ledger entry — second should be unmatched
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany
      .mockResolvedValueOnce([
        makeTx({ id: 'btx-5', amountFils: 10000 }),
        makeTx({ id: 'btx-6', amountFils: 10000 }),
      ])
      .mockResolvedValueOnce([]) // alreadyMatched for btx-5
      .mockResolvedValueOnce([]); // alreadyMatched for btx-6 (entry-D claimed by btx-5)
    // First tx: one candidate
    mockJournalLineFindMany
      .mockResolvedValueOnce([makeCandidate('entry-D', 10000, 0)])
      // Second tx: same entry excluded → no candidates
      .mockResolvedValueOnce([]);
    mockBankTxUpdate.mockResolvedValue({});
    mockBankTxCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await runAutoMatch(STMT_ID, STORE_ID);

    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(1);
  });
});

describe('runAutoMatch — account, direction and ranking (ACCT-AUDIT-7)', () => {
  beforeEach(() => {
    mockBankTxFindFirst.mockResolvedValue({ glAccountId: 'gl-bank' });
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxUpdate.mockResolvedValue({});
    mockBankTxCount.mockResolvedValue(1);
    mockBankStatementUpdate.mockResolvedValue({});
  });
  const run = async (tx: ReturnType<typeof makeTx>, lines: ReturnType<typeof makeCandidate>[]) => {
    mockBankTxFindMany.mockResolvedValueOnce([tx]).mockResolvedValueOnce([]);
    mockJournalLineFindMany.mockResolvedValueOnce(lines);
    return runAutoMatch(STMT_ID, STORE_ID);
  };

  it("only looks at journal lines on the statement's own bank account", async () => {
    await run(makeTx({}), []);
    expect(mockJournalLineFindMany.mock.calls[0][0].where.accountId).toBe('gl-bank');
  });

  it('a deposit (bank credit) looks for a DEBIT on the bank account, a withdrawal for a CREDIT', async () => {
    await run(makeTx({ direction: 'credit', amountFils: 50000 }), []);
    expect(mockJournalLineFindMany.mock.calls[0][0].where).toMatchObject({
      debit: { gte: 49995, lte: 50005 },
    });
    expect(mockJournalLineFindMany.mock.calls[0][0].where.credit).toBeUndefined();
    mockBankTxFindMany.mockReset();
    mockJournalLineFindMany.mockReset();
    await run(makeTx({ direction: 'debit', amountFils: 50000 }), []);
    expect(mockJournalLineFindMany.mock.calls[0][0].where).toMatchObject({
      credit: { gte: 49995, lte: 50005 },
    });
    expect(mockJournalLineFindMany.mock.calls[0][0].where.debit).toBeUndefined();
  });

  it('a candidate three days away scores lower than the same amount on the same day', async () => {
    await run(makeTx({}), [makeCandidate('e-far', 10000, 0, new Date('2026-01-18'))]);
    expect(mockBankTxUpdate.mock.calls[0][0].data.confidence).toBe(70);
  });

  it('two same-amount candidates: the closer date wins and the other stays free', async () => {
    const r = await run(makeTx({}), [
      makeCandidate('e-far', 10000, 0, new Date('2026-01-17')),
      makeCandidate('e-near', 10000, 0, new Date('2026-01-15')),
    ]);
    expect(r.matched).toBe(1);
    expect(mockBankTxUpdate.mock.calls[0][0].data.matchedJournalEntryId).toBe('e-near');
  });

  it('two candidates equally close stay ambiguous for a human', async () => {
    const r = await run(makeTx({}), [makeCandidate('e1'), makeCandidate('e2')]);
    expect(r.ambiguous).toBe(1);
    expect(mockBankTxUpdate).not.toHaveBeenCalled();
  });
});

describe('bank matching row cap (FIX-013)', () => {
  it('importBankStatement rejects an oversized statement with 422 STATEMENT_TOO_LARGE before any DB work', async () => {
    const lines = ['Date,Description,Debit,Credit,Reference'];
    for (let i = 0; i <= MAX_STATEMENT_ROWS; i++) {
      lines.push(`2026-01-10,Row ${i},1.000,,REF${i}`);
    }
    await expect(
      importBankStatement({
        storeId: STORE_ID,
        glAccountId: 'gl-1',
        fileName: 'big.csv',
        buffer: Buffer.from(lines.join('\n'), 'utf-8'),
        fileType: 'csv',
      })
    ).rejects.toMatchObject({ statusCode: 422, code: 'STATEMENT_TOO_LARGE' });
    expect(mockWithRlsBypass).not.toHaveBeenCalled();
  });

  it('runAutoMatch rejects a statement over the cap (legacy rows) and does not reach the match loop', async () => {
    mockBankTxFindFirst.mockResolvedValue({ glAccountId: 'gl-bank' });
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany.mockResolvedValueOnce(
      Array.from({ length: MAX_STATEMENT_ROWS + 1 }, (_, i) => makeTx({ id: `btx-${i}` }))
    );
    await expect(runAutoMatch(STMT_ID, STORE_ID)).rejects.toMatchObject({
      code: 'STATEMENT_TOO_LARGE',
    });
    expect(mockJournalLineFindMany).not.toHaveBeenCalled();
  });

  it('runAutoMatch accepts a statement exactly at the cap', async () => {
    mockBankTxFindFirst.mockResolvedValue({ glAccountId: 'gl-bank' });
    mockBankTxUpdateMany.mockResolvedValue({});
    mockBankTxFindMany
      .mockResolvedValueOnce(
        Array.from({ length: MAX_STATEMENT_ROWS }, (_, i) => makeTx({ id: `btx-${i}` }))
      )
      .mockResolvedValueOnce([]);
    mockJournalLineFindMany.mockResolvedValue([]);
    mockBankTxUpdate.mockResolvedValue({});
    mockBankTxCount.mockResolvedValue(0);
    mockBankStatementUpdate.mockResolvedValue({});
    await expect(runAutoMatch(STMT_ID, STORE_ID)).resolves.toBeDefined();
  });
});

describe('applyManualMatch — overrides', () => {
  it('applies manual_matched with a valid journal entry', async () => {
    mockBankTxFindUnique.mockResolvedValue({
      id: 'btx-7',
      storeId: STORE_ID,
      statementId: STMT_ID,
    });
    mockJournalEntryFindFirst.mockResolvedValue({ id: 'entry-E' });
    mockBankTxFindFirst.mockResolvedValue(null); // not already matched
    mockBankTxUpdate.mockResolvedValue({ id: 'btx-7', matchStatus: 'manual_matched' });
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await applyManualMatch({
      storeId: STORE_ID,
      transactionId: 'btx-7',
      action: 'match',
      journalEntryId: 'entry-E',
    });

    expect(result.matchStatus).toBe('manual_matched');
    expect(mockBankTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matchStatus: 'manual_matched',
          matchedJournalEntryId: 'entry-E',
          confidence: 100,
        }),
      })
    );
  });

  it('rejects match when journal entry already matched to another tx', async () => {
    mockBankTxFindUnique.mockResolvedValue({
      id: 'btx-8',
      storeId: STORE_ID,
      statementId: STMT_ID,
    });
    mockJournalEntryFindFirst.mockResolvedValue({ id: 'entry-F' });
    mockBankTxFindFirst.mockResolvedValue({ id: 'btx-other' }); // already matched

    await expect(
      applyManualMatch({
        storeId: STORE_ID,
        transactionId: 'btx-8',
        action: 'match',
        journalEntryId: 'entry-F',
      })
    ).rejects.toThrow('journal_entry_already_matched');
  });

  it('unmatches a previously matched transaction', async () => {
    mockBankTxFindUnique.mockResolvedValue({
      id: 'btx-9',
      storeId: STORE_ID,
      statementId: STMT_ID,
    });
    mockBankTxUpdate.mockResolvedValue({ id: 'btx-9', matchStatus: 'unmatched' });
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await applyManualMatch({
      storeId: STORE_ID,
      transactionId: 'btx-9',
      action: 'unmatch',
    });

    expect(result.matchStatus).toBe('unmatched');
  });

  it('marks a transaction as ignored', async () => {
    mockBankTxFindUnique.mockResolvedValue({
      id: 'btx-10',
      storeId: STORE_ID,
      statementId: STMT_ID,
    });
    mockBankTxUpdate.mockResolvedValue({ id: 'btx-10', matchStatus: 'ignored' });
    mockBankTxCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mockBankStatementUpdate.mockResolvedValue({});

    const result = await applyManualMatch({
      storeId: STORE_ID,
      transactionId: 'btx-10',
      action: 'ignore',
    });

    expect(result.matchStatus).toBe('ignored');
  });

  it('throws 404 when transaction not found or wrong store', async () => {
    mockBankTxFindUnique.mockResolvedValue(null);

    await expect(
      applyManualMatch({
        storeId: STORE_ID,
        transactionId: 'btx-missing',
        action: 'unmatch',
      })
    ).rejects.toThrow('not_found');
  });

  it('throws 400 when match action is called without journalEntryId', async () => {
    mockBankTxFindUnique.mockResolvedValue({
      id: 'btx-11',
      storeId: STORE_ID,
      statementId: STMT_ID,
    });

    await expect(
      applyManualMatch({
        storeId: STORE_ID,
        transactionId: 'btx-11',
        action: 'match',
        // journalEntryId omitted
      })
    ).rejects.toThrow('journalEntryId required');
  });
});

// ─── getReconciliationDifference ─────────────────────────────────────────────

describe('getReconciliationDifference — balance computation', () => {
  const GL_ACCOUNT_ID = 'gl-account-1030';
  const PERIOD_END = new Date('2026-01-31T23:59:59.000Z');

  /**
   * Helper: set up the mock tx so bankStatement.findFirst returns the stmt meta,
   * bankTransaction.findMany returns the bank txs list, and $queryRawUnsafe
   * returns ledger totals on the first call and unmatched ledger rows on the second.
   */
  function setupMocks({
    glAccountId = GL_ACCOUNT_ID,
    periodEnd = PERIOD_END,
    periodStart = new Date('2026-01-01'),
    bankTxs = [] as Array<{
      amountFils: number;
      direction: 'debit' | 'credit';
      matchStatus: string;
    }>,
    ledgerDebit = 0n,
    ledgerCredit = 0n,
    unmatchedLedgerRows = [] as Array<{ entry_id: string; debit: bigint; credit: bigint }>,
  } = {}) {
    // bankStatement.findFirst — first call = stmt meta (glAccountId, periodEnd)
    // second call = periodStart
    mockBankTxFindFirst
      .mockResolvedValueOnce({ glAccountId, periodEnd })
      .mockResolvedValueOnce({ periodStart });

    // bankTransaction.findMany — full list for bank balance
    mockBankTxFindMany.mockResolvedValueOnce(bankTxs);

    // $queryRawUnsafe — first call = ledger balance; second call = unmatched entries
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ debit_total: ledgerDebit, credit_total: ledgerCredit }])
      .mockResolvedValueOnce(unmatchedLedgerRows);
  }

  it('reports isReconciled=true when bank and ledger agree', async () => {
    setupMocks({
      bankTxs: [
        { amountFils: 50000, direction: 'credit', matchStatus: 'auto_matched' },
        { amountFils: 10000, direction: 'debit', matchStatus: 'auto_matched' },
      ],
      // bankBalance = +50000 − 10000 = +40000
      ledgerDebit: 50000n,
      ledgerCredit: 10000n,
      // ledgerBalance = 50000 − 10000 = +40000
      // difference = 40000 − 40000 = 0
    });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.isReconciled).toBe(true);
    expect(result.differenceFils).toBe(0);
    expect(result.bankBalanceFils).toBe(40000);
    expect(result.ledgerBalanceFils).toBe(40000);
  });

  it('reports positive difference when bank exceeds ledger', async () => {
    setupMocks({
      bankTxs: [
        { amountFils: 100000, direction: 'credit', matchStatus: 'auto_matched' },
        { amountFils: 15000, direction: 'debit', matchStatus: 'unmatched' },
      ],
      // bankBalance = +100000 − 15000 = +85000
      ledgerDebit: 100000n,
      ledgerCredit: 0n,
      // ledgerBalance = 100000 − 0 = +100000
      // difference = 85000 − 100000 = −15000
      unmatchedLedgerRows: [],
    });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.isReconciled).toBe(false);
    expect(result.bankBalanceFils).toBe(85000);
    expect(result.ledgerBalanceFils).toBe(100000);
    expect(result.differenceFils).toBe(-15000);
    expect(result.unmatchedBankFils).toBe(15000);
  });

  it('reports negative difference when ledger exceeds bank', async () => {
    setupMocks({
      bankTxs: [{ amountFils: 50000, direction: 'credit', matchStatus: 'auto_matched' }],
      // bankBalance = +50000
      ledgerDebit: 70000n,
      ledgerCredit: 0n,
      // ledgerBalance = 70000
      // difference = 50000 − 70000 = −20000
      unmatchedLedgerRows: [{ entry_id: 'e-1', debit: 20000n, credit: 0n }],
    });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.isReconciled).toBe(false);
    expect(result.differenceFils).toBe(-20000);
    expect(result.unmatchedLedgerFils).toBe(20000);
    expect(result.unmatchedLedgerCount).toBe(1);
  });

  it('generates suggested action text in EN and AR when reconciled', async () => {
    setupMocks({ bankTxs: [], ledgerDebit: 0n, ledgerCredit: 0n });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.suggestedActionEn).toContain('fully reconciled');
    expect(result.suggestedActionAr).toContain('بالكامل');
  });

  it('generates suggested action text when bank exceeds ledger', async () => {
    setupMocks({
      bankTxs: [{ amountFils: 5000, direction: 'credit', matchStatus: 'unmatched' }],
      ledgerDebit: 0n,
      ledgerCredit: 0n,
    });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.suggestedActionEn).toContain('Bank balance');
    expect(result.suggestedActionEn).toContain('exceeds ledger');
    expect(result.suggestedActionAr).toContain('رصيد البنك');
  });

  it('generates suggested action text when ledger exceeds bank', async () => {
    setupMocks({
      bankTxs: [],
      ledgerDebit: 10000n,
      ledgerCredit: 0n,
      unmatchedLedgerRows: [{ entry_id: 'e-2', debit: 10000n, credit: 0n }],
    });

    const result = await getReconciliationDifference(STMT_ID, STORE_ID);

    expect(result.suggestedActionEn).toContain('Ledger balance');
    expect(result.suggestedActionEn).toContain('exceeds bank');
    expect(result.suggestedActionAr).toContain('رصيد الدفتر');
  });

  it('throws 404 when statement not found', async () => {
    // bankStatement.findFirst returns null
    mockBankTxFindFirst.mockResolvedValueOnce(null);

    await expect(getReconciliationDifference('nonexistent-stmt', STORE_ID)).rejects.toThrow(
      'statement_not_found'
    );
  });
});
