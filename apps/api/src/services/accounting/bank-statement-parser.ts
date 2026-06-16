/**
 * Bank Statement Parsers — CSV + OFX
 *
 * MONEY-PATH RULE: all amounts converted to integer FILS via string/integer
 * arithmetic. No float intermediates cross the boundary.
 *   KWD 12.345 → 12345 fils
 *   KWD  1.000 →  1000 fils
 *   KWD  0.001 →     1 fil
 *
 * The row_hash (SHA-256 of canonical fields) is the idempotent dedup key.
 * Re-importing the same statement rows is a no-op in the DB.
 */

import { createHash } from 'crypto';

export type TransactionDirection = 'debit' | 'credit';

export interface ParsedRow {
  /** Transaction date (midnight UTC) */
  date: Date;
  description: string;
  /** Amount in integer fils (1 KWD = 1000 fils). Always positive. */
  amountFils: number;
  direction: TransactionDirection;
  /** Provider-supplied reference id (FITID, cheque no., etc.) */
  externalRef: string | null;
  /**
   * SHA-256 of (date-ISO | amountFils | direction | externalRef | description)
   * used as the unique dedup key per store.
   */
  rowHash: string;
}

// ─── Fils conversion ──────────────────────────────────────────────────────────

/**
 * Convert a decimal money string to integer fils.
 * Uses only string manipulation and integer math — NO float arithmetic.
 *
 * Supports: "12.345", "1,234.567", "-0.500", "١٢٣.٤٥٦" (Arabic-indic)
 */
export function decimalStringToFils(raw: string): number {
  if (!raw || raw.trim() === '') return 0;

  // Normalise Arabic-Indic digits → ASCII
  const normalised = raw
    .trim()
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/,/g, '') // strip thousands separators
    .replace(/\s/g, '');

  // Split on decimal point
  const [intPart = '0', fracPart = ''] = normalised.split('.');

  const isNegative = intPart.startsWith('-');
  const absInt = parseInt(isNegative ? intPart.slice(1) : intPart, 10) || 0;

  // Pad or trim fractional part to exactly 3 digits (KWD = 3 decimal places)
  const frac3 = fracPart.padEnd(3, '0').slice(0, 3);
  const fracFils = parseInt(frac3, 10) || 0;

  const totalFils = absInt * 1000 + fracFils;
  return isNegative ? -totalFils : totalFils;
}

/** Compute the deterministic row hash. */
function computeRowHash(
  date: Date,
  amountFils: number,
  direction: TransactionDirection,
  externalRef: string | null,
  description: string
): string {
  const canonical = [
    date.toISOString().slice(0, 10), // date portion only
    String(amountFils),
    direction,
    externalRef ?? '',
    description,
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const DMY_RE = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/;
const MDY_RE = /^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/;
// OFX date: YYYYMMDDHHMMSS or YYYYMMDD
const OFX_DATE_RE = /^(\d{4})(\d{2})(\d{2})/;

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const s = raw.trim();

  let m = ISO_RE.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = OFX_DATE_RE.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  // Try d/m/y first (GCC convention), then m/d/y
  m = DMY_RE.exec(s);
  if (m) {
    const d = +m[1],
      month = +m[2],
      y = +m[3];
    // If month > 12 it must be swapped (d/m/y)
    if (month <= 12 && d <= 31) {
      return new Date(Date.UTC(y, month - 1, d));
    }
    if (d <= 12) {
      return new Date(Date.UTC(y, d - 1, month));
    }
  }

  return null;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

/**
 * English column aliases (lower-cased, trimmed).
 * Arabic equivalents are also mapped.
 */
const DATE_COLS = new Set([
  'date',
  'تاريخ',
  'transaction date',
  'تاريخ المعاملة',
  'value date',
  'تاريخ القيمة',
  'posting date',
]);
const DESC_COLS = new Set([
  'description',
  'الوصف',
  'narrative',
  'details',
  'التفاصيل',
  'particulars',
  'تفاصيل',
  'memo',
  'ملاحظة',
  'reference',
  'remarks',
]);
const DEBIT_COLS = new Set([
  'debit',
  'مدين',
  'withdrawals',
  'سحب',
  'dr',
  'debit amount',
  'مبلغ المدين',
]);
const CREDIT_COLS = new Set([
  'credit',
  'دائن',
  'deposits',
  'إيداع',
  'cr',
  'credit amount',
  'مبلغ الدائن',
]);
const AMOUNT_COLS = new Set(['amount', 'المبلغ', 'transaction amount', 'مبلغ المعاملة']);
const REF_COLS = new Set([
  'reference',
  'ref',
  'fitid',
  'transaction id',
  'cheque no',
  'رقم المرجع',
  'رقم الشيك',
  'رقم العملية',
]);

export interface CsvParseResult {
  rows: ParsedRow[];
  skipped: number;
  errors: string[];
}

/**
 * Parse a CSV bank statement buffer.
 * Tolerant: skips malformed/empty rows, reports errors without throwing.
 */
export function parseStatementCsv(buffer: Buffer): CsvParseResult {
  const text = buffer.toString('utf-8');
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const errors: string[] = [];
  let skipped = 0;

  if (lines.length === 0) {
    return { rows: [], skipped: 0, errors: ['empty file'] };
  }

  // Detect separator (comma vs semicolon vs tab)
  const header = lines[0];
  const sep = header.includes(';') ? ';' : header.includes('\t') ? '\t' : ',';

  // Parse header → column index map
  const cols = splitCsvLine(header, sep).map(h => h.toLowerCase().trim().replace(/^"|"$/g, ''));

  const dateIdx = cols.findIndex(c => DATE_COLS.has(c));
  const descIdx = cols.findIndex(c => DESC_COLS.has(c));
  const debitIdx = cols.findIndex(c => DEBIT_COLS.has(c));
  const creditIdx = cols.findIndex(c => CREDIT_COLS.has(c));
  const amountIdx = cols.findIndex(c => AMOUNT_COLS.has(c));
  const refIdx = cols.findIndex(c => REF_COLS.has(c));

  if (dateIdx === -1) {
    return { rows: [], skipped: 0, errors: ['could not find date column'] };
  }
  if (descIdx === -1) {
    return { rows: [], skipped: 0, errors: ['could not find description column'] };
  }
  if (debitIdx === -1 && creditIdx === -1 && amountIdx === -1) {
    return { rows: [], skipped: 0, errors: ['could not find amount column'] };
  }

  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], sep).map(c => c.trim().replace(/^"|"$/g, ''));

    const dateRaw = cells[dateIdx] ?? '';
    const descRaw = cells[descIdx] ?? '';
    const date = parseDate(dateRaw);

    if (!date) {
      errors.push(`row ${i + 1}: invalid date "${dateRaw}"`);
      skipped++;
      continue;
    }

    if (!descRaw) {
      skipped++;
      continue;
    }

    const externalRef = refIdx !== -1 ? (cells[refIdx] ?? null) || null : null;

    let amountFils: number;
    let direction: TransactionDirection;

    if (debitIdx !== -1 || creditIdx !== -1) {
      // Separate debit / credit columns
      const debitRaw = debitIdx !== -1 ? (cells[debitIdx] ?? '') : '';
      const creditRaw = creditIdx !== -1 ? (cells[creditIdx] ?? '') : '';
      const debitFils = decimalStringToFils(debitRaw);
      const creditFils = decimalStringToFils(creditRaw);

      if (debitFils > 0 && creditFils > 0) {
        errors.push(`row ${i + 1}: both debit and credit filled`);
        skipped++;
        continue;
      }
      if (debitFils === 0 && creditFils === 0) {
        skipped++;
        continue;
      }
      if (debitFils > 0) {
        amountFils = debitFils;
        direction = 'debit';
      } else {
        amountFils = creditFils;
        direction = 'credit';
      }
    } else {
      // Single amount column — negative = debit, positive = credit
      const raw = cells[amountIdx] ?? '';
      const fils = decimalStringToFils(raw);
      if (fils === 0) {
        skipped++;
        continue;
      }
      amountFils = Math.abs(fils);
      direction = fils < 0 ? 'debit' : 'credit';
    }

    const rowHash = computeRowHash(date, amountFils, direction, externalRef, descRaw);
    rows.push({ date, description: descRaw, amountFils, direction, externalRef, rowHash });
  }

  return { rows, skipped, errors };
}

/** Simple CSV line splitter that respects double-quoted fields. */
function splitCsvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === sep && !inQuote) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

// ─── OFX Parser (hand-rolled, no heavy deps) ─────────────────────────────────

/**
 * Parse a bank statement in OFX (SGML or XML) format.
 *
 * OFX amounts:
 *   positive → credit (deposit)
 *   negative → debit  (withdrawal)
 *
 * We handle both:
 *  - Classic SGML OFX (no closing tags):  <TRNAMT>-12.345
 *  - XML OFX (with closing tags):         <TRNAMT>-12.345</TRNAMT>
 */
export interface OfxParseResult {
  rows: ParsedRow[];
  skipped: number;
  errors: string[];
}

export function parseStatementOfx(buffer: Buffer): OfxParseResult {
  const text = buffer.toString('utf-8');
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  let skipped = 0;

  // Extract all STMTTRN blocks
  const blockRe =
    /<STMTTRN>([\s\S]*?)<\/STMTTRN>|<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/STMTTRNRS>|$)/gi;

  let match: RegExpExecArray | null;
  let txIdx = 0;

  while ((match = blockRe.exec(text)) !== null) {
    txIdx++;
    const block = (match[1] ?? match[2] ?? '').trim();
    if (!block) continue;

    const dtposted = extractOfxField(block, 'DTPOSTED');
    const trnamt = extractOfxField(block, 'TRNAMT');
    const fitid = extractOfxField(block, 'FITID');
    const name = extractOfxField(block, 'NAME') ?? extractOfxField(block, 'MEMO') ?? '';

    if (!dtposted) {
      errors.push(`tx ${txIdx}: missing DTPOSTED`);
      skipped++;
      continue;
    }
    if (!trnamt) {
      errors.push(`tx ${txIdx}: missing TRNAMT`);
      skipped++;
      continue;
    }

    const date = parseDate(dtposted);
    if (!date) {
      errors.push(`tx ${txIdx}: invalid date "${dtposted}"`);
      skipped++;
      continue;
    }

    const fils = decimalStringToFils(trnamt);
    if (fils === 0) {
      skipped++;
      continue;
    }

    const amountFils = Math.abs(fils);
    const direction: TransactionDirection = fils < 0 ? 'debit' : 'credit';
    const externalRef = fitid || null;
    const description = name || `OFX transaction ${txIdx}`;

    const rowHash = computeRowHash(date, amountFils, direction, externalRef, description);
    rows.push({ date, description, amountFils, direction, externalRef, rowHash });
  }

  if (rows.length === 0 && errors.length === 0 && txIdx === 0) {
    errors.push('no STMTTRN blocks found — check OFX format');
  }

  return { rows, skipped, errors };
}

/**
 * Extract an OFX field value (supports both SGML and XML).
 * <FIELDNAME>value  OR  <FIELDNAME>value</FIELDNAME>
 */
function extractOfxField(block: string, field: string): string | null {
  const re = new RegExp(`<${field}>([^<\r\n]*)`, 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}
