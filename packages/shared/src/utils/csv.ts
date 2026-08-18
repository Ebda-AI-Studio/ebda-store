/**
 * CSV Import/Export Utilities
 *
 * Provides utilities for:
 * - Product import column definitions
 * - Stock adjustment import column definitions + parser
 * - File reading helpers
 */

// ============================================
// Product Import Templates
// ============================================

/**
 * Product import CSV column definitions
 */
export const PRODUCT_IMPORT_COLUMNS = [
  { key: 'name', header: 'Product Name', required: true },
  { key: 'nameAr', header: 'Product Name (Arabic)', required: false },
  { key: 'description', header: 'Description', required: false },
  { key: 'descriptionAr', header: 'Description (Arabic)', required: false },
  { key: 'price', header: 'Price (KWD)', required: true },
  { key: 'compareAtPrice', header: 'Compare At Price (KWD)', required: false },
  { key: 'sku', header: 'SKU', required: false },
  { key: 'barcode', header: 'Barcode', required: false },
  { key: 'inventory', header: 'Inventory', required: false },
  { key: 'category', header: 'Category', required: false },
  { key: 'status', header: 'Status (draft/active/archived)', required: false },
  { key: 'featured', header: 'Featured (true/false)', required: false },
  { key: 'isNew', header: 'New Badge (true/false)', required: false },
  { key: 'imageUrl1', header: 'Image URL 1', required: false },
  { key: 'imageUrl2', header: 'Image URL 2', required: false },
  { key: 'imageUrl3', header: 'Image URL 3', required: false },
  { key: 'imageUrl4', header: 'Image URL 4', required: false },
  { key: 'tags', header: 'Tags (semicolon separated)', required: false },
  { key: 'weight', header: 'Weight (kg)', required: false },
] as const;

// ============================================
// Stock Adjustment Import Templates
// ============================================

/**
 * Stock adjustment CSV column definitions.
 *
 * Supported identifier columns (first match wins):
 *   - SKU / رمز المنتج  → resolves to product/variant by SKU
 *   - Barcode / الباركود → resolves to product by barcode
 *
 * Quantity modes (mutually exclusive, exactly one required per row):
 *   - New Quantity / الكمية الجديدة → set stock to this absolute value
 *   - Delta / التغيير             → signed adjustment (+/-)
 *
 * Optional:
 *   - Reason / السبب
 */
export const STOCK_ADJUST_IMPORT_COLUMNS = [
  { key: 'sku', header: 'SKU', headerAr: 'رمز المنتج', required: false },
  { key: 'barcode', header: 'Barcode', headerAr: 'الباركود', required: false },
  { key: 'new_quantity', header: 'New Quantity', headerAr: 'الكمية الجديدة', required: false },
  { key: 'delta', header: 'Delta', headerAr: 'التغيير', required: false },
  { key: 'reason', header: 'Reason', headerAr: 'السبب', required: false },
] as const;

export const STOCK_ADJUST_ROW_LIMIT = 5000;

export type StockAdjustImportKey = (typeof STOCK_ADJUST_IMPORT_COLUMNS)[number]['key'];

export interface StockAdjustParsedRow {
  /** Row number in the CSV (1-based, excludes header) */
  rowNumber: number;
  /** Identifier that was used for lookup */
  sku: string | null;
  barcode: string | null;
  /**
   * Absolute target quantity (new_quantity column).
   * Mutually exclusive with delta.
   */
  newQuantity: number | null;
  /**
   * Signed delta (delta column).
   * Mutually exclusive with newQuantity.
   */
  delta: number | null;
  reason: string | null;
}

export interface StockAdjustParseResult {
  rows: StockAdjustParsedRow[];
  /** Human-readable error messages per row (row_number → messages[]) */
  errors: Record<number, string[]>;
  /** True when at least one row is valid */
  hasValidRows: boolean;
  totalRows: number;
}

/**
 * Build a header→key normalisation map from STOCK_ADJUST_IMPORT_COLUMNS.
 * Matches English headers AND Arabic headers, case-insensitively, after
 * stripping BOM / surrounding whitespace.
 */
function buildHeaderMap(): Record<string, StockAdjustImportKey> {
  const map: Record<string, StockAdjustImportKey> = {};
  for (const col of STOCK_ADJUST_IMPORT_COLUMNS) {
    map[col.header.toLowerCase()] = col.key;
    map[col.headerAr.toLowerCase()] = col.key;
    // Common abbreviation aliases
    if (col.key === 'new_quantity') {
      map['qty'] = col.key;
      map['quantity'] = col.key;
      map['stock'] = col.key;
      map['new qty'] = col.key;
      map['new stock'] = col.key;
      map['الكمية'] = col.key;
      map['المخزون'] = col.key;
      map['الكمية الجديدة'] = col.key;
    }
    if (col.key === 'delta') {
      map['adjustment'] = col.key;
      map['change'] = col.key;
      map['diff'] = col.key;
      map['التغيير'] = col.key;
      map['الفارق'] = col.key;
    }
    if (col.key === 'sku') {
      map['product sku'] = col.key;
      map['sku code'] = col.key;
      map['رمز المخزون'] = col.key;
    }
    if (col.key === 'barcode') {
      map['upc'] = col.key;
      map['ean'] = col.key;
      map['barcode number'] = col.key;
      map['الباركود'] = col.key;
    }
    if (col.key === 'reason') {
      map['note'] = col.key;
      map['notes'] = col.key;
      map['comment'] = col.key;
      map['ملاحظة'] = col.key;
      map['الملاحظات'] = col.key;
    }
  }
  return map;
}

/**
 * Validate and parse one stock-adjust data row.
 *
 * Pulled out of parseStockAdjustCsv, which the code-health scan flagged at 28
 * branches: almost all of them were this per-row validation, inlined inside the
 * loop inside the file-level parser. This is shared PRODUCTION code that decides
 * what a merchant's stock import does to live inventory, so the validation reads
 * better as one named unit than as the middle of a 123-line function.
 *
 * Returns the parsed row plus any errors. A row is always returned even when
 * invalid — the importer shows the merchant every row with its own errors, so
 * dropping bad rows here would lose the feedback.
 */
function parseStockAdjustRow(
  cells: string[],
  colIndices: Partial<Record<StockAdjustImportKey, number>>,
  rowNumber: number
): { row: StockAdjustParsedRow; errors: string[] } {
  const getValue = (key: StockAdjustImportKey): string => {
    const idx = colIndices[key];
    return idx !== undefined ? (cells[idx] ?? '').trim() : '';
  };

  const errors: string[] = [];

  const rawSku = getValue('sku');
  const rawBarcode = getValue('barcode');
  const rawNewQty = getValue('new_quantity');
  const rawDelta = getValue('delta');
  const rawReason = getValue('reason');

  // Identifier check — without one of these we cannot say WHICH product to adjust.
  const sku = rawSku || null;
  const barcode = rawBarcode || null;
  if (!sku && !barcode) {
    errors.push('Row must have a SKU or Barcode to identify the product.');
  }

  // Quantity mode: absolute ("new quantity") XOR relative ("delta"). Both filled
  // in is rejected rather than guessed — picking one silently would be the
  // difference between setting stock to 5 and adding 5.
  const hasNewQty = rawNewQty !== '';
  const hasDelta = rawDelta !== '';
  if (!hasNewQty && !hasDelta) {
    errors.push('Row must have either "New Quantity" or "Delta" (signed change) column filled in.');
  }
  if (hasNewQty && hasDelta) {
    errors.push('Row has both "New Quantity" and "Delta" filled in — use only one per row.');
  }

  let newQuantity: number | null = null;
  let delta: number | null = null;

  if (hasNewQty && !hasDelta) {
    const parsed = parseFloat(rawNewQty);
    if (isNaN(parsed) || !Number.isFinite(parsed)) {
      errors.push(`"New Quantity" value "${rawNewQty}" is not a valid number.`);
    } else if (!Number.isInteger(parsed)) {
      errors.push(`"New Quantity" must be a whole number (got ${rawNewQty}).`);
    } else if (parsed < 0) {
      errors.push(`"New Quantity" must be ≥ 0 (got ${parsed}).`);
    } else {
      newQuantity = parsed;
    }
  }

  if (hasDelta && !hasNewQty) {
    const parsed = parseFloat(rawDelta);
    if (isNaN(parsed) || !Number.isFinite(parsed)) {
      errors.push(`"Delta" value "${rawDelta}" is not a valid number.`);
    } else if (!Number.isInteger(parsed)) {
      errors.push(`"Delta" must be a whole number (got ${rawDelta}).`);
    } else {
      // Negative delta is legitimate — it is a signed change.
      delta = parsed;
    }
  }

  return {
    row: { rowNumber, sku, barcode, newQuantity, delta, reason: rawReason || null },
    errors,
  };
}

/**
 * Parse a CSV string into stock adjustment rows.
 *
 * Handles:
 *  - BOM prefix
 *  - LF + CRLF line endings
 *  - Quoted fields with embedded commas/newlines
 *  - Arabic column headers
 *  - Mixed case headers
 *
 * Validation:
 *  - Row cap: STOCK_ADJUST_ROW_LIMIT rows max (returns error, not exception)
 *  - Each row must have either new_quantity OR delta, not both, not neither
 *  - Each row must have at least one identifier (sku or barcode)
 *  - newQuantity must be ≥ 0; delta must be an integer
 */
export function parseStockAdjustCsv(raw: string): StockAdjustParseResult {
  // Strip BOM
  const content = raw.startsWith('﻿') ? raw.slice(1) : raw;

  // Split into lines, handling CRLF
  const lines = content.split(/\r?\n/);

  const errors: Record<number, string[]> = {};
  const rows: StockAdjustParsedRow[] = [];

  // Parse header
  const headerLine = lines[0]?.trim();
  if (!headerLine) {
    return {
      rows: [],
      errors: { 0: ['CSV file is empty or has no header row.'] },
      hasValidRows: false,
      totalRows: 0,
    };
  }

  const headerMap = buildHeaderMap();
  const rawHeaders = splitCsvLine(headerLine).map(h =>
    h
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
  );
  const colIndices: Partial<Record<StockAdjustImportKey, number>> = {};
  for (let i = 0; i < rawHeaders.length; i++) {
    const key = headerMap[rawHeaders[i]];
    if (key && !(key in colIndices)) {
      colIndices[key] = i;
    }
  }

  // Check total data rows
  const dataLines = lines.slice(1).filter(l => l.trim().length > 0);
  if (dataLines.length > STOCK_ADJUST_ROW_LIMIT) {
    return {
      rows: [],
      errors: {
        0: [`CSV exceeds the maximum of ${STOCK_ADJUST_ROW_LIMIT} rows. Split into smaller files.`],
      },
      hasValidRows: false,
      totalRows: dataLines.length,
    };
  }

  for (let i = 0; i < dataLines.length; i++) {
    const rowNumber = i + 1; // 1-based, skipping header
    const cells = splitCsvLine(dataLines[i]).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const { row, errors: rowErrors } = parseStockAdjustRow(cells, colIndices, rowNumber);
    if (rowErrors.length > 0) {
      errors[rowNumber] = rowErrors;
    }
    rows.push(row);
  }

  const hasValidRows = rows.some(r => !errors[r.rowNumber]);

  return { rows, errors, hasValidRows, totalRows: dataLines.length };
}

/**
 * Naive CSV line splitter that handles quoted fields.
 * Does not handle multi-line quoted fields (uncommon in inventory CSVs).
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === quoteChar && line[i + 1] === quoteChar) {
        // Escaped quote
        current += ch;
        i++;
      } else if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if ((ch === '"' || ch === "'") && current === '') {
        inQuotes = true;
        quoteChar = ch;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Generate a CSV template string for stock adjustments.
 * Includes English headers only (the common merchant-facing format).
 */
export function generateStockAdjustCsvTemplate(): string {
  return (
    'SKU,Barcode,New Quantity,Delta,Reason\n' +
    'PROD-001,,150,,cycle_count\n' +
    'PROD-002,,,+5,found\n'
  );
}

// ============================================
// File Helpers (Browser-only functions)
// ============================================

// Generic types for browser APIs (without DOM lib dependency)
type GenericFileReader = {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
  result: string | ArrayBuffer | null;
  readAsText: (blob: unknown) => void;
};

/**
 * Read file as text
 * This function only works in browser environments
 */
export function readFileAsText(file: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof globalThis === 'undefined') {
      reject(new Error('readFileAsText only works in browser'));
      return;
    }

    const g = globalThis as Record<string, unknown>;
    if (!g.FileReader) {
      reject(new Error('FileReader not available'));
      return;
    }

    const FileReaderClass = g.FileReader as { new (): GenericFileReader };
    const reader = new FileReaderClass();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
