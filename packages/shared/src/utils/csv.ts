/**
 * CSV Import/Export Utilities
 *
 * Provides utilities for:
 * - Product import column definitions
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
