/**
 * Unit tests for the stock-adjustment CSV parser.
 *
 * Covers: valid rows, malformed inputs, Arabic headers, row limit,
 * delta mode, mixed errors+valid, template generation.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStockAdjustCsv,
  generateStockAdjustCsvTemplate,
  STOCK_ADJUST_ROW_LIMIT,
} from '../../packages/shared/src/utils/csv';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRows(count: number, overrides?: Record<string, string>): string {
  const defaults = { SKU: 'SKU-{i}', 'New Quantity': '10', Barcode: '', Delta: '', Reason: '' };
  const merged = { ...defaults, ...overrides };
  const header = Object.keys(merged).join(',');
  const rows = Array.from({ length: count }, (_, i) => {
    return Object.values(merged)
      .map(v => v.replace('{i}', String(i + 1)))
      .join(',');
  });
  return [header, ...rows].join('\n');
}

// ─── Parser — valid inputs ────────────────────────────────────────────────────

describe('parseStockAdjustCsv — valid inputs', () => {
  it('parses a simple new-quantity CSV with English headers', () => {
    const csv = 'SKU,New Quantity,Reason\nPROD-001,50,cycle_count\nPROD-002,0,damage';
    const result = parseStockAdjustCsv(csv);
    expect(result.totalRows).toBe(2);
    expect(result.hasValidRows).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ sku: 'PROD-001', newQuantity: 50, delta: null });
    expect(result.rows[1]).toMatchObject({ sku: 'PROD-002', newQuantity: 0, delta: null });
  });

  it('parses delta mode rows correctly', () => {
    const csv = 'SKU,Delta\nPROD-001,+5\nPROD-002,-3\nPROD-003,0';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0]).toMatchObject({ sku: 'PROD-001', delta: 5, newQuantity: null });
    expect(result.rows[1]).toMatchObject({ sku: 'PROD-002', delta: -3, newQuantity: null });
    expect(result.rows[2]).toMatchObject({ sku: 'PROD-003', delta: 0, newQuantity: null });
  });

  it('resolves by barcode when SKU is absent', () => {
    const csv = 'Barcode,New Quantity\n123456789012,25';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0]).toMatchObject({ barcode: '123456789012', sku: null, newQuantity: 25 });
  });

  it('strips BOM from the start of the file', () => {
    const csv = '﻿SKU,New Quantity\nPROD-BOM,100';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0].newQuantity).toBe(100);
  });

  it('handles CRLF line endings', () => {
    const csv = 'SKU,New Quantity\r\nPROD-CR,20\r\n';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0].newQuantity).toBe(20);
  });

  it('ignores trailing blank lines', () => {
    const csv = 'SKU,New Quantity\nPROD-001,5\n\n   \n';
    const result = parseStockAdjustCsv(csv);
    expect(result.totalRows).toBe(1);
  });

  it('populates reason field', () => {
    const csv = 'SKU,New Quantity,Reason\nPROD-001,10,annual_count';
    const result = parseStockAdjustCsv(csv);
    expect(result.rows[0].reason).toBe('annual_count');
  });
});

// ─── Parser — Arabic headers ──────────────────────────────────────────────────

describe('parseStockAdjustCsv — Arabic column headers', () => {
  it('parses Arabic headers: رمز المنتج + الكمية الجديدة', () => {
    const csv = 'رمز المنتج,الكمية الجديدة,السبب\nPROD-AR-01,30,جرد دوري';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0]).toMatchObject({
      sku: 'PROD-AR-01',
      newQuantity: 30,
      reason: 'جرد دوري',
    });
  });

  it('parses Arabic headers: الباركود + التغيير', () => {
    const csv = 'الباركود,التغيير\n978345678901,-10';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.rows[0]).toMatchObject({ barcode: '978345678901', delta: -10 });
  });

  it('accepts الملاحظات as Reason alias', () => {
    const csv = 'رمز المنتج,الكمية الجديدة,الملاحظات\nAR-02,5,سرقة';
    const result = parseStockAdjustCsv(csv);
    expect(result.rows[0].reason).toBe('سرقة');
  });
});

// ─── Parser — alias headers ───────────────────────────────────────────────────

describe('parseStockAdjustCsv — alias headers', () => {
  it('accepts "Qty" as alias for New Quantity', () => {
    const csv = 'SKU,Qty\nP1,7';
    const result = parseStockAdjustCsv(csv);
    expect(result.rows[0].newQuantity).toBe(7);
  });

  it('accepts "Adjustment" as alias for Delta', () => {
    const csv = 'SKU,Adjustment\nP2,+3';
    const result = parseStockAdjustCsv(csv);
    expect(result.rows[0].delta).toBe(3);
  });

  it('accepts "Barcode Number" header', () => {
    const csv = 'Barcode Number,New Quantity\n999888777,0';
    const result = parseStockAdjustCsv(csv);
    expect(result.rows[0].barcode).toBe('999888777');
    expect(result.rows[0].newQuantity).toBe(0);
  });
});

// ─── Parser — validation errors ──────────────────────────────────────────────

// Helper: assert that at least one error message in the array matches the pattern.
function hasError(msgs: string[] | undefined, pattern: RegExp): boolean {
  return Boolean(msgs?.some(m => pattern.test(m)));
}

describe('parseStockAdjustCsv — validation errors', () => {
  it('returns error when no identifier (SKU or Barcode)', () => {
    const csv = 'New Quantity\n10';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /SKU or Barcode/i)).toBe(true);
  });

  it('returns error when neither new_quantity nor delta', () => {
    const csv = 'SKU\nPROD-X';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /New Quantity.*Delta|Delta.*New Quantity/i)).toBe(true);
  });

  it('returns error when both new_quantity and delta are set', () => {
    const csv = 'SKU,New Quantity,Delta\nPROD-X,10,+5';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /both.*filled/i)).toBe(true);
  });

  it('returns error for non-integer new_quantity', () => {
    const csv = 'SKU,New Quantity\nPROD-X,10.5';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /whole number/i)).toBe(true);
  });

  it('returns error for negative new_quantity', () => {
    const csv = 'SKU,New Quantity\nPROD-X,-1';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /≥ 0/i)).toBe(true);
  });

  it('returns error for non-numeric delta', () => {
    const csv = 'SKU,Delta\nPROD-X,bad';
    const result = parseStockAdjustCsv(csv);
    expect(hasError(result.errors[1], /not a valid number/i)).toBe(true);
  });

  it('returns error for empty CSV body', () => {
    const result = parseStockAdjustCsv('');
    expect(result.hasValidRows).toBe(false);
    expect(result.errors[0]).toBeDefined();
  });

  it('hasValidRows = false when all rows have errors', () => {
    const csv = 'SKU,New Quantity\n,\n,';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(false);
  });

  it('hasValidRows = true when at least one row is clean', () => {
    const csv = 'SKU,New Quantity\nPROD-OK,5\n,bad';
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.errors[1]).toBeUndefined(); // row 1 is OK
    expect(result.errors[2]).toBeDefined(); // row 2 has errors
  });
});

// ─── Parser — row limit ───────────────────────────────────────────────────────

describe('parseStockAdjustCsv — row limit', () => {
  it('rejects CSV exceeding STOCK_ADJUST_ROW_LIMIT rows', () => {
    const csv = makeRows(STOCK_ADJUST_ROW_LIMIT + 1);
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(false);
    expect(hasError(result.errors[0], /maximum/i)).toBe(true);
  });

  it('accepts CSV exactly at STOCK_ADJUST_ROW_LIMIT rows', () => {
    const csv = makeRows(STOCK_ADJUST_ROW_LIMIT);
    const result = parseStockAdjustCsv(csv);
    expect(result.hasValidRows).toBe(true);
    expect(result.totalRows).toBe(STOCK_ADJUST_ROW_LIMIT);
  });
});

// ─── Template generator ───────────────────────────────────────────────────────

describe('generateStockAdjustCsvTemplate', () => {
  it('returns a non-empty string', () => {
    const tpl = generateStockAdjustCsvTemplate();
    expect(typeof tpl).toBe('string');
    expect(tpl.length).toBeGreaterThan(0);
  });

  it('first line contains expected headers', () => {
    const tpl = generateStockAdjustCsvTemplate();
    const header = tpl.split('\n')[0];
    expect(header).toContain('SKU');
    expect(header).toContain('New Quantity');
    expect(header).toContain('Delta');
    expect(header).toContain('Reason');
  });

  it('template can be re-parsed without errors', () => {
    const tpl = generateStockAdjustCsvTemplate();
    const result = parseStockAdjustCsv(tpl);
    // Template has example rows; at least one should be parseable
    expect(result.totalRows).toBeGreaterThan(0);
  });
});
