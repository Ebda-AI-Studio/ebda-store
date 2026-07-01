/**
 * CSV field-escaping utilities (formula-injection safe).
 *
 * Single canonical implementation shared by every CSV exporter in the platform
 * so the OWASP CSV-injection guard can never be forgotten in one exporter.
 */

/**
 * Escape a single CSV field value (RFC 4180) with spreadsheet-formula-injection
 * protection (OWASP).
 *
 * Two independent concerns:
 *  1. Formula injection — a cell beginning with `= + - @`, a tab, or a CR can
 *     execute as a formula when the file is opened in Excel / Google Sheets.
 *     We neutralise it by prefixing a single quote (`'`).
 *  2. RFC 4180 quoting — a value containing `"`, `,`, or a newline must be
 *     wrapped in double quotes with inner quotes doubled.
 *
 * Output is byte-for-byte identical to a naive escaper for any value that is
 * neither a formula trigger nor contains a quote/comma/newline.
 */
export function csvField(value: string | number | null | undefined | Date): string {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // (1) Formula-injection guard — prefix a quote so the leading char is inert.
  s = neutralizeFormula(s);
  // (2) RFC 4180 quoting.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Neutralise a spreadsheet-formula-injection payload WITHOUT CSV quoting — for
 * XLSX cells (ExcelJS) and any non-CSV spreadsheet output. A cell beginning with
 * `= + - @`, a tab, or a CR can execute as a formula when opened in Excel /
 * Google Sheets; prefixing a single quote makes the leading char inert.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
