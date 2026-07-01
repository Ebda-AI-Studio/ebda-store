/**
 * Shared XLSX export helper — Force Website Builder API
 *
 * Wraps ExcelJS to stream a formatted workbook directly to an Express
 * response. All CSV export routes that want a parallel XLSX endpoint
 * should call this helper with the same column/row data they already
 * build for CSV — guarantees the two outputs stay in sync.
 *
 * Column `numFmt` examples:
 *   '#,##0.000'  → KWD three-decimal amounts
 *   '@'          → force text cell (prevents Excel from mangling phone numbers)
 */
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { neutralizeFormula } from '@force/shared';

export interface XlsxColumn {
  header: string;
  key: string;
  width?: number;
  numFmt?: string; // e.g. '#,##0.000' for KWD amounts
}

export interface StreamXlsxOpts {
  filename: string; // e.g. 'orders-2026-05-23.xlsx' — no path component
  sheetName?: string; // default 'Sheet1'
  columns: XlsxColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Build an ExcelJS workbook from `opts` and pipe it directly into `res`.
 * Sets Content-Type and Content-Disposition headers automatically.
 * Caller MUST NOT write headers or call res.end() before this.
 */
export async function streamXlsxResponse(res: Response, opts: StreamXlsxOpts): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Force AI Store';
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
  const safeRows = opts.rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'string' ? neutralizeFormula(v) : v;
    }
    return out;
  });
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

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`);

  await wb.xlsx.write(res);
  res.end();
}
