/**
 * CSV Import/Export Utilities
 *
 * Provides utilities for:
 * - Parsing CSV files
 * - Generating CSV exports
 * - Product import/export templates
 * - Data validation
 */

// ============================================
// Types
// ============================================

export interface CsvParseOptions {
  delimiter?: string;
  hasHeader?: boolean;
  skipEmptyLines?: boolean;
  trimValues?: boolean;
}

export interface CsvGenerateOptions {
  delimiter?: string;
  includeHeader?: boolean;
  lineEnding?: '\n' | '\r\n';
}

export interface ProductImportRow {
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  price: string;
  compareAtPrice?: string;
  sku?: string;
  barcode?: string;
  inventory?: string;
  category?: string;
  status?: 'draft' | 'active' | 'archived';
  featured?: string;
  isNew?: string;
  imageUrl1?: string;
  imageUrl2?: string;
  imageUrl3?: string;
  imageUrl4?: string;
  tags?: string;
  weight?: string;
}

export interface ProductExportRow {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  price: number;
  compareAtPrice: number | null;
  sku: string;
  barcode: string;
  inventory: number;
  category: string;
  status: string;
  featured: boolean;
  isNew: boolean;
  imageUrls: string;
  tags: string;
  weight: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: { row: number; field: string; message: string }[];
  warnings: { row: number; field: string; message: string }[];
}

// ============================================
// CSV Parsing
// ============================================

/**
 * Parse CSV string into array of objects
 */
export function parseCsv<T extends Record<string, string>>(
  csvString: string,
  options: CsvParseOptions = {}
): { headers: string[]; rows: T[] } {
  const { delimiter = ',', hasHeader = true, skipEmptyLines = true, trimValues = true } = options;

  const lines = csvString.split(/\r?\n/);
  const result: T[] = [];
  let headers: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (skipEmptyLines && !line.trim()) continue;

    const values = parseCsvLine(line, delimiter);

    if (trimValues) {
      for (let j = 0; j < values.length; j++) {
        values[j] = values[j].trim();
      }
    }

    if (i === 0 && hasHeader) {
      headers = values;
      continue;
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }

    result.push(row as T);
  }

  return { headers, rows: result };
}

/**
 * Parse a single CSV line handling quoted values
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

// ============================================
// CSV Generation
// ============================================

/**
 * Generate CSV string from array of objects
 */
export function generateCsv<T extends Record<string, unknown>>(
  data: T[],
  columns: { key: keyof T; header: string }[],
  options: CsvGenerateOptions = {}
): string {
  const { delimiter = ',', includeHeader = true, lineEnding = '\n' } = options;

  const lines: string[] = [];

  if (includeHeader) {
    lines.push(columns.map(col => escapeCsvValue(col.header, delimiter)).join(delimiter));
  }

  for (const row of data) {
    const values = columns.map(col => {
      const value = row[col.key];
      return escapeCsvValue(formatCsvValue(value), delimiter);
    });
    lines.push(values.join(delimiter));
  }

  return lines.join(lineEnding);
}

/**
 * Escape CSV value (handle quotes and delimiters)
 */
function escapeCsvValue(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format value for CSV export
 */
function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join(';');
  return String(value);
}

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

/**
 * Generate empty product import template
 */
export function generateProductImportTemplate(): string {
  const headers = PRODUCT_IMPORT_COLUMNS.map(col => col.header);

  // Add sample row
  const sampleRow = [
    'Sample Product',
    'منتج تجريبي',
    'Product description here',
    'وصف المنتج هنا',
    '25.500',
    '30.000',
    'SKU-001',
    '1234567890123',
    '100',
    'Electronics',
    'active',
    'false',
    'true',
    'https://example.com/image1.jpg',
    'https://example.com/image2.jpg',
    '',
    '',
    'tag1;tag2;tag3',
    '0.5',
  ];

  return [headers.join(','), sampleRow.map(v => escapeCsvValue(v, ',')).join(',')].join('\n');
}

/**
 * Product export CSV column definitions
 */
export const PRODUCT_EXPORT_COLUMNS: { key: keyof ProductExportRow; header: string }[] = [
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Product Name' },
  { key: 'nameAr', header: 'Product Name (Arabic)' },
  { key: 'description', header: 'Description' },
  { key: 'descriptionAr', header: 'Description (Arabic)' },
  { key: 'price', header: 'Price (KWD)' },
  { key: 'compareAtPrice', header: 'Compare At Price (KWD)' },
  { key: 'sku', header: 'SKU' },
  { key: 'barcode', header: 'Barcode' },
  { key: 'inventory', header: 'Inventory' },
  { key: 'category', header: 'Category' },
  { key: 'status', header: 'Status' },
  { key: 'featured', header: 'Featured' },
  { key: 'isNew', header: 'New Badge' },
  { key: 'imageUrls', header: 'Image URLs' },
  { key: 'tags', header: 'Tags' },
  { key: 'weight', header: 'Weight (kg)' },
  { key: 'createdAt', header: 'Created At' },
  { key: 'updatedAt', header: 'Updated At' },
];

// ============================================
// Validation
// ============================================

/**
 * Validate product import data
 */
export function validateProductImport(rows: ProductImportRow[]): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  const warnings: ValidationResult['warnings'] = [];

  rows.forEach((row, index) => {
    const rowNum = index + 2; // +2 for 1-indexed and header row

    // Required field: name
    if (!row.name?.trim()) {
      errors.push({
        row: rowNum,
        field: 'name',
        message: 'Product name is required',
      });
    }

    // Required field: price
    if (!row.price?.trim()) {
      errors.push({
        row: rowNum,
        field: 'price',
        message: 'Price is required',
      });
    } else {
      const price = parseFloat(row.price);
      if (isNaN(price) || price < 0) {
        errors.push({
          row: rowNum,
          field: 'price',
          message: 'Price must be a valid positive number',
        });
      }
    }

    // Validate compareAtPrice if present
    if (row.compareAtPrice?.trim()) {
      const comparePrice = parseFloat(row.compareAtPrice);
      if (isNaN(comparePrice) || comparePrice < 0) {
        errors.push({
          row: rowNum,
          field: 'compareAtPrice',
          message: 'Compare at price must be a valid positive number',
        });
      } else {
        const price = parseFloat(row.price);
        if (!isNaN(price) && comparePrice <= price) {
          warnings.push({
            row: rowNum,
            field: 'compareAtPrice',
            message: 'Compare at price should be higher than the regular price',
          });
        }
      }
    }

    // Validate inventory if present
    if (row.inventory?.trim()) {
      const inventory = parseInt(row.inventory, 10);
      if (isNaN(inventory) || inventory < 0) {
        errors.push({
          row: rowNum,
          field: 'inventory',
          message: 'Inventory must be a valid non-negative integer',
        });
      }
    }

    // Validate status if present
    if (row.status?.trim()) {
      const validStatuses = ['draft', 'active', 'archived'];
      if (!validStatuses.includes(row.status.toLowerCase())) {
        errors.push({
          row: rowNum,
          field: 'status',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        });
      }
    }

    // Validate image URLs if present
    const imageFields = ['imageUrl1', 'imageUrl2', 'imageUrl3', 'imageUrl4'] as const;
    for (const field of imageFields) {
      const url = row[field];
      if (url?.trim() && !isValidUrl(url)) {
        warnings.push({
          row: rowNum,
          field,
          message: `Invalid URL format: ${url}`,
        });
      }
    }

    // Validate weight if present
    if (row.weight?.trim()) {
      const weight = parseFloat(row.weight);
      if (isNaN(weight) || weight < 0) {
        errors.push({
          row: rowNum,
          field: 'weight',
          message: 'Weight must be a valid non-negative number',
        });
      }
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Simple URL validation
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Data Transformation
// ============================================

/**
 * Convert import row to product create data
 */
export function transformImportRowToProduct(row: ProductImportRow, storeId: string) {
  const priceInFils = Math.round(parseFloat(row.price) * 1000);
  const compareAtPriceInFils = row.compareAtPrice
    ? Math.round(parseFloat(row.compareAtPrice) * 1000)
    : null;

  // Generate slug from name
  const slug = row.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  // Collect image URLs
  const imageUrls = [row.imageUrl1, row.imageUrl2, row.imageUrl3, row.imageUrl4].filter(
    Boolean
  ) as string[];

  // Parse tags
  const tags = row.tags
    ? row.tags
        .split(';')
        .map(t => t.trim())
        .filter(Boolean)
    : [];

  return {
    storeId,
    name: row.name.trim(),
    nameAr: row.nameAr?.trim() || null,
    slug,
    description: row.description?.trim() || null,
    descriptionAr: row.descriptionAr?.trim() || null,
    price: priceInFils,
    compareAtPrice: compareAtPriceInFils,
    sku: row.sku?.trim() || null,
    barcode: row.barcode?.trim() || null,
    inventory: row.inventory ? parseInt(row.inventory, 10) : 0,
    status: (row.status?.toLowerCase() as 'draft' | 'active' | 'archived') || 'draft',
    featured: row.featured?.toLowerCase() === 'true',
    isNew: row.isNew?.toLowerCase() === 'true',
    weight: row.weight ? parseFloat(row.weight) : null,
    imageUrls,
    tags,
    categoryName: row.category?.trim() || null,
  };
}

// ============================================
// File Helpers (Browser-only functions)
// ============================================

// Generic types for browser APIs (without DOM lib dependency)
type GenericBlob = { new (parts: unknown[], options: { type: string }): unknown };
type GenericURL = {
  createObjectURL: (blob: unknown) => string;
  revokeObjectURL: (url: string) => void;
};
type GenericElement = {
  setAttribute: (name: string, value: string) => void;
  style: { visibility: string };
  click: () => void;
};
type GenericDocument = {
  createElement: (tag: string) => GenericElement;
  body: { appendChild: (el: unknown) => void; removeChild: (el: unknown) => void };
};
type GenericFileReader = {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
  result: string | ArrayBuffer | null;
  readAsText: (blob: unknown) => void;
};

/**
 * Download CSV file in browser
 * This function only works in browser environments
 */
export function downloadCsv(csvContent: string, filename: string): void {
  if (typeof globalThis === 'undefined') return;

  const g = globalThis as Record<string, unknown>;
  if (!g.document || !g.Blob || !g.URL) return;

  const BlobClass = g.Blob as GenericBlob;
  const URLClass = g.URL as GenericURL;
  const doc = g.document as GenericDocument;

  const blob = new BlobClass(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URLClass.createObjectURL(blob);
  const link = doc.createElement('a');

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';

  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);

  URLClass.revokeObjectURL(url);
}

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
