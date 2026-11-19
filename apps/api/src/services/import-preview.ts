import { parseCsvRecords } from './csv-import';
import { priceErrorCode, priceErrorColumn } from './price-cell';

/**
 * Dry-run view of a converted (internal, piastre) platform CSV: what the
 * importer WOULD write, with no database writes. The admin shows it so the
 * merchant sees every price as EGP before confirming — the guard against a
 * file prepared under the old "whole piastres" instruction importing 100x high.
 */

export interface PreviewRow {
  /** 1-based row in the uploaded file (header = 1). */
  row: number;
  name: string;
  sku: string;
  parentSku: string;
  /** Integer piastres, or null when blank/invalid. */
  price: number | null;
  compareAtPrice: number | null;
  costPrice: number | null;
  error: string | null;
}

export interface PreviewError {
  row: number;
  column: string | null;
  /** Stable PRICE_* code when the error is a price error, else null. */
  code: string | null;
  error: string;
}

export interface PreviewWarning {
  code: 'PRICES_LOOK_LIKE_PIASTRES';
  /** Median of the file's base-row prices / the store's existing median, both in piastres. */
  fileMedianMinor: number;
  storeMedianMinor: number;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: PreviewRow[];
  errors: PreviewError[];
  warnings: PreviewWarning[];
  truncated: boolean;
}

export const PREVIEW_ROW_LIMIT = 200;
export const PREVIEW_ERROR_LIMIT = 200;
/** File median this many times the store's median reads as "prices typed in piastres". */
const PIASTRE_SUSPECT_RATIO = 20;
const MIN_SAMPLE = 3;

const toMinor = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '' || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
};

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function buildImportPreview(csv: string, existingPrices: number[] = []): ImportPreview {
  const records = parseCsvRecords(csv);
  const header = (records[0]?.fields ?? []).map(h => h.trim());
  const at = (name: string) => header.indexOf(name);
  const col = {
    name: at('name'),
    sku: at('sku'),
    parentSku: at('parentSku'),
    price: at('price'),
    compareAtPrice: at('compareAtPrice'),
    costPrice: at('costPrice'),
    error: at('_error'),
    sourceRow: at('sourceRow'),
  };
  const cell = (f: string[], i: number) => (i >= 0 ? (f[i] ?? '').trim() : '');

  const rows: PreviewRow[] = [];
  const errors: PreviewError[] = [];
  const basePrices: number[] = [];
  let valid = 0;
  let invalid = 0;
  for (const rec of records.slice(1)) {
    const f = rec.fields;
    const src = Number.parseInt(cell(f, col.sourceRow), 10);
    const row = Number.isFinite(src) && src > 0 ? src : rec.number;
    const error = cell(f, col.error) || null;
    const price = toMinor(cell(f, col.price));
    if (error) {
      invalid++;
      if (errors.length < PREVIEW_ERROR_LIMIT) {
        errors.push({
          row,
          column: priceErrorColumn(error),
          code: priceErrorCode(error),
          error,
        });
      }
    } else {
      valid++;
      if (price !== null && cell(f, col.parentSku) === '') basePrices.push(price);
    }
    if (rows.length < PREVIEW_ROW_LIMIT) {
      rows.push({
        row,
        name: cell(f, col.name),
        sku: cell(f, col.sku),
        parentSku: cell(f, col.parentSku),
        price,
        compareAtPrice: toMinor(cell(f, col.compareAtPrice)),
        costPrice: toMinor(cell(f, col.costPrice)),
        error,
      });
    }
  }

  const warnings: PreviewWarning[] = [];
  if (basePrices.length >= MIN_SAMPLE && existingPrices.length >= MIN_SAMPLE) {
    const fileMedianMinor = median(basePrices);
    const storeMedianMinor = median(existingPrices);
    if (storeMedianMinor > 0 && fileMedianMinor >= storeMedianMinor * PIASTRE_SUSPECT_RATIO) {
      warnings.push({ code: 'PRICES_LOOK_LIKE_PIASTRES', fileMedianMinor, storeMedianMinor });
    }
  }

  return {
    totalRows: valid + invalid,
    validRows: valid,
    invalidRows: invalid,
    rows,
    errors,
    warnings,
    truncated: valid + invalid > rows.length,
  };
}

/**
 * STORE-QA-64: fold the importer's own row errors (`BulkService.importProducts` with `dryRun`) into the shape-level preview, so the
 * preview can never say "ready" over rows the real import will fail (barcode owned by another product, missing name, orphan
 * variant rows ...). Row 0 = a group-level failure (a parent that cannot be found, a bundle pin): it counts as one invalid entry.
 */
export function mergeImportCheckErrors(
  preview: ImportPreview,
  checkErrors: Array<{ row: number; error: string }>
): ImportPreview {
  const failing = new Set<number>();
  const byRow = new Map<number, string>();
  for (const e of preview.errors) failing.add(e.row);
  for (const r of preview.rows) if (r.error) failing.add(r.row);
  const errors = [...preview.errors];
  let groupLevel = 0;
  for (const e of checkErrors) {
    if (e.row > 0) {
      if (!byRow.has(e.row)) byRow.set(e.row, e.error);
      if (failing.has(e.row)) continue;
      failing.add(e.row);
    } else groupLevel++;
    if (errors.length < PREVIEW_ERROR_LIMIT) {
      errors.push({ row: e.row, column: null, code: null, error: e.error });
    }
  }
  const rows = preview.rows.map(r =>
    byRow.has(r.row) && !r.error ? { ...r, error: byRow.get(r.row)! } : r
  );
  const invalidRows = Math.min(preview.totalRows, failing.size + groupLevel);
  return {
    ...preview,
    rows,
    errors,
    invalidRows,
    validRows: Math.max(0, preview.totalRows - invalidRows),
  };
}
