/**
 * COD reconciliation, exact to the piastre (SP7): the pure matcher and the settlement CSV
 * parser. Every amount is an integer of piastres; nothing is rounded.
 */
import { describe, it, expect } from 'vitest';
import {
  lineRefFor,
  parseSettlementCsv,
  reconcileShipment,
  summarize,
  type ReconInput,
} from '@api/lib/cod-reconciliation';

const line = (gross: number, fee: number) => ({
  grossAmount: gross,
  feeAmount: fee,
  netAmount: gross - fee,
});

describe('reconcileShipment', () => {
  it('settled: the carrier remitted exactly the COD, fees kept apart', () => {
    const r = reconcileShipment({
      expected: 123_450,
      shipmentStatus: 'delivered',
      lines: [line(123_450, 1_235)],
    });
    expect(r).toMatchObject({
      status: 'settled',
      owed: 123_450,
      gross: 123_450,
      fees: 1_235,
      net: 122_215,
      outstanding: 0,
      over: 0,
      flagged: false,
    });
  });

  it('awaiting: delivered but nothing remitted yet', () => {
    const r = reconcileShipment({ expected: 5_000, shipmentStatus: 'delivered', lines: [] });
    expect(r).toMatchObject({ status: 'awaiting', outstanding: 5_000, gross: 0, flagged: false });
  });

  it('partial remittances add up to the piastre and flag until complete', () => {
    const lines = [line(30_000, 300), line(20_001, 200)];
    const open = reconcileShipment({ expected: 60_000, shipmentStatus: 'delivered', lines });
    expect(open).toMatchObject({
      status: 'partial',
      gross: 50_001,
      fees: 500,
      net: 49_501,
      outstanding: 9_999,
      flagged: true,
    });
    expect(open.flags).toContain('short_by_9999');
    const done = reconcileShipment({
      expected: 60_000,
      shipmentStatus: 'delivered',
      lines: [...lines, line(9_999, 100)],
    });
    expect(done).toMatchObject({
      status: 'settled',
      gross: 60_000,
      fees: 600,
      net: 59_400,
      outstanding: 0,
    });
  });

  it('over-remitted: the carrier paid more than the COD', () => {
    const r = reconcileShipment({
      expected: 10_000,
      shipmentStatus: 'delivered',
      lines: [line(10_001, 0)],
    });
    expect(r).toMatchObject({ status: 'over_remitted', over: 1, outstanding: 0, flagged: true });
  });

  it('a returned or cancelled parcel owes nothing; money for it is a mismatch', () => {
    const none = reconcileShipment({ expected: 8_000, shipmentStatus: 'returned', lines: [] });
    expect(none).toMatchObject({ status: 'settled', owed: 0, outstanding: 0, flagged: false });
    const paid = reconcileShipment({
      expected: 8_000,
      shipmentStatus: 'cancelled',
      lines: [line(8_000, 0)],
    });
    expect(paid.status).toBe('mismatch');
    expect(paid.flags).toContain('remitted_for_undelivered_parcel');
    expect(paid.over).toBe(8_000);
  });

  it('a line whose net is not gross minus fee is a mismatch, never trusted', () => {
    const r = reconcileShipment({
      expected: 10_000,
      shipmentStatus: 'delivered',
      lines: [{ grossAmount: 10_000, feeAmount: 100, netAmount: 9_901 }],
    });
    expect(r.status).toBe('mismatch');
    expect(r.flags).toContain('line_net_is_not_gross_minus_fee');
  });

  it('refuses fractional piastres as a mismatch', () => {
    const r = reconcileShipment({
      expected: 10_000,
      shipmentStatus: 'delivered',
      lines: [{ grossAmount: 10_000.5, feeAmount: 0, netAmount: 10_000.5 }],
    });
    expect(r.status).toBe('mismatch');
  });
});

describe('summarize: totals reconcile to the piastre', () => {
  // a spread of shipments a store could really have: settled, partial, awaiting, over, voided
  const inputs: ReconInput[] = [
    { expected: 123_450, shipmentStatus: 'delivered', lines: [line(123_450, 1_235)] },
    {
      expected: 60_000,
      shipmentStatus: 'delivered',
      lines: [line(30_000, 300), line(20_001, 200)],
    },
    { expected: 5_000, shipmentStatus: 'delivered', lines: [] },
    { expected: 10_000, shipmentStatus: 'delivered', lines: [line(10_001, 100)] },
    { expected: 8_000, shipmentStatus: 'returned', lines: [] },
    { expected: 8_000, shipmentStatus: 'cancelled', lines: [line(8_000, 80)] },
    { expected: 99_999, shipmentStatus: 'in_transit', lines: [] },
    { expected: 29, shipmentStatus: 'delivered', lines: [line(29, 1)] },
  ];
  const results = inputs.map(reconcileShipment);
  const s = summarize(results, [{ grossAmount: 777 }, { grossAmount: 3 }]);

  it('owed - gross = outstanding - over, exactly', () => {
    expect(s.owed - s.gross).toBe(s.outstanding - s.over);
  });

  it('gross = fees + net, exactly', () => {
    expect(s.gross).toBe(s.fees + s.net);
  });

  it('matches hand-computed totals', () => {
    // owed: 123450 + 60000 + 5000 + 10000 + 0 + 0 + 99999 + 29
    expect(s.owed).toBe(298_478);
    // gross: 123450 + 50001 + 0 + 10001 + 0 + 8000 + 0 + 29
    expect(s.gross).toBe(191_481);
    expect(s.fees).toBe(1_235 + 500 + 100 + 80 + 1);
    expect(s.outstanding).toBe(9_999 + 5_000 + 99_999);
    expect(s.over).toBe(1 + 8_000);
    expect(s.unmatchedGross).toBe(780);
    expect(s.unmatchedLines).toBe(2);
    expect(s.byStatus).toEqual({
      awaiting: 2,
      partial: 1,
      settled: 3,
      over_remitted: 1,
      mismatch: 1,
    });
    expect(s.flaggedShipments).toBe(3);
  });

  it('every figure is an integer', () => {
    for (const v of [s.owed, s.gross, s.fees, s.net, s.outstanding, s.over]) {
      expect(Number.isSafeInteger(v)).toBe(true);
    }
  });
});

describe('parseSettlementCsv', () => {
  const csv = [
    'Tracking Number,Collected,Fee,Net,Date,Reference',
    'BST00000001,1234.50,12.35,1222.15,2026-10-06,STMT-1-A',
    'BST00000002,"1,000.00",10.00,990.00,2026-10-06,STMT-1-B',
    'BST00000003,0.29,0,0.29,2026-10-06,',
  ].join('\n');

  it('reads EGP decimals into exact piastres without float error', () => {
    const { rows, rejected } = parseSettlementCsv(csv, 'bosta');
    expect(rejected).toEqual([]);
    expect(rows.map(r => [r.trackingNumber, r.grossAmount, r.feeAmount, r.netAmount])).toEqual([
      ['BST00000001', 123_450, 1_235, 122_215],
      ['BST00000002', 100_000, 1_000, 99_000],
      ['BST00000003', 29, 0, 29], // 0.29 EGP is 29 piastres, not 28.999...
    ]);
  });

  it('a `_piastres` column is already integer', () => {
    const { rows } = parseSettlementCsv(
      'awb,collected_piastres,fee_piastres\nT1,12345,100',
      'aramex'
    );
    expect(rows[0]).toMatchObject({ grossAmount: 12_345, feeAmount: 100, netAmount: 12_245 });
  });

  it('derives the missing one of collected / fee / net', () => {
    const a = parseSettlementCsv('awb,net,fee\nT1,99.00,1.00', 'bosta').rows[0];
    expect(a).toMatchObject({ grossAmount: 10_000, feeAmount: 100, netAmount: 9_900 });
    const b = parseSettlementCsv('awb,collected\nT1,50.00', 'bosta').rows[0];
    expect(b).toMatchObject({ grossAmount: 5_000, feeAmount: 0, netAmount: 5_000 });
  });

  it('rejects bad rows with a reason and keeps the good ones', () => {
    const { rows, rejected } = parseSettlementCsv(
      [
        'tracking,collected,fee,net',
        'T1,100.00,1.00,99.00',
        ',100.00,1.00,99.00',
        'T3,1.999,0,1.999',
        'T4,100.00,1.00,98.00',
        'T5,abc,0,0',
      ].join('\n'),
      'bosta'
    );
    expect(rows.map(r => r.trackingNumber)).toEqual(['T1']);
    expect(rejected.map(r => r.line)).toEqual([3, 4, 5, 6]);
    expect(rejected.find(r => r.line === 5)?.reason).toMatch(/net is not collected minus fee/);
  });

  it('refuses a statement with no usable header', () => {
    const { rows, rejected } = parseSettlementCsv('foo,bar\n1,2', 'bosta');
    expect(rows).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it('a line without a reference gets a stable content hash, so a re-upload is a no-op', () => {
    const a = parseSettlementCsv(csv, 'bosta').rows[2];
    const b = parseSettlementCsv(csv, 'bosta').rows[2];
    expect(a.lineRef).toBe(b.lineRef);
    expect(a.lineRef).toBe(lineRefFor('bosta', 'BST00000003', new Date('2026-10-06'), 29, 0));
    // a different carrier or amount is a different line
    expect(lineRefFor('aramex', 'BST00000003', new Date('2026-10-06'), 29, 0)).not.toBe(a.lineRef);
    expect(lineRefFor('bosta', 'BST00000003', new Date('2026-10-06'), 30, 0)).not.toBe(a.lineRef);
  });
});
