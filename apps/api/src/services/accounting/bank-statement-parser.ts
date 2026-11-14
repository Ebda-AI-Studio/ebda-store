/**
 * Bank Statement Parsers — CSV + OFX
 *
 * MONEY-PATH RULE: all amounts converted to integer PIASTRES via string/integer
 * arithmetic. No float intermediates cross the boundary.
 *   EGP 12.34 → 1234 piastres
 *   EGP 10.00 → 1000 piastres
 *   EGP  0.01 →    1 piastre
 *   (a 3rd decimal, if a statement carries one, is truncated — never rounded up)
 *
 * The row_hash (SHA-256 of canonical fields) is the idempotent dedup key.
 * Re-importing the same statement rows is a no-op in the DB.
 */

import { createHash } from 'crypto';

import { REGION, currencyExponent, minorUnitsPerMajor } from '@ebda/shared';
export type TransactionDirection = 'debit' | 'credit';

export interface ParsedRow {
  /** Transaction date (midnight UTC) */
  date: Date;
  description: string;
  /** Amount in integer piastres (1 EGP = 100 piastres). Always positive. */
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

// ─── Piastres conversion ──────────────────────────────────────────────────────────

/**
 * Convert a decimal money string to integer piastres.
 * Uses only string manipulation and integer math — NO float arithmetic.
 *
 * Supports: "12.34", "1,234.56", "1.234,56", "100,50", "-0.50", "١٢٣.٤٥" (Arabic-indic)
 */
export function decimalStringToFils(raw: string): number {
  if (!raw || raw.trim() === '') return 0;

  // Normalise Arabic-Indic digits → ASCII, and the Arabic decimal/thousands marks (٫ ٬) to . and ,
  const digits = raw
    .trim()
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/\s/g, '');

  // ACCT-AUDIT-8: tell the decimal mark from the thousands mark. When both appear the LAST one is the decimal mark
  // ("1.234,56" and "1,234.56" are the same amount). A lone comma is a decimal mark when it appears once with 1-2 digits
  // after it ("100,50"); otherwise it groups thousands ("1,234", "1,234,567"). Several dots group thousands ("1.234.567").
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  let normalised: string;
  if (lastDot !== -1 && lastComma !== -1) {
    normalised =
      lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const single = digits.indexOf(',') === lastComma;
    const after = digits.length - lastComma - 1;
    normalised =
      single && after >= 1 && after <= 2 ? digits.replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastDot !== -1 && digits.indexOf('.') !== lastDot) {
    normalised = digits.replace(/\./g, '');
  } else {
    normalised = digits;
  }

  // Split on decimal point
  const [intPart = '0', fracPart = ''] = normalised.split('.');

  const isNegative = intPart.startsWith('-');
  const absInt = parseInt(isNegative ? intPart.slice(1) : intPart, 10) || 0;

  // Pad or TRUNCATE the fractional part to the currency's exponent (EGP = 2
  // decimals). A bank statement never carries sub-piastre amounts, so an extra
  // digit is statement noise, not money — it is dropped, never rounded up.
  const exp = currencyExponent(REGION.currency);
  const fracDigits = fracPart.padEnd(exp, '0').slice(0, exp);
  const fracMinor = parseInt(fracDigits || '0', 10) || 0;

  const totalMinor = absInt * minorUnitsPerMajor(REGION.currency) + fracMinor;
  return isNegative ? -totalMinor : totalMinor;
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
  const text = decodeStatementText(buffer);
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const errors: string[] = [];
  let skipped = 0;

  if (lines.length === 0) {
    return { rows: [], skipped: 0, errors: ['empty file'] };
  }

  // ACCT-AUDIT-8: a bank preamble (account holder, period) can sit above the header, so the header is the first of the
  // top lines that names a date column, a description column and an amount column; none found -> report line 1's gap.
  let headerAt = -1;
  let h = analyseHeader(lines[0]);
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LINES) && headerAt === -1; i++) {
    const cand = analyseHeader(lines[i]);
    if (cand.dateIdx !== -1 && cand.descIdx !== -1 && cand.hasAmount) {
      headerAt = i;
      h = cand;
    }
  }
  if (headerAt === -1) headerAt = 0;
  const { sep, dateIdx, descIdx, debitIdx, creditIdx, amountIdx, refIdx } = h;

  if (dateIdx === -1) {
    return { rows: [], skipped: 0, errors: ['could not find date column'] };
  }
  if (descIdx === -1) {
    return { rows: [], skipped: 0, errors: ['could not find description column'] };
  }
  if (!h.hasAmount) {
    return { rows: [], skipped: 0, errors: ['could not find amount column'] };
  }

  const rows: ParsedRow[] = [];

  for (let i = headerAt + 1; i < lines.length; i++) {
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
      const piastres = decimalStringToFils(raw);
      if (piastres === 0) {
        skipped++;
        continue;
      }
      amountFils = Math.abs(piastres);
      direction = piastres < 0 ? 'debit' : 'credit';
    }

    const rowHash = computeRowHash(date, amountFils, direction, externalRef, descRaw);
    rows.push({ date, description: descRaw, amountFils, direction, externalRef, rowHash });
  }

  return { rows, skipped, errors };
}

const HEADER_SCAN_LINES = 40;

/** A header cell without quotes, case or the Arabic definite article, so `التاريخ` finds `تاريخ`. */
function headerKeys(cell: string): string[] {
  const c = cell.toLowerCase().trim().replace(/^"|"$/g, '').trim();
  return c.startsWith('ال') ? [c, c.slice(2)] : [c];
}
const colIndex = (cols: string[][], set: Set<string>): number =>
  cols.findIndex(keys => keys.some(k => set.has(k)));

function analyseHeader(line: string) {
  const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  const cols = splitCsvLine(line, sep).map(headerKeys);
  const debitIdx = colIndex(cols, DEBIT_COLS);
  const creditIdx = colIndex(cols, CREDIT_COLS);
  const amountIdx = colIndex(cols, AMOUNT_COLS);
  return {
    sep,
    dateIdx: colIndex(cols, DATE_COLS),
    descIdx: colIndex(cols, DESC_COLS),
    debitIdx,
    creditIdx,
    amountIdx,
    refIdx: colIndex(cols, REF_COLS),
    hasAmount: debitIdx !== -1 || creditIdx !== -1 || amountIdx !== -1,
  };
}

/**
 * Statement bytes -> text. UTF-8 first; a file that is not valid UTF-8 is a windows-1256 export (Egyptian banks), so
 * decode it as that instead of feeding U+FFFD into descriptions and the row hash.
 */
function decodeStatementText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1256').decode(buffer);
  }
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
  const text = decodeStatementText(buffer);
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

    const piastres = decimalStringToFils(trnamt);
    if (piastres === 0) {
      skipped++;
      continue;
    }

    const amountFils = Math.abs(piastres);
    const direction: TransactionDirection = piastres < 0 ? 'debit' : 'credit';
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
