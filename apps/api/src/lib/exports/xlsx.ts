/**
 * Shared XLSX export helper — Ebda API
 *
 * Wraps ExcelJS to stream a formatted workbook directly to an Express
 * response. All CSV export routes that want a parallel XLSX endpoint
 * should call this helper with the same column/row data they already
 * build for CSV — guarantees the two outputs stay in sync.
 *
 * Column `numFmt` examples:
 *   '#,##0.00'   → EGP two-decimal amounts (use `excelMoneyFormat` from @force/shared)
 *   '@'          → force text cell (prevents Excel from mangling phone numbers)
 */
import type ExcelJS from 'exceljs';
import { loadExcelJS } from '../lazy-modules';
import type { Response } from 'express';
import { neutralizeFormula, describeListFilters, type ReportRange, BRAND } from '@force/shared';

/**
 * Formula-injection guard, cell/row level — for routes that build an ExcelJS
 * workbook by hand (multiple sheets, array-form rows) and so can't route through
 * `streamXlsxResponse`. Neutralise every string that would evaluate as a
 * spreadsheet formula when the .xlsx is opened in Excel / Google Sheets; leave
 * numbers, dates, and other non-strings untouched. Wrap EVERY `sheet.addRow(...)`
 * whose payload contains user-controlled text (names, notes, addresses, product
 * names) in the matching helper.
 */
export function neutralizeCell(v: unknown): unknown {
  return typeof v === 'string' ? neutralizeFormula(v) : v;
}

/** Neutralise every string in an object-form `addRow` payload. */
export function neutralizeRowObject(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = neutralizeCell(v);
  return out;
}

/** Neutralise every string in an array-form `addRow` payload. */
export function neutralizeRowArray(row: unknown[]): unknown[] {
  return row.map(neutralizeCell);
}

export interface XlsxColumn {
  header: string;
  key: string;
  width?: number;
  numFmt?: string; // e.g. excelMoneyFormat({ grouped: true }) for EGP amounts
}

export interface StreamXlsxOpts {
  filename: string; // e.g. 'orders-2026-05-23.xlsx' — no path component
  sheetName?: string; // default 'Sheet1'
  columns: XlsxColumn[];
  rows: Record<string, unknown>[];
  /** The filters the export applied — written to a "Filters" sheet. */
  filters?: ExportFilterSummary;
}

/** What an export was filtered by, for the file's own "Filters" sheet. */
export interface ExportFilterSummary {
  /** One line, e.g. `Filters: Date = 2026-09-01 to 2026-09-30; Status = pending`. */
  line: string;
  /** Label/value pairs, one row each (value '' = not applied). */
  details: Array<[string, string]>;
}

/** Builds the summary from label/value pairs (`undefined`/'' = not applied). */
export function summarizeExportFilters(
  details: Array<[string, string | undefined]>
): ExportFilterSummary {
  return {
    line: describeListFilters(details),
    details: details.map(([k, v]) => [k, v ?? '']),
  };
}

/** `2026-09-01 to 2026-09-30` in the viewer's days, or undefined for no range. */
export function describeRange(
  range: ReportRange | undefined,
  dayOf: (d: Date) => string
): string | undefined {
  return range ? `${dayOf(range.startDate)} to ${dayOf(range.endDate)}` : undefined;
}

/**
 * Adds a "Filters" sheet naming exactly what the export was filtered by, so a
 * downloaded file says which slice of the data it holds (owner report
 * 2026-09-30: an "orders" file held the whole store history and nothing in it
 * said so).
 */
export function addFiltersSheet(wb: ExcelJS.Workbook, filters: ExportFilterSummary): void {
  const ws = wb.addWorksheet('Filters');
  ws.columns = [
    { header: 'Filter', key: 'filter', width: 22 },
    { header: 'Value', key: 'value', width: 60 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const [filter, value] of filters.details) {
    ws.addRow(neutralizeRowObject({ filter, value: value || 'all' }));
  }
  ws.addRow([]);
  ws.addRow(neutralizeRowArray([filters.line]));
  ws.addRow(neutralizeRowArray([`Generated: ${new Date().toISOString()}`]));
}

/**
 * Build an ExcelJS workbook from `opts` and pipe it directly into `res`.
 * Sets Content-Type and Content-Disposition headers automatically.
 * Caller MUST NOT write headers or call res.end() before this.
 */
export async function streamXlsxResponse(res: Response, opts: StreamXlsxOpts): Promise<void> {
  const wb = new (await loadExcelJS()).Workbook();
  wb.creator = BRAND.product.nameEn;
  wb.created = new Date();

  const ws = wb.addWorksheet(opts.sheetName || 'Sheet1');
  ws.columns = opts.columns.map(col => ({
    header: col.header,
    key: col.key,
    width: col.width ?? 20,
    style: col.numFmt ? { numFmt: col.numFmt } : undefined,
  }));

  // Formula-injection guard: neutralise any string cell that would evaluate as a
  // spreadsheet formula when the .xlsx is opened in Excel / Google Sheets. Covers
  // EVERY XLSX export (orders, customers, finance…) in one place. Non-string
  // values (numbers, dates) pass through untouched.
  const safeRows = opts.rows.map(neutralizeRowObject);
  ws.addRows(safeRows);

  // Bold + light-grey header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF2F2F2' },
  };
  headerRow.commit();

  if (opts.filters) addFiltersSheet(wb, opts.filters);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`);

  await wb.xlsx.write(res);
  res.end();
}
