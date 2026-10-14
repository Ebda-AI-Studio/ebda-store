/**
 * COD reconciliation: pure money logic, no database (SP7).
 *
 * A carrier collects cash from the customer and later remits it, minus its own fees. A shipment
 * expects `codAmount` piastres; the carrier's settlement statement says, per line, what it
 * collected (`gross`), what it kept (`fee`) and what it paid out (`net = gross - fee`). All
 * integers, all piastres: nothing here uses a float, so totals reconcile to the piastre.
 *
 *   owed        what the carrier should have collected: the shipment's COD, or 0 once the
 *               shipment is cancelled / returned (the parcel never delivered, nothing is owed)
 *   gross       sum of the lines' collected amounts
 *   outstanding max(owed - gross, 0)   still to come (partial or not yet remitted)
 *   over        max(gross - owed, 0)   the carrier remitted MORE than it should have
 *   fees, net   sums of the lines' fee and net
 *
 * Per shipment `owed - gross = outstanding - over`, so for a whole store
 * `sum(owed) - sum(gross) = sum(outstanding) - sum(over)` exactly. That identity is what the
 * tests and the reconciliation page's totals bar rest on.
 */
import { createHash } from 'node:crypto';
import { tryToMinor } from '@ebda/shared';
import { parseCsvRecords } from '../services/csv-import';

export type ReconStatus =
  | 'awaiting' // nothing remitted yet
  | 'partial' // some remitted, less than owed
  | 'settled' // remitted exactly what was owed (or nothing was owed and nothing came)
  | 'over_remitted' // remitted more than owed
  | 'mismatch'; // a line contradicts itself, or money came for a parcel that never delivered

export interface ReconLine {
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
}

export interface ReconInput {
  /** The shipment's expected COD in piastres. */
  expected: number;
  shipmentStatus: string;
  lines: ReconLine[];
}

export interface ReconResult {
  status: ReconStatus;
  expected: number;
  owed: number;
  gross: number;
  fees: number;
  net: number;
  outstanding: number;
  over: number;
  /** Needs the merchant's attention (partial, over-remitted or mismatched). */
  flagged: boolean;
  flags: string[];
}

const VOID_STATUSES = ['cancelled', 'returned'];

const isInt = (n: number) => Number.isSafeInteger(n);

export function reconcileShipment(input: ReconInput): ReconResult {
  const flags: string[] = [];
  let gross = 0;
  let fees = 0;
  let net = 0;
  for (const l of input.lines) {
    if (
      ![l.grossAmount, l.feeAmount, l.netAmount].every(isInt) ||
      l.grossAmount < 0 ||
      l.feeAmount < 0
    ) {
      flags.push('line_not_integer_piastres');
    }
    if (l.netAmount !== l.grossAmount - l.feeAmount) flags.push('line_net_is_not_gross_minus_fee');
    gross += l.grossAmount;
    fees += l.feeAmount;
    net += l.netAmount;
  }

  const voided = VOID_STATUSES.includes(input.shipmentStatus);
  const owed = voided ? 0 : input.expected;
  const outstanding = Math.max(owed - gross, 0);
  const over = Math.max(gross - owed, 0);

  let status: ReconStatus;
  if (flags.length > 0) status = 'mismatch';
  else if (voided && gross > 0) {
    status = 'mismatch';
    flags.push('remitted_for_undelivered_parcel');
  } else if (gross === 0) status = owed === 0 ? 'settled' : 'awaiting';
  else if (gross < owed) status = 'partial';
  else if (gross === owed) status = 'settled';
  else {
    status = 'over_remitted';
    flags.push('remitted_more_than_cod');
  }
  if (status === 'partial') flags.push('short_by_' + outstanding);

  return {
    status,
    expected: input.expected,
    owed,
    gross,
    fees,
    net,
    outstanding,
    over,
    flagged: status === 'partial' || status === 'over_remitted' || status === 'mismatch',
    flags,
  };
}

export interface ReconSummary {
  shipments: number;
  owed: number;
  gross: number;
  fees: number;
  net: number;
  outstanding: number;
  over: number;
  /** Lines whose tracking number matches no shipment of this store. */
  unmatchedGross: number;
  unmatchedLines: number;
  flaggedShipments: number;
  byStatus: Record<ReconStatus, number>;
}

export function summarize(
  results: ReconResult[],
  unmatched: Array<{ grossAmount: number }> = []
): ReconSummary {
  const s: ReconSummary = {
    shipments: results.length,
    owed: 0,
    gross: 0,
    fees: 0,
    net: 0,
    outstanding: 0,
    over: 0,
    unmatchedGross: 0,
    unmatchedLines: unmatched.length,
    flaggedShipments: 0,
    byStatus: { awaiting: 0, partial: 0, settled: 0, over_remitted: 0, mismatch: 0 },
  };
  for (const r of results) {
    s.owed += r.owed;
    s.gross += r.gross;
    s.fees += r.fees;
    s.net += r.net;
    s.outstanding += r.outstanding;
    s.over += r.over;
    if (r.flagged) s.flaggedShipments += 1;
    s.byStatus[r.status] += 1;
  }
  for (const u of unmatched) s.unmatchedGross += u.grossAmount;
  return s;
}

// ---------------------------------------------------------------------------
// Settlement statement import (CSV)
// ---------------------------------------------------------------------------

export interface SettlementRow {
  trackingNumber: string;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  remittedAt: Date;
  lineRef: string;
  batchId?: string;
}

export interface SettlementParseResult {
  rows: SettlementRow[];
  rejected: Array<{ line: number; reason: string }>;
}

const norm = (h: string) =>
  h
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const ALIASES = {
  tracking: ['tracking_number', 'tracking', 'awb', 'waybill', 'waybill_number', 'shipment_number'],
  gross: ['collected', 'cod', 'cod_amount', 'collected_amount', 'gross', 'gross_amount', 'amount'],
  fee: ['fee', 'fees', 'cod_fee', 'carrier_fee', 'deductions'],
  net: ['net', 'net_amount', 'remitted', 'remitted_amount', 'payout'],
  date: ['date', 'remitted_at', 'remittance_date', 'settlement_date', 'paid_at'],
  ref: ['reference', 'ref', 'line_ref', 'statement_ref', 'settlement_id', 'transaction_id'],
  batch: ['batch', 'batch_id', 'statement', 'statement_id'],
};

/** Amount cell -> integer piastres. A `_piastres` column is already integer; any other is EGP. */
function amount(raw: string, inPiastres: boolean): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return null;
  if (inPiastres) return /^\d+$/.test(t) ? Number(t) : null;
  const n = tryToMinor(t, 'EGP');
  return n !== null && n >= 0 ? n : null;
}

/** A stable id for a line, so uploading the same statement twice changes nothing. */
export function lineRefFor(
  carrier: string,
  tracking: string,
  remittedAt: Date,
  gross: number,
  fee: number
): string {
  return (
    'h:' +
    createHash('sha256')
      .update([carrier, tracking, remittedAt.toISOString().slice(0, 10), gross, fee].join('|'))
      .digest('hex')
      .slice(0, 32)
  );
}

/**
 * Parse a carrier's COD settlement CSV. Columns are matched by name (see ALIASES); amounts are
 * EGP decimals unless the column name ends in `_piastres`. Needs a tracking number and two of
 * gross / fee / net (the third is derived; all three given must agree). A bad row is rejected
 * with a reason and never imported, and never fails the others.
 */
export function parseSettlementCsv(
  text: string,
  carrier: string,
  now = new Date()
): SettlementParseResult {
  const records = parseCsvRecords(text);
  const out: SettlementParseResult = { rows: [], rejected: [] };
  if (records.length === 0) return out;

  const headers = records[0].fields.map(norm);
  const find = (names: string[]) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return { i, piastres: false };
      const j = headers.indexOf(`${n}_piastres`);
      if (j >= 0) return { i: j, piastres: true };
    }
    return null;
  };
  const col = {
    tracking: find(ALIASES.tracking),
    gross: find(ALIASES.gross),
    fee: find(ALIASES.fee),
    net: find(ALIASES.net),
    date: find(ALIASES.date),
    ref: find(ALIASES.ref),
    batch: find(ALIASES.batch),
  };
  if (!col.tracking || (!col.gross && !col.net)) {
    out.rejected.push({
      line: 1,
      reason: 'The header needs a tracking number column and a collected or net amount column',
    });
    return out;
  }

  for (const rec of records.slice(1)) {
    const cell = (c: { i: number } | null) => (c ? (rec.fields[c.i] ?? '').trim() : '');
    const tracking = cell(col.tracking);
    if (!tracking) {
      out.rejected.push({ line: rec.number, reason: 'missing tracking number' });
      continue;
    }
    const parse = (c: { i: number; piastres: boolean } | null) =>
      c && cell(c) !== '' ? amount(cell(c), c.piastres) : undefined;
    let gross = parse(col.gross);
    let fee = parse(col.fee);
    let net = parse(col.net);
    if (gross === null || fee === null || net === null) {
      out.rejected.push({ line: rec.number, reason: 'an amount is not a valid EGP number' });
      continue;
    }
    if (fee === undefined) fee = gross !== undefined && net !== undefined ? gross - net : 0;
    if (gross === undefined && net !== undefined) gross = net + fee;
    if (net === undefined && gross !== undefined) net = gross - fee;
    if (gross === undefined || net === undefined) {
      out.rejected.push({ line: rec.number, reason: 'missing collected / net amount' });
      continue;
    }
    if (fee < 0 || net !== gross - fee) {
      out.rejected.push({ line: rec.number, reason: 'net is not collected minus fee' });
      continue;
    }
    let remittedAt = now;
    const rawDate = cell(col.date);
    if (rawDate) {
      const d = new Date(rawDate);
      if (Number.isNaN(d.getTime())) {
        out.rejected.push({ line: rec.number, reason: 'unreadable date' });
        continue;
      }
      remittedAt = d;
    }
    out.rows.push({
      trackingNumber: tracking,
      grossAmount: gross,
      feeAmount: fee,
      netAmount: net,
      remittedAt,
      lineRef: cell(col.ref) || lineRefFor(carrier, tracking, remittedAt, gross, fee),
      batchId: cell(col.batch) || undefined,
    });
  }
  return out;
}
