export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}

export type ImportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  total: number;
  processed: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; error: string }> | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type BulkTab = 'import' | 'catalog' | 'export';
export type FileKind = 'csv' | 'xlsx';
export type DefaultStatus = 'draft' | 'active';

export interface ExportFilters {
  status: string;
  search: string;
  includeDeleted: boolean;
}

export interface ImportOptions {
  updateExisting: boolean;
  skuPrefix: string;
  defaultInventory: number;
  defaultStatus: DefaultStatus;
  trackInventory: boolean;
}

export interface ImportPreviewRow {
  row: number;
  name: string;
  sku: string;
  parentSku: string;
  /** Integer piastres. */
  price: number | null;
  compareAtPrice: number | null;
  costPrice: number | null;
  error: string | null;
}

export interface ImportPreviewError {
  row: number;
  column: string | null;
  code: string | null;
  error: string;
}

export interface ImportPreviewWarning {
  code: 'PRICES_LOOK_LIKE_PIASTRES';
  fileMedianMinor: number;
  storeMedianMinor: number;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: ImportPreviewRow[];
  errors: ImportPreviewError[];
  warnings: ImportPreviewWarning[];
  truncated: boolean;
}
